import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const filename=path.join(root,'package-lock.json');
const lock=JSON.parse(await fs.readFile(filename,'utf8'));
const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
lock.packages[''].engines=manifest.engines;
lock.packages[''].bin=manifest.bin;
// Only package names and versions leave the machine; no workspace files are uploaded.
const results=[];
for(const [location,entry] of Object.entries(lock.packages)){
  if(!location)continue;
  const name=location.replace(/^node_modules\//,'');
  const url=`https://registry.npmjs.org/${encodeURIComponent(name)}/${entry.version}`;
  const response=await fetch(url,{signal:AbortSignal.timeout(20000),redirect:'error'});
  if(!response.ok)throw new Error(`${name}@${entry.version}: registry HTTP ${response.status}`);
  const metadata=await response.json();
  if(metadata.name!==name||metadata.version!==entry.version||!metadata.dist?.integrity?.startsWith('sha512-')||!metadata.dist.tarball.startsWith('https://registry.npmjs.org/'))throw new Error(`Unverified package metadata: ${name}`);
  if(entry.integrity&&entry.integrity!==metadata.dist.integrity)throw new Error(`Integrity mismatch: ${name}`);
  entry.resolved=metadata.dist.tarball;entry.integrity=metadata.dist.integrity;
  results.push({name,version:entry.version,license:metadata.license,integrity:entry.integrity});
  process.stdout.write(`${name}@${entry.version}: integrity recorded\n`);
}
await fs.writeFile(filename,JSON.stringify(lock,null,2)+'\n');
await fs.writeFile(path.join(root,'outputs','dependency-integrity.json'),JSON.stringify({checked_at:new Date().toISOString(),source:'npm official registry metadata',verification:'Registry metadata, not a cryptographic audit of upstream source',packages:results},null,2)+'\n');
