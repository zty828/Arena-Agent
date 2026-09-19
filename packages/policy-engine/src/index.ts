import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../../storage/src/index.js';
import { BridgeError, POLICY_VERSION, TERMINAL_STATES, digest, newId, newSecret, sha256, type AccessMode, type Approval, type Grant, type InvocationContext, type Principal, type Run, type Workspace } from '../../contracts/src/index.js';

interface Pairing {
  id:string; code_hash:string; claim_hash:string|null; workspace_id:string; recipient:string;
  max_access:AccessMode; requested_access:AccessMode|null; approved_access:AccessMode|null;
  remote_label:string|null; state:'created'|'pending'|'approved'|'consumed'|'denied';
  expires_at:number; grant_ttl_ms:number; epoch:number;
}
const RANK:Record<AccessMode,number> = {ask:0,plan:1,code:2,exec:3};
/**
 * The access tiers, in rank order — the single source of truth for "what a pairing code can
 * allow". Exported because the same list is duplicated where it cannot be imported: the
 * sandbox client is Python, and the window's picker is HTML. Those copies are asserted to
 * match this one by `probe:access-mode`, because they drifted once: `exec` landed here, in the
 * prompt and in the picker, but not in the client's argparse whitelist, and every `exec`
 * pairing request died client-side looking like a server refusal.
 */
export const ACCESS_MODES = ['ask','plan','code','exec'] as const;
/**
 * The scopes a mode derives. `exec` implies the patch scope because a shell can write files —
 * withholding `workspace:patch` from it would suggest a limit that does not exist.
 */
const scopesFor = (mode:AccessMode):string[] => [
  // `skills:read` is granted in every mode on purpose. A skill is documentation the operator
  // installed on this machine, not workspace data: reading one cannot change anything, and an
  // `ask`-tier caller that cannot see what the operator made available cannot follow the
  // operator's own instructions either.
  'workspace:read','progress:write','skills:read',
  ...(mode==='code'||mode==='exec'?['workspace:patch']:[]),
  ...(mode==='exec'?['workspace:exec']:[])
];
// Stable ids for the loopback MCP identity, so it can be found and refreshed across restarts.
//
// The run and grant ids are derived per workspace rather than being one global singleton.
// `runs` carries a BEFORE UPDATE trigger that deliberately refuses to change a run's
// workspace_id (an execution binding must never be silently rebound), so a single fixed run
// row could only ever hold the FIRST workspace it was created for. Every later bind would hit
// the trigger and abort with "immutable run binding" — which is exactly what made switching
// the desktop workspace fail after the first launch. One run per workspace keeps the trigger
// honest and makes rebinding a fresh insert instead of a forbidden update.
export const LOCAL_MCP_PRINCIPAL_ID = 'local_mcp';
export const LOCAL_MCP_GRANT_ID = 'grant_local_mcp';
export const LOCAL_MCP_RUN_ID = 'run_local_mcp';
export function localMcpRunId(workspaceId:string):string { return `${LOCAL_MCP_RUN_ID}:${workspaceId}`; }
export function localMcpGrantId(workspaceId:string):string { return `${LOCAL_MCP_GRANT_ID}:${workspaceId}`; }
export const PairingInput = z.object({
  workspace_id:z.string(), recipient:z.string().min(1).max(200),
  max_access:z.enum(ACCESS_MODES).default('ask'),
  // The invitation alone grants nothing: access still needs single-use local approval.
  // 30 minutes is sized for a human-driven flow (paste into a remote agent, wait for it,
  // then approve locally).
  ttl_ms:z.number().int().min(10000).max(1800000).default(300000),
  // How long the credential the remote ends up holding stays valid. Optional, and omitted (or
  // 0) means "no wall-clock expiry": it lasts as long as this daemon session does.
  //
  // That is not the same as "forever". Every daemon start rotates the epoch and every grant is
  // bound to it (`recoverOnStart` -> `authorize`), so the credential dies with the session —
  // closing the window, disconnecting, switching workspace or revoking all end it. A wall-clock
  // TTL on top of that only ever produced one effect in practice: a session that stopped working
  // mid-task, an hour in, for no reason the operator could see.
  //
  // A negative or non-finite value is still refused rather than read as "unlimited" — silently
  // widening a malformed request into an unbounded credential is the worst reading available.
  grant_ttl_ms:z.number().int().nonnegative().max(3600000).optional()
}).strict();
const equal = (a:string,b:string):boolean => a.length === b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));

