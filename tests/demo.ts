import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDaemon } from '../apps/daemon/src/server.js';
import { MODERN_VERSION, newSecret, sha256 } from '../packages/contracts/src/index.js';

/** Deterministic MockAgent scenario. This is not a model and does not contact Arena. */
export async function demo():Promise<void>{
  const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const parent=path.join(project,'.test-data');await fs.mkdir(parent,{recursive:true});
  const base=await fs.mkdtemp(path.join(parent,'demo-')),root=path.join(base,'synthetic-project');await fs.mkdir(root);
  const out=path.join(project,'outputs');await fs.mkdir(out,{recursive:true});
  const before='export const sum = (a, b) => a - b;\n',after='export const sum = (a, b) => a + b;\n';
  const tests="import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\ntest('sum handles positive integers', () => assert.equal(sum(2, 3), 5));\ntest('sum handles negative integers', () => assert.equal(sum(-2, -3), -5));\n";
  await fs.writeFile(path.join(root,'sum.mjs'),before);await fs.writeFile(path.join(root,'sum.test.mjs'),tests);
  const runTest=()=>{
    const r=spawnSync(process.execPath,['--test','sum.test.mjs'],{cwd:root,encoding:'utf8',timeout:15000});
    if(r.error)throw r.error;
    return {exit_code:r.status,stdout:r.stdout.replaceAll(root,'<synthetic-workspace>').replaceAll(root.replace(/\\/g,'/'),'<synthetic-workspace>'),stderr:r.stderr};
  };
  const baseline=runTest();assert.equal(baseline.exit_code,1);
  const adminToken=newSecret(),clientToken=newSecret();
  const daemon=await createDaemon({schema_version:1,state_directory:path.join(base,'state'),ports:{api:0,mcp:0,admin:0},workspaces:[{root,display_name:'MockAgent arithmetic repair'}],security_profile:'local_trusted_development',arena_enabled:false},{adminToken,clientToken});
  const steps:unknown[]=[];
  try{
    const post=async(origin:string,route:string,body:unknown,token?:string)=>{
      const r=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
      const data=await r.json() as any;assert.ok(r.ok,JSON.stringify(data));return data;
    };
    const pairing=await post(daemon.urls.admin,'/admin/v1/pairings',{workspace_id:daemon.workspaces[0]!.id,recipient:'Owned deterministic MockAgent on loopback',max_access:'code'},adminToken);
    const claim=await post(daemon.urls.mcp,'/pair/request',{code:pairing.code,remote_label:'MockAgent fixture',access_mode:'code'});
    await post(daemon.urls.admin,`/admin/v1/pairings/${claim.pair_id}/decision`,{approve:true,access_mode:'code',data_egress_ack:true},adminToken);
    const paired=await post(daemon.urls.mcp,'/pair/claim',{pair_id:claim.pair_id,claim_secret:claim.claim_secret});
    let seq=0;
    const rpc=async(method:string,params:Record<string,unknown>)=>{
      const r=await fetch(daemon.urls.mcp+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${paired.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':MODERN_VERSION,'Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':MODERN_VERSION,'io.modelcontextprotocol/clientCapabilities':{}}}})});
      const data=await r.json() as any;assert.ok(r.ok,JSON.stringify(data));assert.equal(data.error,undefined,JSON.stringify(data));return data.result;
    };
    const call=async(name:string,args:unknown)=>{const result=await rpc('tools/call',{name,arguments:args});assert.equal(result.structuredContent.ok,true,JSON.stringify(result));steps.push({tool:name,audit_id:result.structuredContent.metadata.audit_id,ok:true,execution_owner:result.structuredContent.metadata.execution_owner});return result.structuredContent.data;};
    const discovery=await rpc('server/discover',{});
    await call('bridge_health',{challenge:paired.challenge});
    const directory=await call('list_directory',{});
    const read=await call('read_files',{files:[{path:'sum.mjs'},{path:'sum.test.mjs'}]});
    await call('set_todos',{items:[{id:'fix',title:'Fix subtraction in sum',status:'in_progress'},{id:'verify',title:'Run owned synthetic tests',status:'pending'}]});
    const preview=await call('apply_patch',{action:'preview',changes:[{path:'sum.mjs',expected_hash:read.files[0].version_hash,patch:'--- a/sum.mjs\n+++ b/sum.mjs\n@@ -1 +1 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n'}]});
    assert.equal(await fs.readFile(path.join(root,'sum.mjs'),'utf8'),before);
    await post(daemon.urls.admin,`/admin/v1/approvals/${preview.approval_id}/decision`,{approve:true},adminToken);
    await call('apply_patch',{action:'apply',patch_id:preview.preview.id,approval_id:preview.approval_id});
    assert.equal(await fs.readFile(path.join(root,'sum.mjs'),'utf8'),after);
    const verification=runTest();assert.equal(verification.exit_code,0);
    await call('set_todos',{items:[{id:'fix',title:'Fix subtraction in sum',status:'completed'},{id:'verify',title:'Run owned synthetic tests',status:'completed'}]});
    await call('report_progress',{stage:'verified',message:'Owned test runner: 2 tests passed; actual patch hash verified'});
    const events=daemon.store.events(0,200,paired.run_id);
    const revoke=await post(daemon.urls.admin,'/admin/v1/revoke-all',{confirm:true},adminToken);
    const rejected=await fetch(daemon.urls.mcp+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${paired.token}`,'Content-Type':'application/json'},body:'{}'});await rejected.text();assert.equal(rejected.status,403);
    const evidence={schema_version:'1.0',created_at:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch},actor:'deterministic MockAgent fixture — NOT Arena or a model',approval_actor:'synthetic local test operator using independent admin credential — NOT a recorded human UI approval',command_executor:'owned QA child process, NOT the Bridge (PTY unavailable)',test_scope:'loopback MCP core; not public tunnel or desktop-client E2E',protocol:discovery.supportedVersions,execution_owner:'remote_workspace',workspace_files:directory.entries.map((e:{path:string})=>e.path),baseline,verification,steps,diff:preview.preview.changes[0].diff,file_hashes:{before:sha256(before),after:sha256(after)},events,revocation:{new_actions_blocked:revoke.new_actions_blocked,old_grant_http_status:rejected.status},unverified:['Arena authorization and live integration','WorkBuddy/TRAE real host tools','third-party MCP federation','PTY','desktop UI','installer']};
    const encoded=JSON.stringify(evidence,null,2)+'\n';for(const secret of [adminToken,clientToken,paired.token,paired.challenge,pairing.code,claim.claim_secret])assert.equal(encoded.includes(secret),false);
    await fs.writeFile(path.join(out,'demo-evidence.json'),encoded);
    await fs.writeFile(path.join(out,'demo.patch'),preview.preview.changes[0].diff);
    await fs.writeFile(path.join(out,'demo-before.mjs'),before);await fs.writeFile(path.join(out,'demo-after.mjs'),after);await fs.writeFile(path.join(out,'demo-tests.mjs'),tests);
    process.stdout.write(JSON.stringify({result:'pass',baseline_exit:baseline.exit_code,verification_exit:verification.exit_code,steps:steps.length,old_grant_status:rejected.status,evidence:'outputs/demo-evidence.json'})+'\n');
  }finally{await daemon.close();await fs.rm(base,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))void demo().catch(error=>{process.stderr.write(String(error)+'\n');process.exitCode=1;});
