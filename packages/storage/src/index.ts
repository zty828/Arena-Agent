import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { BridgeError, SCHEMA_VERSION, assertTransition, newId, utc, type AuditEvent, type Run, type RunState } from '../../contracts/src/index.js';

export const TABLES = ['workspaces', 'principals', 'grants', 'approvals', 'runs', 'pairings', 'todos', 'settings'] as const;
export type Table = typeof TABLES[number];
// Every key an event may carry. Anything not listed is dropped rather than stored, so a caller
// cannot accidentally log file contents or a token by passing one through.
const AUDIT_KEYS = new Set(['action', 'mode', 'state', 'reason', 'code', 'grant_id', 'principal_id', 'workspace_id', 'approval_id', 'patch_id', 'params_hash', 'body_hash', 'execution_owner', 'count', 'epoch', 'duration_ms', 'transport', 'protocol_version', 'policy_version', 'recipient_hash',
  // Command execution. `command_preview` is the command text itself: with no approval step in
  // front of run_command, this event is the operator's only record of what ran, so a hash alone
  // would make the log useless for the one question it has to answer. It is truncated to 256
  // characters and Bearer-redacted by the writer above, like every other string here.
  'exit_code', 'timed_out', 'stdout_bytes', 'stderr_bytes', 'truncated', 'command_hash', 'command_preview', 'shell', 'killed_commands']);

/** Application state only. No model keys, bearer tokens, file content or command output. */
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      if (lstatSync(dirname(filename)).isSymbolicLink()) throw new BridgeError('POLICY_DENIED', 403, 'State directory must not be a link');
    }
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    for (const table of TABLES) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, doc TEXT NOT NULL CHECK(json_valid(doc))) STRICT;`);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS grants_token_hash ON grants(json_extract(doc, '$.token_hash'));
      CREATE TABLE IF NOT EXISTS event_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
        run_id TEXT, request_id TEXT, job_id TEXT, source TEXT NOT NULL,
        timestamp TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS idempotency_records (
        scope TEXT NOT NULL, key TEXT NOT NULL, body_hash TEXT NOT NULL,
        state TEXT NOT NULL, response TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY(scope, key)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS immutable_run_binding BEFORE UPDATE ON runs
      WHEN json_extract(OLD.doc, '$.execution_owner') != json_extract(NEW.doc, '$.execution_owner')
        OR json_extract(OLD.doc, '$.workspace_id') != json_extract(NEW.doc, '$.workspace_id')
        OR json_extract(OLD.doc, '$.mode') != json_extract(NEW.doc, '$.mode')
        OR json_extract(OLD.doc, '$.principal_id') != json_extract(NEW.doc, '$.principal_id')
      BEGIN SELECT RAISE(ABORT, 'immutable run binding'); END;
    `);
  }
  close(): void { this.db.close(); }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT doc FROM ${table} WHERE id=?`).get(id) as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) as T : undefined;
  }
  all<T>(table: Table): T[] {
    return (this.db.prepare(`SELECT doc FROM ${table} ORDER BY rowid LIMIT 10000`).all() as {doc:string}[]).map(r => JSON.parse(r.doc) as T);
  }
  put<T extends {id: string}>(table: Table, doc: T): void {
    this.db.prepare(`INSERT INTO ${table}(id,doc) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc`).run(doc.id, JSON.stringify(doc));
  }
  delete(table: Table, id: string): void { this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  event(type: string, payload: Record<string, unknown>, context: {run_id?: string; request_id?: string; job_id?: string; source?: string} = {}): string {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) if (AUDIT_KEYS.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)) {
      safe[key] = typeof value === 'string' ? value.slice(0, 256).replace(/Bearer\s+\S+/gi, '[REDACTED]') : value;
    }
    const event_id = newId('evt');
    this.db.prepare('INSERT INTO event_log(event_id,run_id,request_id,job_id,source,timestamp,type,payload) VALUES(?,?,?,?,?,?,?,?)')
      .run(event_id, context.run_id ?? null, context.request_id ?? null, context.job_id ?? null, context.source ?? 'daemon', utc(), type, JSON.stringify(safe));
    return event_id;
  }
  events(after = 0, limit = 100, runId?: string): AuditEvent[] {
    const rows = runId
      ? this.db.prepare('SELECT * FROM event_log WHERE seq>? AND run_id=? ORDER BY seq LIMIT ?').all(after, runId, Math.min(limit,200))
      : this.db.prepare('SELECT * FROM event_log WHERE seq>? ORDER BY seq LIMIT ?').all(after, Math.min(limit,200));
    return rows.map(row => ({...row, schema_version: SCHEMA_VERSION, payload: JSON.parse(String(row.payload))}) as unknown as AuditEvent);
  }
  transition(runId: string, state: RunState, reason: string): Run {
    const run = this.get<Run>('runs', runId);
    if (!run) throw new BridgeError('NOT_FOUND', 404, 'Run not found');
    assertTransition(run.state, state);
    const next = {...run, state, reason, updated_at: Date.now()};
    this.put('runs', next);
    this.event('run.state', {state, reason, execution_owner: run.execution_owner}, {run_id: run.id});
    return next;
  }
  beginIdempotency(scope: string, key: string | undefined, bodyHash: string): {cached?: unknown; tracked: boolean} {
    if (!key) return {tracked:false};
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new BridgeError('INVALID_ARGUMENT',400,'Invalid Idempotency-Key');
    const row = this.db.prepare('SELECT * FROM idempotency_records WHERE scope=? AND key=?').get(scope,key);
    if (row) {
      if (row.body_hash !== bodyHash) throw new BridgeError('VERSION_CONFLICT',409,'Idempotency-Key reused with a different body');
      if (row.state !== 'completed') throw new BridgeError('RESULT_UNKNOWN',409,'Previous operation is pending or its result is unknown; do not retry side effects');
      return {cached:JSON.parse(String(row.response)),tracked:true};
    }
    this.db.prepare('INSERT INTO idempotency_records(scope,key,body_hash,state,created_at) VALUES(?,?,?,?,?)').run(scope,key,bodyHash,'pending',Date.now());
    return {tracked:true};
  }
  finishIdempotency(scope:string, key:string|undefined, response:unknown):void {
    if (key) this.db.prepare('UPDATE idempotency_records SET state=?,response=? WHERE scope=? AND key=?').run('completed',JSON.stringify(response),scope,key);
  }
  recoverOnStart(): number {
    return this.transaction(() => {
      const previous = this.get<{id:string;value:number}>('settings','epoch')?.value ?? 0;
      const epoch = previous + 1;
      this.put('settings',{id:'epoch',value:epoch});
      for (const run of this.all<Run>('runs')) if (!['completed','failed','cancelled','expired','unknown'].includes(run.state)) {
        this.put('runs',{...run,state:'unknown',reason:'daemon_restart_no_automatic_reexecution',updated_at:Date.now()});
      }
      this.db.prepare("UPDATE idempotency_records SET state='unknown' WHERE state='pending'").run();
      this.event('daemon.started',{epoch});
      return epoch;
    });
  }
}