/** Settings row holding the unattended-write window. A single row, so there is exactly one switch. */
export const AUTO_APPROVE_SETTING_ID = 'auto_approve_writes';
/** The recorded approver for a write no human read. Explicit, so the audit trail cannot be
 *  mistaken for "the operator approved this". */
export const AUTO_APPROVER_ID = 'auto_unattended';
/** Sentinel for "no expiry". Chosen as 0 rather than null/undefined so the setting row has one
 *  shape (`expires_at` is always a number) and a missing field cannot be misread as unlimited. */
export const AUTO_APPROVE_NO_EXPIRY = 0;

/**
 * The `expires_at` a session-scoped grant carries: far enough away that no wall-clock check ever
 * trips, while staying an exact integer in JSON and SQLite.
 *
 * Deliberately a *number* rather than 0/absent, so every existing `expires_at <= Date.now()`
 * comparison in the authorisation path keeps working untouched. The value matches what the local
 * MCP host grant has always used (`localMcpGrant`), so there is one convention in this codebase
 * for "does not expire on a clock", not two.
 *
 * The bound is not "never": grants are bound to the daemon epoch, which `recoverOnStart` rotates
 * on every start. `probe:grant-lifetime` asserts both halves — the grant survives a long idle,
 * and it is refused after a restart.
 */
export const GRANT_NO_EXPIRY_AT = Number.MAX_SAFE_INTEGER;

