import path from 'node:path';
import { z } from 'zod';
import { BridgeError, PageSchema, PathSchema, digest, publicError, type InvocationContext, type ToolResult, type Workspace } from '../../../packages/contracts/src/index.js';
import { Store } from '../../../packages/storage/src/index.js';
import { PolicyEngine } from '../../../packages/policy-engine/src/index.js';
import { WorkspaceFiles } from '../../../packages/workspace-tools/src/files.js';
import { PatchEngine, type PatchPreview } from '../../../packages/workspace-tools/src/patches.js';
import { CommandRunner, COMMAND_DEFAULT_TIMEOUT_MS, COMMAND_MAX_TIMEOUT_MS } from '../../../packages/workspace-tools/src/command.js';
import type { SkillRegistry } from '../../../packages/skills/src/index.js';

const Changes=z.array(z.object({path:PathSchema,patch:z.string().min(1).max(1024*1024),expected_hash:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict()).min(1).max(10);
export const ToolSchemas={
  bridge_health:z.object({challenge:z.string().min(32).max(256).optional()}).strict(),
  list_directory:z.object({path:PathSchema.default('.'),...PageSchema}).strict(),
  find_files:z.object({root:PathSchema.default('.'),globs:z.array(z.string().max(200)).min(1).max(16),exclude:z.array(z.string().max(200)).max(16).optional(),...PageSchema}).strict(),
  search_files:z.object({root:PathSchema.default('.'),pattern:z.string().min(1).max(1024),case_sensitive:z.boolean().default(false),regex:z.boolean().default(false),globs:z.array(z.string().max(200)).min(1).max(16).optional(),...PageSchema}).strict(),
  read_files:z.object({files:z.array(z.object({path:PathSchema,start_line:z.number().int().positive().optional(),end_line:z.number().int().positive().optional()}).strict()).min(1).max(16)}).strict(),
  apply_patch:z.discriminatedUnion('action',[
    z.object({action:z.literal('preview'),changes:Changes}).strict(),
    z.object({action:z.literal('apply'),patch_id:z.string().max(80),approval_id:z.string().max(80)}).strict(),
    // Single-shot write. Accepted only while the unattended-write window is open, and refused
    // outright otherwise — see the branch below for why that gate is re-checked here instead of
    // being trusted from the request.
    z.object({action:z.literal('write'),changes:Changes}).strict()
  ]),
  // String-replacement edit: the same pipeline as apply_patch, with the diff derived from the
  // file's current bytes instead of being authored by the caller.
  edit_file:z.object({path:PathSchema,old_string:z.string().min(1).max(1024*1024),new_string:z.string().max(1024*1024),expected_hash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),replace_all:z.boolean().default(false)}).strict(),
  run_command:z.object({command:z.string().min(1).max(4096),cwd:PathSchema.optional(),timeout_ms:z.number().int().positive().max(COMMAND_MAX_TIMEOUT_MS).optional()}).strict(),
  set_todos:z.object({items:z.array(z.object({id:z.string().min(1).max(64),title:z.string().min(1).max(200),status:z.enum(['pending','in_progress','completed'])}).strict()).max(50)}).strict(),
  report_progress:z.object({stage:z.string().min(1).max(100),message:z.string().min(1).max(500)}).strict(),
  lsp:z.object({operation:z.enum(['workspace_symbols','document_symbols','definition','references','implementation','hover']),path:PathSchema.optional(),line:z.number().int().positive().optional(),character:z.number().int().nonnegative().optional()}).strict(),
  get_diagnostics:z.object({path:PathSchema.optional()}).strict(),
  // Skills live outside the workspace (under the application directory), so they are addressed by
  // skill name rather than by a workspace path. `read_skill` takes an optional `file` so reading a
  // bundled resource does not need a third tool — and because `read_files` cannot reach them: it
  // is workspace-scoped by design, and widening it to the skills root would widen every read.
  list_skills:z.object({}).strict(),
  read_skill:z.object({name:z.string().min(1).max(64),file:z.string().min(1).max(300).optional()}).strict()
};
export type ToolName=keyof typeof ToolSchemas;
export const ToolDescriptions:Record<ToolName,string>={
  bridge_health:'Confirm the one-time pairing challenge and obtain sanitized workspace readiness; does not grant write access.',
  list_directory:'List immediate authorized children. Bounded pagination; hidden policy paths and links are omitted.',
  find_files:'Find authorized files using bounded glob patterns relative to root. Depth and scan limits are explicit.',
  search_files:'Bounded text search in UTF-8 files; regex=true uses a real regex, matched off the main thread under a 2s budget so a pathological pattern cannot wedge the bridge.',
  read_files:'Read up to 16 UTF-8 files or line ranges, preserving raw-byte SHA256 versions, BOM and newline metadata. No unsaved editor buffers.',
  apply_patch:'Preview a create/update unified diff batch first; apply requires a separate local single-use approval and unchanged file versions. action=write does the same in one call, but only while the local unattended-write window is open. Delete/move unsupported.',
  edit_file:'Replace an exact string in one file (the file must already exist; use apply_patch to create one). The diff is computed from the current bytes and goes through the same preview/approval/apply pipeline as apply_patch. old_string must be unique unless replace_all is set. expected_hash pins the version you read; omitted means "against the content now", which a concurrent change still fails.',
  run_command:'Run a shell command inside the workspace with the daemon user\'s privileges. Requires the exec access tier. Bounded by a timeout (default 30s, max 300s) and per-stream output caps; the process tree is killed on timeout, disconnect, revoke or shutdown. No interactive input (no PTY).',
  set_todos:'Replace this run\'s local task list. Status is a report, not verified task success.',
  report_progress:'Record an application progress event for this run; not an MCP protocol progress notification.',
  lsp:'Semantic operations require a real IDE/LSP adapter. Stage1 returns capability_unavailable, never text-search substitutes.',
  get_diagnostics:'Real language-service diagnostics require an IDE adapter. Stage1 returns capability_unavailable.',
  list_skills:'List the Agent Skills the operator installed on this machine, as metadata only: name and description, never the body. This is progressive disclosure stage 1, and it exists so you can decide which skill to open without paying for every skill\'s full text. Skills are read-only documentation; nothing in this listing can execute anything, and a skill\'s `allowed-tools` field is reported for you to read but grants no permission.',
  read_skill:'Read one installed skill: its full SKILL.md body and the inventory of files bundled with it, or with `file` a single bundled file (references/, assets/, scripts/). Progressive disclosure stages 2 and 3. Reading a skill never grants execution: a skill may describe a command, but to run one you must use run_command and hold the exec tier like any other command.'
};
interface WorkspaceRuntime {workspace:Workspace;files:WorkspaceFiles;patches:PatchEngine;commands:CommandRunner;}
export class ToolHost {
  private readonly workspaces=new Map<string,WorkspaceRuntime>();
  private active=0;
  readonly maxParallel=4;
  constructor(readonly store:Store,readonly policy:PolicyEngine,readonly stateDirectory:string,readonly skills:SkillRegistry){}
  async attach(workspace:Workspace):Promise<void>{
    const files=await WorkspaceFiles.open(workspace.root);
    files.protectDirectory(this.stateDirectory);
    const patches=new PatchEngine(files,path.join(this.stateDirectory,'workspaces',workspace.id));
    this.workspaces.set(workspace.id,{workspace,files,patches,commands:new CommandRunner(files)});
  }
  /**
   * The compact shape every write response uses. The diff is not echoed: the caller received it
   * with the preview, the bytes are on disk by the time anything is returned, and re-sending it
   * doubled the response for no decision value — a 37KB patch came back as another 37KB the agent
   * had just read (measured on a real run). Hashes and per-file sizes are kept instead, so the
   * caller can still tell exactly what landed and compare it with what it previewed.
   */
  private patchSummary(p:PatchPreview){return {id:p.id,state:p.state,digest:p.digest,created_at:p.created_at,
    changes:p.changes.map(({path,before_hash,after_hash,diff})=>({path,before_hash,after_hash,diff_bytes:Buffer.byteLength(diff,'utf8')}))};}
  /** Applies a prepared patch, consuming the one-time approval at commit time. */
  private commitPatch(runtime:WorkspaceRuntime,context:InvocationContext,patchId:string,approvalId:string,paramsHash:string,signal?:AbortSignal):Promise<PatchPreview>{
    return runtime.patches.apply(patchId,()=>{
      if(signal?.aborted)throw new BridgeError('CLIENT_DISCONNECTED',499,'Request was cancelled before commit');
      this.policy.consumeApproval(context,approvalId,paramsHash);
    });
  }
  /**
   * Terminates every command in flight.
   *
   * Called when access is revoked, when a run is cancelled and when the daemon stops. "Revoked"
   * has to mean the process is gone — refusing new requests while a build keeps running would
   * leave the operator with something they can neither see nor stop.
   */
  killCommands(reason:string):number{let count=0;for(const runtime of this.workspaces.values())count+=runtime.commands.killAll(reason);return count;}
  async recover(workspaceId:string):Promise<PatchPreview[]>{return this.runtime(workspaceId).patches.recover();}
  private runtime(id:string):WorkspaceRuntime{
    const r=this.workspaces.get(id);if(!r)throw new BridgeError('CAPABILITY_UNAVAILABLE',503,'Workspace is not mounted');return r;
  }
  /**
   * Read-only directory listing for the local operator UI. This deliberately bypasses the
   * grant/`remote_workspace` gate: the caller is already an authenticated local admin on the
   * loopback control plane, and the console must be able to show the operator the tree they
   * are about to approve a patch against. It reuses the exact same path policy as the MCP
   * tool, so nothing is reachable here that the agent could not reach.
   */
  async adminListDirectory(workspaceId:string,arg:{path?:string;limit?:number;cursor?:number}):Promise<{entries:{path:string;name:string;type:string;size?:number}[];truncated:boolean;next_cursor:number|null}>{
    return this.runtime(workspaceId).files.listDirectory(arg);
  }
  /**
   * Read-only single-file read for the operator UI. Same policy as `read_files`, no write path.
   * The viewer wants the whole file, so this reads once and reports whether the 256 KiB output
   * budget cut it short; `next_line` then tells the UI where to resume.
   */
  async adminReadFile(workspaceId:string,relative:string):Promise<{path:string;text:string;version_hash:string;eol:string;truncated:boolean;next_line:number|null}>{
    const {files}=await this.runtime(workspaceId).files.readFiles({files:[{path:relative}]});
    const file=files[0]!;
    return {path:file.path,text:file.text,version_hash:file.version_hash,eol:file.eol,truncated:file.truncated,next_line:file.next_line};
  }
  catalog(context:InvocationContext):ToolName[]{
    const grant=this.policy.assertActive(context);
    if(grant.kind!=='remote_workspace'||context.principal.kind!=='remote_workspace')return [];
    const names=Object.keys(ToolSchemas) as ToolName[];
    // apply_patch needs a write tier; run_command needs `exec` specifically, so a code-scoped
    // pairing can never run a command no matter what it asks for.
    const writable=grant.access_mode==='code'||grant.access_mode==='exec';
    return names.filter(name=>(name!=='apply_patch'||writable)&&(name!=='edit_file'||writable)&&(name!=='run_command'||grant.access_mode==='exec'));
  }
  async previewForAdmin(workspaceId:string,id:string):Promise<PatchPreview>{return this.runtime(workspaceId).patches.get(id);}
  private boundPatch(context:InvocationContext,id:string):void{
    const binding=this.store.get<{id:string;run_id:string;grant_id:string}>('settings',`patch:${id}`);
    if(!binding||binding.run_id!==context.grant.run_id||binding.grant_id!==context.grant.id)throw new BridgeError('POLICY_DENIED',403,'Patch belongs to a different grant or run');
  }
  async call(name:string,args:unknown,context:InvocationContext,signal?:AbortSignal):Promise<ToolResult>{
    const start=performance.now();
    const auditContext={run_id:context.grant.run_id,request_id:context.request_id,source:'workspace-tools'};
    const metadata=(audit_id:string,truncated=false,next_cursor?:number|null)=>({audit_id,duration_ms:Math.round(performance.now()-start),truncated,...(next_cursor===undefined?{}:{next_cursor}),execution_owner:'remote_workspace' as const,source:'local' as const});
    let admitted=false;
    try{
      if(signal?.aborted)throw new BridgeError('CLIENT_DISCONNECTED',499,'Request was cancelled before execution');
      if(!Object.hasOwn(ToolSchemas,name))throw new BridgeError('UNSUPPORTED_CAPABILITY',422,'Unknown tool');
      this.policy.assertActive(context);
      if(this.active>=this.maxParallel)throw new BridgeError('QUEUE_FULL',429,'Local tool concurrency budget is full; no work was queued');
      this.active++;admitted=true;
      const runtime=this.runtime(context.grant.workspace_id);let data:unknown;
      if(name==='bridge_health'){
        const a=ToolSchemas.bridge_health.parse(args);
        this.policy.authorize(context,'workspace:read',{allowUnverified:true});
        if(a.challenge)this.policy.verifyChallenge(context,a.challenge);
        const grant=this.policy.assertActive(context);
        data={workspace_id:runtime.workspace.id,workspace_name:runtime.workspace.display_name,run_id:grant.run_id,execution_owner:'remote_workspace',access_mode:grant.access_mode,challenge_verified:grant.verified_at!==null,local_ready:true,public_reachability:'not_tested',protocol_ready:grant.verified_at!==null,expires_at:grant.expires_at,recipient:grant.recipient};
      }else if(name==='list_skills'||name==='read_skill'){
        // Skills sit outside the workspace, so this is its own scope rather than a widening of
        // `workspace:read`. It is granted in every access mode: reading documentation the operator
        // installed changes nothing, and an `ask`-tier caller that cannot see the operator's own
        // instructions cannot follow them either.
        this.policy.authorize(context,'skills:read');
        if(name==='list_skills'){
          ToolSchemas.list_skills.parse(args);
          data={skills:this.skills.list(),count:this.skills.size,
            // Reported rather than swallowed: a skill that failed validation, or one shadowed by a
            // same-named skill in an earlier root, is the difference between "not installed" and
            // "installed and silently not loading", and only the caller can tell the operator.
            invalid:this.skills.problemsList,shadowed:this.skills.shadowedList,
            note:'Metadata only by design — this is progressive disclosure stage 1. Call read_skill to open one. Nothing here grants execution.'};
        }else{
          const a=ToolSchemas.read_skill.parse(args);
          if(a.file){
            const file=await this.skills.readFile(a.name,a.file);
            if(!file)throw new BridgeError('NOT_FOUND',404,`No such skill file: ${a.name}/${a.file}`);
            data={...file,execution_owner:'remote_workspace'};
          }else{
            const skill=await this.skills.read(a.name);
            if(!skill)throw new BridgeError('NOT_FOUND',404,`No such skill: ${a.name}`);
            data={...skill,execution_owner:'remote_workspace',
              execution_note:'Reading a skill grants no execution. A skill may describe a command; running one still requires run_command and the exec tier.'};
          }
        }
      }else if(name==='apply_patch'){
        this.policy.authorize(context,'workspace:patch',{write:true});const a=ToolSchemas.apply_patch.parse(args);
        if(a.action==='preview'){
          const preview=await runtime.patches.prepare({changes:a.changes});
          this.policy.assertActive(context);
          this.store.put('settings',{id:`patch:${preview.id}`,run_id:context.grant.run_id,grant_id:context.grant.id});
          const approval=this.policy.requestApproval(context,preview.id,preview.digest);
          // Report the approval's real state rather than assuming a human is needed. With
          // unattended writes on, `requestApproval` has already approved this, and hard-coding
          // "waiting_for_approval" would tell the remote to stop and wait for a step that is
          // never coming — it would deadlock against a switch that already let it through.
          const autoApproved=approval.state==='approved';
          data={preview,approval_id:approval.id,state:autoApproved?'approved':'waiting_for_approval',
            effect:autoApproved?'No project files changed yet; this preview was auto-approved and can be applied immediately':'No project files changed; local operator must approve the exact digest'};
        }else if(a.action==='write'){
          // Preview + approval + apply in one call. This exists because with the unattended
          // window open there is nothing to wait for between the two steps — the approval is
          // produced automatically — so the second round trip buys nothing but latency.
          //
          // What it does NOT do is bypass the approval: the decision is still made and recorded
          // by `requestApproval` (approver `auto_unattended`, event `approval.auto_approved`),
          // the bytes are still bound to the exact digest the caller previewed, and the hash
          // check is unchanged. The gate is re-read here rather than inferred from the request,
          // because this is the one shape that must never work while a human is meant to be
          // reading the diffs: with the window closed it is refused, so `code` on its own can
          // never write without an approval.
          if(!this.policy.autoApprove()) throw new BridgeError('POLICY_DENIED',403,'apply_patch action=write is only available while the unattended-write window is open; use action=preview then action=apply');
          const preview=await runtime.patches.prepare({changes:a.changes});
          this.policy.assertActive(context);
          this.store.put('settings',{id:`patch:${preview.id}`,run_id:context.grant.run_id,grant_id:context.grant.id});
          const approval=this.policy.requestApproval(context,preview.id,preview.digest);
          if(approval.state!=='approved'){
            // The window lapsed between the check above and the approval request. Waiting for a
            // human would be exactly the stall the auto-approval exists to prevent, so this
            // returns the ordinary preview instead: nothing was written, the patch is parked,
            // and the caller (or the operator) can finish it through the two-step path.
            data={preview,approval_id:approval.id,state:'waiting_for_approval',
              effect:'The unattended-write window closed before this write was authorised; nothing was written. A local approval is now required: call action=apply with this approval_id once the operator has approved.'};
          }else{
            const applied=await this.commitPatch(runtime,context,preview.id,approval.id,preview.digest,signal);
            data={patch:this.patchSummary(applied),state:'applied',effect:'already_executed',execution_owner:'remote_workspace'};
          }
        }else{
          this.boundPatch(context,a.patch_id);
          const preview=await runtime.patches.get(a.patch_id);
          const applied=await this.commitPatch(runtime,context,a.patch_id,a.approval_id,preview.digest,signal);
          data={patch:this.patchSummary(applied),effect:'already_executed',execution_owner:'remote_workspace'};
        }
      }else if(name==='edit_file'){
        this.policy.authorize(context,'workspace:patch',{write:true});const a=ToolSchemas.edit_file.parse(args);
        // A string replacement is compiled into an exact diff against the current bytes and then
        // handed to the very same pipeline as apply_patch: same hash binding, same single-use
        // approval, same journal. It is a friendlier way to author a change, not a second way to
        // write one.
        const preview=await runtime.patches.prepareEdit({path:a.path,old_string:a.old_string,new_string:a.new_string,expected_hash:a.expected_hash,replace_all:a.replace_all});
        this.policy.assertActive(context);
        this.store.put('settings',{id:`patch:${preview.id}`,run_id:context.grant.run_id,grant_id:context.grant.id});
        const approval=this.policy.requestApproval(context,preview.id,preview.digest);
        if(approval.state!=='approved'){
          data={preview,approval_id:approval.id,state:'waiting_for_approval',
            effect:'No project files changed; the local operator must approve the exact digest, then call apply_patch action=apply with this approval_id.'};
        }else{
          const applied=await this.commitPatch(runtime,context,preview.id,approval.id,preview.digest,signal);
          data={patch:this.patchSummary(applied),state:'applied',effect:'already_executed',execution_owner:'remote_workspace'};
        }
      }else if(name==='run_command'){
        this.policy.authorize(context,'workspace:exec');
        const a=ToolSchemas.run_command.parse(args);
        const result=await runtime.commands.run({command:a.command,cwd:a.cwd,timeout_ms:a.timeout_ms,signal});
        // This capability has no approval step, so this event is the operator's only record of
        // what ran. The command text is kept (truncated and Bearer-redacted by the store) and
        // hashed in full, so a log line can always be tied to one exact command line.
        this.store.event('command.completed',{action:'run_command',exit_code:result.exit_code,duration_ms:result.duration_ms,
          timed_out:result.timed_out,stdout_bytes:result.stdout_bytes,stderr_bytes:result.stderr_bytes,truncated:result.truncated,
          command_hash:digest({command:result.command,cwd:result.cwd}),command_preview:result.command,shell:result.shell},
          {run_id:context.grant.run_id,request_id:context.request_id});
        data=result;
      }else if(name==='set_todos'){
        this.policy.authorize(context,'progress:write');const a=ToolSchemas.set_todos.parse(args);
        if(new Set(a.items.map(i=>i.id)).size!==a.items.length)throw new BridgeError('INVALID_ARGUMENT',400,'Todo identifiers must be unique');
        this.store.put('todos',{id:context.grant.run_id,items:a.items});data={items:a.items};
      }else if(name==='report_progress'){
        this.policy.authorize(context,'progress:write');const a=ToolSchemas.report_progress.parse(args);
        // User text stays in explicitly managed run state, not the diagnostic event log.
        this.store.put('settings',{id:`progress:${context.grant.run_id}`,stage:a.stage,message:a.message,updated_at:Date.now()});data={recorded:true,kind:'application_progress'};
      }else{
        this.policy.authorize(context,'workspace:read');
        switch(name){
          case 'list_directory':data=await runtime.files.listDirectory(ToolSchemas.list_directory.parse(args));break;
          case 'find_files':data=await runtime.files.findFiles(ToolSchemas.find_files.parse(args));break;
          case 'search_files':data=await runtime.files.searchFiles(ToolSchemas.search_files.parse(args));break;
          case 'read_files':data=await runtime.files.readFiles(ToolSchemas.read_files.parse(args));break;
          case 'lsp':ToolSchemas.lsp.parse(args);throw new BridgeError('CAPABILITY_UNAVAILABLE',503,'capability_unavailable: no active IDE/LSP adapter');
          case 'get_diagnostics':ToolSchemas.get_diagnostics.parse(args);throw new BridgeError('CAPABILITY_UNAVAILABLE',503,'capability_unavailable: no active language-service diagnostic adapter');
        }
      }
      const audit=this.store.event('tool.completed',{action:name,params_hash:digest(args),execution_owner:'remote_workspace',duration_ms:Math.round(performance.now()-start)},auditContext);
      const paged=data as {truncated?:boolean;next_cursor?:number|null}|undefined;
      return {ok:true,data,metadata:metadata(audit,paged?.truncated??false,paged?.next_cursor)};
    }catch(error){
      const e=publicError(error);
      const audit=this.store.event('tool.failed',{action:Object.hasOwn(ToolSchemas,name)?name:'unknown_tool',code:e.code,duration_ms:Math.round(performance.now()-start)},auditContext);
      return {ok:false,error:{code:e.code,message:e.message,...(e.details?{details:e.details}:{})},metadata:metadata(audit)};
    }finally{if(admitted)this.active--;}
  }
}
