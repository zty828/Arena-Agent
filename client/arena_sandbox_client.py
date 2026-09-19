#!/usr/bin/env python3
"""
ArenaBridge sandbox MCP client.

Runs inside a remote agent sandbox (Arena Agent bash, or any shell) and talks to
your local ArenaBridge MCP endpoint. Python 3 standard library only: no pip, no
npm, no network install step.

It speaks MCP 2026-07-28 over Streamable HTTP (JSON or request-scoped SSE) and
falls back to the 2025-11-25 handshake only when the server answers as legacy.

It never executes workspace tools itself. It only forwards tool calls to the
bridge and prints the structured result, so the caller decides what to do.

Usage (grant token already issued by a local pairing):
  export ARENABRIDGE_URL='http://[2001:db8::1]:48271'
  export ARENABRIDGE_TOKEN='<grant token>'
  python3 arena_sandbox_client.py discover
  python3 arena_sandbox_client.py tools
  python3 arena_sandbox_client.py call read_files '{"files":[{"path":"src/app.ts"}]}'

Usage (do the pairing handshake from the sandbox):
  python3 arena_sandbox_client.py pair-request --code=<pairing code> --label 'arena-agent'
  python3 arena_sandbox_client.py pair-claim
  python3 arena_sandbox_client.py verify --challenge=<challenge from pair-claim>

Note: pairing codes, claim secrets and challenges are base64url and may start
with '-'. Always use the --flag=value form (or the ARENABRIDGE_CODE,
ARENABRIDGE_PAIR_ID, ARENABRIDGE_CLAIM_SECRET, ARENABRIDGE_CHALLENGE variables),
otherwise argparse reads the value as another flag.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request

MODERN = "2026-07-28"
LEGACY = "2025-11-25"
TIMEOUT = float(os.environ.get("ARENABRIDGE_TIMEOUT", "60"))
STATE_FILE = os.environ.get("ARENABRIDGE_STATE", ".arenabridge-sandbox.json")

# Extensions the bridge is expected to serve as text. Used only to suggest a readable file
# to report on; the bridge itself still decides, and a refusal is a valid answer.
TEXT_FILE = re.compile(r"\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|txt|ya?ml|toml|css|html?|py|sh|ps1|sql|csv|log|ini|cfg|go|rs|java|rb)$", re.I)

# Sandboxes usually export http_proxy/https_proxy for outbound traffic. The bridge is
# reached directly, so proxy handling is disabled by default; a proxy would otherwise
# swallow or mangle a request to a raw IPv6 literal. Set ARENABRIDGE_USE_PROXY=1 to opt back in.
if os.environ.get("ARENABRIDGE_USE_PROXY") == "1":
    OPENER = urllib.request.build_opener()
else:
    OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# --- a stalled read is not a slow server ---------------------------------------------------
#
# Measured against a Cloudflare quick tunnel, with one daemon and one payload, repeated:
#
#   Node fetch (undici)  : 6 of 6 requests answered in 0.4-1.6 s
#   Python urllib        : 5 of 6 answered in 0.9-2.0 s, 1 stalled past a 12 s deadline
#
# The tunnel's HTTP/1.1 path is intermittently unresponsive. That is a property of the edge,
# not of the bridge, and it is the reason this file previously produced contradictory
# readings: a single request would either answer in a second or hang until the read
# deadline, so whichever one was sampled looked like the whole truth. Two dead ends are
# worth recording so nobody repeats them:
#
#   * "the tunnel is HTTP/2 only"  — false. A raw HTTP/1.1 POST with no ALPN answered
#     HTTP 400 in about a second, several times, on the same tunnel where urllib timed out.
#   * "a header / proxy / ALPN is the cause" — false. Neither Accept-Encoding, nor the
#     proxy bypass, nor the ALPN offer changed the outcome; only the sample did.
#
# So the fix is not a different protocol. It is to stop treating a stalled read as a slow
# server: a body that never arrives is a transport that needs retrying, and the retry cost
# has to be small enough that the alternative (one long timeout) is never the better trade.
# The read deadline is therefore capped, and a stall is retried like any other transport
# error. `ARENABRIDGE_READ_DEADLINE=0` restores the old single long-deadline behaviour.
STALL_DEADLINE = float(os.environ.get("ARENABRIDGE_READ_DEADLINE", "20"))


def base_url() -> str:
    url = os.environ.get("ARENABRIDGE_URL", "").rstrip("/")
    if not url:
        die("ARENABRIDGE_URL is not set. Example: http://[2001:db8::1]:48271")
    return url


def token() -> str:
    value = os.environ.get("ARENABRIDGE_TOKEN", "")
    if not value:
        value = load_state().get("token", "")
    if not value:
        die("No grant token. Run pair-claim first, or set ARENABRIDGE_TOKEN.")
    return value


def die(message: str, code: int = 1) -> None:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False), file=sys.stderr)
    sys.exit(code)


# The access tiers, in rank order. This list has to match the daemon's (`ACCESS_MODES` in the
# policy engine) and the window's picker — it did not, once: `exec` was added everywhere except
# here, and the remote's `pair-request --access-mode=exec` died in argparse before a single byte
# went over the network, which looks exactly like a server-side refusal and is not one.
# `probe:access-mode` now asserts the four lists agree, and runs this script for real.
ACCESS_MODES = ["ask", "plan", "code", "exec"]

# How many subdirectories `agent-check` will look into when the workspace root holds no readable
# text file. Bounded on purpose: the point is to stop "the root has no files" from reading as
# "the workspace is empty", not to walk the tree.
SUBDIR_SCAN_LIMIT = 8

# Tool calls that change state, and therefore must not be silently retried: apply_patch,
# edit_file, run_command, set_todos, report_progress. Every other tool is read-only and keeps
# the default retry budget, which is what lets a stalled tunnel read recover (see STALL_DEADLINE).
SIDE_EFFECTING_TOOLS = {"apply_patch", "edit_file", "run_command", "set_todos", "report_progress"}

# Mirrors GRANT_NO_EXPIRY_AT in the policy engine. A session-scoped grant carries this instead of
# a deadline, so the value stays a number and every server-side comparison stays numeric.
NO_EXPIRY_AT = 9007199254740991


def expires_in(expires_at_ms: object) -> str:
    """A human reading of a grant deadline.

    The raw epoch is kept in the same payload, but on its own it is a trap: a remote agent
    reported reading `1789711776434` as "about nine months away" and planned around a deadline
    that was actually 40 minutes off. Both forms are printed for that reason.
    """
    if not isinstance(expires_at_ms, (int, float)) or isinstance(expires_at_ms, bool):
        return "unknown"
    # A session-scoped grant must NOT be rendered as a date, and must not be described as
    # "never expires" either: the session ending is exactly what ends it.
    if expires_at_ms >= NO_EXPIRY_AT:
        return "no wall-clock expiry (valid until the bridge session ends)"
    remaining = float(expires_at_ms) / 1000 - time.time()
    if remaining <= 0:
        return "expired"
    minutes = int(remaining // 60)
    if minutes >= 60:
        return f"{minutes // 60}h{minutes % 60:02d}m"
    if minutes >= 1:
        return f"{minutes}m"
    return f"{int(remaining)}s"


def load_state() -> dict:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def save_state(patch: dict) -> None:
    state = load_state()
    state.update(patch)
    with open(STATE_FILE, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
    try:
        os.chmod(STATE_FILE, 0o600)
    except OSError:
        pass


def http_json(method: str, url: str, body: dict | None = None, headers: dict | None = None, attempts: int | None = None) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    tries = attempts if attempts is not None else int(os.environ.get("ARENABRIDGE_RETRIES", "3"))
    last_error: Exception | None = None
    stalled = False
    for attempt in range(max(1, tries)):
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Accept", "application/json, text/event-stream")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            # A stalled read is given a short deadline rather than the full TIMEOUT. The
            # measured failure mode is a tunnel that accepts the request and then never
            # answers; waiting the whole TIMEOUT for it wastes the retry budget that would
            # have recovered. See STALL_DEADLINE for the measurements behind the default.
            deadline = TIMEOUT if STALL_DEADLINE <= 0 else min(TIMEOUT, STALL_DEADLINE)
            started = time.monotonic()
            with OPENER.open(request, timeout=deadline) as response:
                raw = response.read().decode("utf-8", "replace")
                status = response.status
                content_type = response.headers.get("Content-Type", "")
            return status, decode_body(raw, content_type)
        except urllib.error.HTTPError as error:
            # The server answered: this is a real result, never retried.
            raw = error.read().decode("utf-8", "replace")
            content_type = error.headers.get("Content-Type", "") if error.headers else ""
            return error.code, decode_body(raw, content_type)
        except (urllib.error.URLError, OSError) as error:
            # The connection never completed. Retrying is only safe when the server could
            # not have acted, so callers pass attempts=1 for side-effecting calls.
            last_error = error
            reason = getattr(error, "reason", error)
            # A stall is a timeout by type, not by message: ConnectionResetError and SSL-wrapped
            # timeouts never contain the literal "timed out", so substring matching misreported
            # them as "check the address/firewall" and burned the retry budget on the wrong hint.
            # Match TimeoutError/socket.timeout instead (socket.timeout is an alias of TimeoutError
            # since 3.10, and urllib wraps read timeouts in URLError.reason), and treat any attempt
            # that burned the whole stall deadline as stalled whatever the reason text says.
            if (isinstance(error, (TimeoutError, socket.timeout)) or isinstance(reason, (TimeoutError, socket.timeout))
                    or time.monotonic() - started >= max(1.0, deadline - 0.5)):
                stalled = True
            if attempt + 1 < max(1, tries):
                time.sleep(min(4, 0.5 * (2 ** attempt)))
                continue
            hint = (
                "the connection was accepted but no response arrived before the read deadline "
                f"({deadline:.0f}s), {tries} times. A relay in front of the bridge can do this "
                "intermittently; the bridge itself is alive (it answers on loopback). Retry, or "
                "raise ARENABRIDGE_READ_DEADLINE / ARENABRIDGE_TIMEOUT."
                if stalled else
                "Check the address, firewall and that the bridge is running."
            )
            die(f"cannot reach {url}: {getattr(error, 'reason', error)}. {hint}")
    die(f"cannot reach {url}: {last_error}")


def decode_body(raw: str, content_type: str) -> dict:
    if "text/event-stream" in content_type:
        frames = []
        for block in raw.replace("\r\n", "\n").split("\n\n"):
            payload = "\n".join(line[5:].lstrip() for line in block.split("\n") if line.startswith("data:"))
            if not payload or payload == "[DONE]":
                continue
            try:
                frames.append(json.loads(payload))
            except ValueError:
                continue
        for frame in frames:
            if "result" in frame or "error" in frame:
                return frame
        return frames[-1] if frames else {}
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return {"raw": raw[:2000]}


def structured_of(result: dict) -> dict:
    """The tool payload from a `tools/call` result, envelope included.

    The bridge wraps every tool result as `{ok, data, metadata}` inside
    `structuredContent`; `metadata` carries the audit id and `data` carries the tool's own
    fields. Callers that want the tool's fields must unwrap first — reading them straight
    off `structuredContent` yields `None` for every field and looks exactly like "the tool
    returned nothing", which is how a real directory listing was once reported as empty.
    """
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    # A transport that does not send structuredContent still puts the same JSON in a text
    # content block, so fall back to that rather than reporting an empty result.
    for block in result.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            try:
                parsed = json.loads(block.get("text") or "")
            except ValueError:
                continue
            if isinstance(parsed, dict):
                return parsed
    return {}


def unwrap(structured: dict) -> dict:
    """Drops the `{ok, data, metadata}` envelope so callers see the tool's own fields."""
    data = structured.get("data")
    return data if isinstance(data, dict) else structured


