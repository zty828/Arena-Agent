import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { BridgeError, sha256 } from '../packages/contracts/src/index.js';
import { PatchEngine, WorkspaceFiles, WORKSPACE_LIMITS } from '../packages/workspace-tools/src/index.js';

async function fixture(t: TestContext): Promise<{ base: string; root: string; state: string; files: WorkspaceFiles }> {
  const data = path.resolve('.test-data');
  await fs.mkdir(data, { recursive: true });
  const base = await fs.mkdtemp(path.join(data, 'workspace-'));
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'workspace');
  await fs.mkdir(root);
  return { base, root, state: path.join(base, 'private-state'), files: await WorkspaceFiles.open(root) };
}
function update(relative: string, before: string, after: string): string {
  return `--- a/${relative}\n+++ b/${relative}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}
function create(relative: string, content: string): string {
  return `--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1 @@\n+${content}\n`;
}
async function unchanged(root: string, values: Record<string, string | null>): Promise<void> {
  for (const [name, expected] of Object.entries(values)) {
    if (expected === null) await assert.rejects(fs.lstat(path.join(root, name)), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(path.join(root, name), 'utf8'), expected);
  }
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.arena-tmp-')), false);
}

test('文件读取、分页、glob、字面量搜索与原始字节 SHA256', async t => {
  const { root, files } = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'a.txt'), 'Hello 世界\n第二行\n尾行');
  await fs.writeFile(path.join(root, 'src', 'b.ts'), 'hello.ts\nHELLO again\n');
  await fs.writeFile(path.join(root, 'src', 'c.js'), 'const dot = ".";\n');
  await fs.writeFile(path.join(root, 'empty.txt'), '');
  const read = await files.readFiles({ files: [{ path: 'a.txt' }, { path: 'a.txt', start_line: 2, end_line: 2 }, { path: 'empty.txt' }] });
  assert.equal(read.files[0]!.text, 'Hello 世界\n第二行\n尾行');
  assert.equal(read.files[0]!.version_hash, sha256('Hello 世界\n第二行\n尾行'));
  assert.equal(read.files[0]!.unsaved, false);
  assert.equal(read.files[1]!.text, '第二行\n');
  assert.equal(read.files[2]!.text, '');
  assert.equal(read.truncated, false);
  assert.equal(await files.hashFile('a.txt'), read.files[0]!.version_hash);
  assert.equal(await files.hashFile('missing.txt'), null);
  const first = await files.listDirectory({ limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.truncated, true);
  assert.equal(first.next_cursor, 1);
  const second = await files.listDirectory({ limit: 2, cursor: first.next_cursor! });
  assert.equal(second.entries.length, 2);
  assert.notEqual(second.entries[0]!.path, first.entries[0]!.path);
  assert.deepEqual((await files.findFiles({ globs: ['**/*.{ts,js}'] })).files, ['src/b.ts', 'src/c.js']);
  assert.deepEqual((await files.findFiles({ globs: ['**/*'], exclude: ['src/**'] })).files, ['a.txt', 'empty.txt']);
  assert.deepEqual((await files.findFiles({ root: 'src', globs: ['[bc].?s'] })).files, ['src/b.ts', 'src/c.js']);
  const foundFirst = await files.findFiles({ globs: ['**/*.txt'], limit: 1 });
  assert.deepEqual(foundFirst.files, ['a.txt']);
  assert.deepEqual((await files.findFiles({ globs: ['**/*.txt'], cursor: foundFirst.next_cursor! })).files, ['empty.txt']);
  const search = await files.searchFiles({ pattern: 'hello', limit: 2 });
  assert.deepEqual(search.matches.map(match => [match.path, match.line]), [['a.txt', 1], ['src/b.ts', 1]]);
  assert.equal(search.next_cursor, 2);
  assert.deepEqual((await files.searchFiles({ pattern: 'hello', cursor: search.next_cursor! })).matches.map(match => match.line), [2]);
  assert.equal((await files.searchFiles({ pattern: 'HELLO', case_sensitive: true })).matches.length, 1);
  assert.equal((await files.searchFiles({ root: 'src', pattern: '.', globs: ['*.js'] })).matches.length, 1);
  // Regex used to be refused outright (`UNSUPPORTED_REGEX`). It is implemented now, so what has to
  // hold instead is that it really matches, and that a bad pattern is a caller error rather than
  // a silently empty result.
  // The fixture holds "Hello 世界" (a.txt:1), "hello.ts" (src/b.ts:1) and "HELLO again" (src/b.ts:2),
  // so an anchored case-insensitive pattern matches all three and the anchored case-sensitive one
  // matches only the shouty line.
  const regex = await files.searchFiles({ pattern: '^hel+o', regex: true });
  assert.deepEqual(regex.matches.map(match => [match.path, match.line]), [['a.txt', 1], ['src/b.ts', 1], ['src/b.ts', 2]]);
  assert.equal((await files.searchFiles({ pattern: '^HEL+O', regex: true, case_sensitive: true })).matches.length, 1, 'case_sensitive still applies to regex');
  assert.deepEqual((await files.searchFiles({ pattern: '^const .*\\.\";$', regex: true })).matches.map(match => match.path), ['src/c.js']);
  await assert.rejects(files.searchFiles({ pattern: '([', regex: true }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(files.listDirectory({ limit: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(files.readFiles({ files: [{ path: 'a.txt', start_line: 2, end_line: 1 }] }), { code: 'INVALID_ARGUMENT' });
});

test('拒绝二进制及非 UTF-8 文本，并限制文件和返回文本大小', async t => {
  const { root, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(files.readFiles({ files: [{ path: 'binary.dat' }] }), { code: 'BINARY_FILE' });
  await assert.rejects(files.readFiles({ files: [{ path: 'invalid.txt' }] }), { code: 'UNSUPPORTED_ENCODING' });
  await assert.rejects(files.searchFiles({ pattern: 'a', globs: ['binary.dat'] }), { code: 'BINARY_FILE' });
  await assert.rejects(files.searchFiles({ pattern: 'a', globs: ['invalid.txt'] }), { code: 'UNSUPPORTED_ENCODING' });
  const text = '界'.repeat(100000) + '\r\n';
  await fs.writeFile(path.join(root, 'bounded.txt'), text);
  const read = await files.readFiles({ files: [{ path: 'bounded.txt' }] });
  assert.equal(read.truncated, true);
  assert.ok(Buffer.byteLength(read.files[0]!.text) <= WORKSPACE_LIMITS.outputBytes);
  assert.ok(!read.files[0]!.text.includes('\uFFFD'));
  assert.equal(read.files[0]!.version_hash, sha256(text));
  const search = await files.searchFiles({ pattern: '界', globs: ['bounded.txt'] });
  assert.equal(search.truncated, true);
  assert.ok(Buffer.byteLength(search.matches[0]!.text) <= 8192);
  await fs.writeFile(path.join(root, 'too-large.txt'), Buffer.alloc(WORKSPACE_LIMITS.fileBytes + 1, 97));
  await assert.rejects(files.readFiles({ files: [{ path: 'too-large.txt' }] }), { code: 'FILE_TOO_LARGE' });
});

test('拒绝穿越、绝对路径、UNC、ADS、设备名、保留名及敏感路径且不泄漏名字', async t => {
  const { root, files } = await fixture(t);
  for (const value of ['../secret', 'a/../b', 'a\\..\\b', '/etc/passwd', 'C:/secret', 'C:secret', '\\\\server\\share', '\\\\?\\C:\\file', 'a.txt:stream', 'a\0b', 'a\nb', 'NUL', 'con.txt', 'COM1.log', 'LPT¹', 'tail.', 'tail ', '.env', '.env.local', '.ssh/key', '.aws/config', '.git/config', '.workbuddy-ai/config', '.arena-bridge/state']) {
    await assert.rejects(files.resolve(value, { allowMissing: true }), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'PATH_DENIED');
      assert.equal(error.message.includes(value), false);
      return true;
    });
  }
  await fs.writeFile(path.join(root, 'public.txt'), 'public\n');
  await fs.writeFile(path.join(root, '.env.local'), 'private\n');
  for (const name of ['.git', '.ssh', '.aws', '.workbuddy-ai', '.arena-bridge']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'hidden.txt'), 'private\n');
  }
  assert.deepEqual((await files.listDirectory()).entries.map(entry => entry.name), ['public.txt']);
  assert.deepEqual((await files.findFiles({ globs: ['**/*'] })).files, ['public.txt']);
  assert.deepEqual((await files.searchFiles({ pattern: 'private' })).matches, []);
  await assert.rejects(WorkspaceFiles.open(os.homedir()), { code: 'PATH_DENIED' });
  await assert.rejects(WorkspaceFiles.open(path.parse(root).root), { code: 'PATH_DENIED' });
  await assert.rejects(WorkspaceFiles.open(path.join(os.homedir(), 'Desktop')), { code: 'PATH_DENIED' });
  await assert.rejects(WorkspaceFiles.open(`${root}${path.sep}..`), { code: 'PATH_DENIED' });
});

test('junction、符号链接与硬链接不可读取、遍历或用作工作区根', async t => {
  const { base, root, files } = await fixture(t);
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n');
  await fs.symlink(outside, path.join(root, 'junction-out'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.link(path.join(outside, 'secret.txt'), path.join(root, 'hardlink.txt'));
  await assert.rejects(files.resolve('junction-out/secret.txt'), { code: 'PATH_DENIED' });
  await assert.rejects(files.resolve('hardlink.txt'), { code: 'PATH_DENIED' });
  await assert.rejects(files.hashFile('hardlink.txt'), { code: 'PATH_DENIED' });
  await assert.rejects(WorkspaceFiles.open(path.join(root, 'junction-out')), { code: 'PATH_DENIED' });
  assert.deepEqual((await files.listDirectory()).entries, []);
  assert.deepEqual((await files.findFiles({ globs: ['**/*'] })).files, []);
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'symlink.txt'));
    await assert.rejects(files.resolve('symlink.txt'), { code: 'PATH_DENIED' });
  }
});

test('遍历深度和条目预算耗尽时明确截断，不返回伪造游标', async t => {
  const { root, files } = await fixture(t);
  let directory = root;
  for (let index = 0; index < WORKSPACE_LIMITS.depth + 3; index++) {
    directory = path.join(directory, 'nested'); await fs.mkdir(directory);
  }
  await fs.writeFile(path.join(directory, 'deep.txt'), 'hidden by depth\n');
  const result = await files.findFiles({ globs: ['**/*'] });
  assert.deepEqual(result.files, []);
  assert.equal(result.truncated, true);
  assert.equal(result.next_cursor, null);
});

test('第二个 hunk 不匹配时整批预检失败，之前文件及状态目录均未写入', async t => {
  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'first.txt'), 'old\n');
  await fs.writeFile(path.join(root, 'second.txt'), 'one\ntwo\nthree\nfour\n');
  const engine = new PatchEngine(files, state);
  const broken = '--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-one\n+ONE\n@@ -4 +4 @@\n-WRONG\n+FOUR\n';
  await assert.rejects(engine.prepare({ changes: [
    { path: 'first.txt', expected_hash: sha256('old\n'), patch: update('first.txt', 'old', 'new') },
    { path: 'second.txt', expected_hash: sha256('one\ntwo\nthree\nfour\n'), patch: broken },
  ] }), { code: 'INVALID_PATCH' });
  await unchanged(root, { 'first.txt': 'old\n', 'second.txt': 'one\ntwo\nthree\nfour\n' });
  await assert.rejects(fs.lstat(state), { code: 'ENOENT' });
});

test('精确 hunk 位置、数量、头部及无末换行标记，不接受删除或重命名', async t => {
  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'one\ntwo\none\n');
  const engine = new PatchEngine(files, state);
  for (const patch of [
    '--- a/file.txt\n+++ b/file.txt\n@@ -2 +2 @@\n-one\n+new\n',
    '--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1 @@\n-one\n+new\n',
    '--- a/file.txt\n+++ b/renamed.txt\n@@ -1 +1 @@\n-one\n+new\n',
    '--- a/file.txt\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-one\n-two\n-one\n',
    '--- a/file.txt\n+++ b/file.txt\n@@ -1 +2 @@\n-one\n+new\n',
    '--- a/file.txt\n+++ b/file.txt\n@@ -3 +3 @@\n-one\n\\ No newline at end of file\n+new\n',
  ]) await assert.rejects(engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('one\ntwo\none\n'), patch }] }), { code: 'INVALID_PATCH' });
  await unchanged(root, { 'file.txt': 'one\ntwo\none\n' });
  await assert.rejects(engine.prepare({ changes: Array.from({ length: 11 }, (_, index) => ({ path: `${index}.txt`, patch: create(`${index}.txt`, 'new'), expected_hash: null })) }), { code: 'INVALID_ARGUMENT' });
});

test('CRLF、BOM、中文空格路径和无末换行按字节保留', async t => {
  const { root, state, files } = await fixture(t);
  const name = '中文 空格.txt';
  const before = '\uFEFF第一行\r\n原内容\r\n最后一行';
  const after = '\uFEFF第一行\r\n新内容\r\n末行';
  await fs.writeFile(path.join(root, name), before);
  const read = await files.readFiles({ files: [{ path: name }] });
  assert.equal(read.files[0]!.text, before);
  assert.equal(read.files[0]!.bom, true);
  assert.equal(read.files[0]!.eol, 'CRLF');
  const diff = `--- a/${name}\n+++ b/${name}\n@@ -1,3 +1,3 @@\n 第一行\n-原内容\n-最后一行\n\\ No newline at end of file\n+新内容\n+末行\n\\ No newline at end of file\n`;
  const engine = new PatchEngine(files, state);
  const preview = await engine.prepare({ changes: [{ path: name, patch: diff, expected_hash: sha256(before) }] });
  assert.equal(preview.workspace_root_hash, sha256(files.root));
  assert.equal(preview.changes[0]!.after_hash, sha256(after));
  assert.equal(preview.state, 'previewed');
  assert.equal(await fs.readFile(path.join(root, name), 'utf8'), before);
  const applied = await engine.apply(preview.id, () => undefined);
  assert.equal(applied.state, 'applied');
  assert.deepEqual(await fs.readFile(path.join(root, name)), Buffer.from(after));
  assert.equal((await engine.get(preview.id)).digest, preview.digest);
});

test('创建和更新同批提交，首次工作区写入之前授权，返回预览不可改变私有日志', async t => {
  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'old.txt'), 'old\n');
  const engine = new PatchEngine(files, state);
  const preview = await engine.prepare({ changes: [
    { path: 'old.txt', expected_hash: sha256('old\n'), patch: update('old.txt', 'old', 'new') },
    { path: 'new.txt', expected_hash: null, patch: create('new.txt', 'created') },
  ] });
  const digest = preview.digest;
  preview.changes[0]!.path = 'tampered.txt';
  assert.equal((await engine.get(preview.id)).changes[0]!.path, 'old.txt');
  let calls = 0;
  const applied = await engine.apply(preview.id, () => {
    calls++;
    assert.deepEqual(readdirSync(root), ['old.txt']);
  });
  assert.equal(calls, 1);
  assert.equal(applied.digest, digest);
  assert.equal(applied.state, 'applied');
  await unchanged(root, { 'old.txt': 'new\n', 'new.txt': 'created\n' });
  await engine.apply(preview.id, () => { throw new Error('幂等返回不能再次写入或请求授权'); });
});

test('授权拒绝不会写工作区，包括暂存临时文件', async t => {
  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  let faults = 0;
  const engine = new PatchEngine(files, state, { fault: () => { faults++; } });
  const preview = await engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('old\n'), patch: update('file.txt', 'old', 'new') }] });
  await assert.rejects(engine.apply(preview.id, () => { throw new BridgeError('FORBIDDEN', 403, '拒绝授权'); }), { code: 'FORBIDDEN' });
  assert.equal(faults, 0);
  // 授权在任何写入之前执行，因此被拒只是回到可重试的 previewed，不能烧成终态，
  // 也不能用 PATCH_APPLY_FAILED 掩盖 FORBIDDEN。
  assert.equal((await engine.get(preview.id)).state, 'previewed');
  await unchanged(root, { 'file.txt': 'old\n' });
  // 操作者随后批准，同一个 patch_id 必须能成功提交。
  const applied = await engine.apply(preview.id, () => undefined);
  assert.equal(applied.state, 'applied');
  await unchanged(root, { 'file.txt': 'new\n' });
});

test('非 BridgeError 的授权拒绝也必须原样透出错误码，并被包装成 BridgeError', async t => {
  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  const engine = new PatchEngine(files, state);
  const preview = await engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('old\n'), patch: update('file.txt', 'old', 'new') }] });
  // 策略层抛出的错误可能不是 BridgeError，但仍带 code/status；不能被压成 IO_ERROR/PATCH_APPLY_FAILED。
  const denial = Object.assign(new Error('A matching, unexpired, unused local approval is required'), { code: 'APPROVAL_REQUIRED', status: 403 });
  await assert.rejects(engine.apply(preview.id, () => { throw denial; }), { code: 'APPROVAL_REQUIRED' });
  assert.equal((await engine.get(preview.id)).state, 'previewed');
  await unchanged(root, { 'file.txt': 'old\n' });
});

test('提交前全量版本检查，后续文件冲突不使首文件发生写入', async t => {  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'first.txt'), 'old\n');
  await fs.writeFile(path.join(root, 'second.txt'), 'old\n');
  const engine = new PatchEngine(files, state);
  const preview = await engine.prepare({ changes: ['first.txt', 'second.txt'].map(name => ({ path: name, expected_hash: sha256('old\n'), patch: update(name, 'old', 'new') })) });
  await fs.writeFile(path.join(root, 'second.txt'), 'manual\n');
  let authorizations = 0;
  await assert.rejects(engine.apply(preview.id, () => { authorizations++; }), { code: 'VERSION_CONFLICT' });
  assert.equal(authorizations, 0);
  assert.equal((await engine.get(preview.id)).state, 'previewed');
  await unchanged(root, { 'first.txt': 'old\n', 'second.txt': 'manual\n' });
  await assert.rejects(engine.prepare({ changes: [{ path: 'first.txt', expected_hash: null, patch: create('first.txt', 'new') }] }), { code: 'VERSION_CONFLICT' });
});

test('预览后变成硬链接时重新校验路径，不授权也不改外部文件', async t => {
  const { base, root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  const engine = new PatchEngine(files, state);
  const preview = await engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('old\n'), patch: update('file.txt', 'old', 'new') }] });
  await fs.link(path.join(root, 'file.txt'), path.join(base, 'linked.txt'));
  let authorized = false;
  await assert.rejects(engine.apply(preview.id, () => { authorized = true; }), { code: 'PATH_DENIED' });
  assert.equal(authorized, false);
  assert.equal(await fs.readFile(path.join(base, 'linked.txt'), 'utf8'), 'old\n');
});

test('不同实例以固定顺序锁定冲突批次，仅一个提交能够成功', async t => {
  const { base, root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'old\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'old\n');
  const left = new PatchEngine(files, state);
  const right = new PatchEngine(await WorkspaceFiles.open(root), path.join(base, 'other-state'));
  const first = await left.prepare({ changes: ['a.txt', 'b.txt'].map(name => ({ path: name, expected_hash: sha256('old\n'), patch: update(name, 'old', 'LEFT') })) });
  const second = await right.prepare({ changes: ['b.txt', 'a.txt'].map(name => ({ path: name, expected_hash: sha256('old\n'), patch: update(name, 'old', 'RIGHT') })) });
  let authorized = 0;
  const results = await Promise.allSettled([left.apply(first.id, () => { authorized++; }), right.apply(second.id, () => { authorized++; })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(authorized, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal((rejected as PromiseRejectedResult).reason.code, 'VERSION_CONFLICT');
  const a = await fs.readFile(path.join(root, 'a.txt'), 'utf8');
  const b = await fs.readFile(path.join(root, 'b.txt'), 'utf8');
  assert.equal(a, b);
  assert.ok(a === 'LEFT\n' || a === 'RIGHT\n');
});

for (const point of ['after_stage', 'before_rename', 'after_rename']) {
  for (const failIndex of [0, 1]) test(`${point}[${failIndex}] 故障回滚更新和新建文件`, async t => {
    const { root, state, files } = await fixture(t);
    await fs.writeFile(path.join(root, 'old.txt'), 'original\n');
    const engine = new PatchEngine(files, state, { fault: (at, index) => { if (at === point && index === failIndex) throw new Error('合成故障'); } });
    const preview = await engine.prepare({ changes: [
      { path: 'old.txt', expected_hash: sha256('original\n'), patch: update('old.txt', 'original', 'updated') },
      { path: 'created.txt', expected_hash: null, patch: create('created.txt', 'created') },
    ] });
    await assert.rejects(engine.apply(preview.id, () => undefined), { code: 'PATCH_APPLY_FAILED' });
    assert.equal((await engine.get(preview.id)).state, 'rolled_back');
    await unchanged(root, { 'old.txt': 'original\n', 'created.txt': null });
    assert.deepEqual(await engine.recover(), []);
  });
}

test('故障期间人工修改不被备份覆盖，结果为 unknown', async t => {
  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  const engine = new PatchEngine(files, state, { fault: async (point, index) => {
    if (point === 'after_rename' && index === 0) {
      await fs.writeFile(path.join(root, 'file.txt'), 'manual change\n');
      throw new Error('人工改动后的合成故障');
    }
  } });
  const preview = await engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('old\n'), patch: update('file.txt', 'old', 'new') }] });
  await assert.rejects(engine.apply(preview.id, () => undefined), { code: 'PATCH_STATE_UNKNOWN' });
  assert.equal((await engine.get(preview.id)).state, 'unknown');
  await unchanged(root, { 'file.txt': 'manual change\n' });
  assert.deepEqual(await engine.recover(), []);
});

function crashApply(root: string, state: string, id: string, point: string): void {
  const entry = new URL('../packages/workspace-tools/src/index.js', import.meta.url).href;
  const code = `
    const { WorkspaceFiles, PatchEngine } = await import(process.argv[1]);
    const files = await WorkspaceFiles.open(process.argv[2]);
    const engine = new PatchEngine(files, process.argv[3], {
      fault(point, index) { if (point === process.argv[5] && index === 0) process.exit(77); }
    });
    await engine.apply(process.argv[4], () => {});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, entry, root, state, id, point], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 77, child.stderr);
}
for (const point of ['after_stage', 'before_rename', 'after_rename']) test(`${point} 进程退出后从写前日志恢复，恢复可重复调用`, async t => {
  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  const engine = new PatchEngine(files, state);
  const preview = await engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('old\n'), patch: update('file.txt', 'old', 'new') }] });
  crashApply(root, state, preview.id, point);
  assert.equal((await engine.get(preview.id)).state, 'committing');
  const fresh = new PatchEngine(await WorkspaceFiles.open(root), state);
  const recovered = await fresh.recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.state, 'rolled_back');
  await unchanged(root, { 'file.txt': 'old\n' });
  assert.deepEqual(await fresh.recover(), []);
});

