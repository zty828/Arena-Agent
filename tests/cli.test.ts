import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { LEGACY_VERSION, MODERN_VERSION } from '../packages/contracts/src/index.js';
import { fixture } from './helpers.js';
const cli=fileURLToPath(new URL('../apps/daemon/src/cli.js',import.meta.url));

for(const era of ['modern','legacy'] as const)test(`T02/T03 CLI stdio ${era}: real SDK discovers and reads through one bound HTTP grant`,async t=>{
  const f=await fixture(t),p=await f.pair('ask');await fs.writeFile(path.join(f.root,'cli.txt'),'stdio is real\n');
  const transport=new StdioClientTransport({command:process.execPath,args:[cli,'mcp','stdio','--endpoint',f.daemon.urls.mcp+'/mcp'],env:{ARENABRIDGE_MCP_TOKEN:p.token},stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=String(chunk);});
  const client=new Client({name:'ArenaBridge CLI QA',version:'1.0'},{capabilities:{},supportedProtocolVersions:[MODERN_VERSION,LEGACY_VERSION],versionNegotiation:{mode:era==='modern'?'auto':'legacy'}});
  t.after(()=>client.close());await client.connect(transport);
  assert.equal(client.getNegotiatedProtocolVersion(),era==='modern'?MODERN_VERSION:LEGACY_VERSION);
  const listed=await client.listTools();assert.ok(listed.tools.some(tool=>tool.name==='read_files'));assert.equal(listed.tools.some(tool=>tool.name==='apply_patch'),false);
  await client.callTool({name:'bridge_health',arguments:{challenge:p.challenge}});
  const result=await client.callTool({name:'read_files',arguments:{files:[{path:'cli.txt'}]}});
  assert.equal((result.structuredContent as any).data.files[0].text,'stdio is real\n');
  assert.equal(stderr.includes(p.token),false);
});

test('CLI init creates an actual non-secret config and refuses to overwrite it',async t=>{
  const f=await fixture(t),config=path.join(f.base,'config.json');
  const args=[cli,'init','--workspace',f.root,'--config',config,'--state',path.join(f.base,'new-state')];
  const first=spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000});assert.equal(first.status,0,first.stderr);
  const raw=await fs.readFile(config,'utf8'),parsed=JSON.parse(raw);assert.equal(parsed.arena_enabled,false);assert.equal(parsed.ports.mcp,48271);assert.equal(raw.includes('token'),false);
  const second=spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000});assert.notEqual(second.status,0);assert.equal(await fs.readFile(config,'utf8'),raw);
});

test('CLI relay rejects remote URLs and missing credentials without sending any network request',()=>{
  const noToken=spawnSync(process.execPath,[cli,'mcp','stdio'],{env:{...process.env,ARENABRIDGE_MCP_TOKEN:''},encoding:'utf8',timeout:10000});
  assert.equal(noToken.status,1);assert.equal(noToken.stdout,'');assert.match(noToken.stderr,/AUTH_REQUIRED/);
  const remote=spawnSync(process.execPath,[cli,'mcp','stdio','--endpoint','https://unapproved.example/mcp'],{encoding:'utf8',timeout:10000});assert.equal(remote.status,1);assert.equal(remote.stdout,'');assert.match(remote.stderr,/POLICY_DENIED/);
});

test('CLI serve keeps secrets out of output; Windows force termination leaves a safety lock',async t=>{
  const f=await fixture(t),state=path.join(f.base,'cli-state'),config=path.join(f.base,'serve.json');
  await fs.writeFile(config,JSON.stringify({schema_version:1,state_directory:state,ports:{api:0,mcp:0,admin:0},workspaces:[{root:f.root,display_name:'CLI owned fixture'}],security_profile:'local_trusted_development',arena_enabled:false}));
  const child=spawn(process.execPath,[cli,'serve','--config',config],{env:{...process.env,ARENABRIDGE_ADMIN_TOKEN:f.adminToken,ARENABRIDGE_API_TOKEN:f.clientToken,ARENABRIDGE_MCP_TOKEN:f.mcpToken},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let errors='';child.stderr.on('data',chunk=>{errors+=String(chunk);});
  const ready=await new Promise<any>((resolve,reject)=>{
    let buffer='';child.once('error',reject);child.once('exit',code=>reject(new Error(`CLI exited ${code}: ${errors}`)));
    child.stdout.on('data',chunk=>{buffer+=String(chunk);const line=buffer.split('\n')[0];if(line)resolve(JSON.parse(line));});
  });
  assert.equal(ready.event,'daemon.ready');assert.equal(JSON.stringify(ready).includes(f.adminToken),false);
  const status=await fetch(ready.urls.admin+'/admin/v1/status',{headers:{Authorization:`Bearer ${f.adminToken}`}});assert.equal(status.status,200);await status.text();
  // Windows child.kill() is force termination rather than a portable SIGTERM handler;
  // validate graceful lifecycle through a controlled IPC-independent stdin-free harness below.
  if(process.platform==='win32'){
    child.kill();await once(child,'exit');
    assert.equal((await fs.lstat(path.join(state,'daemon.lock'))).isFile(),true);
    assert.equal(errors.includes(f.adminToken),false);
  }else{
    const exited=once(child,'exit');child.kill('SIGTERM');await exited;
    await assert.rejects(fs.lstat(path.join(state,'daemon.lock')),{code:'ENOENT'});
  }
});