def is_directory(entry: dict) -> bool:
    """True for a directory entry, accepting both field spellings.

    The bridge emits `type`; `kind` is accepted only so a result cached from an older
    revision still reads correctly.
    """
    value = entry.get("type", entry.get("kind"))
    return str(value or "").lower() in ("directory", "dir")


class Client:
    def __init__(self, url: str, bearer: str) -> None:
        self.endpoint = url.rstrip("/") + "/mcp"
        self.bearer = bearer
        self.sequence = 0
        self.era: str | None = None
        self.session: str | None = None

    def rpc(self, method: str, params: dict | None = None, attempts: int | None = None,
            soft: bool = False) -> dict:
        """`soft=True` returns the JSON-RPC error instead of exiting.

        Used when walking a directory tree: one unreadable subdirectory should not abort
        the whole check and leave the caller with no output at all.
        """
        self.sequence += 1
        payload: dict = {"jsonrpc": "2.0", "id": self.sequence, "method": method}
        body_params = dict(params or {})
        headers = {"Authorization": f"Bearer {self.bearer}"}
        if self.era == LEGACY:
            if self.session:
                headers["Mcp-Session-Id"] = self.session
            headers["MCP-Protocol-Version"] = LEGACY
        else:
            body_params.setdefault("_meta", {
                "io.modelcontextprotocol/protocolVersion": MODERN,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {"name": "arenabridge-sandbox-client", "version": "1.0.0"},
            })
            headers["MCP-Protocol-Version"] = MODERN
            headers["Mcp-Method"] = method
            if method in ("tools/call", "prompts/get") and body_params.get("name"):
                headers["Mcp-Name"] = str(body_params["name"])
            if method == "resources/read" and body_params.get("uri"):
                headers["Mcp-Name"] = str(body_params["uri"])
        payload["params"] = body_params
        status, data = http_json("POST", self.endpoint, payload, headers, attempts=attempts)
        if data.get("error"):
            error = data["error"]
            code = error.get("code")
            message = error.get("message", "unknown error")
            if soft:
                return {"error": {"code": code, "message": message}}
            if code == -32022:
                supported = (error.get("data") or {}).get("supported", [])
                die(f"protocol version rejected; server supports {supported}")
            die(f"MCP error {code}: {message}")
        if status >= 400 and not data.get("result"):
            die(f"HTTP {status}: {json.dumps(data, ensure_ascii=False)[:800]}")
        return data.get("result", data)


