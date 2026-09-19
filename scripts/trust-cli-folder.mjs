#!/usr/bin/env node
/**
 * Manages the CodeBuddy CLI's folder-trust list.
 *
 * The CLI prompts "Do you trust the files in this folder?" before it will work in a
 * directory. That is fine interactively but blocks headless dispatch, so this
 * pre-answers it. The mechanism, read out of the CLI bundle:
 *
 *   trustAll = settingsManager.get("trustAll")
 *   trustedDirectories = settingsManager.get("trustedDirectories")
 *   needsAuthorization(path) = !(trustAll || trustedDirectories.some(match(path)))
 *
 * Settings live in ~/.codebuddy/settings.json (the desktop app uses ~/.workbuddy).
 * This script always backs up first and preserves every other key.
 *
 *   node scripts/trust-cli-folder.mjs --list
 *   node scripts/trust-cli-folder.mjs --add <folder> [--recursive]
 *   node scripts/trust-cli-folder.mjs --remove <folder>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const settingsPath = path.join(os.homedir(), '.codebuddy', 'settings.json');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

function read() {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try { return JSON.parse(raw); }
  catch (error) { console.error(`Refusing to touch ${settingsPath}: it is not valid JSON (${error.message}).`); process.exit(1); }
}

function write(settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  if (fs.existsSync(settingsPath)) {
    const backup = `${settingsPath}.bak-${Date.now()}`;
    fs.copyFileSync(settingsPath, backup);
    console.log(`backup: ${backup}`);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`wrote : ${settingsPath}`);
}

const settings = read();
const current = Array.isArray(settings.trustedDirectories) ? settings.trustedDirectories : [];

if (flag('--list') || args.length === 0) {
  console.log(JSON.stringify({
    settings_path: settingsPath,
    exists: fs.existsSync(settingsPath),
    trustAll: settings.trustAll ?? false,
    trustedDirectories: current,
    note: 'A directory ending in /** trusts that folder and everything under it.',
  }, null, 2));
  process.exit(0);
}

if (flag('--add')) {
  const target = valueOf('--add');
  if (!target) { console.error('--add needs a folder'); process.exit(1); }
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) { console.error(`not a directory: ${resolved}`); process.exit(1); }
  const entry = flag('--recursive') ? `${resolved.replace(/[\\/]+$/, '')}/**` : resolved;
  if (current.includes(entry)) { console.log(`already trusted: ${entry}`); process.exit(0); }
  write({ ...settings, trustedDirectories: [...current, entry] });
  console.log(`added: ${entry}`);
  process.exit(0);
}

if (flag('--remove')) {
  const target = valueOf('--remove');
  if (!target) { console.error('--remove needs a folder'); process.exit(1); }
  const resolved = path.resolve(target);
  const next = current.filter((entry) => entry !== resolved && entry !== `${resolved.replace(/[\\/]+$/, '')}/**`);
  if (next.length === current.length) { console.log(`not in the list: ${resolved}`); process.exit(0); }
  write({ ...settings, trustedDirectories: next });
  console.log(`removed: ${resolved}`);
  process.exit(0);
}

console.error('usage: --list | --add <folder> [--recursive] | --remove <folder>');
process.exit(1);
