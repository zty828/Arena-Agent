import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import { BridgeError, newId, sha256 } from '../../contracts/src/index.js';
import { WorkspaceFiles, WORKSPACE_LIMITS, decodeUtf8, denied, ioError, normalizeRelative, pathKey, textLines, type TextLine } from './files.js';

export interface PatchPreview {
  id: string;
  workspace_root_hash: string;
  digest: string;
  state: 'previewed' | 'committing' | 'applied' | 'rolled_back' | 'unknown';
  changes: { path: string; before_hash: string | null; after_hash: string; diff: string }[];
  created_at: number;
}
/** recover() 没能自动处理的一个事务：id、失败码和原因。恢复本身不被它中断。 */
export interface RecoveryProblem { patch_id: string; code: string; message: string; }
/** recover() 的报告：已回滚的预览列表 + 需要本地人工处理的问题列表。 */
export interface RecoveryReport { recovered: PatchPreview[]; problems: RecoveryProblem[]; }
type Phase = 'pending' | 'staging' | 'staged' | 'renaming' | 'renamed' | 'restoring' | 'restored';
interface Journal { schema: 1; preview: PatchPreview; records: { mode: number; phase: Phase }[]; }
interface Content { before: Buffer | null; after: Buffer; mode: number; }
interface HunkLine { kind: ' ' | '+' | '-'; text: string; crlf: boolean; noNewline: boolean; }
interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: HunkLine[]; }
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
// prepare 不持有任何锁（id 公开之前无需互斥），guard/owner 存活性判定因此看不到一个
// 进行中的 prepare。只有 mtime 足够旧的无日志目录才可能是残骸：prepare 的写入窗口是
// 毫秒到秒级，而 recover 面对的残骸几乎都来自上一个进程生命周期。宁可跳过等下次恢复，
// 也绝不动一个可能正在被写入的目录。
const REAP_MIN_AGE_MS = 60_000;
const ID = /^patch_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const lockTails = new Map<string, Promise<void>>();

// 同一进程的所有实例共用规范路径锁，统一排序后获取，避免交叉批次死锁。
async function locked<T>(keys: string[], action: () => Promise<T>): Promise<T> {
  const releases: (() => void)[] = [];
  try {
    for (const key of [...new Set(keys)].sort()) {
      const previous = lockTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>(resolve => { release = resolve; });
      const tail = previous.then(() => next);
      lockTails.set(key, tail);
      await previous;
      releases.push(() => { release(); if (lockTails.get(key) === tail) lockTails.delete(key); });
    }
    return await action();
  } finally { for (const release of releases.reverse()) release(); }
}
function invalidPatch(): never { throw new BridgeError('INVALID_PATCH', 400, '需要完整且精确匹配的单文件 unified diff；不支持删除、重命名或模糊匹配'); }
function conflict(): never { throw new BridgeError('VERSION_CONFLICT', 409, '文件版本与补丁预期不一致'); }
/**
 * 判断一个记录在锁文件里的 pid 是否仍然存活。
 *
 * ESRCH 表示进程不存在；EPERM 表示进程存在但不属于当前用户，仍算存活。其他错误按存活处理，
 * 因为无法确认存活时清锁会造成两个进程同时提交。
 */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/**
 * unlink 被「明确拒绝」时的 errno 集合。
 *
 * 这些码表示锁文件仍然存在、并且**确实**删不掉（权限不足、被占用、外部保护策略拦下），
 * 属于操作者需要本地处理的状态，因此归类为 PATCH_LOCKED。
 *
 * 其余 errno 一律**不**套用锁语义：它们是普通 IO 故障，会被 apply/recover 的 IO 兜底
 * 折成不透明的 IO_ERROR。把这类故障谎报成锁冲突，会让操作者去排查一个并不存在的问题。
 */
