import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDaemon, ConfigSchema } from '../apps/daemon/src/server.js';
import { newSecret } from '../packages/contracts/src/index.js';

// Uses the existing synthetic workspace and creates a fresh state directory.
// It deliberately does NOT recursively delete: this host blocks bulk deletes.
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const workspaceRoot=path.join(project,'outputs','synthetic-workspace');
const stamp=Date.now();

test('D01 real daemon API port serves the gateway end to end with mock config',async t=>{
  const state=path.join(project,'outputs','gateway-increment',`e2e-state-${stamp}`);
  const adminToken=newSecret(),clientToken=newSecret();
  const config=ConfigSchema.parse({schema_version:1,state_directory:state,ports:{api:0,mcp:0,admin:0},workspaces:[{root:workspaceRoot,display_name:'Synthetic gateway E2E'}],response_mode:'json',security_profile:'local_trusted_development',arena_enabled:false,gateway:{type:'mock',acknowledge_mock:true,alias:'mock-e2e',scenario:'echo'}});
  assert.equal(config.gateway.type,'mock');
  const daemon=await createDaemon(config,{adminToken,clientToken});
  try{
    const call=async(route:string,init:RequestInit={})=>fetch(daemon.urls.api+route,{...init,headers:{Authorization:`Bearer ${clientToken}`,'Content-Type':'application/json',...(init.headers??{})}});
    const models=await (await call('/v1/models')).json() as any;
    assert.deepEqual(models.data.map((model:any)=>model.id),['mock-e2e']);
    const ready=await call('/readyz');assert.equal(ready.status,200);
    const completion=await call('/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'mock-e2e',messages:[{role:'user',content:'端到端'}]})});
    assert.equal(completion.status,200);assert.equal(completion.headers.get('x-arenabridge-execution-owner'),'client');
    const body=await completion.json() as any;assert.match(body.choices[0].message.content,/端到端/);
    const stream=await call('/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'mock-e2e',messages:[{role:'user',content:'流'}],stream:true})});
    assert.equal(stream.headers.get('content-type'),'text/event-stream; charset=utf-8');
    const text=await stream.text();assert.ok(text.endsWith('data: [DONE]\n\n'));assert.ok(text.includes('流'));
    const capabilities=await (await fetch(daemon.urls.admin+'/bridge/v1/capabilities',{headers:{Authorization:`Bearer ${adminToken}`}})).json() as any;
    assert.equal(capabilities.model_api.chat_completions,'implemented_bounded_client_tools_alpha');
    assert.equal(capabilities.model_api.gateway.enabled,true);assert.equal(capabilities.model_api.gateway.execution_owner,'client');
    assert.equal(capabilities.model_api.gateway.tools_executed_by_gateway,false);
    assert.equal(capabilities.arena.status,'blocked');
    // A model API key is not a workspace grant: the MCP port rejects it during authentication.
    const wrongPort=await fetch(daemon.urls.mcp+'/v1/models',{headers:{Authorization:`Bearer ${clientToken}`}});assert.equal(wrongPort.status,401);
    const crossRole=await fetch(daemon.urls.api+'/v1/models',{headers:{Authorization:`Bearer ${adminToken}`}});assert.equal(crossRole.status,401);
    const status=await (await fetch(daemon.urls.admin+'/admin/v1/status',{headers:{Authorization:`Bearer ${adminToken}`}})).json() as any;
    assert.equal(status.health.arena,'blocked');assert.equal(status.credentials_persisted,false);
    assert.equal(JSON.stringify(status).includes(clientToken),false);
  }finally{await daemon.close();}
});

test('D02 disabled gateway reports no model and refuses inference without touching the workspace',async t=>{
  const state=path.join(project,'outputs','gateway-increment',`e2e-state-disabled-${stamp}`);
  const adminToken=newSecret(),clientToken=newSecret();
  const daemon=await createDaemon({schema_version:1,state_directory:state,ports:{api:0,mcp:0,admin:0},workspaces:[{root:workspaceRoot,display_name:'Synthetic disabled gateway'}],response_mode:'json',security_profile:'local_trusted_development',arena_enabled:false},{adminToken,clientToken});
  try{
    const models=await (await fetch(daemon.urls.api+'/v1/models',{headers:{Authorization:`Bearer ${clientToken}`}})).json() as any;
    assert.deepEqual(models,{object:'list',data:[]});
    const response=await fetch(daemon.urls.api+'/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${clientToken}`,'Content-Type':'application/json'},body:JSON.stringify({model:'anything',messages:[{role:'user',content:'x'}]})});
    assert.equal(response.status,503);assert.equal((await response.json() as any).error.code,'UPSTREAM_UNAVAILABLE');
    assert.equal((await fetch(daemon.urls.api+'/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${clientToken}`,'Content-Type':'application/json'},body:'{}'})).status,422);
    const files=await fs.readdir(workspaceRoot);assert.deepEqual(files.sort(),['sum.mjs','sum.test.mjs']);
  }finally{await daemon.close();}
});
