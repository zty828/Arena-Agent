import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { LEGACY_VERSION, MODERN_VERSION, sha256 } from '../packages/contracts/src/index.js';
import { fixture } from './helpers.js';

for(const mode of ['json','sse'] as const)test(`T01/T04 modern discovery and real tool call over ${mode}`,async t=>{
  const f=await fixture(t,mode),p=await f.pair();await fs.writeFile(path.join(f.root,'hello.txt'),'你好 MCP\n');
  const discovered=await f.modern(p.token,'server/discover');
  assert.equal(discovered.response.status,200,discovered.text);
  assert.equal(discovered.data.result.resultType,'complete');assert.ok(discovered.data.result.supportedVersions.includes(MODERN_VERSION));
  assert.equal(discovered.data.result.cacheScope,'private');assert.equal(discovered.data.result.ttlMs,0);
  assert.equal(discovered.response.headers.get('mcp-session-id'),null);
  assert.ok(discovered.response.headers.get('content-type')?.includes(mode==='sse'?'text/event-stream':'application/json'));
  const denied=await f.call(p.token,'read_files',{files:[{path:'hello.txt'}]});
  assert.equal(denied.data.result.structuredContent.error.code,'AUTHORIZATION_REQUIRED');
  const health=await f.call(p.token,'bridge_health',{challenge:p.challenge});assert.equal(health.data.result.structuredContent.data.protocol_ready,true);
  const result=await f.call(p.token,'read_files',{files:[{path:'hello.txt'}]});
  assert.equal(result.data.result.structuredContent.data.files[0].text,'你好 MCP\n');
  assert.equal(result.data.result.structuredContent.metadata.execution_owner,'remote_workspace');
});

