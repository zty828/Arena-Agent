import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError, newSecret } from '../../../packages/contracts/src/index.js';
import { processStartedAtMs } from '../../../packages/contracts/src/process-identity.js';

/** Never auto-break a stale daemon lock. After a crash, local inspection is required. */
export async function acquireStateLease(directory:string):Promise<()=>Promise<void>>{
  const absolute=path.resolve(directory),root=path.parse(absolute).root;let current=root;
  for(const component of absolute.slice(root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,component);
    try{await mkdir(current,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    const stat=await lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new BridgeError('POLICY_DENIED',403,'State directory components must not be links');
  }
  for(const name of ['state.sqlite','state.sqlite-wal','state.sqlite-shm']){
    try{const stat=await lstat(path.join(absolute,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new BridgeError('POLICY_DENIED',403,'State files must be ordinary unlinked files');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  // The lease records when this process started, not just its pid. Pids are recycled, so a
  // reader that only compares pids cannot tell a live daemon from an unrelated later process
  // that inherited the number; the start time is what makes the holder identifiable.
  const lock=path.join(absolute,'daemon.lock'),data=JSON.stringify({pid:process.pid,pid_started_at:processStartedAtMs(process.pid)??null,nonce:newSecret(),created_at:new Date().toISOString()});
  let handle;
  try{handle=await open(lock,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new BridgeError('VERSION_CONFLICT',409,'State directory is locked. Do not start another daemon or break the lock without local process inspection.');throw e;}
  try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
  let released=false;
  return async()=>{
    if(released)return;
    const stat=await lstat(lock);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(await readFile(lock,'utf8'))!==data)throw new BridgeError('RESULT_UNKNOWN',409,'State lock identity changed; it was not removed');
    await unlink(lock);released=true;
  };
}