def do_discover(args: argparse.Namespace) -> None:
    client = Client(base_url(), token())
    result = client.rpc("server/discover")
    client.era = MODERN
    print(json.dumps({
        "ok": True,
        "protocol_versions": result.get("supportedVersions"),
        "capabilities": result.get("capabilities"),
        "server": (result.get("_meta") or {}).get("io.modelcontextprotocol/serverInfo"),
        "instructions": result.get("instructions"),
    }, ensure_ascii=False, indent=2))


def do_tools(args: argparse.Namespace) -> None:
    client = Client(base_url(), token())
    client.era = MODERN
    result = client.rpc("tools/list", {"limit": args.limit})
    tools = result.get("tools", [])
    print(json.dumps({
        "ok": True,
        "count": len(tools),
        "tools": [{"name": tool.get("name"), "description": tool.get("description"),
                   "inputSchema": tool.get("inputSchema"), "annotations": tool.get("annotations")} for tool in tools],
    }, ensure_ascii=False, indent=2))


def do_call(args: argparse.Namespace) -> None:
    try:
        arguments = json.loads(args.arguments) if args.arguments else {}
    except ValueError as error:
        die(f"arguments must be a JSON object: {error}")
    client = Client(base_url(), token())
    client.era = MODERN
    # attempts=1 only where a retry could apply the change twice (SIDE_EFFECTING_TOOLS); a
    # read-only call keeps the default retry budget so a stalled tunnel read is retried.
    attempts = 1 if args.tool in SIDE_EFFECTING_TOOLS else None
    result = client.rpc("tools/call", {"name": args.tool, "arguments": arguments}, attempts=attempts)
    structured = structured_of(result)
    payload = {
        "ok": bool(structured.get("ok", not result.get("isError", False))),
        "is_error": bool(result.get("isError")),
        "execution_owner": (structured.get("metadata") or {}).get("execution_owner"),
        "audit_id": (structured.get("metadata") or {}).get("audit_id"),
        "data": structured.get("data"),
    }
    # The envelope is deliberately NOT echoed again under a second key. It used to be, which
    # repeated the whole payload — a 37KB patch diff came back as two identical 37KB copies in
    # one response, and every call paid that twice for no extra information. `data` already
    # holds the tool's fields; the fallback below only fires when there is no envelope at all,
    # so a raw/legacy transport is still visible rather than silently reported as empty.
    if payload["data"] is None:
        payload["result"] = structured or result
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def do_agent() -> None:
    """One stable call that exercises the whole read path, for a pasted prompt.

    A generated prompt has to name a concrete file to read, and it cannot know what the
    operator's workspace holds — the old prompt hard-coded a fixture filename (`sum.mjs`),
    which is simply wrong against any other directory. This print-only command reports
    endpoint, tool names and the first text-ish files the grant can actually read, so the
    agent has something true to report without guessing.
    """
    print(json.dumps({"endpoint": base_url(), "state_file": STATE_FILE,
                      "grant_token_present": bool(os.environ.get("ARENABRIDGE_TOKEN"))},
                     ensure_ascii=False, indent=2), flush=True)
    client = Client(base_url(), token())
    client.era = MODERN
    result = client.rpc("tools/list", {"limit": 100})
    names = sorted(str(t.get("name")) for t in result.get("tools", []))
    print(json.dumps({"tools": names}, ensure_ascii=False), flush=True)
    # Complete the challenge handshake here, using the value the claim stored.
    #
    # Without this, `bridge_health` only reports readiness and every read afterwards is refused
    # with `AUTHORIZATION_REQUIRED: Complete the pairing challenge first` — which is what this
    # command used to do: it printed the tool list, then died on the directory listing, and the
    # caller was left with no listing at all and concluded the workspace was empty. A command
    # whose whole purpose is "confirm the grant works end to end" cannot require the caller to
    # have run `verify` first.
    challenge = os.environ.get("ARENABRIDGE_CHALLENGE") or str(load_state().get("challenge") or "")
    health_args = {"challenge": challenge} if challenge else {}
    health = unwrap(structured_of(client.rpc("tools/call", {"name": "bridge_health", "arguments": health_args}, soft=True)))
    if not challenge:
        print(json.dumps({
            "warning": "no challenge available (the state file is gone and ARENABRIDGE_CHALLENGE is unset)",
            "fix": "run: verify --challenge=<the value pair-claim returned>, then run agent-check again",
        }, ensure_ascii=False), flush=True)
    print(json.dumps({"access_mode": health.get("access_mode"),
                      "grant_expires_at": health.get("expires_at"),
                      "grant_expires_in": expires_in(health.get("expires_at"))}, ensure_ascii=False), flush=True)
    # list_directory is free-text; read_files is the call that proves the read path end to end.
    def list_entries(path: str) -> dict:
        """One directory listing, or an `error` marker instead of exiting.

        Exploring the tree means asking about paths the caller has not seen yet, and a directory
        can legitimately fail to list (removed in between, denied by policy). `soft=True` keeps
        that from aborting the whole check and leaving the caller with no output at all.
        """
        response = client.rpc("tools/call", {"name": "list_directory", "arguments": {"path": path}}, soft=True)
        if response.get("error"):
            return {"error": response["error"]}
        return unwrap(structured_of(response))

    data = list_entries(".")
    if data.get("error"):
        print(json.dumps({"error": data["error"],
                          "note": "the workspace root could not be listed; report this error verbatim"},
                         ensure_ascii=False, indent=2))
        return
    entries = data.get("entries") or []
    files = [e for e in entries if not is_directory(e)]
    directories = [e for e in entries if is_directory(e)]
    textish = [e for e in files if TEXT_FILE.search(str(e.get("name") or ""))]
    found = [e.get("path") or e.get("name") for e in textish[:5]]

    # Look one level down before reporting "nothing readable here".
    #
    # A workspace whose content lives in folders has an empty root file list, and this command
    # used to stop there — the caller saw `file_count: 0` and reasonably concluded the workspace
    # was empty, when in fact everything was one directory down. The descent is bounded and says
    # how far it went, so "nothing found" stays a statement about what was actually looked at.
    descended, failures = 0, []
    for directory in directories[:SUBDIR_SCAN_LIMIT]:
        if len(found) >= 5:
            break
        path = directory.get("path") or directory.get("name")
        if not path:
            continue
        listing = list_entries(str(path))
        descended += 1
        if listing.get("error"):
            failures.append({"path": path, "error": listing["error"]})
            continue
        for entry in listing.get("entries") or []:
            if is_directory(entry):
                continue
            if TEXT_FILE.search(str(entry.get("name") or "")):
                found.append(entry.get("path") or entry.get("name"))
        if len(found) >= 5:
            break

    print(json.dumps({
        "file_count": len(files), "directory_count": len(directories),
        "directory_names": [e.get("path") or e.get("name") for e in directories[:20]],
        "first_text_files": found,
        "subdirectories_searched": descended,
        "subdirectory_errors": failures,
        "truncated": bool(data.get("truncated")),
        "note": ("first_text_files is what you can read right now; read the first one, then wait "
                 "for the next instruction. If it is empty, use list_directory on directory_names "
                 "to go deeper — do not report the workspace as empty."
                 if not found else
                 "report what you see, then wait for the next instruction; do not write anything"),
    }, ensure_ascii=False, indent=2))


