#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, open, mkdir } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, BridgeError, newSecret, publicError } from '../../../packages/contracts/src/index.js';
import { WorkspaceFiles } from '../../../packages/workspace-tools/src/files.js';
import { capabilities, ConfigSchema, createDaemon } from './server.js';
import { serveStdioRelay } from './stdio.js';

const help=`ArenaBridge ${APP_VERSION} — local trusted-development build, NOT production

Commands (run with node dist/apps/daemon/src/cli.js):
  init --workspace <project> --config <new.json> [--state <directory>] [--name <label>]
  serve --config <json> [--ephemeral-keys]
  status [--endpoint http://127.0.0.1:48272]
  control <GET|POST> </admin/v1/...|/bridge/v1/...> [--json '<JSON>'] [--endpoint <loopback>]
  mcp stdio [--endpoint http://127.0.0.1:48271/mcp]
  preflight [--config <json>]
  capabilities
  version

serve: supply independent ARENABRIDGE_ADMIN_TOKEN and ARENABRIDGE_API_TOKEN.
--ephemeral-keys explicitly generates and displays process-lifetime credentials once;
  do not paste them into a remote chat or save console output. No OS keyring yet.
control/status: requires ARENABRIDGE_ADMIN_TOKEN. mcp stdio: requires a paired
  short-lived ARENABRIDGE_MCP_TOKEN, never the admin token. No shell execution.
Arena automation, model inference, tunnels, external MCP and desktop UI are disabled.
`;
function controlEndpoint(value:string):URL{
  const url=new URL(value);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new BridgeError('POLICY_DENIED',403,'Use a loopback control origin without a path or credentials');
  return url;
}
export async function main(argv=process.argv.slice(2)):Promise<void>{
  const {positionals,values}=parseArgs({args:argv,allowPositionals:true,strict:true,options:{workspace:{type:'string'},config:{type:'string'},state:{type:'string'},name:{type:'string'},endpoint:{type:'string'},json:{type:'string'},'ephemeral-keys':{type:'boolean',default:false},help:{type:'boolean',short:'h'}}});
  const [command,subcommand,route]=positionals;
  if(values.help||!command){process.stdout.write(help);return;}
  if(command==='version'){process.stdout.write(APP_VERSION+'\n');return;}
  if(command==='capabilities'){process.stdout.write(JSON.stringify(capabilities(),null,2)+'\n');return;}
  if(command==='init'){
    if(!values.workspace||!values.config)throw new BridgeError('INVALID_ARGUMENT',400,'init requires --workspace and --config');
    const workspace=await WorkspaceFiles.open(values.workspace),filename=path.resolve(values.config);
    const config=ConfigSchema.parse({schema_version:1,state_directory:path.resolve(values.state??path.join(path.dirname(filename),'.arena-bridge')),ports:{api:48270,mcp:48271,admin:48272},workspaces:[{root:workspace.root,display_name:values.name??path.basename(workspace.root)}],response_mode:'json',security_profile:'local_trusted_development',arena_enabled:false});
    await mkdir(path.dirname(filename),{recursive:true});
    const handle=await open(filename,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(config,null,2)+'\n');await handle.sync();}finally{await handle.close();}
    process.stdout.write(JSON.stringify({config:filename,secrets_persisted:false,production_ready:false})+'\n');return;
  }
  if(command==='serve'){
    if(!values.config)throw new BridgeError('INVALID_ARGUMENT',400,'serve requires --config');
    const raw=await readFile(path.resolve(values.config),'utf8');if(Buffer.byteLength(raw)>65536)throw new BridgeError('RESOURCE_LIMIT',413,'Config exceeds 64 KiB');
    let adminToken=process.env.ARENABRIDGE_ADMIN_TOKEN,clientToken=process.env.ARENABRIDGE_API_TOKEN,mcpToken=process.env.ARENABRIDGE_MCP_TOKEN;
    const missing=[!adminToken&&'ARENABRIDGE_ADMIN_TOKEN',!clientToken&&'ARENABRIDGE_API_TOKEN',!mcpToken&&'ARENABRIDGE_MCP_TOKEN'].filter(Boolean) as string[];
    const generated=missing.length>0;
    if(generated){
      if(!values['ephemeral-keys'])throw new BridgeError('AUTH_REQUIRED',401,`Missing credential environment variable(s): ${missing.join(', ')}. All three are required, or pass --ephemeral-keys to generate process-lifetime credentials.`);
      adminToken=newSecret();clientToken=newSecret();mcpToken=newSecret();
    }
    const daemon=await createDaemon(JSON.parse(raw),{adminToken:adminToken!,clientToken:clientToken!,mcpToken:mcpToken!});
    if(generated)process.stderr.write(JSON.stringify({warning:'EPHEMERAL LOCAL CREDENTIALS. Do not record or share this output.',admin_token:adminToken,api_token:clientToken,mcp_token:mcpToken})+'\n');
    process.stdout.write(JSON.stringify({event:'daemon.ready',version:APP_VERSION,urls:daemon.urls,workspaces:daemon.workspaces.map(({root,...w})=>w),production_ready:false})+'\n');
    await new Promise<void>(resolve=>{
      let closing=false;
      const stop=()=>{if(closing)return;closing=true;void daemon.close().then(resolve).catch(()=>{process.exitCode=1;resolve();});};
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
    });return;
  }
  if(command==='mcp'&&subcommand==='stdio'){
    await serveStdioRelay(values.endpoint??'http://127.0.0.1:48271/mcp',process.env.ARENABRIDGE_MCP_TOKEN??'');return;
  }
  if(command==='preflight'){
    const interfaces=networkInterfaces();
    const addresses:{interface:string;address:string;family:string;scope:'loopback'|'private'|'global'|'link_local';note?:string}[]=[];
    for(const [name,list] of Object.entries(interfaces))for(const entry of list??[]){
      const value=entry.address.split('%')[0]!;
      if(entry.internal&&entry.family==='IPv4')continue;
      const scope=entry.internal?'loopback':/^fe80:/i.test(value)?'link_local':/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd])/i.test(value)?'private':'global';
      const note=/^2001:0:/i.test(value)?'Teredo tunnel (2001:0000::/32): NAT-traversal pseudo-interface, not a native ISP prefix and normally not inbound-reachable'
        :/^2002:/i.test(value)?'6to4 relay prefix: generally not inbound-reachable'
        :/^fec0:/i.test(value)?'deprecated site-local prefix'
        :undefined;
      addresses.push({interface:name,address:value,family:entry.family,scope,...(note?{note}:{})});
    }
    const nativeGlobal=addresses.filter(a=>a.scope==='global'&&!a.note);
    let configured:unknown={note:'no --config supplied; showing defaults'};
    if(values.config){
      const raw=await readFile(path.resolve(values.config),'utf8');
      const parsed=ConfigSchema.parse(JSON.parse(raw));
      configured={ports:parsed.ports,remote_ingress:parsed.remote_ingress,gateway_type:parsed.gateway.type,arena_enabled:parsed.arena_enabled};
    }
    process.stdout.write(JSON.stringify({
      local_addresses:addresses,
      wildcard_ipv6_available:addresses.some(a=>a.family==='IPv6'),
      native_inbound_candidate_prefixes:nativeGlobal.map(a=>`${a.address}/128 on ${a.interface}`),
      inbound_plausible:nativeGlobal.length>0?'maybe — a native global prefix exists, but router and host firewall must both allow inbound':'no — no native global prefix was found; the scoped addresses above are tunnel, link-local or private',
      configured,
      checks_you_must_do_yourself:[
        'Router/ISP must forward inbound traffic to this host; most consumer IPv6 setups block it by default.',
        'Windows Defender Firewall must allow the chosen port for inbound TCP; it blocks by default.',
        'The remote sandbox must be permitted to reach arbitrary external addresses; this is not documented for Arena Agent.',
        'Arena must actually implement an MCP client or a custom tool endpoint; the official tool list does not include one.'
      ],
      not_verified_by_this_command:['public reachability','TLS','remote peer compatibility','Arena authorization'],
      warning:'Do not treat a routable address as evidence that the remote side can or may connect.'
    },null,2)+'\n');return;
  }
  if(command==='control'||command==='status'){
    const token=process.env.ARENABRIDGE_ADMIN_TOKEN;
    if(!token)throw new BridgeError('AUTH_REQUIRED',401,'Set ARENABRIDGE_ADMIN_TOKEN for local control operations');
    const method=command==='status'?'GET':subcommand,target=command==='status'?'/admin/v1/status':route;
    if(!['GET','POST'].includes(method??'')||!target||!/^\/(admin|bridge)\/v1\/[A-Za-z0-9_/?=&.-]+$/.test(target)||target.includes('..'))throw new BridgeError('INVALID_ARGUMENT',400,'control requires GET/POST and an application control route');
    const origin=controlEndpoint(values.endpoint??'http://127.0.0.1:48272');
    const body=values.json===undefined?undefined:JSON.stringify(JSON.parse(values.json));
    if(method==='POST'&&body===undefined)throw new BridgeError('INVALID_ARGUMENT',400,'POST requires an explicit --json body');
    const response=await fetch(new URL(target,origin),{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body,redirect:'error',signal:AbortSignal.timeout(30000)});
    const text=await response.text();process.stdout.write(text+'\n');if(!response.ok)process.exitCode=1;return;
  }
  throw new BridgeError('INVALID_ARGUMENT',400,'Unknown command; use --help');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  void main().catch(error=>{const e=publicError(error);process.stderr.write(JSON.stringify({error:{code:e.code,message:e.message}})+'\n');process.exitCode=1;});
}
