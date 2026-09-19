/**
 * Verifies the two read-only workspace endpoints the desktop harndess depends on:
 *   GET /admin/v1/workspace/tree?path=.
 *   GET /admin/v1/workspace/file?path=<rel>
 *
 * These exist so the local operator can see the tree a patch will touch, and read a file
 * before approving a change to it. They must therefore read exactly what the MCP tools
 * read — no more — and must refuse the same paths. This probe asserts both halves:
 * the happy path returns content, and a sensitive path is still denied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemon } from '../dist/apps/daemon/src/server.js';
import { newSecret } from '../dist/packages/contracts/src/index.js';

// The path policy refuses to mount a workspace inside the OS temp directory (it is on the
// forbidden roots list), so the fixture has to live under the repo's outputs/ area, which is
// the location the rest of the probes use.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(repo, 'outputs', 'probe-workspace-view');
fs.rmSync(base, { recursive: true, force: true });
const root = path.join(base, 'workspace');
const state = path.join(base, 'state');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(root, 'README.md'), '# probe\nsecond line\n');
fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
fs.writeFileSync(path.join(root, '.env'), 'SECRET_TOKEN=should-never-be-readable\n');

const adminToken = newSecret();
const daemon = await createDaemon({
  schema_version: 1, state_directory: state,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root, display_name: 'probe' }],
  response_mode: 'json', security_profile: 'local_trusted_development', arena_enabled: false,
  remote_ingress: { enabled: false, acknowledge_exposure: false, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [], require_grant: true },
  gateway: { type: 'disabled' },
}, { adminToken, clientToken: newSecret(), mcpToken: newSecret() });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const get = async (route) => {
  const response = await fetch(daemon.urls.admin + route, { headers: { Authorization: `Bearer ${adminToken}` } });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
};

try {
  // --- no credential is still refused ------------------------------------------------
  const anon = await fetch(daemon.urls.admin + '/admin/v1/workspace/tree?path=.');
  check('the tree is refused without a credential', anon.status === 401 || anon.status === 403, `status ${anon.status}`);

  // --- directory listing --------------------------------------------------------------
  const tree = await get('/admin/v1/workspace/tree?path=.');
  check('the root listing succeeds', tree.status === 200, `status ${tree.status}`);
  const names = (tree.body.entries ?? []).map((e) => e.name).sort();
  check('the listing shows the real entries', names.includes('README.md') && names.includes('src'), names.join(', '));
  check('the listing marks directory vs file', tree.body.entries.find((e) => e.name === 'src')?.type === 'directory' && tree.body.entries.find((e) => e.name === 'README.md')?.type === 'file');

  const nested = await get('/admin/v1/workspace/tree?path=' + encodeURIComponent('src'));
  check('a nested listing succeeds', nested.status === 200 && (nested.body.entries ?? []).some((e) => e.name === 'index.ts'), `status ${nested.status}`);

  const missing = await get('/admin/v1/workspace/tree?path=' + encodeURIComponent('nope'));
  check('a missing directory reports NOT_FOUND', missing.status === 404 && missing.body?.error?.code === 'NOT_FOUND', JSON.stringify(missing.body?.error ?? missing.body));

  // --- file read ----------------------------------------------------------------------
  const file = await get('/admin/v1/workspace/file?path=' + encodeURIComponent('src/index.ts'));
  check('a file read succeeds', file.status === 200, `status ${file.status}`);
  check('the file content is returned verbatim', file.body.text === 'export const answer = 42;\n', JSON.stringify(file.body.text));
  check('the file carries a version hash', /^[a-f0-9]{64}$/.test(file.body.version_hash ?? ''), String(file.body.version_hash).slice(0, 12));

  // --- the same policy still applies ---------------------------------------------------
  const secret = await get('/admin/v1/workspace/file?path=' + encodeURIComponent('.env'));
  check('a sensitive path is still denied', secret.status === 403 && secret.body?.error?.code === 'PATH_DENIED', JSON.stringify(secret.body?.error ?? secret.body));

  const escape = await get('/admin/v1/workspace/file?path=' + encodeURIComponent('../outside.txt'));
  check('traversal is still denied', escape.status === 403, `status ${escape.status}`);

  const binary = path.join(root, 'blob.bin');
  fs.writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0x00]));
  const bin = await get('/admin/v1/workspace/file?path=' + encodeURIComponent('blob.bin'));
  check('binary data is refused, not garbled', bin.status === 422 && bin.body?.error?.code === 'BINARY_FILE', JSON.stringify(bin.body?.error ?? bin.body));
} finally {
  await daemon.close();
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll workspace-view endpoint checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
