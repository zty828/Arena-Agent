/**
 * Does the sandbox client read a tool result correctly?
 *
 * Reported by a remote agent: `agent-check` in client/arena_sandbox_client.py saw zero files
 * against a non-empty workspace, and proposed that the bridge (a) wraps payloads in a
 * `{ok, data, metadata}` envelope and (b) marks directories with `type`. Both are true of the
 * bridge, so the client was wrong, not the server.
 *
 * The wrong reads are silent by construction: `structured.get("entries")` on the envelope
 * level returns `None`, and `e.get("kind")` is `None` for every entry, so a full directory
 * listing renders as "no files" with no error anywhere. That is why this needs a guard.
 *
 * Two things are asserted, and both matter:
 *   1. the OLD reads really do collapse a real payload to an empty list (the bug existed), and
 *   2. the NEW reads return the real files (the fix works).
 * Asserting only (2) cannot tell "fixed" from "this path was never exercised".
 *
 * A child process cannot talk to a daemon owned by this process in the build sandbox, so the
 * client's real functions are imported and fed a payload captured verbatim from a live daemon.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createDaemon } = await import(pathToFileURL(path.join(root, 'dist', 'apps', 'daemon', 'src', 'server.js')).href);

let failures = 0;
const check = (ok, message) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
};

const clientPath = path.join(root, 'client', 'arena_sandbox_client.py');

// ---------------------------------------------------------------------------
// 1) Capture a real tools/call result from a live daemon, with a known workspace.
// ---------------------------------------------------------------------------
// The workspace policy denies paths outside the repository, so the fixture lives under
// `.test-data/` (the same place the other probes put theirs) rather than in the OS temp dir.
const fixtureRoot = path.join(root, '.test-data');
fs.mkdirSync(fixtureRoot, { recursive: true });
const workspace = fs.mkdtempSync(path.join(fixtureRoot, 'client-ws-'));
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'readme.md'), '# hi\n');
fs.writeFileSync(path.join(workspace, 'sum.mjs'), 'export default 1\n');
fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-client-state-'));
const mcpToken = 'c'.repeat(48);
const daemon = await createDaemon({
  schema_version: 1,
  state_directory: stateDir,
  ports: { api: 0, mcp: 0, mcp_remote: 0, admin: 0 },
  workspaces: [{ root: workspace, display_name: 'client-check' }],
  response_mode: 'json',
  security_profile: 'local_trusted_development',
  arena_enabled: false,
  remote_ingress: { enabled: false, acknowledge_exposure: false, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [], require_grant: true },
  gateway: { type: 'disabled' },
}, { adminToken: 'a'.repeat(48), clientToken: 'b'.repeat(48), mcpToken });

const MODERN = '2026-07-28';
let sequence = 0;
const rpc = async (method, params, extraHeaders = {}) => {
  sequence += 1;
  const response = await fetch(daemon.urls.mcp + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mcpToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN,
      'Mcp-Method': method,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: sequence, method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'client-check', version: '1.0.0' },
        },
      },
    }),
  });
  return response.json();
};

let captured;
try {
  const result = await rpc('tools/call', { name: 'list_directory', arguments: { path: '.' } }, { 'Mcp-Name': 'list_directory' });
  captured = result?.result;
} finally {
  await daemon.close();
}

check(!!captured, 'a real tools/call result was captured from the daemon');
check(captured?.structuredContent?.data?.entries?.length === 3,
  `the captured payload really carries 3 entries (got ${captured?.structuredContent?.data?.entries?.length})`);

// Record the shape so a future change to the envelope is a visible failure, not a silent one.
const envelopeKeys = Object.keys(captured?.structuredContent ?? {}).sort().join(',');
check(envelopeKeys === 'data,metadata,ok', `structuredContent is the {ok, data, metadata} envelope (got "${envelopeKeys}")`);
const entryFields = Object.keys(captured?.structuredContent?.data?.entries?.[0] ?? {}).sort().join(',');
check(entryFields.includes('type'), `directory entries carry a "type" field (got "${entryFields}")`);

// ---------------------------------------------------------------------------
// 2) Feed that payload through the client's REAL functions.
// ---------------------------------------------------------------------------
const captureFile = path.join(stateDir, 'captured.json');
fs.writeFileSync(captureFile, JSON.stringify(captured ?? null));

const replay = `
import importlib.util, json, sys

spec = importlib.util.spec_from_file_location("abc_client", r"${clientPath}")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

with open(r"${captureFile}", encoding="utf-8") as handle:
    captured = json.load(handle)

structured = mod.structured_of(captured)
data = mod.unwrap(structured)
entries = data.get("entries") or []
files = [e for e in entries if not mod.is_directory(e)]
textish = [e for e in files if mod.TEXT_FILE.search(str(e.get("name") or ""))]

# The old reads, on this same payload: what the agent actually experienced.
old_files = [e for e in (structured.get("entries") or []) if e.get("kind") != "directory"]

# --- pair-request must hand back everything the next step needs -------------------
# A sandbox that resets /tmp loses the state file, and with it the claim secret. The agent can
# only carry on if this response prints the value, so it is asserted on the real function with
# the transport stubbed out (the transport itself is exercised elsewhere in this probe).
import contextlib, io, os, time, types

# The endpoint is only read to build the request URL, and the transport below is stubbed, so a
# placeholder is enough — but it has to be set or base_url() exits before anything is printed.
os.environ["ARENABRIDGE_URL"] = "http://127.0.0.1:1"
# Keep the client's own state file out of the repository: save_state() writes wherever the
# module global points, and the probe's working directory is the project root.
mod.STATE_FILE = r"${path.join(stateDir, 'probe-state.json')}"
mod.http_json = lambda method, url, body=None, headers=None, attempts=None: (
    200, {"pair_id": "pair_test", "claim_secret": "secret_test", "state": "pending"})
buffer = io.StringIO()
with contextlib.redirect_stdout(buffer):
    mod.do_pair_request(types.SimpleNamespace(code="-abc", label="probe", access_mode="code"))
printed = json.loads(buffer.getvalue().strip())

# --- pair-claim must hand back the token, and say how long it lasts ------------------
# Two separate reports from a real run: the token was written only to the state file (so a
# sandbox that discards /tmp loses the credential outright), and the grant deadline was only a
# bare epoch (which the caller read as "months away" when it was 40 minutes off).
mod.http_json = lambda method, url, body=None, headers=None, attempts=None: (
    200, {"state": "approved", "token": "tok_test", "grant_id": "grant_1", "run_id": "run_1",
          "workspace_id": "ws_1", "workspace_name": "w", "access_mode": "code",
          "scopes": ["workspace:read"], "execution_owner": "remote_workspace",
          "challenge": "chal_test", "expires_at": int(time.time() * 1000) + 3600 * 1000})
buffer = io.StringIO()
with contextlib.redirect_stdout(buffer):
    mod.do_pair_claim(types.SimpleNamespace(pair_id="pair_test", claim_secret="secret_test"))
claimed = json.loads(buffer.getvalue().strip())
now_ms = int(time.time() * 1000)
readable = {
    "half_hour": mod.expires_in(now_ms + 30 * 60 * 1000 + 30000),
    "past": mod.expires_in(now_ms - 1000),
    "missing": mod.expires_in(None),
    # Session-scoped: the sentinel must not be rendered as a date, and must not be described as
    # "never expires" either — the session ending is what ends it.
    "session": mod.expires_in(mod.NO_EXPIRY_AT),
}

# --- agent-check against a workspace whose root holds only directories -------------------
# The operator's workspace had a single folder and no files at the root. agent-check reported
# file_count 0 with an empty first_text_files, and the remote agent — whose step 7 is "read the
# first entry of first_text_files" — concluded the workspace was empty. There were two separate
# causes and both are asserted below: it never completed the challenge handshake, so the listing
# itself was refused (AUTHORIZATION_REQUIRED), and it only ever looked at the root.
seen_calls = []


def agent_http(method, url, body=None, headers=None, attempts=None):
    params = (body or {}).get("params") or {}
    name = params.get("name") or (body or {}).get("method")
    seen_calls.append({"name": name, "arguments": params.get("arguments")})
    if name == "tools/list":
        return 200, {"jsonrpc": "2.0", "id": 1, "result": {"tools": [{"name": "list_directory"}, {"name": "read_files"}, {"name": "run_command"}]}}
    if name == "bridge_health":
        return 200, {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": {"ok": True, "data": {"access_mode": "exec", "expires_at": mod.NO_EXPIRY_AT}, "metadata": {}}}}
    path = (params.get("arguments") or {}).get("path")
    entries = [{"name": "src", "path": "src", "type": "directory"},
               {"name": "docs", "path": "docs", "type": "directory"}]
    if path == "src":
        entries = [{"name": "main.ts", "path": "src/main.ts", "type": "file", "size": 12}]
    return 200, {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": {"ok": True, "data": {"entries": entries, "truncated": False}, "metadata": {}}}}


mod.http_json = agent_http
agent_buffer = io.StringIO()
with contextlib.redirect_stdout(agent_buffer):
    mod.do_agent()
agent_text = agent_buffer.getvalue()
agent_docs = []
agent_depth, agent_start = 0, -1
for agent_index, agent_char in enumerate(agent_text):
    if agent_char == "{":
        if agent_depth == 0:
            agent_start = agent_index
        agent_depth += 1
    elif agent_char == "}":
        agent_depth -= 1
        if agent_depth == 0 and agent_start >= 0:
            try:
                agent_docs.append(json.loads(agent_text[agent_start:agent_index + 1]))
            except ValueError:
                pass
            agent_start = -1
agent_listing = next((doc for doc in agent_docs if "first_text_files" in doc), {})


def agent_http_nothing_readable(method, url, body=None, headers=None, attempts=None):
    params = (body or {}).get("params") or {}
    name = params.get("name") or (body or {}).get("method")
    if name == "tools/list":
        return 200, {"jsonrpc": "2.0", "id": 1, "result": {"tools": [{"name": "list_directory"}]}}
    if name == "bridge_health":
        return 200, {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": {"ok": True, "data": {"access_mode": "ask"}, "metadata": {}}}}
    path = (params.get("arguments") or {}).get("path")
    if path == ".":
        entries = [{"name": "assets", "path": "assets", "type": "directory"}]
    else:
        entries = [{"name": "logo.png", "path": "assets/logo.png", "type": "file", "size": 2048}]
    return 200, {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": {"ok": True, "data": {"entries": entries, "truncated": False}, "metadata": {}}}}


mod.http_json = agent_http_nothing_readable
empty_buffer = io.StringIO()
with contextlib.redirect_stdout(empty_buffer):
    mod.do_agent()
empty_text = empty_buffer.getvalue()
empty_docs = []
empty_depth, empty_start = 0, -1
for empty_index, empty_char in enumerate(empty_text):
    if empty_char == "{":
        if empty_depth == 0:
            empty_start = empty_index
        empty_depth += 1
    elif empty_char == "}":
        empty_depth -= 1
        if empty_depth == 0 and empty_start >= 0:
            try:
                empty_docs.append(json.loads(empty_text[empty_start:empty_index + 1]))
            except ValueError:
                pass
            empty_start = -1
empty_listing = next((doc for doc in empty_docs if "first_text_files" in doc), {})
agent_health = next((call for call in seen_calls if call["name"] == "bridge_health"), {})
agent_paths = [call["arguments"].get("path") for call in seen_calls if call["name"] == "list_directory"]

print(json.dumps({
    "agent_check": {
        "health_challenge": (agent_health.get("arguments") or {}).get("challenge"),
        "listed_paths": agent_paths,
        "first_text_files": agent_listing.get("first_text_files"),
        "directory_names": agent_listing.get("directory_names"),
        "searched": agent_listing.get("subdirectories_searched"),
        "note": agent_listing.get("note"),
        "empty_root_note": empty_listing.get("note"),
        "empty_root_files": empty_listing.get("first_text_files"),
        "empty_root_directories": empty_listing.get("directory_names"),
    },
    "new_file_names": [e["name"] for e in files],
    "new_text_paths": [e.get("path") or e.get("name") for e in textish[:5]],
    "new_directory_count": len(entries) - len(files),
    "old_file_count": len(old_files),
    "is_dir_type": mod.is_directory({"type": "directory"}),
    "is_dir_kind": mod.is_directory({"kind": "dir"}),
    "is_file": mod.is_directory({"type": "file"}),
    "text_only_entries": len((mod.unwrap(mod.structured_of({"content": captured["content"]})) or {}).get("entries") or []),
    "printed_claim_secret": printed.get("claim_secret"),
    "printed_pair_id": printed.get("pair_id"),
    "claimed_token": claimed.get("token"),
    "claimed_expires_in": claimed.get("expires_in"),
    "claimed_next": claimed.get("next"),
    "readable": readable,
}))
`;

let observed;
let replayError = '';
try {
  observed = JSON.parse(execFileSync(process.env.PYTHON ?? 'python', ['-c', replay], { encoding: 'utf8' }));
} catch (error) {
  replayError = String(error.stdout ?? error.message).slice(0, 400);
}

check(!!observed, `the client's real functions run against the captured payload ${replayError}`);

// The bug, on the record: the old reads returned nothing at all from a 3-entry listing.
check(observed?.old_file_count === 0,
  `the OLD reads collapse this payload to an empty list, which is exactly what was reported (got ${observed?.old_file_count})`);

// The fix.
check(JSON.stringify(observed?.new_file_names) === JSON.stringify(['readme.md', 'sum.mjs']),
  `the NEW reads return the real files (got ${JSON.stringify(observed?.new_file_names)})`);
check(observed?.new_directory_count === 1,
  `the NEW reads count the real directories (got ${observed?.new_directory_count})`);
check(JSON.stringify(observed?.new_text_paths) === JSON.stringify(['readme.md', 'sum.mjs']),
  `first_text_files is what the agent should report (got ${JSON.stringify(observed?.new_text_paths)})`);

check(observed?.is_dir_type === true, 'a "type: directory" entry is recognised as a directory');
check(observed?.is_dir_kind === true, 'a legacy "kind: dir" entry is still recognised');
check(observed?.is_file === false, 'a "type: file" entry is not treated as a directory');
check(observed?.text_only_entries === 3,
  `a transport that sends only text content is still unwrapped (got ${observed?.text_only_entries})`);
// A sandbox that resets /tmp takes the state file with it. pair-claim can still run only if
// these two values were printed, so they are asserted on the real function's real output.
check(observed?.printed_pair_id === 'pair_test',
  `pair-request prints the pair_id the next step must pass (got ${JSON.stringify(observed?.printed_pair_id)})`);
check(observed?.printed_claim_secret === 'secret_test',
  `pair-request prints the claim_secret, so a wiped state file is survivable (got ${JSON.stringify(observed?.printed_claim_secret)})`);
check(observed?.claimed_token === 'tok_test',
  `pair-claim prints the grant token, not just the state file it went to (got ${JSON.stringify(observed?.claimed_token)})`);
check(typeof observed?.claimed_expires_in === 'string' && !['unknown', 'expired'].includes(observed.claimed_expires_in),
  `pair-claim states the remaining life in words (got ${JSON.stringify(observed?.claimed_expires_in)})`);
// The hint must name the file that is actually running, and use the --flag=value form the rest
// of the flow uses: the old literal named arena_sandbox_client.py while the distributed file is
// saved as ab_client.py, and showed `<challenge>` without the '=' that base64url values need.
const clientBasename = path.basename(clientPath);
check(typeof observed?.claimed_next === 'string' && observed.claimed_next.includes(clientBasename)
  && observed.claimed_next.includes('--challenge='),
  `the claim hint names this file and uses --challenge= (got ${JSON.stringify(observed?.claimed_next)})`);
// Deterministic unit checks on the readable form, so the assertion above cannot pass by accident.
check(observed?.readable?.half_hour === '30m',
  `a half-hour deadline reads as 30m (got ${JSON.stringify(observed?.readable?.half_hour)})`);
check(observed?.readable?.past === 'expired', `a passed deadline reads as expired (got ${JSON.stringify(observed?.readable?.past)})`);
check(observed?.readable?.missing === 'unknown',
  `a missing deadline is not invented (got ${JSON.stringify(observed?.readable?.missing)})`);
check(/no wall-clock expiry/.test(observed?.readable?.session ?? '') && /session ends/.test(observed?.readable?.session ?? ''),
  `a session-scoped grant is not rendered as a date or as "forever" (got ${JSON.stringify(observed?.readable?.session)})`);

// --- agent-check must be usable on its own, and must not read "empty root" as "empty workspace"
const agent = observed?.agent_check;
check(agent?.health_challenge === 'chal_test',
  `agent-check completes the handshake itself, using the challenge the claim stored (got ${JSON.stringify(agent?.health_challenge)})`);
check(Array.isArray(agent?.listed_paths) && agent.listed_paths.includes('.') && agent.listed_paths.includes('src'),
  `it descends one level when the root holds no readable file (listed ${JSON.stringify(agent?.listed_paths)})`);
check(agent?.first_text_files?.includes('src/main.ts'),
  `so a workspace whose files are one level down does not read as empty (got ${JSON.stringify(agent?.first_text_files)})`);
check(agent?.directory_names?.join(',') === 'src,docs',
  `and it names the directories so the caller can navigate (got ${JSON.stringify(agent?.directory_names)})`);
// The other half, and the one the operator actually hit: nothing readable anywhere. The note has
// to send the caller to the directory names instead of letting "no files here" stand as "empty".
check(/do not report the workspace as empty/.test(agent?.empty_root_note ?? ''),
  `when nothing is readable at all, the note says so explicitly (got ${JSON.stringify(agent?.empty_root_note)})`);
check(agent?.empty_root_files?.length === 0 && agent?.empty_root_directories?.join(',') === 'assets',
  `and the directories are still named (files=${JSON.stringify(agent?.empty_root_files)} directories=${JSON.stringify(agent?.empty_root_directories)})`);

// ---------------------------------------------------------------------------
// 3) Static guards: the specific mistakes must not come back.
// ---------------------------------------------------------------------------
const source = fs.readFileSync(clientPath, 'utf8');
const agentBody = source.slice(source.indexOf('def do_agent'), source.indexOf('def pairing_code'));

check(/unwrap\(structured_of\(response\)\)/.test(agentBody),
  'agent-check unwraps the envelope through the shared helper');
check(/def list_entries/.test(agentBody) && /list_entries\("\."\)/.test(agentBody),
  'and every listing (the root and each descent) goes through it, so entries cannot be read from the wrong level');
// The old hint was a hard-coded string that named a file the sandbox never had. `__file__` is
// the only spelling that stays correct whatever the operator saves the script as.
check(!/Run: python3 arena_sandbox_client\.py verify --challenge </.test(source),
  'the stale hard-coded "next" hint is gone');
check(/os\.path\.basename\(__file__\)/.test(source),
  'the "next" hint names the file that is actually running');
// One response must not carry the payload twice: `data` and a re-embedded envelope doubled
// every reply, including a 37KB diff.
check(!/"result": structured or result/.test(source),
  'call does not echo the whole envelope a second time');
check(!/structured\.get\(["']entries["']\)/.test(agentBody),
  'agent-check no longer looks for entries on the envelope level');
check(!/\.get\(["']kind["']\)\s*!=\s*["']directory["']/.test(source),
  'no code compares a bare `kind` against "directory" any more');
check(/def structured_of\(/.test(source) && /def unwrap\(/.test(source) && /def is_directory\(/.test(source),
  'the shared envelope/entry helpers are present');

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed.');
