import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { createDaemon } from '../apps/daemon/src/server.js';
import { LEGACY_VERSION, MODERN_VERSION, newSecret } from '../packages/contracts/src/index.js';

export async function fixture(t:TestContext,responseMode:'json'|'sse'='json'){
  const parent=path.resolve('.test-data');await fs.mkdir(parent,{recursive:true});
  const base=await fs.mkdtemp(path.join(parent,'daemon-')),root=path.join(base,'project');await fs.mkdir(root);
  const adminToken=newSecret(),clientToken=newSecret(),mcpToken=newSecret();
  const daemon=await createDaemon({schema_version:1,state_directory:path.join(base,'state'),ports:{api:0,mcp:0,admin:0},workspaces:[{root,display_name:'Synthetic test project'}],response_mode:responseMode,security_profile:'local_trusted_development',arena_enabled:false},{adminToken,clientToken,mcpToken});
  t.after(async()=>{await daemon.close();await fs.rm(base,{recursive:true,force:true});});
  const json=async(kind:'admin'|'api'|'mcp',url:string,method='GET',body?:unknown,token?:string,headers:Record<string,string>={})=>{
    const response=await fetch(daemon.urls[kind]+url,{method,headers:{...(kind==='admin'?{Authorization:`Bearer ${adminToken}`}:{ }),...(kind==='api'?{Authorization:`Bearer ${clientToken}`}:{ }),...(token?{Authorization:`Bearer ${token}`}:{ }),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const text=await response.text();return {response,data:text?JSON.parse(text):undefined};
  };
  const pair=async(access_mode:'ask'|'plan'|'code'='code')=>{
    const start=await json('admin','/admin/v1/pairings','POST',{workspace_id:daemon.workspaces[0]!.id,recipient:'MockAgent local fixture only',max_access:access_mode});
    const requested=await json('mcp','/pair/request','POST',{code:start.data.code,remote_label:'MockAgent',access_mode});
    await json('admin',`/admin/v1/pairings/${requested.data.pair_id}/decision`,'POST',{approve:true,access_mode,data_egress_ack:true});
    const claim=await json('mcp','/pair/claim','POST',{pair_id:requested.data.pair_id,claim_secret:requested.data.claim_secret});
    return {...claim.data,start:start.data,requested:requested.data} as {token:string;challenge:string;grant_id:string;run_id:string;workspace_id:string;start:Record<string,unknown>;requested:Record<string,unknown>};
  };
  let sequence=0;
  const modern=async(token:string,method:string,params:Record<string,unknown>={},headers:Record<string,string>={})=>{
    const body={jsonrpc:'2.0',id:++sequence,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':MODERN_VERSION,'io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'SyntheticClient',version:'1.0'}}}};
    const response=await fetch(daemon.urls.mcp+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':MODERN_VERSION,'Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{}),...headers},body:JSON.stringify(body)});
    const text=await response.text();
    const frames=response.headers.get('content-type')?.includes('text/event-stream')?text.split(/\r?\n\r?\n/).map(frame=>frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean).map(line=>JSON.parse(line)):[JSON.parse(text)];
    return {response,data:frames.findLast(frame=>frame.id===body.id)??frames.at(-1),text};
  };
  const call=async(token:string,name:string,args:unknown)=>modern(token,'tools/call',{name,arguments:args});
  const handshake=async(token:string)=>{
    const response=await fetch(daemon.urls.mcp+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:LEGACY_VERSION,capabilities:{},clientInfo:{name:'LegacySynthetic',version:'1.0'}}})});
    return response;
  };
  return {base,root,daemon,adminToken,clientToken,mcpToken,json,pair,modern,call,handshake};
}