def pairing_code(explicit: str | None) -> str:
    """base64url values can start with '-', which argparse treats as a flag.
    Always prefer the --code=<value> form, or set ARENABRIDGE_CODE."""
    value = explicit or os.environ.get("ARENABRIDGE_CODE", "")
    if not value:
        die("No pairing code. Pass --code=<value> (use '=' if the value starts with '-'), or set ARENABRIDGE_CODE.")
    return value


def do_pair_request(args: argparse.Namespace) -> None:
    status, data = http_json("POST", base_url() + "/pair/request", {
        "code": pairing_code(args.code), "remote_label": args.label, "access_mode": args.access_mode,
    })
    if status >= 400:
        die(f"pairing request rejected (HTTP {status}): {json.dumps(data, ensure_ascii=False)[:600]}")
    # `pairing_expires_at` is the deadline on the PENDING pairing, not on the grant. It is saved
    # so `pair-claim` can tell "not approved yet, keep waiting" from "the pairing lapsed and the
    # claim will now fail". The daemon omits it on APPROVED, so .get() stays.
    save_state({"pair_id": data.get("pair_id"), "claim_secret": data.get("claim_secret"),
                "pairing_expires_at": data.get("expires_at")})
    # The secret is printed as well as saved. A sandbox that resets /tmp between turns loses the
    # state file, and `pair-claim` cannot then recover the secret — the pairing would have to be
    # minted again and the operator would have to approve a second time. Printing it lets the
    # agent pass `--pair-id`/`--claim-secret` explicitly on the next step instead. Nothing new is
    # disclosed: this value was returned to this same caller in the HTTP response.
    print(json.dumps({
        "ok": True, "state": data.get("state"), "pair_id": data.get("pair_id"),
        "claim_secret": data.get("claim_secret"),
        "claim_secret_saved_to": STATE_FILE,
        "next": "Ask the local operator to approve this pairing, then run: pair-claim"
                " (pass --pair-id and --claim-secret if this sandbox does not keep its state file)",
    }, ensure_ascii=False, indent=2))