test('崩溃后人工编辑保持原样，恢复持久化 unknown', async t => {
  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  const engine = new PatchEngine(files, state);
  const preview = await engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('old\n'), patch: update('file.txt', 'old', 'new') }] });
  crashApply(root, state, preview.id, 'after_rename');
  await fs.writeFile(path.join(root, 'file.txt'), 'human\n');
  const recovered = await engine.recover();
  assert.equal(recovered[0]!.state, 'unknown');
  assert.equal((await engine.get(preview.id)).state, 'unknown');
  await unchanged(root, { 'file.txt': 'human\n' });
});

test('日志仅位于 stateDirectory/patches，工作区工具不暴露日志、备份或暂存名字', async t => {
  const { root, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  const state = path.join(root, '.local-state');
  const engine = new PatchEngine(files, state);
  const preview = await engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('old\n'), patch: update('file.txt', 'old', 'new') }] });
  assert.deepEqual(await fs.readdir(state), ['patches']);
  await assert.rejects(files.resolve(`.local-state/patches/${preview.id}/journal.json`), { code: 'PATH_DENIED' });
  const other = await WorkspaceFiles.open(root);
  assert.deepEqual((await other.listDirectory({ path: '.local-state' })).entries, []);
  assert.deepEqual((await files.findFiles({ globs: ['**/*'] })).files, ['file.txt']);
  assert.deepEqual((await files.searchFiles({ pattern: 'before_hash' })).matches, []);
  await assert.rejects(engine.get('../other'), { code: 'INVALID_ARGUMENT' });
  await engine.apply(preview.id, () => undefined);
});