export class PolicyEngine {
  epoch:number;
  readonly admin:Principal = {id:'local_admin',kind:'admin',label:'Local approval operator'};
  readonly apiClient:Principal = {id:'local_api',kind:'api_client',label:'Local model API client'};
  readonly mcpClient:Principal = {id:'local_mcp',kind:'local_mcp',label:'Local MCP host'};
  private readonly adminHash:string;
  private readonly clientHash:string;
  private readonly mcpHash:string;
  constructor(readonly store:Store, credentials:{adminToken:string;clientToken:string;mcpToken?:string}, epoch:number) {
    if (credentials.adminToken.length < 32 || credentials.clientToken.length < 32 || credentials.adminToken === credentials.clientToken) throw new BridgeError('INVALID_CONFIG',400,'Independent high-entropy credentials are required');
    // The local MCP credential must be its own secret, not a reuse of the others.
    const mcpToken = credentials.mcpToken ?? newSecret();
    if (mcpToken.length < 32 || mcpToken === credentials.adminToken || mcpToken === credentials.clientToken) throw new BridgeError('INVALID_CONFIG',400,'The local MCP credential must be independent of the admin and API credentials');
    this.adminHash = sha256(credentials.adminToken); this.clientHash = sha256(credentials.clientToken); this.mcpHash = sha256(mcpToken); this.epoch = epoch;
  }
  authenticateLocal(header:string|undefined, realm:'admin'|'api_client'|'mcp_client'):Principal {
    const token = this.bearer(header);
    const expected = realm === 'admin' ? this.adminHash : realm === 'api_client' ? this.clientHash : this.mcpHash;
    if (!equal(sha256(token),expected)) {
      // Pairing codes, claim secrets and local tokens are all 32 random bytes in base64url,
      // so they are indistinguishable by eye. Say which one this is instead of a bare 401.
      const digest = sha256(token);
      const pairings = this.store.all<Pairing>('pairings');
      if (pairings.some(p => equal(p.code_hash,digest))) throw new BridgeError('AUTH_REQUIRED',401,'That is a pairing code, not the console credential. Use admin_token from .arena-bridge/local-credentials.json');
      if (pairings.some(p => p.claim_hash !== null && equal(p.claim_hash,digest))) throw new BridgeError('AUTH_REQUIRED',401,'That is a claim secret for the remote agent, not a local credential');
      if (realm === 'admin' && equal(digest,this.clientHash)) throw new BridgeError('AUTH_REQUIRED',401,'That is the API client token (port 48270), not the admin token (port 48272)');
      if (realm === 'admin' && equal(digest,this.mcpHash)) throw new BridgeError('AUTH_REQUIRED',401,'That is the local MCP token (port 48271), not the admin token (port 48272)');
      if (realm === 'api_client' && equal(digest,this.adminHash)) throw new BridgeError('AUTH_REQUIRED',401,'That is the admin token (port 48272), not the API client token (port 48270)');
      if (realm === 'api_client' && equal(digest,this.mcpHash)) throw new BridgeError('AUTH_REQUIRED',401,'That is the local MCP token (port 48271), not the API client token (port 48270)');
      if (realm === 'mcp_client' && equal(digest,this.adminHash)) throw new BridgeError('AUTH_REQUIRED',401,'That is the admin token (port 48272); the local MCP port needs mcp_token');
      if (realm === 'mcp_client' && equal(digest,this.clientHash)) throw new BridgeError('AUTH_REQUIRED',401,'That is the API client token (port 48270); the local MCP port needs mcp_token');
      throw new BridgeError('AUTH_REQUIRED',401,'Credential is invalid for this endpoint');
    }
    return realm === 'admin' ? this.admin : realm === 'api_client' ? this.apiClient : this.mcpClient;
  }
  private bearer(header:string|undefined):string {
    if (!header || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(header)) throw new BridgeError('AUTH_REQUIRED',401,'A bearer credential is required');
    return header.slice(7);
  }
  /** A stable identity for the local MCP host. It is not a grant and never expires,
   *  because a process that can read local-credentials.json is already trusted on this
   *  machine. It only exists on the loopback listener; the exposed listener refuses it. */
  /** Materialise the local MCP host as a real, audited principal. It is not a pairing grant:
   *  it never expires and needs no challenge, because a process that can read
   *  local-credentials.json is already trusted on this machine. It still goes through the
   *  normal store, scope checks and approval flow, and it exists only on the loopback
   *  listener; the exposed listener refuses this credential outright. Recreated whenever the
   *  epoch changes, so a restart invalidates the previous one. */
  ensureLocalMcpGrant(workspaceId:string):void {
    const runId = localMcpRunId(workspaceId);
    const grantId = localMcpGrantId(workspaceId);
    const existing = this.store.get<Grant>('grants',grantId);
    // A grant from an older epoch is stale (credentials rotate on restart), but revoking it
    // would be an UPDATE on the run binding's grant and the run itself is immutable. Leave the
    // old workspace's rows in place as history; this bind just writes its own.
    if (existing && existing.epoch === this.epoch && existing.revoked_at === null) return;
    this.store.transaction(() => {
      const principal:Principal = {id:LOCAL_MCP_PRINCIPAL_ID,kind:'remote_workspace',label:'Local MCP host (loopback)'};
      const run:Run = {id:runId,workspace_id:workspaceId,principal_id:principal.id,mode:'remote_workspace',execution_owner:'remote_workspace',state:'running',reason:null,policy_version:POLICY_VERSION,created_at:Date.now(),updated_at:Date.now()};
      const grant:Grant = {
        id:grantId,principal_id:principal.id,
        // Deliberately not the mcp_token hash: this identity is reached through
        // authenticateLocal on the loopback listener, never by presenting a bearer grant.
        // If it were the token hash, the local credential would become a valid grant and the
        // listener a tunnel forwards to would accept it.
        //
        // It must also not be one fixed constant. `grants_token_hash` is a UNIQUE index, so a
        // shared placeholder value allows exactly one local identity in the whole state file:
        // the only reason the old singleton "worked" was that there was only ever one row.
        // Derive it from this grant's own id instead. A derived value keeps the grant
        // individually addressable, still never matches a real secret, and no longer collides.
        // The `id:` prefix keeps the derivation domain-separated from sha256(token) — a bare
        // sha256(grant_id) is just "a digest", and this string is a bearer-credential lookup key.
        token_hash:sha256(`local-mcp-identity-has-no-bearer-token:${grantId}`),
        kind:'remote_workspace',
        workspace_id:workspaceId,run_id:run.id,access_mode:'code',
        scopes:['workspace:read','progress:write','workspace:patch'],
        expires_at:Number.MAX_SAFE_INTEGER,revoked_at:null,epoch:this.epoch,recipient:'Local MCP host',
        policy_version:POLICY_VERSION,challenge_hash:'',verified_at:Date.now(),
      };
      this.store.put('principals',principal);
      this.store.put('runs',run);
      this.store.put('grants',grant);
      this.store.event('grant.issued',{grant_id:grant.id,principal_id:principal.id,workspace_id:workspaceId,mode:grant.access_mode,execution_owner:run.execution_owner,local:true},{run_id:run.id});
    });
  }
  /** The identity a loopback MCP client acts as. Requires ensureLocalMcpGrant first.
   *  Scoped to the workspace it was granted for — the grant id is derived from workspace_id,
   *  so a context can never be silently borrowed from a different workspace's binding. */
  localMcpContext(workspaceId:string):InvocationContext {
    const principal = this.store.get<Principal>('principals',LOCAL_MCP_PRINCIPAL_ID)
      ?? {id:LOCAL_MCP_PRINCIPAL_ID,kind:'remote_workspace' as const,label:'Local MCP host (loopback)'};
    const grant = this.store.get<Grant>('grants',localMcpGrantId(workspaceId));
    if (!grant) throw new BridgeError('AUTHORIZATION_REQUIRED',403,'The local MCP identity is not active on this daemon');
    return { principal, grant, request_id:newId('req') };
  }
  /** Resolve the identity for an MCP request. On the loopback listener a local host may
   *  present the dedicated MCP credential instead of a pairing grant; on the listener a
   *  tunnel forwards to, only a grant is accepted. Both the HTTP layer and the transport's
   *  per-request resolver go through here, so they can never disagree. */
  resolveMcpContext(header:string|undefined, requestId:string, options:{allowLocal:boolean; workspaceId:string}):InvocationContext {
    try{return this.authenticateGrant(header,requestId);}
    catch(grantError){
      if(!options.allowLocal)throw grantError;
      try{this.authenticateLocal(header,'mcp_client');return this.localMcpContext(options.workspaceId);}
      catch(localError){
        // "Unknown workspace credential" hides which credential was actually presented.
        // Prefer the specific diagnosis when the local check has one.
        const specific = localError instanceof BridgeError && localError.message !== 'Credential is invalid for this endpoint';
        throw specific ? localError : grantError;
      }
    }
  }
  authenticateGrant(header:string|undefined, requestId:string):InvocationContext {
    const hash = sha256(this.bearer(header));
    const grant = this.store.all<Grant>('grants').find(g => equal(g.token_hash,hash));
    if (!grant) throw new BridgeError('AUTH_REQUIRED',401,'Unknown workspace credential');
    const principal = this.store.get<Principal>('principals',grant.principal_id);
    if (!principal) throw new BridgeError('AUTH_REQUIRED',401,'Unknown principal');
    const context = {principal,grant,request_id:requestId};
    this.assertActive(context);
    return context;
  }
  assertActive(context:InvocationContext):Grant {
    const grant = this.store.get<Grant>('grants',context.grant.id);
    if (!grant || grant.principal_id !== context.principal.id || grant.epoch !== this.epoch || grant.revoked_at !== null || grant.expires_at <= Date.now()) throw new BridgeError('AUTHORIZATION_REQUIRED',403,'Grant expired or revoked');
    const run = this.store.get<Run>('runs',grant.run_id);
    if (!run || TERMINAL_STATES.has(run.state)) throw new BridgeError('POLICY_DENIED',403,'Run no longer permits new actions');
    if (run.workspace_id !== grant.workspace_id || run.principal_id !== grant.principal_id) throw new BridgeError('POLICY_DENIED',403,'Run binding mismatch');
    return grant;
  }
  authorize(context:InvocationContext, scope:string, opts:{write?:boolean;allowUnverified?:boolean} = {}):Grant {
    const grant = this.assertActive(context);
    const run = this.store.get<Run>('runs',grant.run_id)!;
    // Worker self-declarations and client-tools profiles never gain execution permission.
    if (grant.kind !== 'remote_workspace' || context.principal.kind !== 'remote_workspace' || run.execution_owner !== 'remote_workspace') throw new BridgeError('POLICY_DENIED',403,'This identity cannot execute workspace tools');
    if (!opts.allowUnverified && grant.verified_at === null) throw new BridgeError('AUTHORIZATION_REQUIRED',403,'Complete the pairing challenge first');
    if (!grant.scopes.includes(scope)) throw new BridgeError('POLICY_DENIED',403,'Grant does not include the required scope');
    // `exec` may write too: a shell can already write files, so refusing the patch scope here
    // would be a limit in name only.
    if (opts.write && grant.access_mode !== 'code' && grant.access_mode !== 'exec') throw new BridgeError('POLICY_DENIED',403,'Ask and Plan are read-only');
    return grant;
  }
  createPairing(input:unknown):Record<string,unknown> {
    const arg = PairingInput.parse(input);
    if (!this.store.get<Workspace>('workspaces',arg.workspace_id)) throw new BridgeError('NOT_FOUND',404,'Workspace not found');
    const active = this.store.all<Pairing>('pairings').filter(p => p.expires_at > Date.now() && p.state !== 'consumed');
    if (active.length >= 32) throw new BridgeError('QUEUE_FULL',429,'Too many pending pairings');
    const code = newSecret();
    // 0 (or omitted) is recorded as 0 and turned into the no-expiry sentinel at claim time, so
    // the stored pairing keeps saying what the caller asked for rather than an inflated number.
    const grantTtl = arg.grant_ttl_ms ?? 0;
    const pairing:Pairing = {id:newId('pair'),code_hash:sha256(code),claim_hash:null,workspace_id:arg.workspace_id,recipient:arg.recipient,max_access:arg.max_access,requested_access:null,approved_access:null,remote_label:null,state:'created',expires_at:Date.now()+arg.ttl_ms,grant_ttl_ms:grantTtl,epoch:this.epoch};
    this.store.put('pairings',pairing);
    this.store.event('pairing.created',{workspace_id:arg.workspace_id,recipient_hash:sha256(arg.recipient)});
    return {pair_id:pairing.id,code,expires_at:pairing.expires_at,workspace_id:arg.workspace_id,recipient:arg.recipient,warning:'Short-lived pairing secret; no workspace access before local approval'};
  }
  requestPairing(input:unknown):Record<string,unknown> {
    const arg = z.object({code:z.string().min(32).max(256),remote_label:z.string().min(1).max(80),access_mode:z.enum(ACCESS_MODES).default('ask')}).strict().parse(input);
    return this.store.transaction(() => {
      const p = this.store.all<Pairing>('pairings').find(p => equal(p.code_hash,sha256(arg.code)));
      if (!p || p.state !== 'created' || p.expires_at <= Date.now() || p.epoch !== this.epoch) throw new BridgeError('AUTHORIZATION_REQUIRED',403,'Pairing code expired, used or invalid');
      if (RANK[arg.access_mode] > RANK[p.max_access]) throw new BridgeError('POLICY_DENIED',403,'Requested access exceeds pairing scope');
      const claim = newSecret();
      this.store.put('pairings',{...p,state:'pending',remote_label:arg.remote_label,requested_access:arg.access_mode,claim_hash:sha256(claim)});
      this.store.event('pairing.requested',{workspace_id:p.workspace_id,mode:arg.access_mode});
      return {pair_id:p.id,claim_secret:claim,state:'pending',expires_at:p.expires_at};
    });
  }
  pendingPairings():unknown[] {
    return this.store.all<Pairing>('pairings').filter(p=>p.state==='pending'&&p.expires_at>Date.now()&&p.epoch===this.epoch).map(p=>({pair_id:p.id,workspace_id:p.workspace_id,remote_label:p.remote_label,requested_access:p.requested_access,recipient:p.recipient,expires_at:p.expires_at,data_categories:['file content','relative paths','diffs'],path:'loopback MCP only in stage1',warning:'Read results leave the local process. Remote storage/publication depends on the recipient.'}));
  }
  approvePairing(id:string,input:unknown):unknown {
    const arg=z.object({approve:z.boolean(),access_mode:z.enum(ACCESS_MODES),data_egress_ack:z.literal(true)}).strict().parse(input);
    return this.store.transaction(()=>{
      const p=this.store.get<Pairing>('pairings',id);
      if(!p||p.state!=='pending'||p.expires_at<=Date.now()||p.epoch!==this.epoch) throw new BridgeError('VERSION_CONFLICT',409,'Pairing is not pending');
      if(!p.requested_access||RANK[arg.access_mode]>RANK[p.requested_access]) throw new BridgeError('POLICY_DENIED',403,'Approval cannot exceed requested permissions');
      this.store.put('pairings',{...p,state:arg.approve?'approved':'denied',approved_access:arg.access_mode});
      this.store.event('pairing.decided',{state:arg.approve?'approved':'denied',mode:arg.access_mode});
      return {pair_id:id,state:arg.approve?'approved':'denied'};
    });
  }
  claimPairing(input:unknown):Record<string,unknown> {
    const arg=z.object({pair_id:z.string(),claim_secret:z.string().min(32).max(256)}).strict().parse(input);
    return this.store.transaction(()=>{
      const p=this.store.get<Pairing>('pairings',arg.pair_id);
      if(!p||!p.claim_hash||!equal(p.claim_hash,sha256(arg.claim_secret))||p.expires_at<=Date.now()||p.epoch!==this.epoch) throw new BridgeError('AUTHORIZATION_REQUIRED',403,'Invalid pairing claim');
      if(p.state==='pending') return {pair_id:p.id,state:'pending'};
      if(p.state!=='approved'||!p.approved_access) throw new BridgeError('AUTHORIZATION_REQUIRED',403,'Pairing is denied or already consumed');
      const principal:Principal={id:newId('principal'),kind:'remote_workspace',label:p.remote_label??'Remote Agent'};
      const run:Run={id:newId('run'),workspace_id:p.workspace_id,principal_id:principal.id,mode:'remote_workspace',execution_owner:'remote_workspace',state:'running',reason:null,policy_version:POLICY_VERSION,created_at:Date.now(),updated_at:Date.now()};
      const token=newSecret(),challenge=newSecret();
      const grant:Grant={id:newId('grant'),principal_id:principal.id,token_hash:sha256(token),kind:'remote_workspace',workspace_id:p.workspace_id,run_id:run.id,access_mode:p.approved_access,scopes:scopesFor(p.approved_access),expires_at:p.grant_ttl_ms>0?Date.now()+p.grant_ttl_ms:GRANT_NO_EXPIRY_AT,revoked_at:null,epoch:this.epoch,recipient:p.recipient,policy_version:POLICY_VERSION,challenge_hash:sha256(challenge),verified_at:null};
      this.store.put('principals',principal); this.store.put('runs',run); this.store.put('grants',grant); this.store.put('pairings',{...p,state:'consumed'});
      this.store.event('grant.issued',{grant_id:grant.id,principal_id:principal.id,workspace_id:run.workspace_id,mode:grant.access_mode,execution_owner:run.execution_owner},{run_id:run.id});
      return {state:'approved',token,challenge,grant_id:grant.id,run_id:run.id,workspace_id:run.workspace_id,workspace_name:this.store.get<Workspace>('workspaces',run.workspace_id)!.display_name,access_mode:grant.access_mode,scopes:grant.scopes,expires_at:grant.expires_at,execution_owner:run.execution_owner};
    });
  }
  verifyChallenge(context:InvocationContext,challenge:string):void {
    const grant=this.authorize(context,'workspace:read',{allowUnverified:true});
    if(!equal(sha256(challenge),grant.challenge_hash)) throw new BridgeError('AUTHORIZATION_REQUIRED',403,'Challenge mismatch');
    if(grant.verified_at===null) { this.store.put('grants',{...grant,verified_at:Date.now()}); this.store.event('grant.verified',{grant_id:grant.id},{run_id:grant.run_id}); }
  }
  requestApproval(context:InvocationContext,patchId:string,paramsHash:string):Approval {
    const grant=this.authorize(context,'workspace:patch',{write:true});
    // The operator has to read a diff before deciding, so 120s was too tight for a real
    // review and approvals were expiring mid-read. Five minutes is the default; the grant
    // expiry still caps it, so this never outlives the authorization that justifies it.
    const approvalTtlMs=Number(process.env.ARENABRIDGE_APPROVAL_TTL_MS ?? 300000);
    const ttl=Number.isFinite(approvalTtlMs)&&approvalTtlMs>0?approvalTtlMs:300000;
    const approval:Approval={id:newId('approval'),run_id:grant.run_id,grant_id:grant.id,action:'workspace.patch',params_hash:paramsHash,description:`Apply reviewed patch ${patchId}`,state:'pending',approver_id:null,expires_at:Math.min(Date.now()+ttl,grant.expires_at),created_at:Date.now()};
    this.store.put('approvals',approval);
    this.store.transition(grant.run_id,'waiting_for_approval','patch_requires_local_approval');
    this.store.event('approval.requested',{approval_id:approval.id,patch_id:patchId,params_hash:paramsHash},{run_id:grant.run_id,request_id:context.request_id});
    // Unattended mode: decide it here instead of waiting for the operator. This is the one place
    // every write funnels through, so honouring the setting in a single spot means no write path
    // can bypass it by construction. The decision is recorded as an approval with an explicit
    // approver, NOT as a missing approval, so the audit trail still shows that a write was
    // authorised and by what.
    const auto=this.autoApprove();
    if(auto) {
      const decided:Approval={...approval,state:'approved',approver_id:AUTO_APPROVER_ID};
      this.store.put('approvals',decided);
      this.store.transition(grant.run_id,'running','auto_approved_unattended_write');
      this.store.event('approval.auto_approved',{approval_id:approval.id,patch_id:patchId,params_hash:paramsHash,expires_at:auto.expires_at},{run_id:grant.run_id,request_id:context.request_id});
      return decided;
    }
    return approval;
  }
  /**
   * Unattended write mode. When enabled, every `apply_patch` is approved the moment it is
   * requested — no diff is read by anyone before the file is written.
   *
   * This deliberately removes the property the bridge exists to provide (execution stays local
   * *and supervised*): if the remote agent is steered by a prompt-injection payload in any file it
   * reads, whatever it writes lands on this disk unreviewed. It is therefore opt-in, always
   * time-boxed to an explicit deadline (never open-ended), and revocable at any moment. The
   * default is off, and an unset or unparseable setting can never enable it.
   *
   * Stored in settings rather than in memory so that a restart cannot silently drop it, and so
   * the operator can see it in the same place as everything else. `expires_at` is enforced on
   * every read, so an expired window stops applying without anything having to run.
   */
  autoApprove():{expires_at:number;unlimited:boolean}|null {
    const row=this.store.get<{id:string;value?:{enabled?:boolean;expires_at?:number;reason?:string}}>('settings',AUTO_APPROVE_SETTING_ID);
    const value=row?.value;
    if(!value||value.enabled!==true) return null;
    const expires=value.expires_at;
    // Unlimited is the explicit 0 sentinel. A null/undefined/NaN must NOT be read as unlimited —
    // that would turn a corrupt or half-written row into an unbounded window.
    if(expires===AUTO_APPROVE_NO_EXPIRY) return {expires_at:AUTO_APPROVE_NO_EXPIRY,unlimited:true};
    if(typeof expires!=='number'||!Number.isFinite(expires)) return null;
    if(expires<=Date.now()) return null;
    return {expires_at:expires,unlimited:false};
  }
  /**
   * Enables or disables unattended writes. `ttlMs` is optional and may be 0 / omitted, which means
   * "no expiry" — the window stays on until someone turns it off. Disabling is still unconditional
   * and always available, which is what makes an unbounded window acceptable: the off switch does
   * not depend on a timer. Both transitions are audited, including who turned it off.
   */
  setAutoApprove(enabled:boolean,ttlMs?:number):{enabled:boolean;expires_at:number|null;unlimited:boolean} {
    if(!enabled) {
      this.store.put('settings',{id:AUTO_APPROVE_SETTING_ID,value:{enabled:false,expires_at:null,updated_at:Date.now()}});
      this.store.event('auto_approve.disabled',{}, {});
      return {enabled:false,expires_at:null,unlimited:false};
    }
    // A negative or non-finite ttl is still a caller bug, and silently treating it as "unlimited"
    // would be the worst possible reading of a malformed request.
    if(ttlMs!==undefined&&(!Number.isFinite(ttlMs)||ttlMs<0)) throw new BridgeError('INVALID_ARGUMENT',400,'ttl_ms must be a non-negative number of milliseconds, or omitted for no expiry');
    const unlimited=ttlMs===undefined||ttlMs===0;
    const expires_at=unlimited?AUTO_APPROVE_NO_EXPIRY:Date.now()+ttlMs;
    this.store.put('settings',{id:AUTO_APPROVE_SETTING_ID,value:{enabled:true,expires_at,updated_at:Date.now()}});
    this.store.event('auto_approve.enabled',{expires_at,ttl_ms:unlimited?null:ttlMs,unlimited,effect:'apply_patch is approved without a human reading the diff'}, {});
    return {enabled:true,expires_at,unlimited};
  }
  decideApproval(id:string,approved:boolean):Approval {
    const a=this.store.get<Approval>('approvals',id);
    if(!a||a.state!=='pending'||a.expires_at<=Date.now()) throw new BridgeError('VERSION_CONFLICT',409,'Approval is not pending');
    const grant=this.store.get<Grant>('grants',a.grant_id);
    if(!grant||grant.epoch!==this.epoch||grant.revoked_at!==null||grant.expires_at<=Date.now()) throw new BridgeError('AUTHORIZATION_REQUIRED',403,'Approval grant is inactive');
    const run=this.store.get<Run>('runs',a.run_id);
    if(!run||TERMINAL_STATES.has(run.state)) throw new BridgeError('POLICY_DENIED',403,'Run ended');
    const next:Approval={...a,state:approved?'approved':'denied',approver_id:this.admin.id};
    this.store.put('approvals',next);
    if(run.state==='waiting_for_approval') this.store.transition(a.run_id,'running',approved?'approval_granted':'approval_denied');
    this.store.event('approval.decided',{approval_id:a.id,state:next.state},{run_id:a.run_id});
    return next;
  }
  consumeApproval(context:InvocationContext,id:string,paramsHash:string):void {
    this.authorize(context,'workspace:patch',{write:true});
    this.store.transaction(()=>{
      const a=this.store.get<Approval>('approvals',id);
      if(!a||a.run_id!==context.grant.run_id||a.grant_id!==context.grant.id||a.state!=='approved'||a.expires_at<=Date.now()||a.action!=='workspace.patch'||!equal(a.params_hash,paramsHash)) throw new BridgeError('APPROVAL_REQUIRED',403,'A matching, unexpired, unused local approval is required');
      this.store.put('approvals',{...a,state:'consumed'});
      this.store.event('approval.consumed',{approval_id:id,params_hash:paramsHash},{run_id:a.run_id,request_id:context.request_id});
    });
  }
  revokeAll():Record<string,unknown> {
    this.epoch++;
    this.store.put('settings',{id:'epoch',value:this.epoch});
    let count=0;
    for(const g of this.store.all<Grant>('grants')) if(g.revoked_at===null){this.store.put('grants',{...g,revoked_at:Date.now()});count++;}
    this.store.event('grants.revoked_all',{epoch:this.epoch,count});
    return {revoked_grants:count,epoch:this.epoch,new_actions_blocked:true,running_actions:'Revocation is not a process-termination guarantee; PTY is unavailable in stage1'};
  }
}