def do_pair_claim(args: argparse.Namespace) -> None:
    state = load_state()
    pair_id = args.pair_id or state.get("pair_id") or os.environ.get("ARENABRIDGE_PAIR_ID")
    secret = args.claim_secret or state.get("claim_secret") or os.environ.get("ARENABRIDGE_CLAIM_SECRET")
    if not pair_id or not secret:
        die("pair_id and claim_secret are required (or run pair-request first).")
    status, data = http_json("POST", base_url() + "/pair/claim", {"pair_id": pair_id, "claim_secret": secret})
    # The claim must not die with HTTP 4xx on a pairing that was PENDING and has since lapsed:
    # the daemon answers AUTHORIZATION_REQUIRED for that, and "claim rejected / wrong secret"
    # would send the operator debugging a value that is fine — the code simply expired. Detect it
    # from the deadline saved by pair-request and say so distinctly (same exit code as before).
    if status >= 400:
        message = json.dumps(data, ensure_ascii=False)[:600]
        if "AUTHORIZATION_REQUIRED" in message:
            pairing_expires_at = state.get("pairing_expires_at")
            if isinstance(pairing_expires_at, (int, float)) and not isinstance(pairing_expires_at, bool) \
                    and time.time() * 1000 >= pairing_expires_at:
                die("pairing EXPIRED: the pairing code was never approved before its deadline. "
                    "Run pair-request again with a fresh code — this is not a wrong claim secret.")
        die(f"claim rejected (HTTP {status}): {message}")
    if data.get("state") != "approved":
        # A PENDING response carries `expires_at` (epoch ms) since the parallel daemon change;
        # .get() keeps older daemons working. When it is known, say how long the operator has.
        pending_expires_at = data.get("expires_at")
        print(json.dumps({"ok": False, "state": data.get("state"),
                          "expires_at": pending_expires_at,
                          "expires_in": expires_in(pending_expires_at),
                          "hint": ("The local operator has not approved this pairing yet."
                                   if not isinstance(pending_expires_at, (int, float)) or isinstance(pending_expires_at, bool)
                                   else f"The local operator has not approved this pairing yet; they have {expires_in(pending_expires_at)} left.")},
                         ensure_ascii=False, indent=2))
        sys.exit(2)
    # The challenge is kept as well, so `agent-check` can complete the handshake on its own:/n    # the claim is the only place it is handed out, and a command whose whole job is "confirm
    # the grant works" must not depend on the caller remembering a value from an earlier step.
    save_state({"token": data.get("token"), "run_id": data.get("run_id"), "workspace_id": data.get("workspace_id"),
                "challenge": data.get("challenge"), "pairing_expires_at": None})
    # The token is printed as well as saved, for the same reason the claim secret is: a sandbox
    # that discards /tmp between turns would otherwise lose the only copy of the credential, and
    # the whole pairing would have to be minted and approved again. It is a live credential —
    # hence the explicit expiry below, in both raw and readable form.
    print(json.dumps({
        "ok": True, "grant_id": data.get("grant_id"), "run_id": data.get("run_id"),
        "workspace": data.get("workspace_name"), "access_mode": data.get("access_mode"),
        "scopes": data.get("scopes"),
        "expires_at": data.get("expires_at"), "expires_in": expires_in(data.get("expires_at")),
        "expires_note": ("this grant has no wall-clock expiry: it stays valid until the bridge "
                         "session ends (window closed, tunnel disconnected, workspace switched, or "
                         "the operator revoked it). If calls start being refused, the session is "
                         "over — report it, do not retry in a loop."
                         if (data.get("expires_at") or 0) >= NO_EXPIRY_AT else
                         "this grant is time-limited; after it lapses every call fails and the operator must mint a new pairing code"),
        "execution_owner": data.get("execution_owner"),
        "challenge": data.get("challenge"),
        "token": data.get("token"),
        "token_note": "keep this; pass it as ARENABRIDGE_TOKEN=<value> on later calls if the state file is gone",
        "next": f"ARENABRIDGE_TOKEN='{data.get('token')}' python3 {os.path.basename(__file__)} verify --challenge='<challenge>'",
    }, ensure_ascii=False, indent=2))