const DELETION_REFUSED_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EISDIR', 'ENOTEMPTY', 'EROFS']);
function headerPath(header: string, prefix: '--- ' | '+++ '): string {
  if (!header.startsWith(prefix)) invalidPatch();
  let value = header.slice(4).split('\t')[0]!;
  if (value.startsWith('"')) {
    try { value = JSON.parse(value) as string; } catch { invalidPatch(); }
    if (typeof value !== 'string') invalidPatch();
  }
  if (value === '/dev/null') return value;
  if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2);
  return normalizeRelative(value);
}
function parsePatch(diff: string, relative: string, creating: boolean): Hunk[] {
  if (typeof diff !== 'string' || !diff || Buffer.byteLength(diff) > MAX_BATCH_BYTES || diff.includes('\0')) invalidPatch();
  const rows = diff.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  if (rows.length < 3) invalidPatch();
  const oldPath = headerPath(rows[0]!.replace(/\r$/, ''), '--- ');
  const newPath = headerPath(rows[1]!.replace(/\r$/, ''), '+++ ');
  if (oldPath !== (creating ? '/dev/null' : relative) || newPath !== relative) invalidPatch();
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const row of rows.slice(2)) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*?)?\r?$/.exec(row);
    if (match) {
      const values = [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
      if (values.some(value => !Number.isSafeInteger(value) || value < 0 || value > WORKSPACE_LIMITS.fileBytes)) invalidPatch();
      current = { oldStart: values[0]!, oldCount: values[1]!, newStart: values[2]!, newCount: values[3]!, lines: [] };
      if ((!current.oldStart && current.oldCount) || (!current.newStart && current.newCount) || (!current.oldCount && !current.newCount)) invalidPatch();
      hunks.push(current);
    } else if (row.replace(/\r$/, '') === '\\ No newline at end of file') {
      const previous = current?.lines[current.lines.length - 1];
      if (!previous || previous.noNewline) invalidPatch();
      previous.noNewline = true;
    } else {
      const kind = row[0];
      if (!current || (kind !== ' ' && kind !== '+' && kind !== '-')) invalidPatch();
      current.lines.push({ kind, text: row.slice(1).replace(/\r$/, ''), crlf: row.endsWith('\r'), noNewline: false });
    }
  }
  if (!hunks.length || !hunks.some(hunk => hunk.lines.some(line => line.kind !== ' '))) invalidPatch();
  for (const hunk of hunks) {
    if (hunk.lines.filter(line => line.kind !== '+').length !== hunk.oldCount || hunk.lines.filter(line => line.kind !== '-').length !== hunk.newCount) invalidPatch();
  }
  return hunks;
}
function applyExact(before: Buffer | null, relative: string, diff: string): Buffer {
  const decoded = decodeUtf8(before ?? Buffer.alloc(0));
  const hunks = parsePatch(diff, relative, before === null);
  const source = textLines(decoded.bom ? decoded.text.slice(1) : decoded.text);
  const output: TextLine[] = [];
  const defaultEol = source.find(line => line.eol)?.eol ?? '\n';
  let position = 0, bom = decoded.bom;
  for (const hunk of hunks) {
    const oldIndex = hunk.oldCount ? hunk.oldStart - 1 : hunk.oldStart;
    const newIndex = hunk.newCount ? hunk.newStart - 1 : hunk.newStart;
    if (oldIndex < position || oldIndex > source.length || oldIndex + hunk.oldCount > source.length) invalidPatch();
    for (; position < oldIndex; position++) output.push(source[position]!);
    if (output.length !== newIndex) invalidPatch();
    for (const line of hunk.lines) {
      let text = line.text;
      const atFirst = line.kind === '+' ? output.length === 0 : position === 0;
      if (atFirst && text.startsWith('\uFEFF')) {
        if (before === null && line.kind === '+') bom = true;
        if (!bom) invalidPatch();
        text = text.slice(1);
      }
      if (line.kind !== '+') {
        const existing = source[position];
        if (!existing || existing.text !== text || (existing.eol === '') !== line.noNewline || (line.crlf && !line.noNewline && existing.eol !== '\r\n')) invalidPatch();
        position++;
        if (line.kind === ' ') output.push({ ...existing });
      } else output.push({ text, eol: line.noNewline ? '' : line.crlf ? '\r\n' : defaultEol });
    }
  }
  for (; position < source.length; position++) output.push(source[position]!);
  if (output.some((line, index) => !line.eol && index !== output.length - 1)) invalidPatch();
  const after = Buffer.from((bom ? '\uFEFF' : '') + output.map(line => line.text + line.eol).join(''));
  if (after.length > WORKSPACE_LIMITS.fileBytes) throw new BridgeError('FILE_TOO_LARGE', 413, '补丁结果超过文件大小上限');
  decodeUtf8(after);
  return after;
}
function previewDigest(preview: Pick<PatchPreview, 'workspace_root_hash' | 'changes'>): string {
  return sha256(JSON.stringify({ workspace_root_hash: preview.workspace_root_hash, changes: preview.changes }));
}
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function badJournal(): never { throw new BridgeError('INVALID_PATCH_STATE', 409, '本地补丁日志无效或与当前工作区不符'); }
function fileStat(stat: Stats): void { if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) denied(); }
async function readLocal(filename: string, maximum: number): Promise<Buffer> {
  const before = await fs.lstat(filename); fileStat(before);
  if (before.size > maximum) badJournal();
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat(); fileStat(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximum) badJournal();
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const part = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    const after = await handle.stat(); fileStat(after);
    const visible = await fs.lstat(filename); fileStat(visible);
    if (opened.size !== offset || after.size !== offset || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || visible.dev !== opened.dev || visible.ino !== opened.ino) badJournal();
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
async function writeExclusive(filename: string, data: Uint8Array, mode: number): Promise<void> {
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  // Windows 不提供与 POSIX 相同的目录 fsync；不能据此承诺断电持久性。
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export class PatchEngine {
  private readonly directory: string;
  private readonly rootHash: string;
  private stateIdentity: Stats | undefined;
  constructor(private readonly files: WorkspaceFiles, stateDirectory: string, private readonly options: { fault?: (point: string, index: number) => void | Promise<void> } = {}) {
    if (typeof stateDirectory !== 'string' || !stateDirectory || /[\x00-\x1f]/.test(stateDirectory)) denied();
    this.directory = path.resolve(stateDirectory, 'patches');
    this.files.protectDirectory(this.directory);
    this.rootHash = sha256(files.root);
  }

  private async ensureDirectory(directory: string, create: boolean): Promise<void> {
    const parsed = path.parse(directory);
    if (parsed.root.startsWith('\\\\') || parsed.root.startsWith('//')) denied();
    let current = parsed.root;
    for (const component of directory.slice(parsed.root.length).split(path.sep)) {
      current = path.join(current, component);
      if (create) {
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) denied();
    }
    if (pathKey(await fs.realpath(directory)) !== pathKey(directory)) denied();
  }
  private async init(): Promise<void> {
    await this.ensureDirectory(this.directory, true);
    const identity = await fs.lstat(this.directory);
    if (this.stateIdentity && (identity.dev !== this.stateIdentity.dev || identity.ino !== this.stateIdentity.ino)) denied();
    this.stateIdentity ??= identity;
  }
  private transactionDirectory(id: string): string {
    if (!ID.test(id)) throw new BridgeError('INVALID_ARGUMENT', 400, '补丁标识无效');
    return path.join(this.directory, id);
  }
  private async save(journal: Journal): Promise<void> {
    await this.init();
    const directory = this.transactionDirectory(journal.preview.id);
    await this.ensureDirectory(directory, false);
    const temporary = path.join(directory, `${newId('journal')}.tmp`);
    const destination = path.join(directory, 'journal.json');
    const data = Buffer.from(JSON.stringify(journal));
    if (data.length > MAX_JOURNAL_BYTES) badJournal();
    await writeExclusive(temporary, data, 0o600);
    try {
      try { fileStat(await fs.lstat(destination)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.ensureDirectory(directory, false);
      await fs.rename(temporary, destination);
      await syncDirectory(directory);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  private validateJournal(value: unknown, id: string): Journal {
    if (!plain(value) || value.schema !== 1 || !plain(value.preview) || !Array.isArray(value.records)) badJournal();
    const preview = value.preview;
    if (preview.id !== id || preview.workspace_root_hash !== this.rootHash || typeof preview.digest !== 'string' || !HASH.test(preview.digest) || typeof preview.created_at !== 'number' || !Number.isSafeInteger(preview.created_at) || preview.created_at < 0 || !['previewed', 'committing', 'applied', 'rolled_back', 'unknown'].includes(String(preview.state)) || !Array.isArray(preview.changes) || !preview.changes.length || preview.changes.length > 10 || value.records.length !== preview.changes.length) badJournal();
    const paths = new Set<string>();
    for (const change of preview.changes) {
      if (!plain(change) || typeof change.path !== 'string' || normalizeRelative(change.path) !== change.path || (change.before_hash !== null && (typeof change.before_hash !== 'string' || !HASH.test(change.before_hash))) || typeof change.after_hash !== 'string' || !HASH.test(change.after_hash) || typeof change.diff !== 'string' || Buffer.byteLength(change.diff) > MAX_BATCH_BYTES) badJournal();
      const key = pathKey(change.path);
      if (paths.has(key)) badJournal();
      paths.add(key);
    }
    for (const record of value.records) if (!plain(record) || typeof record.mode !== 'number' || !Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0o777 || !['pending', 'staging', 'staged', 'renaming', 'renamed', 'restoring', 'restored'].includes(String(record.phase))) badJournal();
    const journal = value as unknown as Journal;
    if (previewDigest(journal.preview) !== journal.preview.digest) badJournal();
    return journal;
  }
  private async load(id: string): Promise<Journal> {
    await this.init();
    const directory = this.transactionDirectory(id);
    await this.ensureDirectory(directory, false);
    const data = await readLocal(path.join(directory, 'journal.json'), MAX_JOURNAL_BYTES);
    let value: unknown;
    try { value = JSON.parse(data.toString('utf8')); } catch { badJournal(); }
    return this.validateJournal(value, id);
  }
  private keys(preview: PatchPreview): string[] {
    return [`state:${pathKey(this.directory)}:${this.rootHash}`, `journal:${pathKey(this.directory)}:${preview.id}`, ...preview.changes.map(change => `file:${pathKey(path.join(this.files.root, change.path))}`)];
  }
  private async exclusive<T>(preview: PatchPreview, action: () => Promise<T>): Promise<T> {
    return locked(this.keys(preview), async () => {
      await this.init();
      const ownerFile = path.join(this.directory, `.lock-${this.rootHash}`);
      const guardFile = `${ownerFile}.guard`;
      const ownership = Buffer.from(JSON.stringify({ pid: process.pid, token: newId('lock') }));
      // guard 将死亡进程锁的检查、移除和新锁创建串行化，避免两个恢复者互删新锁。
      //
      // guard 只有在持有者已经死亡时才可回收：它存在的唯一目的就是让这一段临界区串行，
      // 而一个已退出进程不可能还在临界区里。此前一律报 PATCH_LOCKED，会让一次「清理失败」
      // （例如外部环境短暂拒绝删除文件）把工作区永久锁死——这是不可接受的故障放大，
      // 所以这里补上与 owner 锁相同的存活性判定。
      await this.claimGuard(guardFile, ownership);
      let acquired = false;
      try {
        let previous: Buffer | null;
        try { previous = await readLocal(ownerFile, 1024); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') previous = null; else throw error; }
        if (previous !== null) {
          let owner: unknown;
          try { owner = JSON.parse(previous.toString('utf8')); } catch { badJournal(); }
          if (!plain(owner) || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') badJournal();
          if (alive(owner.pid)) throw new BridgeError('PATCH_LOCKED', 409, '另一进程正在提交或恢复此工作区');
          // 回收死亡进程的残留锁。删不掉时 removeLockFile 会如实抛出：此刻还没有开始提交，
          // 抛出是安全的，调用方也没有既成的写入结果需要保护。
          await this.removeLockFile(ownerFile, '提交锁');
        }
        await writeExclusive(ownerFile, ownership, 0o600);
        acquired = true;
      } catch (error) {
        // 取得锁失败（或回收残留锁失败）时，guard 必须仍被释放，否则一次瞬时故障
        // 会把 guard 留成后续提交的路障。
        await this.releaseGuard(guardFile).catch(() => undefined);
        throw error;
      }
      let result: T;
      try { result = await action(); }
      catch (error) {
        // 动作失败（含业务错误码）：先尽力释放 guard 与 owner 锁，再原样抛出动作的真实错误。
        // 释放失败不得覆盖业务错误码——那是调用方唯一可操作的信号。
        await this.releaseGuard(guardFile).catch(() => undefined);
        await this.releaseOwnership(ownerFile, ownership).catch(() => undefined);
        throw error;
      }
      // 动作已经成功返回。此时释放锁**只是清理**，两把锁任何一把删不掉都**不能**改变
      // 已经成立的结果：工作区文件已经写入、日志已经标记 applied。把释放失败升级成异常，
      // 会把一次成功提交谎报成失败，并让调用方无法用 preview.state 判断真实状态。
      // 残留锁由存活性判定（见 claimGuard / 上面的 owner 检查）在下次提交时回收。
      await this.releaseGuard(guardFile).catch((error) => this.noteLockLeak('提交锁 guard', error));
      if (acquired) await this.releaseOwnership(ownerFile, ownership).catch((error) => this.noteLockLeak('提交锁', error));
      return result;
    });
  }
  /** 释放 owner 锁：身份不符是日志损坏，必须报出；删除失败由调用方决定如何处理。 */
  private async releaseOwnership(ownerFile: string, ownership: Buffer): Promise<void> {
    await this.init();
    const current = await readLocal(ownerFile, 1024);
    if (!current.equals(ownership)) badJournal();
    await this.removeLockFile(ownerFile, '提交锁');
  }
  /**
   * 记录一次「结果已经成立、但锁没能清掉」。
   *
   * 这是刻意降级为日志的：下一次提交会通过存活性判定回收该锁，所以它不构成故障；
   * 但它也确实值得被记录，否则操作者无法解释磁盘上为什么多出一个锁文件。
   * 诊断开关 ARENABRIDGE_TRACE_LOCK 打开时输出到 stderr。
   */
  private noteLockLeak(label: string, error: unknown): void {
    if (!process.env.ARENABRIDGE_TRACE_LOCK) return;
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(JSON.stringify({ trace: 'lock_leak', label, directory: this.directory, detail: detail.slice(0, 300) }) + '\n');
  }
  /**
   * 取得 guard，或回收一个属于已死进程的 guard。
   *
   * 关键性质：这里绝不能把「guard 已存在」直接当成「有人在提交」。guard 的持有者一旦
   * 退出，它就只是一个普通残留文件；把它当成永久锁，会让任何一次删除失败永久堵死工作区。
   * 因此只有「guard 存在且其 pid 仍然存活」才拒绝。
   */
  private async claimGuard(guardFile: string, ownership: Buffer): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await writeExclusive(guardFile, ownership, 0o600); return; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      let holder: Buffer;
      try { holder = await readLocal(guardFile, 1024); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      let parsed: unknown;
      try { parsed = JSON.parse(holder.toString('utf8')); } catch { throw new BridgeError('PATCH_LOCKED', 409, '工作区提交锁 guard 已损坏，需要本地检查'); }
      if (!plain(parsed) || typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid)) throw new BridgeError('PATCH_LOCKED', 409, '工作区提交锁 guard 无法识别，需要本地检查');
      if (alive(parsed.pid)) throw new BridgeError('PATCH_LOCKED', 409, '工作区提交锁正在维护或需要本地检查');
      // 持有者已死：回收 guard 后重试一次。若回收被外部拒绝，把真实原因报出来，
      // 而不是把它伪装成「有人在提交」。
      await this.removeLockFile(guardFile, '提交锁 guard');
    }
    throw new BridgeError('PATCH_LOCKED', 409, '工作区提交锁 guard 无法取得，需要本地检查');
  }
  /**
   * 释放 guard。
   *
   * 失败**不能**静默：一个删不掉的 guard 会让后续所有提交都被拒，所以必须让调用方知道。
   * 但它也**不是**「有人在提交」——把删除失败一律映射成 PATCH_LOCKED 会污染错误语义：
   * 真实原因（权限、外部保护、瞬时 IO 故障）会被谎报成锁冲突，让操作者去查错误的线索。
   * 所以这里按 errno 分类：删除被明确拒绝 ⇒ 锁确实还在 ⇒ PATCH_LOCKED；
   * 其他底层故障 ⇒ 交给调用方的 IO 兜底，如实报成 IO_ERROR。
   */
  private async releaseGuard(guardFile: string): Promise<void> {
    await this.removeLockFile(guardFile, '提交锁 guard');
  }
  /**
   * 删除一个锁文件。
   *
   * 刻意不吞错误：删除被拒意味着锁仍留在磁盘上，而残留锁会直接导致下一次提交失败，
   * 伪装成功只会把问题推迟成更难诊断的形态。
   *
   * 但错误的**归类**必须准确，这里区分三种情形：
   *   - ENOENT：已经不在了，成功返回。
   *   - 明确的删除拒绝（EPERM/EACCES/EBUSY/EISDIR/ENOTEMPTY，以及宿主沙箱的
   *     批量删除保护）：锁确实存在且删不掉 ⇒ PATCH_LOCKED，并带上真实原因。
   *   - 其他底层 IO 故障：不是锁语义问题 ⇒ 原样抛出，由 apply/recover 的 IO 兜底
   *     映射成 IO_ERROR。
   *
   * 绝不把第三种谎报成 PATCH_LOCKED。此前无条件改写会让「提交已经成功、只是释放锁失败」
   * 这类情形看起来像锁冲突，并且会掩盖调用方真正需要看到的业务错误码。
   */
  private async removeLockFile(file: string, label: string): Promise<void> {
    try { await fs.unlink(file); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (typeof code === 'string' && DELETION_REFUSED_CODES.has(code)) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new BridgeError('PATCH_LOCKED', 409, `无法清除${label}（${detail}）；该锁仍然存在，需要本地检查`, { file: path.basename(file) });
      }
      throw error;
    }
  }
  private async contents(journal: Journal): Promise<Content[]> {
    const directory = this.transactionDirectory(journal.preview.id);
    await this.ensureDirectory(directory, false);
    const result: Content[] = [];
    let total = 0;
    for (const [index, change] of journal.preview.changes.entries()) {
      const before = change.before_hash === null ? null : await readLocal(path.join(directory, `before-${index}.bin`), WORKSPACE_LIMITS.fileBytes);
      const after = await readLocal(path.join(directory, `after-${index}.bin`), WORKSPACE_LIMITS.fileBytes);
      if ((before === null ? null : sha256(before)) !== change.before_hash || sha256(after) !== change.after_hash) badJournal();
      total += (before?.length ?? 0) + after.length;
      if (total > MAX_BATCH_BYTES) badJournal();
      result.push({ before, after, mode: journal.records[index]!.mode });
    }
    return result;
  }

  /**
   * 尽力清理一个没有 journal.json 的事务目录（prepare 失败留下的残骸）。
   *
   * 绝不能动一个还在被写入的目录：正常事务目录**总是**带日志（prepare 先写 before/after
   * 再落 journal），recover 也不会把日志弄丢，所以「无日志」基本等价于「prepare 没走完」。
   * 真正的门槛是活性：prepare 本身不持有 guard/owner 锁，存活性判定看不到它，因此只回收
   * mtime 早于 REAP_MIN_AGE_MS 的目录（见常量处注释）。删除失败或判定为活跃都如实记入
   * problems，不静默丢弃——留在原地等下次扫描，比删掉一个活体事务安全得多。
   */
  private async reapJournalLess(id: string, problems: RecoveryProblem[]): Promise<void> {
    try {
      const directory = this.transactionDirectory(id);
      const stat = await fs.stat(directory);
      if (!stat.isDirectory() || Date.now() - stat.mtimeMs < REAP_MIN_AGE_MS) {
        problems.push({ patch_id: id, code: 'RECOVERY_SKIPPED', message: '事务目录缺少日志但最近仍被修改；为避免影响进行中的操作，暂不清理，下次恢复将重试' });
        return;
      }
      await fs.rm(directory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      problems.push({ patch_id: id, code: 'RECOVERY_REAP_FAILED', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * A string-replacement edit, compiled into the same exact unified diff the patch engine
   * already consumes.
   *
   * Mainstream harnesses edit files with "replace this exact text with that text" rather than by
   * authoring hunks, and for good reason: a model that gets a hunk header wrong produces a
   * rejected patch, while a model that gets an `old_string` wrong gets told so. This does not add
   * a second write path — it builds a diff from the *current* bytes and hands it to `prepare`,
   * so the hash binding, the path policy, the approval flow and the recovery journal are all the
   * same ones `apply_patch` uses.
   *
   * Ambiguity is an error rather than a guess: if `old_string` appears more than once and
   * `replace_all` was not asked for, replacing "the first one" would silently edit a different
   * place than the caller meant.
   */
  async prepareEdit(input: { path: string; old_string: string; new_string: string; expected_hash: string | null; replace_all?: boolean }): Promise<PatchPreview> {
    try {
      if (typeof input.path !== 'string' || !input.path) throw new BridgeError('INVALID_ARGUMENT', 400, 'path is required');
      if (typeof input.old_string !== 'string' || !input.old_string) throw new BridgeError('INVALID_ARGUMENT', 400, 'old_string must be a non-empty string');
      if (typeof input.new_string !== 'string') throw new BridgeError('INVALID_ARGUMENT', 400, 'new_string must be a string');
      if (input.old_string === input.new_string) throw new BridgeError('INVALID_ARGUMENT', 400, 'old_string and new_string are identical; there is nothing to change');
      const relative = normalizeRelative(input.path);
      // `readBytes` is what makes this an edit rather than a create: a missing file is NOT_FOUND
      // here, and creating one stays `apply_patch`'s job.
      const before = await this.files.readBytes(relative);
      const baseline = sha256(before);
      if (input.expected_hash !== null && input.expected_hash !== baseline) conflict();
      const source = before.toString('utf8');
      const occurrences = source.split(input.old_string).length - 1;
      if (occurrences === 0) throw new BridgeError('EDIT_NOT_FOUND', 409, 'old_string does not appear in the file; read it again and retry with the exact text');
      if (occurrences > 1 && !input.replace_all) throw new BridgeError('EDIT_AMBIGUOUS', 409, `old_string appears ${occurrences} times; include more surrounding text to make it unique, or pass replace_all:true`);
      const after = input.replace_all ? source.split(input.old_string).join(input.new_string) : source.replace(input.old_string, input.new_string);
      // The same call the engine uses for the diff it shows the operator, so the format this
      // produces is by construction one `parsePatch` accepts.
      const patch = createTwoFilesPatch(`a/${relative}`, `b/${relative}`, source, after, undefined, undefined, { headerOptions: FILE_HEADERS_ONLY, timeout: 1000, maxEditLength: 10000 });
      // The diff helper returns undefined when it finds no difference at all (or gives up). Both
      // cases mean there is nothing to apply, and neither may be papered over with an empty
      // string — that would reach the parser as a malformed patch and be reported as one.
      if (!patch) throw new BridgeError('EDIT_NOT_APPLIED', 409, 'the replacement produced no change; check that new_string differs from old_string');
      // An omitted hash means "against what is there now", not "any version will do": the baseline
      // is the content this edit was computed from, so a concurrent write between the read above
      // and the commit is still rejected. A caller that read the file can pin its version by
      // passing the hash it saw, which is strictly stronger (it also catches a change elsewhere in
      // the file that the hunk context would not have noticed).
      return await this.prepare({ changes: [{ path: relative, patch, expected_hash: input.expected_hash ?? baseline }] });
    } catch (error) {
      return ioError(error);
    }
  }

  async prepare(input: { changes: { path: string; patch: string; expected_hash: string | null }[] }): Promise<PatchPreview> {
    try {
      if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 10) throw new BridgeError('INVALID_ARGUMENT', 400, '每批补丁必须包含 1 至 10 个文件');
      const changes: PatchPreview['changes'] = [], contents: Content[] = [];
      const paths = new Set<string>();
      let total = 0, diffBytes = 0;
      // 所有文件和所有 hunk 完成预检后，才创建私有日志；此阶段不写工作区。
      for (const request of input.changes) {
        const relative = normalizeRelative(request.path);
        if (paths.has(pathKey(relative))) throw new BridgeError('INVALID_ARGUMENT', 400, '同一批不能重复修改同一路径');
        paths.add(pathKey(relative));
        if (request.expected_hash !== null && (typeof request.expected_hash !== 'string' || !HASH.test(request.expected_hash))) throw new BridgeError('INVALID_ARGUMENT', 400, '必须提供 SHA256 或 null 版本');
        if (typeof request.patch !== 'string') invalidPatch();
        diffBytes += Buffer.byteLength(request.patch);
        if (diffBytes > MAX_BATCH_BYTES) throw new BridgeError('PATCH_TOO_LARGE', 413, '补丁批次超出大小上限');
        await this.files.resolve(relative, { allowMissing: true });
        let before: Buffer | null;
        try { before = await this.files.readBytes(relative); }
        catch (error) {
          if (error instanceof BridgeError && error.code === 'NOT_FOUND') { await this.files.resolve(relative, { allowMissing: true }); before = null; }
          else throw error;
        }
        const beforeHash = before === null ? null : sha256(before);
        if (beforeHash !== request.expected_hash) conflict();
        const after = applyExact(before, relative, request.patch);
        const mode = before === null ? 0o600 : (await fs.lstat(await this.files.resolve(relative))).mode & 0o777;
        total += (before?.length ?? 0) + after.length;
        if (total > MAX_BATCH_BYTES) throw new BridgeError('PATCH_TOO_LARGE', 413, '补丁备份和结果总量超出上限');
        const actualDiff = createTwoFilesPatch(before === null ? '/dev/null' : `a/${relative}`, `b/${relative}`, (before ?? Buffer.alloc(0)).toString('utf8'), after.toString('utf8'), undefined, undefined, { headerOptions: FILE_HEADERS_ONLY, timeout: 1000, maxEditLength: 10000 });
        if (actualDiff === undefined) throw new BridgeError('PATCH_TOO_LARGE', 413, '生成真实 Diff 超过预算；没有写入工作区');
        changes.push({ path: relative, before_hash: beforeHash, after_hash: sha256(after), diff: actualDiff });
        contents.push({ before, after, mode });
      }
      const preview: PatchPreview = { id: newId('patch'), workspace_root_hash: this.rootHash, digest: '', state: 'previewed', changes, created_at: Date.now() };
      preview.digest = previewDigest(preview);
      await this.init();
      const directory = this.transactionDirectory(preview.id);
      try {
        await fs.mkdir(directory, { mode: 0o700 });
        for (const [index, content] of contents.entries()) {
          if (content.before !== null) await writeExclusive(path.join(directory, `before-${index}.bin`), content.before, 0o600);
          await writeExclusive(path.join(directory, `after-${index}.bin`), content.after, 0o600);
        }
        const journal: Journal = { schema: 1, preview, records: contents.map(content => ({ mode: content.mode, phase: 'pending' })) };
        await this.save(journal);
        await syncDirectory(this.directory);
        return structuredClone(preview);
      } catch (error) {
        // 中途失败会留下没有 journal.json 的半截事务目录，recover() 永远扫不到它（见下方
        // 对无日志目录的 reaping 注释）。best-effort 清掉——清理失败不掩盖真实错误。
        await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    } catch (error) { return ioError(error); }
  }

  async get(id: string): Promise<PatchPreview> {
    try { return structuredClone((await this.load(id)).preview); }
    catch (error) { return ioError(error); }
  }
  private async checkVersions(journal: Journal): Promise<void> {
    for (const [index, change] of journal.preview.changes.entries()) {
      await this.files.resolve(change.path, { allowMissing: true });
      const expected = journal.records[index]!.phase === 'renamed' ? change.after_hash : change.before_hash;
      if (await this.files.hashFile(change.path) !== expected) conflict();
    }
  }
  private async temporary(journal: Journal, index: number, rollback = false): Promise<string> {
    const target = await this.files.resolve(journal.preview.changes[index]!.path, { allowMissing: true });
    return path.join(path.dirname(target), `.arena-tmp-${journal.preview.id}-${index}${rollback ? '-rollback' : ''}`);
  }
  private async cleanTemporary(journal: Journal, index: number, hash: string, rollback = false): Promise<boolean> {
    try {
      const temporary = await this.temporary(journal, index, rollback);
      let data: Buffer;
      try { data = await readLocal(temporary, WORKSPACE_LIMITS.fileBytes); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
      if (sha256(data) !== hash) return false;
      await this.temporary(journal, index, rollback);
      await fs.unlink(temporary);
      return true;
    } catch { return false; }
  }
  /**
   * 撤销一次「尚未写入工作区」的提交尝试。授权被拒或版本预检失败时调用，
   * 使补丁回到可重试的 previewed；不产生 restored 记录，也不吞掉原始错误。
   */
  private async rewind(journal: Journal): Promise<void> {
    journal.preview.state = 'previewed';
    await this.save(journal);
  }

  private async rollback(journal: Journal): Promise<void> {
    const contents = await this.contents(journal);
    let unknown = false;
    for (let index = journal.preview.changes.length - 1; index >= 0; index--) {
      const change = journal.preview.changes[index]!, record = journal.records[index]!, content = contents[index]!;
      try {
        const current = await this.files.hashFile(change.path);
        const mayHaveWritten = ['renaming', 'renamed', 'restoring', 'restored'].includes(record.phase);
        if (current === change.before_hash) {
          record.phase = 'restored';
        } else if (mayHaveWritten && current === change.after_hash) {
          record.phase = 'restoring';
          await this.save(journal);
          if (content.before === null) {
            const target = await this.files.resolve(change.path);
            if (await this.files.hashFile(change.path) !== change.after_hash) conflict();
            await fs.unlink(target);
            await syncDirectory(path.dirname(target));
          } else {
            const temporary = await this.temporary(journal, index, true);
            try { await writeExclusive(temporary, content.before, content.mode); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || sha256(await readLocal(temporary, WORKSPACE_LIMITS.fileBytes)) !== change.before_hash) throw error;
            }
            if (sha256(await readLocal(temporary, WORKSPACE_LIMITS.fileBytes)) !== change.before_hash) badJournal();
            const target = await this.files.resolve(change.path);
            if (await this.files.hashFile(change.path) !== change.after_hash) conflict();
            await fs.rename(temporary, target);
            await syncDirectory(path.dirname(target));
          }
          record.phase = 'restored';
          await this.save(journal);
        } else unknown = true;
      } catch { unknown = true; }
      // 临时文件由 temporary() 放在**工作区目录内**（rename 需要同目录才能原子替换），
      // 因此「临时文件没删掉」就等于工作区里留下了 .arena-tmp-* 垃圾——工作区确实不干净，
      // 必须计入 unknown。把它降级成日志会让补丁谎报 rolled_back，而磁盘上还留着半成品文件。
      if (!await this.cleanTemporary(journal, index, change.after_hash)) unknown = true;
      if (change.before_hash !== null && !await this.cleanTemporary(journal, index, change.before_hash, true)) unknown = true;
    }
    journal.preview.state = unknown ? 'unknown' : 'rolled_back';
    await this.save(journal);
  }

  async apply(id: string, authorize: () => void): Promise<PatchPreview> {
    try {
      if (typeof authorize !== 'function') throw new BridgeError('INVALID_ARGUMENT', 400, '必须提供授权检查回调');
      const initial = await this.load(id);
      return await this.exclusive(initial.preview, async () => {
        const journal = await this.load(id);
        if (journal.preview.digest !== initial.preview.digest) badJournal();
        if (journal.preview.state === 'applied') return structuredClone(journal.preview);
        if (journal.preview.state !== 'previewed') throw new BridgeError('PATCH_STATE_CONFLICT', 409, '补丁不在可提交状态');
        const contents = await this.contents(journal);
        await this.checkVersions(journal);
        // 一旦第一个临时文件落盘，工作区副作用就存在了，此后失败必须走回滚。
        let wroteWorkspace = false;
        journal.preview.state = 'committing';
        try {
          await this.save(journal);
          // 授权在任何工作区临时文件写入之前执行。此刻尚未触碰任何文件，因此拒绝
          // 不能把补丁烧成终态：仅还原为 previewed，并原样抛出真实错误码，
          // 让操作者批准之后可以用同一个 patch_id 重试。
          await authorize();
          await this.checkVersions(journal);
          for (const [index, content] of contents.entries()) {
            journal.records[index]!.phase = 'staging';
            await this.save(journal);
            const temporary = await this.temporary(journal, index);
            await writeExclusive(temporary, content.after, content.mode);
            wroteWorkspace = true;
            journal.records[index]!.phase = 'staged';
            await this.save(journal);
            await this.options.fault?.('after_stage', index);
          }
          for (const [index, change] of journal.preview.changes.entries()) {
            journal.records[index]!.phase = 'renaming';
            await this.save(journal);
            await this.options.fault?.('before_rename', index);
            await this.checkVersions(journal);
            const temporary = await this.temporary(journal, index);
            if (sha256(await readLocal(temporary, WORKSPACE_LIMITS.fileBytes)) !== change.after_hash) badJournal();
            const target = await this.files.resolve(change.path, { allowMissing: true });
            if (await this.files.hashFile(change.path) !== change.before_hash) conflict();
            await fs.rename(temporary, target);
            await syncDirectory(path.dirname(target));
            journal.records[index]!.phase = 'renamed';
            await this.save(journal);
            await this.options.fault?.('after_rename', index);
          }
          await this.checkVersions(journal);
          journal.preview.state = 'applied';
          await this.save(journal);
          return structuredClone(journal.preview);
        } catch (error) {
          // 尚未写入任何工作区文件时，日志里的 committing 是唯一的副作用。
          // 直接还原为 previewed，并保留真实原因：既不能把补丁烧成 rolled_back，
          // 也不能用 PATCH_APPLY_FAILED 掩盖 APPROVAL_REQUIRED/POLICY_DENIED。
          if (wroteWorkspace === false && journal.preview.state === 'committing') {
            await this.rewind(journal);
            throw error;
          }
          try { await this.rollback(journal); }
          catch { journal.preview.state = 'unknown'; await this.save(journal).catch(() => undefined); }
          if (journal.preview.state === 'unknown') throw new BridgeError('PATCH_STATE_UNKNOWN', 409, '补丁状态不确定；未覆盖无法确认归属的文件，请检查本地工作区', { patch_id: id, state: 'unknown' });
          if (error instanceof BridgeError) throw new BridgeError(error.code, error.status, error.message, { patch_id: id, state: journal.preview.state });
          if (typeof (error as { code?: unknown })?.code === 'string') throw new BridgeError((error as { code: string }).code, Number((error as { status?: number }).status) || 500, error instanceof Error ? error.message : String(error), { patch_id: id, state: journal.preview.state });
          throw new BridgeError('PATCH_APPLY_FAILED', 500, '补丁提交失败，已回滚可确认的修改', { patch_id: id, state: journal.preview.state });
        }
      });
    } catch (error) {
      // 授权/策略类错误是调用方的可操作信号，必须原样透出；ioError 只负责兜住真正的 IO 故障。
      if (error instanceof BridgeError) throw error;
      if (typeof (error as { code?: unknown })?.code === 'string' && !(error instanceof Error && 'errno' in error)) {
        throw new BridgeError((error as { code: string }).code, Number((error as { status?: number }).status) || 500, error instanceof Error ? error.message : String(error), error instanceof Error ? undefined : undefined);
      }
      // ARENABRIDGE_TRACE_IO is a local diagnostic: the opaque IO_ERROR is correct for remote
      // callers, but it hides the errno from an operator debugging their own machine.
      if (process.env.ARENABRIDGE_TRACE_IO) {
        const e = error as NodeJS.ErrnoException;
        process.stderr.write(JSON.stringify({ trace: 'patch_apply_io', code: e?.code, errno: e?.errno, syscall: e?.syscall, path: e?.path, message: e?.message, stack: e?.stack?.split('\n').slice(0, 4) }) + '\n');
      }
      return ioError(error);
    }
  }

  async recover(): Promise<RecoveryReport> {
    try {
      await this.init();
      const directory = await fs.opendir(this.directory);
      const ids: string[] = [];
      let visited = 0;
      try {
        for (;;) {
          const entry = await directory.read();
          if (!entry) break;
          if (++visited > 1000) throw new BridgeError('RECOVERY_LIMIT', 413, '恢复日志数量超出本次扫描上限，需要本地维护');
          if (entry.isDirectory() && !entry.isSymbolicLink() && ID.test(entry.name)) ids.push(entry.name);
        }
      } finally { await directory.close(); }
      const recovered: PatchPreview[] = [];
      // 一个损坏的事务绝不能中断整次恢复：失败只记入 problems，后续 id 照常扫描。
      // 之前的 rethrow 会让排在前面的坏日志挡住后面所有 committing 日志的回滚。
      const problems: RecoveryProblem[] = [];
      for (const id of ids.sort()) {
        let initial: Journal;
        try { initial = await this.load(id); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // 目录存在但日志缺失 ⇒ prepare 失败的残骸，恢复扫描永远够不到它。尽力回收；
            // 内部会先做活性检查，进行中的 prepare 不会被误删（见 reapJournalLess 注释）。
            await this.reapJournalLess(id, problems);
            continue;
          }
          // 其他读取失败（损坏的日志等）只登记，不中断——该目录留给本地人工处理。
          problems.push({ patch_id: id, code: error instanceof BridgeError ? error.code : 'IO_ERROR', message: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (initial.preview.state !== 'committing') continue;
        try {
          await this.exclusive(initial.preview, async () => {
            const journal = await this.load(id);
            if (journal.preview.state !== 'committing') return;
            try { await this.rollback(journal); }
            catch { journal.preview.state = 'unknown'; await this.save(journal); }
            recovered.push(structuredClone(journal.preview));
          });
        } catch (error) {
          // PATCH_LOCKED（另一进程正在处理）与任何 IO/损坏错误都只是这**一个**事务的问题，
          // 其余事务照常处理。事务目录留在原地，等锁释放或人工处理后再由下次恢复接手。
          problems.push({ patch_id: id, code: error instanceof BridgeError ? error.code : 'IO_ERROR', message: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      return { recovered, problems };
    } catch (error) {
      // ioError 只负责**构造** BridgeError，它不抛。必须 return，否则引擎会把错误吞掉，
      // 对调用方返回 undefined——排障时看到的是一个没有 code 的 undefined，
      // 而不是本该得到的 IO_ERROR。
      if (error instanceof BridgeError) throw error;
      return ioError(error);
    }
  }
}
