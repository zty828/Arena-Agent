import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sample = '中文测试 ABC http://[2409::1]:48271/mcp 引号"与换行\n第二行 END';
const utf8File = path.join(root, 'outputs', 'clip-test.txt');
fs.writeFileSync(utf8File, sample, 'utf8');
const readbackFile = path.join(root, 'outputs', 'clip-readback.txt');
const ps = (command) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30000, windowsHide: true });

// Read the clipboard through a UTF-8 file so console codepage never touches the data.
function readBack() {
  const result = ps(`Get-Clipboard -Raw | Set-Content -LiteralPath '${readbackFile}' -Encoding UTF8`);
  if (result.status !== 0) return { ok: false, note: (result.stderr ?? '').trim().slice(0, 200) };
  try { return { ok: true, text: fs.readFileSync(readbackFile, 'utf8').replace(/^\uFEFF/, '') }; }
  catch (error) { return { ok: false, note: error.message }; }
}

function attempt(name, setter) {
  const set = setter();
  const back = readBack();
  const normalized = back.ok ? back.text.replace(/\r\n/g, '\n').replace(/\n$/, '') : '';
  console.log(`--- ${name} ---`);
  console.log(`  set exit: ${set.status}${set.error ? ' ' + set.error.message : ''}${set.stderr ? ' ' + String(set.stderr).trim().slice(0, 160) : ''}`);
  console.log(`  readback : ${JSON.stringify(normalized.slice(0, 70))}`);
  console.log(`  MATCH    : ${normalized === sample}`);
  return normalized === sample;
}

const results = {};
results.clipUtf8 = attempt('A) clip.exe, UTF-8 bytes on stdin (current approach)', () =>
  spawnSync('clip', { input: sample, encoding: 'utf8', timeout: 10000, windowsHide: true }));

results.clipUtf16 = attempt('B) clip.exe, UTF-16LE BOM file on stdin', () => {
  const file = path.join(root, 'outputs', 'clip-test-utf16.txt');
  fs.writeFileSync(file, '\uFEFF' + sample, 'utf16le');
  return spawnSync('clip', { input: fs.readFileSync(file), timeout: 10000, windowsHide: true });
});

results.setClipboard = attempt('C) PowerShell Set-Clipboard from a UTF-8 file', () =>
  ps(`Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath '${utf8File.replace(/'/g, "''")}')`));

console.log('\nsummary:', JSON.stringify(results));
