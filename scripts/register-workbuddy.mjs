#!/usr/bin/env node
/**
 * Registers the local ArenaBridge MCP endpoint with WorkBuddy.
 *
 * WorkBuddy runs on this machine, so it talks to the loopback MCP listener and needs
 * no tunnel, no public address and no pairing handshake. It authenticates with the
 * dedicated mcp_token, which only works on the local listener; the listener a tunnel
 * forwards to refuses that credential outright.
 *
 * The existing configuration is backed up before anything is written, and every other
 * server entry is preserved untouched.
 *
 * Usage:
 *   node scripts/register-workbuddy.mjs            # add or update the entry
 *   node scripts/register-workbuddy.mjs --remove   # take it back out
 *   node scripts/register-workbuddy.mjs --print    # show what would be written
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLocalConfig } from './ensure-local-config.mjs';
import { ensureLocalCredentials } from './gen-credentials.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Both local-state files are generated on demand, for the same reason the other local scripts do
// it: one records absolute paths and the other holds secrets, so neither can be committed and a
// fresh clone has no way to produce them.
ensureLocalConfig(root);
const configFile = path.join(os.homedir(), '.workbuddy-ai', 'mcp.json');
const baseConfigFile = path.join(root, 'outputs', 'run-local.config.json');
const SERVER_NAME = 'arenabridge';

const remove = process.argv.includes('--remove');
const printOnly = process.argv.includes('--print');

const { credentials } = ensureLocalCredentials(root);
const base = JSON.parse(fs.readFileSync(baseConfigFile, 'utf8'));
const port = base.ports?.mcp ?? 48271;
const endpoint = `http://127.0.0.1:${port}/mcp`;

let document = { mcpServers: {} };
if (fs.existsSync(configFile)) {
  try {
    document = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    console.error(`${configFile} is not valid JSON (${error.message}). Nothing was changed.`);
    process.exit(1);
  }
}
document.mcpServers ??= {};
const existingNames = Object.keys(document.mcpServers);

if (remove) {
  if (!document.mcpServers[SERVER_NAME]) {
    console.log(`${SERVER_NAME} is not registered. Nothing to remove.`);
    process.exit(0);
  }
  delete document.mcpServers[SERVER_NAME];
  if (!printOnly) {
    fs.writeFileSync(configFile, JSON.stringify(document, null, 2) + '\n');
    console.log(`Removed ${SERVER_NAME} from ${configFile}. Other servers untouched: ${Object.keys(document.mcpServers).join(', ') || '(none)'}`);
  } else {
    console.log(JSON.stringify(document, null, 2));
  }
  process.exit(0);
}

if (!credentials.mcp_token) {
  console.error('The credential file has no mcp_token. Run: node scripts/gen-credentials.mjs (it will add one without rotating the others)');
  process.exit(1);
}

// Verify the bridge is actually listening before writing a config that would fail.
let reachable = false;
try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.mcp_token}`,
      // The modern era requires the method in a header as well as the body.
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/list',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => ({}));
  reachable = response.ok && Array.isArray(body?.result?.tools);
  if (!reachable) console.warn(`Warning: the bridge answered HTTP ${response.status}${body?.error?.message ? ' (' + body.error.message + ')' : ''}. Start it with "npm run local" first.`);
  else console.log(`The bridge is running and exposes ${body.result.tools.length} tools.`);
} catch (error) {
  console.warn(`Warning: could not reach ${endpoint} (${error.cause?.code ?? error.message}). Start it first with: npm run local`);
}

document.mcpServers[SERVER_NAME] = {
  type: 'http',
  url: endpoint,
  headers: { Authorization: `Bearer ${credentials.mcp_token}` },
  description: 'ArenaBridge local workspace MCP (loopback only, audited, writes require explicit approval)',
};
// Keep the file readable by grouping the new entry last.
const ordered = {};
for (const [name, value] of Object.entries(document.mcpServers)) if (name !== SERVER_NAME) ordered[name] = value;
ordered[SERVER_NAME] = document.mcpServers[SERVER_NAME];
document.mcpServers = ordered;

if (printOnly) {
  console.log(JSON.stringify(document, null, 2));
  process.exit(0);
}

fs.mkdirSync(path.dirname(configFile), { recursive: true });
if (fs.existsSync(configFile)) {
  const backup = `${configFile}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(configFile, backup);
  console.log(`Backed up the previous config to ${path.relative(os.homedir(), backup)}`);
}
fs.writeFileSync(configFile, JSON.stringify(document, null, 2) + '\n');

console.log('');
console.log('Registered the ArenaBridge MCP server with WorkBuddy.');
console.log(`  config   ${configFile}`);
console.log(`  endpoint ${endpoint}`);
console.log(`  auth     mcp_token (loopback only; the tunnel listener refuses it)`);
console.log(`  servers  ${existingNames.filter((name) => name !== SERVER_NAME).join(', ') || '(none)'} + ${SERVER_NAME}`);
console.log(`  reachable now: ${reachable ? 'yes' : 'no (start the bridge first)'}`);
console.log('');
console.log('Next:');
console.log('  1. Start the bridge: npm run local');
console.log('  2. Open the connector management page in WorkBuddy, find the custom connectors');
console.log('     entry at the top right, and click "Trust" on arenabridge.');
console.log('  3. The workspace tools then appear. Writes still require explicit local approval.');
console.log('');
console.log(`To undo: node scripts/register-workbuddy.mjs --remove`);
