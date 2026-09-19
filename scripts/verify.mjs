import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'outputs');await fs.mkdir(output,{recursive:true});
const results=[];

// The host WorkBuddy CLI installs a node-safe-delete shim that charges every
// deletion made by a child Node process against a per-agent-tool-call budget
// (threshold 50). Running the whole suite in one spawn from an agent session
// therefore exhausts the budget partway through, and the resulting failures are
// environmental, not regressions -- they abort the run before it reaches its
// final tally. Hand each test file its own child environment with no ledger to
// charge against, which is what an ordinary interactive shell looks like. The
// shim stays loaded; it simply has nothing to count. See scripts/run-tests-clean.mjs.
const BUDGET_VARS=['CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR','CODEBUDDY_SAFE_DELETE_BULK_GUARD','CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD','CODEBUDDY_TOOL_CALL_ID','CODEBUDDY_CONVERSATION_REQUEST_ID'];
function childEnv(index){
  const env={...process.env};
  for(const name of BUDGET_VARS)delete env[name];
  env.CODEBUDDY_CONVERSATION_REQUEST_ID=`arenabridge-verify-${process.pid}-${index??0}`;
  env.CODEBUDDY_TOOL_CALL_ID=env.CODEBUDDY_CONVERSATION_REQUEST_ID;
  return env;
}

