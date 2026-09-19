import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const lock=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const output=path.join(root,'outputs');await fs.mkdir(output,{recursive:true});
const licenses=new Map(),components=[];
for(const [location,entry] of Object.entries(lock.packages)){
  if(!location)continue;
  const name=location.replace(/^node_modules\//,''),installed=JSON.parse(await fs.readFile(path.join(root,location,'package.json'),'utf8'));
  if(installed.version!==entry.version||installed.name!==name)throw new Error(`Installed dependency differs from lock: ${name}`);
  if(!entry.integrity||!entry.resolved)throw new Error(`Missing lock integrity: ${name}`);
  const license=installed.license??entry.license??'UNKNOWN';
  licenses.set(license,(licenses.get(license)??0)+1);
  const purl=`pkg:npm/${name.startsWith('@')?name.replace('@','%40'):name}@${entry.version}`;
  const sri=entry.integrity.split(' ').find(value=>value.startsWith('sha512-'));
  if(!sri)throw new Error(`No SHA512 integrity: ${name}`);
  components.push({type:'library','bom-ref':purl,name,version:entry.version,scope:entry.dev?'optional':'required',purl,licenses:[{license:{id:license}}],hashes:[{alg:'SHA-512',content:Buffer.from(sri.slice(7),'base64').toString('hex')}],externalReferences:[{type:'distribution',url:entry.resolved}],properties:[{name:'arenabridge:integrity-scope',value:'npm-distribution-archive, not expanded files'},{name:'arenabridge:development-dependency',value:String(!!entry.dev)}]});
}
const byName=new Map(components.map(c=>[c.name,c['bom-ref']]));
const appRef=`arena-bridge:${manifest.version}`;
const dependencies=[{ref:appRef,dependsOn:[...Object.keys(manifest.dependencies),...Object.keys(manifest.devDependencies)].map(name=>byName.get(name)).filter(Boolean)},...Object.entries(lock.packages).filter(([location])=>location).map(([location,entry])=>({ref:byName.get(location.replace(/^node_modules\//,'')),dependsOn:Object.keys(entry.dependencies??{}).map(name=>byName.get(name)).filter(Boolean)}))];
const sbom={bomFormat:'CycloneDX',specVersion:'1.6',serialNumber:`urn:uuid:${randomUUID()}`,version:1,metadata:{timestamp:new Date().toISOString(),component:{type:'application',name:manifest.name,version:manifest.version,'bom-ref':appRef},properties:[{name:'arenabridge:scope',value:'Node daemon and CLI stage1; not a signed installer or full production product'}]},components,dependencies};
await fs.writeFile(path.join(output,'sbom.cdx.json'),JSON.stringify(sbom,null,2)+'\n');
const report={checked_at:new Date().toISOString(),method:'Compare installed manifest names/versions with lock; enumerate SPDX licenses; installer scripts disabled during install',package_count:components.length,license_summary:Object.fromEntries(licenses),unknown_licenses:components.filter(c=>c.licenses[0].license.id==='UNKNOWN').map(c=>c.name),source_license:manifest.license,supply_chain_limits:['No independent cryptographic source-to-tarball reproducibility audit','License identifiers are package-maintainer assertions, not a legal opinion','OS keyring, native desktop dependencies and signed installers are outside this build'],install_scripts_executed:false};
await fs.writeFile(path.join(output,'license-review.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify({packages:components.length,licenses:report.license_summary,sbom:'outputs/sbom.cdx.json'})+'\n');