def do_verify(args: argparse.Namespace) -> None:
    challenge = args.challenge or load_state().get("challenge") or os.environ.get("ARENABRIDGE_CHALLENGE")
    if not challenge:
        die("--challenge is required (returned by pair-claim).")
    client = Client(base_url(), token())
    client.era = MODERN
    result = client.rpc("tools/call", {"name": "bridge_health", "arguments": {"challenge": challenge}})
    payload = dict(result.get("structuredContent", result))
    # `expires_at` is the grant deadline. It is a plain epoch in milliseconds, which is exactly
    # how a real caller misread it as "months away" when it was 40 minutes off, so the readable
    # form is added wherever the raw one appears.
    data = payload.get("data")
    if isinstance(data, dict) and "expires_at" in data:
        payload["expires_in"] = expires_in(data.get("expires_at"))
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="ArenaBridge sandbox MCP client (stdlib only)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("discover", help="server/discover: versions, capabilities, instructions").set_defaults(func=do_discover)

    tools_parser = sub.add_parser("tools", help="list available workspace tools")
    tools_parser.add_argument("--limit", type=int, default=100)
    tools_parser.set_defaults(func=do_tools)

    call_parser = sub.add_parser("call", help="call one workspace tool")
    call_parser.add_argument("tool")
    call_parser.add_argument("arguments", nargs="?", default="{}")
    call_parser.set_defaults(func=do_call)

    request_parser = sub.add_parser("pair-request", help="request pairing with a code")
    request_parser.add_argument("--code", help="pairing code; use --code=<value> because base64url values may start with '-' (or set ARENABRIDGE_CODE)")
    request_parser.add_argument("--label", default="remote-agent")
    request_parser.add_argument("--access-mode", default="ask", choices=ACCESS_MODES)
    request_parser.set_defaults(func=do_pair_request)

    claim_parser = sub.add_parser("pair-claim", help="claim the grant after local approval")
    claim_parser.add_argument("--pair-id")
    claim_parser.add_argument("--claim-secret")
    claim_parser.set_defaults(func=do_pair_claim)

    verify_parser = sub.add_parser("verify", help="confirm the pairing challenge")
    verify_parser.add_argument("--challenge")
    verify_parser.set_defaults(func=do_verify)

    # Print-only end-to-end read check. Reads the workspace over a real grant; never writes.
    sub.add_parser("agent-check", help="confirm the grant works and show a few readable files").set_defaults(func=lambda _a: do_agent())

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
