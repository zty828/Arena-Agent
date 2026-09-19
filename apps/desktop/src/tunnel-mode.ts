/**
 * Tunnel mode for the desktop harness.
 *
 * The window boots the daemon itself, so the tunnel needs two things the window cannot get
 * from a CLI flag: the daemon has to be *restarted* with its remote listener enabled and its
 * host allowlist set to the tunnel hostname, and that hostname only exists after the tunnel
 * is up. Restarting the daemon would not be acceptable — the operator's session, grants and
 * pending approvals live in it — so the order is: start the tunnel first, then start (or
 * restart) the daemon once, with the hostname baked into its config.
 *
 * Rules this module keeps:
 *  - The remote listener is the only thing that becomes reachable. Ports API, MCP (local) and
 *    admin stay on 127.0.0.1 no matter what.
 *  - `acknowledge_exposure` is only ever set true after the operator confirms, in the window,
 *    for that specific session.
 *  - No hostname, no exposure: the daemon refuses remote_ingress with a loopback bind address
 *    and an empty allowed_hosts, and this module never tries to work around that.
 *
 * Kept free of Electron imports so the config shape is testable without a window.
 */

export interface TunnelIngressConfig {
  enabled: boolean;
  acknowledge_exposure: boolean;
  bind_address: string;
  allow_cidrs: string[];
  allowed_hosts: string[];
  require_grant: boolean;
}

/** The config block for a daemon that nothing but loopback and the named tunnel can reach. */
export function exposedIngress(tunnelHostname: string): TunnelIngressConfig {
  const host = normaliseHostname(tunnelHostname);
  if (!host) throw new Error('the tunnel hostname is required before the bridge can be exposed');
  return {
    enabled: true,
    // The daemon itself refuses `enabled` without this. Setting it here is a statement that the
    // operator confirmed, which is why this function is only ever called after that confirmation.
    acknowledge_exposure: true,
    bind_address: '127.0.0.1',
    allow_cidrs: [],
    allowed_hosts: [host],
    // Never configurable from here: an exposed listener without a grant would be an open door.
    require_grant: true,
  };
}

export function closedIngress(): TunnelIngressConfig {
  return { enabled: false, acknowledge_exposure: false, bind_address: '127.0.0.1', allow_cidrs: [], allowed_hosts: [], require_grant: true };
}

/**
 * The bare hostname of a tunnel URL, as the daemon's Host-header allowlist must match it.
 *
 * Rejects anything that is not a plain hostname: the allowlist is compared against an
 * attacker-controlled header, so a value carrying a scheme, a path, a wildcard or a second
 * host must never reach it. A port is stripped rather than rejected — a Host header always
 * carries `host:port`, and the daemon matches on the name.
 *
 * IP literals are rejected as well as malformed names. The two callers are a Cloudflare
 * quick-tunnel hostname (always a DNS name) and the CLI's `--host` hint; neither is ever a
 * literal address, and a literal in a host allowlist is the one form that can match a
 * request aimed straight at the listener. Anything that genuinely needs a literal address
 * belongs in `allow_cidrs`, which the daemon checks separately.
 */
export function normaliseHostname(input: string): string {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return '';
  let host = raw;
  if (raw.includes('://')) {
    try { host = new URL(raw).hostname; } catch { return ''; }
  }
  host = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return '';
  // A name whose last label is all digits (or an IPv6-shaped remainder) is an address, not a
  // hostname. Domain labels cannot be purely numeric in the TLD position.
  const last = host.slice(host.lastIndexOf('.') + 1);
  if (/^\d+$/.test(last) || host.includes(':')) return '';
  return host;
}

/**
 * Validate the URL the tunnel writer reports, before anything is built from it.
 *
 * This is a boundary in two senses. The writer is plain JavaScript outside the TypeScript
 * build, so its return value is unvalidated at the type level — `ok: true` is a claim, not
 * proof, and a malformed url used to surface as a bare `Invalid URL` thrown out of an IPC
 * handler, reaching the operator as "Error occurred in handler for 'arena:connect'" with no
 * indication of what went wrong. And the hostname derived here is handed to the daemon as part
 * of its Host-header allowlist, so accepting an arbitrary string would widen the boundary of an
 * internet-facing listener.
 *
 * The allowlist check is deliberately about the *shape* of the value, not a guess at who is
 * talking: only an https URL on a trycloudflare.com host is accepted, because a quick tunnel is
 * the only thing this path ever creates.
 */
export function parseTunnelUrl(value: unknown): { url: string; hostname: string } | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { return undefined; }
  if (parsed.protocol !== 'https:') return undefined;
  if (!/(^|\.)trycloudflare\.com$/i.test(parsed.hostname)) return undefined;
  // Reuse the allowlist validator so the hostname that reaches the daemon is exactly the form
  // `normaliseHostname` guarantees it can match: never empty, never carrying a port or scheme.
  const hostname = normaliseHostname(parsed.hostname);
  if (!hostname) return undefined;
  return { url: parsed.origin, hostname };
}

/**
 * The port of an address the daemon reports, or undefined when there is no usable one.
 *
 * The daemon reports an absent optional listener as an EMPTY STRING rather than as undefined,
 * and an empty string survives every `??` fallback. That turned what should have been a clear
 * "the remote listener is not up yet" into a bare `Invalid URL` thrown from inside an IPC
 * handler, arriving at the operator as "Error occurred in handler for 'arena:connect'". Any
 * value that is not a parseable address yields undefined here, so callers can branch on a real
 * answer instead of catching an exception.
 */
export function portOf(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { return undefined; }
  const port = Number(parsed.port);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}
