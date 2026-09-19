#!/usr/bin/env node
/**
 * Owns the local loopback development credentials: creates them, or returns the existing ones.
 *
 * They live in `.arena-bridge/`, which git ignores and which holds secrets, so a fresh clone
 * never has them — while every local script needs them. Reading the file directly produced a bare
 * ENOENT naming something the reader had no way to produce; `ensureLocalCredentials()` is the one
 * place that decides whether they exist, so a reader never has to care.
 *
 * Never rotates an existing file. Rotating would invalidate an already-paired session, and a
 * caller that only wanted to read a token has no business doing that.
 *
 * Run directly to create them:  node scripts/gen-credentials.mjs   (npm run credentials)
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = {
  admin: 'http://127.0.0.1:48272/admin/v1/* and /bridge/v1/* (control plane)',
  api: 'http://127.0.0.1:48270/v1/* (model gateway)',
  mcp_local: 'http://127.0.0.1:48271/mcp (local MCP hosts, using mcp_token)',
  mcp_remote: 'the tunnel/public port uses a separate short-lived pairing grant; mcp_token is refused there',
};

/** Absolute path of the credentials file, for a given project root. */
export function localCredentialsPath(rootDirectory = root) {
  return path.join(rootDirectory, '.arena-bridge', 'local-credentials.json');
}

function readIfPresent(target) {
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch { return null; }
}

/**
 * Returns usable local credentials, creating or repairing the file as needed.
 *
 * Returns `{ path, credentials, created, upgraded }` so a caller can report which of the three
 * happened without parsing a message, and a probe can assert on it.
 */
export function ensureLocalCredentials(rootDirectory = root) {
  const target = localCredentialsPath(rootDirectory);
  const existing = readIfPresent(target);
  if (existing?.admin_token && existing?.api_token && existing?.mcp_token) {
    return { path: target, credentials: existing, created: false, upgraded: false };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (existing) {
    // A file written before mcp_token existed. Add that one key in place rather than rotating the
    // others, so an already-paired session is not invalidated.
    existing.mcp_token = randomBytes(32).toString('base64url');
    existing.usage = existing.usage ?? USAGE;
    existing.mcp_token_added_at = new Date().toISOString();
    fs.writeFileSync(target, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
    return { path: target, credentials: existing, created: false, upgraded: true };
  }
  const document = {
    purpose: 'Local loopback development credentials for ArenaBridge. NOT production. NOT an Arena/LMArena credential.',
    created_at: new Date().toISOString(),
    admin_token: randomBytes(32).toString('base64url'),
    api_token: randomBytes(32).toString('base64url'),
    // A dedicated credential for local MCP hosts (WorkBuddy, TRAE, editors) on the loopback MCP
    // port. It is not a grant: it never expires, and it only works on the local port, never on
    // the port a tunnel or public bind forwards to.
    mcp_token: randomBytes(32).toString('base64url'),
    usage: USAGE,
  };
  fs.writeFileSync(target, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
  return { path: target, credentials: document, created: true, upgraded: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = ensureLocalCredentials();
  const event = result.created ? 'credentials_created' : result.upgraded ? 'credentials_upgraded' : 'credentials_existing';
  const note = result.created
    ? 'Loopback only. Delete this file to rotate.'
    : result.upgraded
      ? 'Existing admin and API tokens were left unchanged.'
      : 'Not overwritten.';
  process.stdout.write(JSON.stringify({ event, file: path.relative(root, result.path), note }) + '\n');
}