test('T01 modern metadata, header/body mismatch, unsupported version and no silent legacy fallback',async t=>{
  const f=await fixture(t),p=await f.pair();
  const wrong=await f.modern(p.token,'server/discover',{}, {'Mcp-Method':'tools/call'});
  assert.equal(wrong.response.status,400);assert.equal(wrong.data.error.code,-32020);
  const send=async(body:unknown,headers:Record<string,string>={})=>{
    const response=await fetch(f.daemon.urls.mcp+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${p.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':MODERN_VERSION,'Mcp-Method':'server/discover',...headers},body:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};
  };
  const missing=await send({jsonrpc:'2.0',id:1,method:'server/discover',params:{}});
  assert.equal(missing.status,400);assert.equal(missing.data.error.code,-32602);
  const unsupported=await send({jsonrpc:'2.0',id:2,method:'server/discover',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2099-01-01','io.modelcontextprotocol/clientCapabilities':{}}}},{'MCP-Protocol-Version':'2099-01-01'});
  assert.equal(unsupported.status,400);assert.equal(unsupported.data.error.code,-32022);assert.ok(unsupported.data.error.data.supported.includes(MODERN_VERSION));
  const wrongName=await f.modern(p.token,'tools/call',{name:'bridge_health',arguments:{}},{'Mcp-Name':'read_files'});
  assert.equal(wrongName.data.error.code,-32020);
  const unknown=await f.modern(p.token,'unknown/test');assert.equal(unknown.response.status,404);assert.equal(unknown.data.error.code,-32601);
  const session=await f.modern(p.token,'server/discover',{}, {'Mcp-Session-Id':'legacy-not-modern'});assert.equal(session.response.status,400);
});

test('T02 legacy initialize/initialized, bound session, deletion and reinitialization',async t=>{
  const f=await fixture(t),p=await f.pair();
  const init=await f.handshake(p.token),sid=init.headers.get('mcp-session-id'),data=await init.json() as any;
  assert.equal(init.status,200);assert.ok(sid);assert.equal(data.result.protocolVersion,LEGACY_VERSION);assert.equal(data.result.resultType,undefined);
  const headers={Authorization:`Bearer ${p.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':LEGACY_VERSION,'Mcp-Session-Id':sid!};
  const send=async(body:unknown,extra:Record<string,string>={})=>fetch(f.daemon.urls.mcp+'/mcp',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  const before=await send({jsonrpc:'2.0',id:2,method:'tools/list'});assert.equal(before.status,400);await before.text();
  const initialized=await send({jsonrpc:'2.0',method:'notifications/initialized'});assert.equal(initialized.status,202);await initialized.text();
  const listed=await send({jsonrpc:'2.0',id:3,method:'tools/list'}),list=await listed.json() as any;
  assert.ok(list.result.tools.some((tool:any)=>tool.name==='read_files'));assert.equal(list.result.resultType,undefined);
  const other=await f.pair();const swapped=await send({jsonrpc:'2.0',id:4,method:'tools/list'},{Authorization:`Bearer ${other.token}`});assert.equal(swapped.status,403);await swapped.text();
  const deleted=await fetch(f.daemon.urls.mcp+'/mcp',{method:'DELETE',headers});assert.ok(deleted.ok);await deleted.text();
  const expired=await send({jsonrpc:'2.0',id:5,method:'tools/list'});assert.equal(expired.status,404);await expired.text();
  const fresh=await f.handshake(p.token);assert.equal(fresh.status,200);assert.notEqual(fresh.headers.get('mcp-session-id'),sid);await fresh.text();
});

test('T03 official SDK auto negotiation uses discovery then executes only the requested read',async t=>{
  const f=await fixture(t),p=await f.pair();await fs.writeFile(path.join(f.root,'data.txt'),'official SDK\n');
  const client=new Client({name:'ArenaBridge-conformance',version:'1.0'},{capabilities:{},supportedProtocolVersions:[MODERN_VERSION,LEGACY_VERSION],versionNegotiation:{mode:'auto'}});
  const transport=new StreamableHTTPClientTransport(new URL(f.daemon.urls.mcp+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${p.token}`}}});
  await client.connect(transport);t.after(()=>client.close());
  assert.equal(client.getNegotiatedProtocolVersion(),MODERN_VERSION);
  const tools=await client.listTools();assert.ok(tools.tools.some(tool=>tool.name==='read_files'));
  await client.callTool({name:'bridge_health',arguments:{challenge:p.challenge}});
  const read=await client.callTool({name:'read_files',arguments:{files:[{path:'data.txt'}]}});
  assert.equal((read.structuredContent as any).data.files[0].text,'official SDK\n');
  assert.equal(f.daemon.store.events(0,200).filter(e=>e.type==='tool.completed'&&e.payload.action==='read_files').length,1);
});

test('T16/T24/T31 local MockAgent MCP patch flow requires approval and records a real diff',async t=>{
  const f=await fixture(t),p=await f.pair();
  const filename=path.join(f.root,'sum.mjs');await fs.writeFile(filename,'export const sum = (a,b) => a-b;\n');
  await f.call(p.token,'bridge_health',{challenge:p.challenge});
  const patch='--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-export const sum = (a,b) => a-b;\n+export const sum = (a,b) => a+b;\n';
  const response=await f.call(p.token,'apply_patch',{action:'preview',changes:[{path:'sum.mjs',expected_hash:sha256('export const sum = (a,b) => a-b;\n'),patch}]});
  assert.equal(response.data.result.structuredContent.ok,true,JSON.stringify(response.data));
  const data=response.data.result.structuredContent.data;
  assert.equal(await fs.readFile(filename,'utf8'),'export const sum = (a,b) => a-b;\n');
  const preview=await f.json('admin',`/admin/v1/workspaces/${p.workspace_id}/patches/${data.preview.id}`);assert.equal(preview.data.digest,data.preview.digest);
  const approval=await f.json('admin',`/admin/v1/approvals/${data.approval_id}/decision`,'POST',{approve:true});assert.equal(approval.response.status,200);
  const applied=await f.call(p.token,'apply_patch',{action:'apply',patch_id:data.preview.id,approval_id:data.approval_id});assert.equal(applied.data.result.structuredContent.ok,true,JSON.stringify(applied.data));
  assert.equal(await fs.readFile(filename,'utf8'),'export const sum = (a,b) => a+b;\n');
  assert.equal(applied.data.result.structuredContent.data.effect,'already_executed');
  const progress=await f.call(p.token,'report_progress',{stage:'patched',message:'Synthetic change committed'});assert.equal(progress.data.result.structuredContent.data.kind,'application_progress');
  const revoke=await f.json('admin','/admin/v1/revoke-all','POST',{confirm:true});assert.equal(revoke.data.new_actions_blocked,true);
  const after=await f.call(p.token,'read_files',{files:[{path:'sum.mjs'}]});assert.equal(after.response.status,403);
  const events=f.daemon.store.events(0,200);assert.equal(events.filter(e=>e.type==='approval.consumed').length,1);
  assert.equal(JSON.stringify(events).includes(p.token),false);assert.equal(JSON.stringify(events).includes('export const sum'),false);
});
