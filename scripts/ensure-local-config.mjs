#!/usr/bin/env node
/**
 * Creates the local development config when it is missing.
 *
 * `outputs/run-local.config.json` is a prerequisite for every local script — `npm run local`,
 * `serve`, `workbuddy`, `arena:*`, the tunnel diagnostics — but it cannot live in the repository:
 * it records absolute paths, so a copy taken on another machine would point at directories that
 * do not exist, and `outputs/` is ignored anyway. That combination meant a fresh clone failed
 * with a bare `ENOENT` on the first development command, naming a file the reader had no way to
 * produce. Generating it on demand is the fix.
 *
 * It never overwrites. An existing config is the operator's — silently rewriting the gateway
 * backend or the mounted workspace would be a worse failure than the missing file it replaced.
 *
 * The defaults are the safe ones: a mock gateway (no network, no cost, not a model) and the
 * synthetic fixture as the mounted workspace, so nothing real is exposed before the operator
 * deliberately points it somewhere else.
 *
 * Run directly to create it:  node scripts/ensure-local-config.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path of the local development config, for a given project root. */
export function localConfigPath(rootDirectory) {
  return path.join(rootDirectory, 'outputs', 'run-local.config.json');
}

/**
 * Writes the local config if it does not exist yet.
 *
 * Returns `{ path, created }` so a caller can say which of the two happened, and a probe can
 * assert both without parsing a message.
 */
export function ensureLocalConfig(rootDirectory = root) {
  const target = localConfigPath(rootDirectory);
  if (fs.existsSync(target)) return { path: target, created: false };
  const config = {
    schema_version: 1,
    // Kept beside the project rather than in the OS temp directory: the path policy refuses to
    // mount a workspace under temp, and a state directory that survives a reboot is easier to
    // reason about when a lock looks stale.
    state_directory: path.join(rootDirectory, '.arena-bridge', 'run'),
    ports: { api: 48270, mcp: 48271, admin: 48272 },
    workspaces: [{ root: path.join(rootDirectory, 'outputs', 'synthetic-workspace'), display_name: 'synthetic-workspace' }],
    response_mode: 'json',
    security_profile: 'local_trusted_development',
    arena_enabled: false,
    // Written out explicitly rather than left to the schema default, because "is this bridge
    // reachable from outside?" is the question an operator most needs a definite answer to, and
    // the smoke test asserts on this key being present and false.
    remote_ingress: {
      enabled: false,
      acknowledge_exposure: false,
      bind_address: '127.0.0.1',
      allow_cidrs: [],
      allowed_hosts: [],
      require_grant: true,
    },
    gateway: { type: 'mock', acknowledge_mock: true, alias: 'mock-agent-local', scenario: 'echo' },
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 'wx' so two concurrent callers cannot both believe they created it, and so a file that
  // appeared between the check and the write is never clobbered.
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  return { path: target, created: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = ensureLocalConfig();
  process.stdout.write(JSON.stringify({ config: path.relative(root, result.path), created: result.created }) + '\n');
}
