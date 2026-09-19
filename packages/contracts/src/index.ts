import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const APP_VERSION = '0.1.0-stage1';
export const SCHEMA_VERSION = '1.0';
export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSION = '2025-11-25';
export const POLICY_VERSION = 'stage1-local-trusted-1';
export const Modes = ['remote_workspace', 'provider_gateway_client_tools', 'provider_gateway_bridge_tools', 'mcp_task_service'] as const;
export type RunMode = typeof Modes[number];
export type ExecutionOwner = 'remote_workspace' | 'client' | 'bridge';
/**
 * What a pairing code's ceiling allows, ranked.
 *
 * `exec` is a deliberate reversal of the original stage-1 decision ("no run_command, ever"). It is
 * strictly more powerful than `code`: a shell can write files, so it subsumes the patch scope.
 * The reversal is recorded in docs/architecture-and-security.md rather than quietly dropped —
 * with command execution enabled, this bridge no longer keeps the remote from running arbitrary
 * code on the operator's machine, and the only things left are the tier the operator chose, the
 * audit trail, and the session bounds (revoke / disconnect / restart).
 */
export type AccessMode = 'ask' | 'plan' | 'code' | 'exec';
export type PrincipalKind = 'admin' | 'api_client' | 'local_mcp' | 'remote_workspace' | 'worker' | 'orchestrator';
export type RunState = 'created' | 'queued' | 'assigned' | 'running' | 'waiting_for_tool' | 'waiting_for_approval' | 'needs_user_resume' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'unknown';
export const TERMINAL_STATES = new Set<RunState>(['completed', 'failed', 'cancelled', 'expired', 'unknown']);
const transitions: Record<RunState, readonly RunState[]> = {
  created: ['queued', 'running', 'cancelled', 'expired'],
  queued: ['assigned', 'running', 'cancelled', 'expired', 'failed'],
  assigned: ['running', 'needs_user_resume', 'cancelled', 'expired', 'unknown'],
  running: ['waiting_for_tool', 'waiting_for_approval', 'needs_user_resume', 'completed', 'failed', 'cancelled', 'expired', 'unknown'],
  waiting_for_tool: ['running', 'failed', 'cancelled', 'expired', 'unknown'],
  waiting_for_approval: ['running', 'failed', 'cancelled', 'expired', 'unknown'],
  needs_user_resume: ['running', 'cancelled', 'expired', 'failed', 'unknown'],
  completed: [], failed: [], cancelled: [], expired: [], unknown: []
};
export function executionOwner(mode: RunMode): ExecutionOwner {
  return mode === 'remote_workspace' ? 'remote_workspace' : mode === 'provider_gateway_client_tools' ? 'client' : 'bridge';
}
export function assertTransition(from: RunState, to: RunState): void {
  if (from !== to && !transitions[from].includes(to)) throw new BridgeError('VERSION_CONFLICT', 409, `Illegal run transition: ${from} -> ${to}`);
}
export class BridgeError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string, public readonly details?: Record<string, unknown>) { super(message); this.name = 'BridgeError'; }
}
export function fail(code: string, message: string, status = 403): never { throw new BridgeError(code, status, message); }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new BridgeError('INVALID_ARGUMENT', 400, 'Value is not JSON');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const digest = (value: unknown): string => sha256(canonical(value));
export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;
export const newSecret = (): string => randomBytes(32).toString('base64url');
export const now = (): number => Date.now();
export const utc = (): string => new Date().toISOString();
export const IdSchema = z.string().regex(/^[a-z]+_[0-9a-f-]{36}$/);
export const PathSchema = z.string().min(1).max(1024);
export const PageSchema = { limit: z.number().int().min(1).max(200).default(50), cursor: z.number().int().min(0).max(100000).default(0) };
export interface Workspace { id: string; display_name: string; root: string; created_at: number; }
export interface Principal { id: string; kind: PrincipalKind; label: string; }
export interface Grant {
  id: string; principal_id: string; token_hash: string; kind: 'remote_workspace' | 'worker';
  workspace_id: string; run_id: string; access_mode: AccessMode; scopes: string[];
  expires_at: number; revoked_at: number | null; epoch: number; recipient: string;
  policy_version: string; challenge_hash: string; verified_at: number | null;
}
export interface Run {
  id: string; workspace_id: string; principal_id: string; mode: RunMode;
  execution_owner: ExecutionOwner; state: RunState; reason: string | null;
  policy_version: string; created_at: number; updated_at: number;
}
export interface Approval {
  id: string; run_id: string; grant_id: string; action: string; params_hash: string;
  description: string; state: 'pending' | 'approved' | 'denied' | 'consumed';
  approver_id: string | null; expires_at: number; created_at: number;
  // The structured patch preview id this approval gates. Optional because approvals stored
  // before this field existed only carried the id inside the description text; consumers must
  // treat a missing value as "legacy, parse the description" and never invent one.
  patch_id?: string | null;
}
export interface AuditEvent {
  schema_version: string; event_id: string; run_id: string | null; request_id: string | null;
  job_id: string | null; source: string; seq: number; timestamp: string; type: string;
  payload: Record<string, unknown>;
}
export interface InvocationContext { principal: Principal; grant: Grant; request_id: string; }
export interface ToolResult {
  ok: boolean; data?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  metadata: { audit_id: string; duration_ms: number; truncated: boolean; next_cursor?: number | null; execution_owner: ExecutionOwner; source: 'local'; };
}
export function publicError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof z.ZodError) return new BridgeError('INVALID_ARGUMENT', 400, 'Schema validation failed', { issues: error.issues.map(i => ({ path: i.path.map(String).join('.'), code: i.code })) });
  return new BridgeError('INTERNAL_ERROR', 500, 'Operation failed; consult the local diagnostic log');
}
export const ToolResultSchema = z.object({
  ok: z.boolean(), data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }).optional(),
  metadata: z.object({ audit_id: z.string(), duration_ms: z.number(), truncated: z.boolean(), next_cursor: z.number().nullable().optional(), execution_owner: z.enum(['remote_workspace', 'client', 'bridge']), source: z.literal('local') })
});