async function run(label,args,timeout=180000,env){
  const started=new Date().toISOString(),start=performance.now();
  const result=await new Promise(resolve=>{
    const child=spawn(process.execPath,args,{cwd:root,env:env??process.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeout);
    child.stdout.on('data',chunk=>{stdout+=String(chunk);});child.stderr.on('data',chunk=>{stderr+=String(chunk);});
    child.on('error',error=>{stderr+=error.message;});
    child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr,timedOut});});
  });
  const record={label,command:['<node>',...args.map(a=>a.startsWith(root)?path.relative(root,a):a)],started_at:started,duration_ms:Math.round(performance.now()-start),exit_code:result.code,timed_out:result.timedOut};
  results.push(record);
  await fs.writeFile(path.join(output,`${label}.log`),result.stdout+(result.stderr?'\n[stderr]\n'+result.stderr:''));
  process.stdout.write(`${label}: exit ${result.code}, ${record.duration_ms} ms\n`);
  if(result.code!==0||result.timedOut){
    process.stderr.write(result.stdout+result.stderr);
    // Same shape as the success path, on purpose. The failure record used to be written with
    // different field names (`node`/`platform` instead of `environment`, and no `tests` at all),
    // which meant nothing that reads this file could read a failure: the traceability table looks
    // for `tests`, so a failed run came out there as "not run" — the one thing a failure must
    // never be mistaken for. `failed_stage` says where it stopped, and the zeroed counts are
    // honest because the run never got far enough to count anything.
    const failure={status:'failed',created_at:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch},tests:{total:0,passed:0,failed:0,skipped:0,cancelled:0},failed_stage:label,scope:'Local automated QA with owned synthetic projects; not Arena, WorkBuddy/TRAE, production or real human approval E2E',results};
    await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(failure,null,2)+'\n');
    throw new Error(`Verification failed: ${label}`);
  }
  return result.stdout;
}
await run('build',[path.join(root,'node_modules','typescript','bin','tsc'),'-p',path.join(root,'tsconfig.json')]);
// Runs immediately after the build and before anything slow: it is a static check that every
// dynamic import in the output resolves, which catches path wiring that only breaks at runtime
// (a relative specifier that was correct in the source tree but not after compilation).
await run('probe-imports',[path.join(root,'scripts','probe-import-paths.mjs')]);
await run('probe-desktop-wiring',[path.join(root,'scripts','probe-desktop-tunnel-wiring.mjs')]);
// The operator-facing half of the Arena flow: a pairing request must be visible and approvable.
await run('probe-pairing-approval',[path.join(root,'scripts','probe-pairing-approval.mjs')]);
// The remote half: what a sandboxed agent actually reads out of a tool result. A client that
// looks for entries one level too high silently reports an empty workspace.
await run('probe-client-envelope',[path.join(root,'scripts','probe-client-envelope.mjs')]);
// The access-mode ceiling: a pairing code carries a hard maximum, and the window must be able to
// mint one at the mode the operator chose. Otherwise `code` is unreachable no matter what the
// prompt asks for, and raising the mode by hand only earns a 403.
await run('probe-access-mode',[path.join(root,'scripts','probe-access-mode.mjs')]);
// Unattended writes: the switch that removes the human from the write path. The checks that
// matter are the guards (opt-in only, never open-ended, expiry enforced, turned off by
// disconnect) and that the audit trail does not attribute a machine decision to the operator.
await run('probe-auto-approve',[path.join(root,'scripts','probe-auto-approve.mjs')]);
// The grant's lifetime. Session-scoped by default, and — the half that makes that acceptable —
// still bounded: it is refused after a restart (epoch rotation) and after revocation, and a
// timed grant still expires, so "no wall-clock expiry" cannot be a broken expiry check.
await run('probe-grant-lifetime',[path.join(root,'scripts','probe-grant-lifetime.mjs')]);
// Command execution, the edit helper and real regex. The operator asked for commands to run with
// no approval step, which removes the last human check on what reaches this machine — so what is
// asserted here is everything that is left: the tier gate, the cwd bound, the scrubbed child
// environment, a killable process tree, the audit record, and a regex that cannot wedge the
// daemon's single event loop.
await run('probe-exec',[path.join(root,'scripts','probe-exec.mjs')]);
// The window's own checks run here too. They are the only automated coverage of two things a
// headless probe cannot reach: that the mode picker exists and defaults to read-only, and that
// the operator's choice survives contextBridge into the main process. Skipping this stage is how
// the picker could regress to minting every code read-only without any probe failing.
await run('desktop-selftest',[path.join(root,'scripts','desktop-selftest.mjs')],240000,childEnv('desktop-selftest'));
const testFiles=(await fs.readdir(path.join(root,'dist','tests'))).filter(name=>name.endsWith('.test.js')).sort().map(name=>path.join(root,'dist','tests',name));
// One child per test file, each with an independent deletion budget, so the
// host shim cannot abort the run before it reaches its final tally.
let tap='';
for(const [index,file] of testFiles.entries()){
  // A colon in the label would become an unsafe filename on Windows and the
  // per-file log write would fail, so use a filesystem-safe separator.
  tap+=await run(`tests-${path.basename(file).replace(/\.test\.js$/,'')}`,['--test','--test-concurrency=1','--test-timeout=180000',file],480000,childEnv(index));
}
// `demo` and `sbom` are given the same clean deletion budget as the test files. Both of them
// tear down a real daemon and unlink its state, so both are exposed to the host shim's per-turn
// budget: run in the same turn as everything else, `demo` reaches it (`count 60 > threshold 50`)
// and its own `daemon.close()` is refused. That aborts the run at the last stage with every
// check already green -- `{"result":"pass",...}` then a non-zero exit -- which reads as a
// regression and is not one. See the note on BUDGET_VARS above.
await run('demo',[path.join(root,'dist','tests','demo.js')],180000,childEnv('demo'));
await run('sbom',[path.join(root,'scripts','sbom.mjs')],180000,childEnv('sbom'));
// Each file reports its own "# tests / # pass / # fail" block, so sum them;
// reading a single match would report only whichever file ran last.
const count=name=>[...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`,'gm'))].reduce((total,match)=>total+Number(match[1]),0);
const lockHash=createHash('sha256').update(await fs.readFile(path.join(root,'package-lock.json'))).digest('hex');
const report={status:'passed',created_at:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch},tests:{total:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped'),cancelled:count('cancelled')},package_lock_sha256:lockHash,scope:'Local automated QA with owned synthetic projects; not Arena, WorkBuddy/TRAE, production or real human approval E2E',results};
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify(report.tests)+'\n');
