import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { APP_VERSION, BridgeError, LEGACY_VERSION, MODERN_VERSION, POLICY_VERSION, TERMINAL_STATES, digest, newId, newSecret, publicError, type Approval, type InvocationContext, type Run, type Workspace } from '../../../packages/contracts/src/index.js';
import { Store } from '../../../packages/storage/src/index.js';
import { PolicyEngine, AUTO_APPROVE_NO_EXPIRY } from '../../../packages/policy-engine/src/index.js';
import { McpGateway } from '../../../packages/mcp-transport/src/index.js';
import { WorkspaceFiles } from '../../../packages/workspace-tools/src/files.js';
import { ToolHost, ToolDescriptions, ToolSchemas } from './tools.js';
import { acquireStateLease } from './state-lease.js';
import { CONSOLE_HTML } from './console.js';
import { ProviderGateway, GatewayConfigSchema, buildAdapter } from '../../../packages/provider-gateway/src/index.js';
import { SkillRegistry, installSkillFromDirectory, removeSkill } from '../../../packages/skills/src/index.js';

const MAX_BODY=1024*1024;
export const ConfigSchema=z.object({
  schema_version:z.literal(1),
  state_directory:z.string().min(1),
  ports:z.object({api:z.number().int().min(0).max(65535).default(48270),mcp:z.number().int().min(0).max(65535).default(48271),mcp_remote:z.number().int().min(0).max(65535).default(48273),admin:z.number().int().min(0).max(65535).default(48272)}).default({api:48270,mcp:48271,mcp_remote:48273,admin:48272}),
  workspaces:z.array(z.object({root:z.string().min(1),display_name:z.string().min(1).max(100)}).strict()).min(1).max(8),
  response_mode:z.enum(['json','sse']).default('json'),
  security_profile:z.literal('local_trusted_development'),
  arena_enabled:z.literal(false).default(false),
  gateway:GatewayConfigSchema.default({type:'disabled'}),
  // Off by default. Exposing the workspace bridge beyond loopback is a deliberate,
  // acknowledged act, never a side effect of another setting.
  remote_ingress:z.object({
    enabled:z.boolean().default(false),
    acknowledge_exposure:z.literal(false).or(z.literal(true)).default(false),
    bind_address:z.string().min(1).max(64).default('127.0.0.1'),
    allow_cidrs:z.array(z.string().min(1).max(64)).max(32).default([]),
    // Host values to accept in addition to those implied by bind_address. A tunnel
    // terminates the connection and forwards the tunnel's own hostname, so the bridge
    // must accept it even though it still listens on loopback.
    allowed_hosts:z.array(z.string().min(1).max(253)).max(16).default([]),
    require_grant:z.literal(true).default(true)
  }).strict().default({enabled:false,acknowledge_exposure:false,bind_address:'127.0.0.1',allow_cidrs:[],allowed_hosts:[],require_grant:true}),
  // Agent Skills roots. The application's own `skills/` directory is always searched first and is
  // where the window installs into; these are *additional* read-only roots, so an operator can
  // also expose skills another tool already installed (say ~/.workbuddy-ai/skills) without
  // copying them. Kept out of the workspace on purpose: a skill that the code under instruction
  // could edit would be a way to rewrite the instructions between runs.
  skills:z.object({
    roots:z.array(z.string().min(1).max(1024)).max(8).default([]),
    // Where installs land. Defaults to the application's own `skills/` directory, which is what
    // makes an installed skill travel with the folder. Overridable so a test — or an operator with
    // an opinion about where their skills live — can point it elsewhere without touching the real
    // one; the smoke test relies on this to exercise install/remove without writing into the
    // directory the operator actually uses.
    install_root:z.string().min(1).max(1024).optional()
  }).strict().default({roots:[]})
}).strict();
export type DaemonConfig=z.infer<typeof ConfigSchema>;
export interface DaemonHandle {
  urls:{api:string;mcp:string;mcp_remote:string;admin:string};store:Store;policy:PolicyEngine;host:ToolHost;
  workspaces:Workspace[];close():Promise<void>;
}
export function capabilities(gateway?:ProviderGateway){const modelGateway=gateway?.capabilities();return {
  schema_version:'1.0',product:'ArenaBridge',version:APP_VERSION,delivery_stage:'0/1 plus client-tools gateway alpha',production_ready:false,
  modes:{remote_workspace:{status:'implemented_local',execution_owner:'remote_workspace'},provider_gateway_client_tools:{status:modelGateway?.enabled?'enabled_experimental':'disabled_configurable',execution_owner:'client'},provider_gateway_bridge_tools:{status:'not_implemented',execution_owner:'bridge'},mcp_task_service:{status:'not_implemented',execution_owner:'bridge'}},
  mcp:{sdk:'@modelcontextprotocol/server@2.0.0',versions:[MODERN_VERSION,LEGACY_VERSION],transport:'streamable_http',modern:{session:false,discovery:true},legacy:{session:true,initialize:true,get_sse:false,last_event_id:false},subscriptions:false,mrtr:false,sampling:false,resources:false,prompts:false},
  tools:{read:'bounded UTF-8',patch:'create/update, exact preflight and approval',regex:false,delete:false,move:false,pty:'capability_unavailable',lsp:'capability_unavailable',
    // Skills are mounted (read-only) outside the workspace. `skills_can_execute` is stated
    // separately and stays false: a skill's scripts/ is a directory of files, and running one
    // still goes through run_command under the exec tier, so no skill can widen what a caller may
    // do. `allowed-tools` is reported to the caller as text and is never treated as a grant.
    skills_external_mounts:true,skills_can_execute:false,skills_format:'agentskills.io SKILL.md',max_parallel:4},
  model_api:{chat_completions:'implemented_bounded_client_tools_alpha',responses:'unsupported_protocol',anthropic_messages:'unsupported_protocol',gateway:modelGateway??{enabled:false,execution_owner:'client',tools_executed_by_gateway:false}},
  arena:{status:'blocked',authorization:false,live_test:false,mailbox_enabled:false,reason:'No platform permission or approved data agreement supplied'},
  federation:{status:'not_implemented'},tunnels:{quick:'not_implemented; no SSE support',named:'not_implemented',ngrok:'not_implemented'},
  security:{listen:'127.0.0.1 only',credentials:'independent ephemeral local credentials; SHA256 grant lookup',keyring:'not_implemented; production blocker',approval:'single-use parameter-bound',restart:'revokes old grants; active runs become unknown',os_sandbox:false,residual:'Path revalidation is not a race-proof OS handle-relative sandbox. Trusted local project test use only.'},
  provenance:{A:'Independent implementation of documented Bridge principles; not ShunCode source parity',B:'Bounded client-tools gateway alpha implemented; mailbox and bridge-owned workflow are not implemented',C:'Third-party MCP federation addition is not delivered yet',D:'Arena, desktop clients, tunnels, installer and cross-platform E2E remain blocked/not_tested'}
};}
function json(res:ServerResponse,status:number,data:unknown):void {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));
}
function boundary(req:IncomingMessage,port:number,allowedHosts:string[]|null):void {
  const host=(req.headers.host??'').toLowerCase();
  const hostName=host.startsWith('[')?host.slice(0,host.indexOf(']')+1):host.split(':')[0]!;
  if(allowedHosts!==null&&!allowedHosts.includes(hostName))throw new BridgeError('POLICY_DENIED',403,'Invalid Host header');
  const origin=req.headers.origin;
  // A same-origin browser page is allowed (the local console). Anything else stays blocked,
  // which keeps DNS-rebinding and cross-site requests out.
  if(origin!==undefined){
    const expected=[`http://127.0.0.1:${port}`,`http://localhost:${port}`];
    if(!expected.includes(origin))throw new BridgeError('POLICY_DENIED',403,'Cross-origin requests are disabled');
  }
  if(req.headers['content-encoding'])throw new BridgeError('UNSUPPORTED_PARAMETER',415,'Compressed request bodies are not supported');
  if(req.headers['transfer-encoding']&&req.headers['content-length'])throw new BridgeError('INVALID_ARGUMENT',400,'Ambiguous request framing');
  const length=Number(req.headers['content-length']??0);
  if(!Number.isFinite(length)||length<0||length>MAX_BODY)throw new BridgeError('RESOURCE_LIMIT',413,'Request body exceeds 1 MiB');
}
async function readBody(req:IncomingMessage):Promise<{raw:string;value:unknown}>{
  if(req.method!=='POST')return {raw:'',value:undefined};
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))throw new BridgeError('INVALID_ARGUMENT',415,'Content-Type must be application/json');
  const parts:Buffer[]=[];let size=0;
  for await(const part of req){const buf=Buffer.from(part as Uint8Array);size+=buf.length;if(size>MAX_BODY)throw new BridgeError('RESOURCE_LIMIT',413,'Request body exceeds 1 MiB');parts.push(buf);}
  let raw:string;
  try{raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));}catch{throw new BridgeError('INVALID_ARGUMENT',400,'Request must contain valid UTF-8');}
  try{return {raw,value:JSON.parse(raw)};}catch{throw new BridgeError('INVALID_JSON',400,'Invalid JSON body');}
}
function toRequest(req:IncomingMessage,url:string,raw:string,signal:AbortSignal):Request {
  const headers=new Headers();
  for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
  return new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:raw}:{}),signal});
}
async function sendResponse(res:ServerResponse,response:Response):Promise<void>{
  response.headers.forEach((value,key)=>res.setHeader(key,value));
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.writeHead(response.status);
  if(!response.body){res.end();return;}
  const reader=response.body.getReader();
  try{for(;;){const {done,value}=await reader.read();if(done)break;if(res.destroyed){await reader.cancel();return;}if(!res.write(Buffer.from(value)))await Promise.race([once(res,'drain'),once(res,'close')]);}if(!res.destroyed)res.end();}
  finally{reader.releaseLock();}
}
async function listen(server:Server,port:number,address:string):Promise<number>{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,address,()=>{server.off('error',reject);resolve();});});
  return (server.address() as {port:number}).port;
}
function isLoopback(address:string):boolean{
  const value=address.toLowerCase().replace(/^\[|\]$/g,'');
  return value==='127.0.0.1'||value==='::1'||value==='localhost';
}
function urlFor(address:string,port:number):string{
  const host=address.includes(':')?`[${address.replace(/^\[|\]$/g,'')}]`:address;
  return `http://${host}:${port}`;
}
function hostsFor(address:string,extra:string[]=[]):string[]|null{
  const value=address.toLowerCase().replace(/^\[|\]$/g,'');
  const extraHosts=extra.map((entry)=>entry.toLowerCase());
  const base=(()=>{
    if(value==='127.0.0.1')return ['127.0.0.1','localhost'];
    if(value==='::1')return ['[::1]','localhost'];
    // A wildcard bind cannot enumerate this machine's routable addresses. The MCP port is
    // authenticated by a grant and rejects every cross-origin Origin, so host matching adds
    // no protection there; loopback binds keep the strict allowlist.
    if(value==='0.0.0.0'||value==='::')return null;
    // An IPv6 Host header arrives bracketed ([2409:...]:port), so the allowlist must match that form.
    return value.includes(':')?[`[${value}]`]:[value];
  })();
  if(base===null)return null;
  return [...new Set([...base,...extraHosts])];
}
export async function createDaemon(input:unknown,credentials:{adminToken:string;clientToken:string;mcpToken?:string}):Promise<DaemonHandle>{
  const config=ConfigSchema.parse(input);
  // When a caller does not supply a local MCP credential, mint one the caller never sees.
  // It satisfies the independence requirement and simply leaves the loopback MCP listener
  // unusable from outside, which is the safe default.
  const mcpToken=credentials.mcpToken??newSecret();
  const wellFormed=[credentials.adminToken,credentials.clientToken,mcpToken].every(token=>/^[A-Za-z0-9_-]{32,256}$/.test(token));
  const distinct=new Set([credentials.adminToken,credentials.clientToken,mcpToken]).size===3;
  if(!wellFormed||!distinct)throw new BridgeError('INVALID_CONFIG',400,'Independent high-entropy credentials are required');
  for(const candidate of config.workspaces)await WorkspaceFiles.open(candidate.root);
  const state=path.resolve(config.state_directory),release=await acquireStateLease(state);
  let store:Store|undefined;
  try{
    store=new Store(path.join(state,'state.sqlite'));
    const result=await startDaemon(config,credentials,store);
    let closed=false;
    return {...result,async close(){if(closed)return;closed=true;try{await result.close();}finally{await release();}}};
  }catch(error){try{store?.close();}catch{}await release();throw error;}
}
async function startDaemon(config:DaemonConfig,credentials:{adminToken:string;clientToken:string;mcpToken?:string},store:Store):Promise<DaemonHandle>{
  const state=path.resolve(config.state_directory),epoch=store.recoverOnStart();
  // The application's own skills directory travels with the application, which is what makes an
  // installed skill survive moving the folder — the same property the bundled release depends on.
  // It stays the first root, and therefore the install target, unless a config says otherwise.
  const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
  const installRoot=config.skills.install_root?path.resolve(config.skills.install_root):path.join(appRoot,'skills');
  const skills=new SkillRegistry([installRoot,...config.skills.roots.map(root=>path.resolve(root))]);
  await skills.discover();
  const policy=new PolicyEngine(store,credentials,epoch),host=new ToolHost(store,policy,state,skills);
  const gateway=new ProviderGateway(store,buildAdapter(config.gateway,process.env));
  const workspaces:Workspace[]=[];
  for(const candidate of config.workspaces){
    const files=await WorkspaceFiles.open(candidate.root);
    let workspace=store.all<Workspace>('workspaces').find(w=>w.root.toLowerCase()===files.root.toLowerCase());
    workspace=workspace?{...workspace,display_name:candidate.display_name}:{id:newId('workspace'),root:files.root,display_name:candidate.display_name,created_at:Date.now()};
    store.put('workspaces',workspace);workspaces.push(workspace);await host.attach(workspace);
  }
  policy.ensureLocalMcpGrant(workspaces[0]!.id);
  const gatewayAuth={workspaceId:workspaces[0]!.id};
  const mcpLocal=new McpGateway(host,policy,config.response_mode,{...gatewayAuth,allowLocal:true});
  const mcpRemote=new McpGateway(host,policy,config.response_mode,{...gatewayAuth,allowLocal:false});
  // Every one of these starts as a *string*, and an absent listener stays a string. Anything
  // that reads a url must therefore treat '' as "not listening" rather than "no value": ''
  // is truthy enough to survive `??` and only fails later, as an opaque `new URL('')`.
  const servers:Server[]=[],urls={api:'',mcp:'',mcp_remote:'',admin:''};
  let openRequests=0;
  const ingress=config.remote_ingress;
  if(ingress.enabled&&!ingress.acknowledge_exposure)throw new BridgeError('INVALID_CONFIG',400,'remote_ingress.enabled requires acknowledge_exposure:true; exposing the workspace bridge is never implicit');
  if(ingress.enabled&&!ingress.require_grant)throw new BridgeError('INVALID_CONFIG',400,'remote_ingress cannot disable grant authentication');
  // Two MCP listeners with deliberately different trust: the local one also accepts the
  // long-lived loopback credential so a local host (an editor, an agent) can work without
  // re-pairing; the remote one accepts only short-lived paired grants, so whatever a tunnel
  // or public bind forwards to can never use the local credential.
  const mcpAddress=ingress.enabled?ingress.bind_address:'127.0.0.1';
  if(ingress.enabled&&isLoopback(mcpAddress)&&ingress.allowed_hosts.length===0)throw new BridgeError('INVALID_CONFIG',400,'remote_ingress with a loopback bind_address requires allowed_hosts (tunnel mode), otherwise nothing could reach it');
  const remoteEnabled=ingress.enabled;
  const addressFor=(kind:'api'|'mcp'|'mcp_remote'|'admin')=>kind==='mcp_remote'?mcpAddress:'127.0.0.1';
  const makeServer=(kind:'api'|'mcp'|'mcp_remote'|'admin')=>{
    let port=0;
    // The pairing rate limit is per listener: these counters used to live in createDaemon scope,
    // so the mcp and mcp_remote surfaces shared one 20/minute budget and burned each other's
    // allowance. Each listener now keeps its own window.
    let pairWindow=Date.now(),pairCount=0;
    const allowedHosts=hostsFor(addressFor(kind),kind==='mcp_remote'&&ingress.enabled?ingress.allowed_hosts:[]);
    const server=createServer({maxHeaderSize:16384,requestTimeout:15000,headersTimeout:10000},(req,res)=>{
      void(async()=>{
        let admitted=false;const requestId=newId('req');
        try{
          boundary(req,port,allowedHosts);
          if(openRequests>=32)throw new BridgeError('QUEUE_FULL',429,'Too many in-flight local requests');
          openRequests++;admitted=true;
          res.setHeader('X-ArenaBridge-Request-Id',requestId);
          const selfOrigin=urlFor(addressFor(kind),port);
          const address=new URL(req.url??'/',`http://127.0.0.1:${port}`);
          if(address.username||address.password)throw new BridgeError('POLICY_DENIED',403,'Invalid request target');
          const route=address.pathname;
          const isMcp=kind==='mcp'||kind==='mcp_remote';
          const pairing=isMcp&&(route==='/pair/request'||route==='/pair/claim');
          // The sandbox client script is public and secret-free, so a remote agent can
          // fetch it with curl instead of having it pasted in by hand.
          if(isMcp&&req.method==='GET'&&(route==='/client.py'||route==='/arena_sandbox_client.py')){
            let source:string;
            try{source=await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../client/arena_sandbox_client.py'),'utf8');}
            catch{throw new BridgeError('NOT_FOUND',404,'Client script is not present in this deployment');}
            res.writeHead(200,{'Content-Type':'text/x-python; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline; filename="arena_sandbox_client.py"'});res.end(source);return;
          }
          // The console shell is static and secret-free, so it is served before auth.
          // Accept every obvious entry URL so a bare host:port still lands on it.
          const console=kind==='admin'&&(route==='/'||route==='/console'||route==='/console/'||route==='/index.html');
          if(console){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(CONSOLE_HTML);return;}
          let mcpContext:InvocationContext|undefined;
          if(kind==='admin')policy.authenticateLocal(req.headers.authorization,'admin');
          else if(kind==='api')policy.authenticateLocal(req.headers.authorization,'api_client');
          else if(!pairing)mcpContext=policy.resolveMcpContext(req.headers.authorization,requestId,{allowLocal:kind!=='mcp_remote',workspaceId:workspaces[0]!.id});
          if(pairing){if(Date.now()-pairWindow>60000){pairWindow=Date.now();pairCount=0;}if(++pairCount>20)throw new BridgeError('RATE_LIMITED',429,'Pairing attempt budget exceeded');}
          const {raw,value}=await readBody(req);
          if(isMcp){
            if(req.method==='POST'&&route==='/pair/request'){json(res,202,policy.requestPairing(value));return;}
            if(req.method==='POST'&&route==='/pair/claim'){json(res,200,policy.claimPairing(value));return;}
            if(route!=='/mcp')throw new BridgeError('NOT_FOUND',404,'No remote route');
            const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
            await sendResponse(res,await (kind==='mcp_remote'?mcpRemote:mcpLocal).fetch(toRequest(req,address.toString(),raw,controller.signal),value,mcpContext));return;
          }
          if(req.method==='GET'&&route==='/healthz'){json(res,200,{status:'alive',version:APP_VERSION,role:kind});return;}
          if(req.method==='GET'&&route==='/bridge/v1/capabilities'){json(res,200,capabilities(gateway));return;}
          if(req.method==='GET'&&route==='/readyz'&&kind==='admin'){json(res,200,{ready:true,reason:'Local control plane ready',production_ready:false});return;}
          if(kind==='api'){
            const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
            await sendResponse(res,await gateway.handle(toRequest(req,address.toString(),raw,controller.signal),policy.authenticateLocal(req.headers.authorization,'api_client')));return;
          }
          if(req.method==='GET'&&route==='/admin/v1/status'){
            json(res,200,{version:APP_VERSION,urls,workspaces:workspaces.map(({root,...w})=>w),runs:store.all<Run>('runs'),pairings:policy.pendingPairings(),approvals:store.all<Approval>('approvals').filter(a=>a.state==='pending'),health:{local:'ready',public:'not_tested',arena:'blocked'},credentials_persisted:false});return;
          }
          if(req.method==='POST'&&route==='/admin/v1/pairings'){json(res,201,policy.createPairing(value));return;}
          const pairingApproval=/^\/admin\/v1\/pairings\/([^/]+)\/decision$/.exec(route);
          if(req.method==='POST'&&pairingApproval){json(res,200,policy.approvePairing(pairingApproval[1]!,value));return;}
          const approval=/^\/admin\/v1\/approvals\/([^/]+)\/decision$/.exec(route);
          if(req.method==='POST'&&approval){const arg=z.object({approve:z.boolean()}).strict().parse(value);json(res,200,policy.decideApproval(approval[1]!,arg.approve));return;}
          if(req.method==='POST'&&route==='/admin/v1/revoke-all'){z.object({confirm:z.literal(true)}).strict().parse(value);const result=policy.revokeAll();await mcpLocal.closeSessions();await mcpRemote.closeSessions();
            // Revoking has to stop what is already running, not just refuse what comes next: an
            // in-flight command would otherwise keep writing to the workspace after the operator
            // pulled the plug, with no way to see or stop it from the window.
            const killed=host.killCommands('access revoked');store.event('command.killed',{reason:'access_revoked',killed_commands:killed},{});json(res,200,{...result,killed_commands:killed});return;}
          // Unattended-write switch. GET is what the console polls to render the banner; POST
          // toggles it. `confirm: true` is required to enable, matching revoke-all: turning this
          // on is a posture change, not a preference, and should not be reachable by a stray
          // request. ttl_ms is optional; omitted or 0 means no expiry (the window stays on until
          // explicitly turned off), which the policy engine also accepts so the rule does not live
          // only in the HTTP layer.
          if(req.method==='GET'&&route==='/admin/v1/auto-approve'){
            const active=policy.autoApprove();
            json(res,200,{enabled:!!active,expires_at:active?active.expires_at:null,unlimited:active?active.unlimited:false,no_expiry_sentinel:AUTO_APPROVE_NO_EXPIRY,now:Date.now(),effect:'Every apply_patch is approved without a human reading the diff'});return;
          }
          if(req.method==='POST'&&route==='/admin/v1/auto-approve'){
            const arg=z.object({enabled:z.boolean(),ttl_ms:z.number().int().nonnegative().optional(),confirm:z.literal(true).optional()}).strict().parse(value);
            if(arg.enabled&&arg.confirm!==true)throw new BridgeError('INVALID_ARGUMENT',400,'Enabling unattended writes requires confirm: true');
            json(res,200,policy.setAutoApprove(arg.enabled,arg.ttl_ms));return;
          }
          if(req.method==='POST'&&route==='/admin/v1/recover'){
            const arg=z.object({workspace_id:z.string(),confirm:z.literal(true)}).strict().parse(value);json(res,200,{recovered:await host.recover(arg.workspace_id),warning:'Recovery rolls back only versions matching the journal; this does not rerun tools'});return;
          }
          if(req.method==='GET'&&route==='/admin/v1/tool-schemas'){json(res,200,Object.entries(ToolSchemas).map(([name,schema])=>({name,description:ToolDescriptions[name as keyof typeof ToolDescriptions],inputSchema:z.toJSONSchema(schema,{io:'input'})})));return;}
          // Read-only workspace browsing for the local operator UI (the desktop harness sidebar
          // and file viewer). Scoped to the first configured workspace, same as the rest of the
          // admin plane, and served through the identical path policy as the MCP tools.
          if(req.method==='GET'&&route==='/admin/v1/workspace/tree'){
            const arg=z.object({path:z.string().max(1024).default('.'),limit:z.coerce.number().int().min(1).max(200).default(200),cursor:z.coerce.number().int().min(0).max(100000).default(0)}).strict().parse({path:address.searchParams.get('path')??'.',limit:address.searchParams.get('limit')??200,cursor:address.searchParams.get('cursor')??0});
            json(res,200,await host.adminListDirectory(workspaces[0]!.id,arg));return;
          }
          if(req.method==='GET'&&route==='/admin/v1/workspace/file'){
            const arg=z.object({path:z.string().min(1).max(1024)}).strict().parse({path:address.searchParams.get('path')??''});
            json(res,200,await host.adminReadFile(workspaces[0]!.id,arg.path));return;
          }
          // Agent Skills, operator side. Installs land in the application's own skills directory
          // (the first root) and are validated before anything is written; the registry is
          // re-discovered immediately, so a newly installed skill is usable without restarting the
          // daemon — the window would otherwise have to tell the operator to reopen it, which is
          // the kind of instruction that makes a feature feel broken.
          if(req.method==='GET'&&route==='/admin/v1/skills'){
            json(res,200,{roots:skills.roots,skills:skills.list(),invalid:skills.problemsList,shadowed:skills.shadowedList});return;
          }
          if(req.method==='POST'&&route==='/admin/v1/skills/install'){
            const arg=z.object({source:z.string().min(1).max(1024)}).strict().parse(value);
            const outcome=await installSkillFromDirectory(arg.source,skills.roots[0]!);
            // Refusals are errors, not a 200 with ok:false, so the window cannot accidentally treat
            // "we declined to install this" as a success with an empty result.
            if(!outcome.ok)throw new BridgeError('INVALID_ARGUMENT',400,outcome.reason??'Install refused');
            await skills.discover();
            json(res,201,outcome);return;
          }
          if(req.method==='POST'&&route==='/admin/v1/skills/remove'){
            const arg=z.object({name:z.string().min(1).max(64)}).strict().parse(value);
            const outcome=await removeSkill(skills.roots[0]!,arg.name);
            if(!outcome.ok)throw new BridgeError('INVALID_ARGUMENT',400,outcome.reason??'Remove refused');
            await skills.discover();
            json(res,200,outcome);return;
          }
          const patch=/^\/admin\/v1\/workspaces\/([^/]+)\/patches\/([^/]+)$/.exec(route);
          if(req.method==='GET'&&patch){json(res,200,await host.previewForAdmin(patch[1]!,patch[2]!));return;}
          if(req.method==='GET'&&route==='/admin/v1/events'){
            const after=z.coerce.number().int().nonnegative().parse(address.searchParams.get('after')??0);
            json(res,200,{events:store.events(after,100),continuation:'seq',redacted:true});return;
          }
          if(req.method==='POST'&&route==='/bridge/v1/runs'){
            const arg=z.object({mode:z.enum(['remote_workspace','provider_gateway_client_tools','provider_gateway_bridge_tools','mcp_task_service']),workspace_id:z.string()}).strict().parse(value);
            if(arg.mode!=='remote_workspace')throw new BridgeError('UNSUPPORTED_CAPABILITY',422,'Only manual remote_workspace runs are implemented; no background workflow was started');
            if(!workspaces.some(w=>w.id===arg.workspace_id))throw new BridgeError('NOT_FOUND',404,'Workspace not found');
            const key=req.headers['idempotency-key'];if(Array.isArray(key))throw new BridgeError('INVALID_ARGUMENT',400,'Invalid idempotency key');
            const scope='local_admin:manual_run',record=store.beginIdempotency(scope,key,digest(arg));
            if(record.cached!==undefined){json(res,200,record.cached);return;}
            const run:Run={id:newId('run'),workspace_id:arg.workspace_id,principal_id:policy.admin.id,mode:'remote_workspace',execution_owner:'remote_workspace',state:'created',reason:'manual_record_only_use_pairing_to_create_an_authorized_remote_run',policy_version:POLICY_VERSION,created_at:Date.now(),updated_at:Date.now()};
            store.put('runs',run);store.event('run.created',{execution_owner:run.execution_owner,state:run.state},{run_id:run.id,request_id:requestId});store.finishIdempotency(scope,key,run);json(res,201,run);return;
          }
          const runRoute=/^\/bridge\/v1\/runs\/([^/]+)(?:\/(cancel|events|complete))?$/.exec(route);
          if(runRoute){
            const run=store.get<Run>('runs',runRoute[1]!);if(!run)throw new BridgeError('NOT_FOUND',404,'Run not found');
            if(req.method==='GET'&&!runRoute[2]){json(res,200,{...run,todos:store.get('todos',run.id),progress:store.get('settings',`progress:${run.id}`)});return;}
            if(req.method==='GET'&&runRoute[2]==='events'){const after=z.coerce.number().int().nonnegative().parse(address.searchParams.get('after')??0);json(res,200,{events:store.events(after,100,run.id)});return;}
            if(req.method==='POST'&&runRoute[2]==='cancel'){z.object({confirm:z.literal(true)}).strict().parse(value);gateway.cancelRun(run.id);host.killCommands('run cancelled');json(res,200,TERMINAL_STATES.has(run.state)?run:store.transition(run.id,'cancelled','local_operator_cancelled_new_actions_blocked'));return;}
            if(req.method==='POST'&&runRoute[2]==='complete'){z.object({confirm:z.literal(true)}).strict().parse(value);json(res,200,store.transition(run.id,'completed','local_operator_reported_complete_not_independently_verified'));return;}
          }
          throw new BridgeError('NOT_FOUND',404,'No control route');
        }catch(error){
          const e=publicError(error);store.event('http.rejected',{code:e.code},{request_id:requestId});
          if(!res.headersSent)json(res,e.status,{error:{code:e.code,message:e.message,...(e.details?{details:e.details}:{})},request_id:requestId});else res.destroy();
        }finally{if(admitted)openRequests--;}
      })().catch(()=>{if(!res.destroyed)res.destroy();});
    });
    server.maxConnections=64;
    server.setTimeout(30000,socket=>socket.destroy());
    servers.push(server);return {server,setPort:(p:number)=>{port=p;}};
  };
  const kinds:(('admin'|'api'|'mcp'|'mcp_remote'))[]=['admin','api','mcp'];if(remoteEnabled)kinds.push('mcp_remote');
  try{for(const kind of kinds){const entry=makeServer(kind);const port=await listen(entry.server,config.ports[kind],addressFor(kind));entry.setPort(port);urls[kind]=urlFor(addressFor(kind),port);}}
  catch(error){await mcpLocal.close();await mcpRemote.close();for(const server of servers)server.close();store.close();throw error;}
  if(ingress.enabled)process.stderr.write(JSON.stringify({warning:'REMOTE INGRESS ACTIVE. The workspace MCP port accepts traffic from beyond loopback. Keep the pairing grant short-lived, keep the admin port private, and stop the daemon when finished.',bind_address:mcpAddress,url:urls.mcp_remote,allowed_hosts:ingress.allowed_hosts,allow_cidrs:ingress.allow_cidrs,acknowledged:ingress.acknowledge_exposure})+'\n');
  return {urls,store,policy,host,workspaces,async close(){host.killCommands('daemon shutdown');await gateway.close();await mcpLocal.close();await mcpRemote.close();await Promise.all(servers.map(server=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();})));store.close();}};
}
