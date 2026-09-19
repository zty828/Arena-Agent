/**
 * Delivery gate: are the generated artefacts consistent with each other and with the code?
 *
 * This is the last step of a chain, so it depends on earlier steps having run:
 *
 *   contracts.mjs  ->  verify.mjs  ->  traceability.mjs  ->  check-delivery.mjs
 *
 * It validates document/schema/evidence consistency only. It is NOT a runtime or production
 * acceptance pass, and it says so in the report it writes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ConfigSchema } from '../dist/apps/daemon/src/server.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'outputs');
const checks=[];
const check=(name,condition)=>{checks.push({name,passed:!!condition});if(!condition)throw new Error(`Delivery check failed: ${name}`);};
const json=async name=>{
  try{return JSON.parse(await fs.readFile(path.join(out,name),'utf8'));}
  catch(error){
    // Name the producing step instead of surfacing a bare ENOENT. This script runs last, so
    // "which step did I forget" is the only useful question it can answer here.
    throw new Error(`Cannot read outputs/${name} (${error.code??error.message}). Run the producing step first: contracts -> verify -> traceability -> check-delivery.`);
  }
};
const spec=await json('openapi.json');check('OpenAPI version is 3.1.0',spec.openapi==='3.1.0');
function refs(value){
  if(!value||typeof value!=='object')return;
  if(typeof value.$ref==='string'&&value.$ref.startsWith('#/')){
    let target=spec;for(const key of value.$ref.slice(2).split('/').map(s=>s.replaceAll('~1','/').replaceAll('~0','~')))target=target?.[key];
    if(target===undefined)throw new Error(`Unresolved local OpenAPI reference: ${value.$ref}`);
  }
  for(const child of Object.values(value))refs(child);
}
refs(spec);check('All local OpenAPI references resolve',true);
check('Only pairing bootstrap routes are exempt from bearer auth',Object.entries(spec.paths).every(([route,ops])=>Object.values(ops).every(op=>op.security?.length||route==='/pair/request'||route==='/pair/claim')));
const tools=await json('mcp-tools.schema.json');check('Tool names are unique',new Set(tools.tools.map(t=>t.name)).size===tools.tools.length);
check('Every tool has input/output schema',tools.tools.every(t=>t.inputSchema&&t.outputSchema));
const requirements=await json('requirements-traceability.json'),matrix=await json('test-matrix.json');
check('All 27 B/N/O/X entries present',requirements.requirements.length===27&&new Set(requirements.requirements.map(r=>r.id)).size===27);
check('All 38 T acceptance groups present',matrix.tests.length===38&&new Set(matrix.tests.map(r=>r.id)).size===38);
const verification=await json('verification.json');
// This assertion used to hardcode a specific failure — status `failed`, 44 failing tests — to
// prove a bad run had not been relabelled as a pass. The intent is right; the implementation
// rotted, because the moment the suite genuinely went green the delivery gate began failing for
// the opposite reason. The invariant that actually matters is agreement: whatever the regression
// reports, the delivery summary must report the same thing.
const expected=verification.status==='passed'?'passed':verification.status==='failed'?'failed':'not_run';
check('The delivery summary agrees with the regression instead of relabelling it',
  matrix.overall_status===expected
  &&matrix.latest_run.total===(verification.tests?.total??0)
  &&matrix.latest_run.passed===(verification.tests?.passed??0)
  &&matrix.latest_run.failed===(verification.tests?.failed??0));
// The local config is the one generated runtime config that actually exists; validate it against
// the real schema so a drift in its generator is caught here rather than at daemon startup.
const config=await json('run-local.config.json');check('Generated runtime config validates against the actual schema',ConfigSchema.safeParse(config).success);
check('No raw secrets in generated config',!Object.keys(config).some(key=>/token|secret|password|key$/i.test(key))&&config.arena_enabled===false);
const evidence=await json('demo-evidence.json');check('Real demo retains failure and success exit codes',evidence.baseline.exit_code===1&&evidence.verification.exit_code===0&&evidence.revocation.old_grant_http_status===403);
const patch=await fs.readFile(path.join(out,'demo.patch'),'utf8');check('Delivered patch equals recorded actual diff',patch===evidence.diff);
for(const [name,which] of [['demo-before.mjs','before'],['demo-after.mjs','after']])check(`${name} SHA256 matches evidence`,createHash('sha256').update(await fs.readFile(path.join(out,name))).digest('hex')===evidence.file_hashes[which]);
const sbom=await json('sbom.cdx.json');
// Derived from the lock rather than pinned to a number: a hardcoded count turns "we added a
// dependency" into an unexplained delivery failure.
const lock=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
const expectedComponents=Object.keys(lock.packages).filter(location=>location).length;
check(`SBOM enumerates every resolved dependency (${expectedComponents})`,sbom.bomFormat==='CycloneDX'&&sbom.components.length===expectedComponents);
for(const name of (await fs.readdir(path.join(root,'scripts'))).filter(name=>name.endsWith('.mjs'))){
  const result=spawnSync(process.execPath,['--check',path.join(root,'scripts',name)],{encoding:'utf8',timeout:10000});
  check(`Syntax ${name}`,result.status===0);
}
const report={created_at:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,kernel_release:os.release()},status:'passed',scope:'Delivery format, schema references and evidence consistency only; NOT a runtime or production acceptance pass',checks};
await fs.writeFile(path.join(out,'delivery-checks.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify({checks:checks.length,status:report.status,kernel_release:report.environment.kernel_release,scope:report.scope})+'\n');