test('共享状态目录中的跨进程提交锁不会让恢复或另一提交覆盖活跃事务', { timeout: 30000 }, async t => {
  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  const engine = new PatchEngine(files, state);
  const first = await engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('old\n'), patch: update('file.txt', 'old', 'first') }] });
  const second = await engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('old\n'), patch: update('file.txt', 'old', 'second') }] });
  const entry = new URL('../packages/workspace-tools/src/index.js', import.meta.url).href;
  const code = `
    const { WorkspaceFiles, PatchEngine } = await import(process.argv[1]);
    const engine = new PatchEngine(await WorkspaceFiles.open(process.argv[2]), process.argv[3], {
      async fault(point) {
        if (point === 'after_stage') {
          process.stdout.write('staged\\n');
          await new Promise(resolve => process.stdin.once('data', resolve));
          process.stdin.destroy();
        }
      }
    });
    await engine.apply(process.argv[4], () => {});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, entry, root, state, first.id], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let errors = '';
  child.stderr.on('data', chunk => { errors += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`子进程提前退出：${code} ${errors}`)));
    child.stdout.once('data', chunk => String(chunk).trim() === 'staged' ? resolve() : reject(new Error('子进程同步信号无效')));
  });
  let authorized = false;
  await assert.rejects(engine.apply(second.id, () => { authorized = true; }), { code: 'PATCH_LOCKED' });
  await assert.rejects(engine.recover(), { code: 'PATCH_LOCKED' });
  assert.equal(authorized, false);
  const finished = once(child, 'exit');
  child.stdin.end('continue');
  const [codeResult] = await finished;
  assert.equal(codeResult, 0, errors);
  assert.equal((await engine.get(first.id)).state, 'applied');
  await unchanged(root, { 'file.txt': 'first\n' });
});

test('误传异步授权时仍等待拒绝结果，不提前写入', async t => {
  const { root, state, files } = await fixture(t);
  const engine = new PatchEngine(files, state);
  const preview = await engine.prepare({ changes: [{ path: 'new.txt', expected_hash: null, patch: create('new.txt', 'new') }] });
  await assert.rejects(engine.apply(preview.id, async () => {
    await Promise.resolve();
    throw new BridgeError('FORBIDDEN', 403, '异步拒绝');
  }), { code: 'FORBIDDEN' });
  await unchanged(root, { 'new.txt': null });
});

test('备份损坏在提交前拒绝，不发生授权或工作区写入', async t => {
  const { root, state, files } = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  const engine = new PatchEngine(files, state);
  const preview = await engine.prepare({ changes: [{ path: 'file.txt', expected_hash: sha256('old\n'), patch: update('file.txt', 'old', 'new') }] });
  await fs.writeFile(path.join(state, 'patches', preview.id, 'before-0.bin'), 'broken\n');
  let authorizations = 0;
  await assert.rejects(engine.apply(preview.id, () => { authorizations++; }), { code: 'INVALID_PATCH_STATE' });
  assert.equal(authorizations, 0);
  await unchanged(root, { 'file.txt': 'old\n' });
});
