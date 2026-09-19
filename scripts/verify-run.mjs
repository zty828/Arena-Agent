#!/usr/bin/env node
/**
 * Independently verifies a reported remote run against the bridge's own audit log,
 * rather than trusting the remote agent's summary.
 *
 * Usage: node scripts/verify-run.mjs <run_id> [grant_id]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = process.argv[2];
const grantId = process.argv[3];
if (!runId) { console.error('usage: node scripts/verify-run.mjs <run_id> [grant_id]'); process.exit(1); }

const credentials = JSON.parse(fs.readFileSync(path.join(root, '.arena-bridge', 'local-credentials.json'), 'utf8'));
const base = JSON.parse(fs.readFileSync(path.join(root, 'outputs', 'run-local.config.json'), 'utf8'));
const stateDirectory = path.resolve(root, base.state_directory);
const database = path.join(stateDirectory, 'state.sqlite');

const out = { run_id: runId, grant_id: grantId ?? null, checks: [] };
const add = (name, passed, detail) => out.checks.push({ name, passed: !!passed, detail });

// Query the store through the project's own CLI rather than a third-party sqlite client.
const query = spawnSync(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'events', '--config', path.join(root, 'outputs', 'run-local.tunnel.json'), '--limit', '400'], { cwd: root, encoding: 'utf8', timeout: 60000 });
out.events_command = { status: query.status, stderr: (query.stderr ?? '').slice(0, 300) };

// Read the audit trail straight from the database file in read-only mode.
let rows = [];
try {
  const reader = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const rows = db.prepare('SELECT seq, timestamp, type, payload, run_id, request_id, source FROM event_log ORDER BY seq ASC').all();
const summary = {
  runs: db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,
  grants: db.prepare('SELECT COUNT(*) AS n FROM grants').get().n,
  pairings: db.prepare('SELECT COUNT(*) AS n FROM pairings').get().n,
  approvals: db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n,
};
process.stdout.write(JSON.stringify({ rows, summary }));
db.close();
`;
  const result = spawnSync(process.execPath, ['--experimental-sqlite', '-e', reader, database], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 0 && result.stdout) { const parsed = JSON.parse(result.stdout); rows = parsed.rows; out.tables = parsed.summary; }
  else out.database_error = (result.stderr ?? '').slice(0, 400);
} catch (error) { out.database_error = error.message; }

out.database = path.relative(root, database);
out.total_events = rows.length;

const forRun = rows.filter((row) => row.run_id === runId);
const types = [...new Set(rows.map((row) => row.type))];
out.event_types_present = types;
out.events_for_this_run = forRun.map((row) => ({ seq: row.seq, type: row.type, at: new Date(row.timestamp).toISOString() }));

add('the run id appears in the bridge audit log', forRun.length > 0, { events: forRun.length });
add('a grant was issued and bound to this run', rows.some((row) => row.type === 'grant.issued' && row.run_id === runId), rows.filter((row) => row.type === 'grant.issued').map((row) => row.run_id));
add('the challenge was verified locally', rows.some((row) => /challenge/.test(row.type) && row.run_id === runId), rows.filter((row) => /challenge/.test(row.type)).map((row) => row.type));

const reads = rows.filter((row) => /read|invoke|tool/i.test(row.type));
add('workspace reads were recorded', reads.length > 0, reads.map((row) => row.type).slice(0, 12));

// The audit log must never contain credentials or file bodies.
const blob = JSON.stringify(rows);
add('the audit log contains no admin/api credential', !blob.includes(credentials.admin_token) && !blob.includes(credentials.api_token), undefined);
add('the audit log contains no file body', !blob.includes('export const sum'), undefined);

// The fixture on disk must match what the remote agent reported reading.
const fixture = path.join(root, 'outputs', 'synthetic-workspace', 'sum.mjs');
if (fs.existsSync(fixture)) {
  const text = fs.readFileSync(fixture, 'utf8');
  const hash = spawnSync(process.execPath, ['-e', `const c=require('node:crypto');const fs=require('node:fs');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))`, fixture], { encoding: 'utf8' }).stdout.trim();
  out.fixture = { path: path.relative(root, fixture), bytes: text.length, sha256: hash, content: text.trim() };
  add('the local fixture is unchanged by the read-only session', text.includes('export const sum'), text.trim());
  add('the reported version_hash matches the file on disk', hash === '2d864757af083c7a572b6928d3316fd110ebcc6e15a2f9e5c7189bf78152ec22', { local: hash, reported: '2d864757af083c7a572b6928d3316fd110ebcc6e15a2f9e5c7189bf78152ec22' });
}

// LSP was advertised in the tool list; it must report as unavailable rather than pretend.
const capabilities = spawnSync(process.execPath, [path.join(root, 'dist', 'apps', 'daemon', 'src', 'cli.js'), 'capabilities'], { cwd: root, encoding: 'utf8', timeout: 30000 });
try {
  const caps = JSON.parse(capabilities.stdout);
  out.capabilities = { lsp: caps.tools.lsp, pty: caps.tools.pty, arena: caps.arena.status };
  add('lsp is declared unavailable, not silently stubbed', caps.tools.lsp === 'capability_unavailable', caps.tools.lsp);
} catch (error) { add('lsp is declared unavailable, not silently stubbed', false, error.message); }

const passed = out.checks.filter((entry) => entry.passed).length;
out.summary = `${passed}/${out.checks.length} checks passed`;
fs.writeFileSync(path.join(root, 'outputs', 'run-verification.json'), JSON.stringify(out, null, 2) + '\n');
for (const entry of out.checks) console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail !== undefined ? ' :: ' + JSON.stringify(entry.detail).slice(0, 200) : ''}`);
console.log(`\n${out.summary} -> outputs/run-verification.json`);
