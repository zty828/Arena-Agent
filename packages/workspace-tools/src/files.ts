import { constants } from 'node:fs';
import { lstat, realpath, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import picomatch from 'picomatch';
import { BridgeError, sha256 } from '../../contracts/src/index.js';
import { compilePattern, regexLineMatches, REGEX_MAX_LINE } from './regex.js';

/** Ceiling on how many lines one regex search may hand to the matcher worker. */
const REGEX_MAX_LINES = 200000;

export const WORKSPACE_LIMITS = { fileBytes: 1048576, outputBytes: 262144, walkEntries: 2000, directoryEntries: 5000, depth: 8 } as const;
export interface DirectoryEntry { path:string; name:string; type:string; size?:number; }
export interface TextLine { text:string; eol:string; }
export interface FileRead {path:string;text:string;version_hash:string;encoding:'utf-8';eol:'LF'|'CRLF'|'mixed'|'none';bom:boolean;unsaved:false;truncated:boolean;next_line:number|null;}
const protectedDirectories = new Set<string>();
const DENIED = new Set(['.git','.hg','.svn','.ssh','.aws','.azure','.gnupg','.kube','.workbuddy-ai','.arena-bridge','appdata','library','node_modules','cookies','login data','credentials','secrets.json','id_rsa','id_ed25519','id_ecdsa']);
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const errno = (e:unknown,code:string):boolean => !!e && typeof e === 'object' && 'code' in e && e.code === code;
export const pathKey = (v:string):string => process.platform === 'win32' ? path.resolve(v).toLowerCase() : path.resolve(v);
export function denied():never { throw new BridgeError('PATH_DENIED',403,'Path is outside the approved file policy'); }
export function ioError(error:unknown):never {
  if(error instanceof BridgeError)throw error;
  const code=(error as NodeJS.ErrnoException)?.code;
  throw new BridgeError(code==='ENOENT'?'NOT_FOUND':'IO_ERROR',code==='ENOENT'?404:500,'Filesystem operation failed');
}
export function textLines(text:string):TextLine[] {
  return (text.match(/[^\n]*\n|[^\n]+$/g)??[]).map(line=>line.endsWith('\r\n')?{text:line.slice(0,-2),eol:'\r\n'}:line.endsWith('\n')?{text:line.slice(0,-1),eol:'\n'}:{text:line,eol:''});
}
export function decodeUtf8(bytes:Buffer):{text:string;bom:boolean;eol:FileRead['eol']} {
  if(bytes.includes(0))throw new BridgeError('BINARY_FILE',422,'Binary data cannot be read as text');
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new BridgeError('UNSUPPORTED_ENCODING',422,'Only valid UTF-8 is supported');}
  const crlf=text.includes('\r\n'),lf=/(^|[^\r])\n/.test(text);
  return {text,bom:text.startsWith('\uFEFF'),eol:crlf&&lf?'mixed':crlf?'CRLF':lf?'LF':'none'};
}
function sensitive(segment:string):boolean {
  const lower=segment.toLowerCase();
  return DENIED.has(lower)||lower.startsWith('.arena-tmp-')||lower==='.env'||lower.startsWith('.env.')||/\.(?:pem|pfx|p12|key)$/i.test(segment);
}
function parseRelative(value:string,allowRoot=false):string[] {
  if(allowRoot&&(value==='.'||value===''))return [];
  if(typeof value!=='string'||!value||value.length>1024||/[\x00-\x1f\x7f:]/.test(value)||/^[\\/]/.test(value)||path.isAbsolute(value))denied();
  const parts=value.replace(/\\/g,'/').split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||RESERVED.test(p)||sensitive(p)))denied();
  return parts;
}
export function normalizeRelative(value:string):string{return parseRelative(value).join('/');}
function within(root:string,target:string):boolean {
  const rel=path.relative(root,target);
  return rel===''||(!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel));
}
function page(limit=50,cursor=0):void {
  if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(cursor)||cursor<0||cursor>100000)throw new BridgeError('INVALID_ARGUMENT',400,'Invalid pagination');
}
async function validateParents(absolute:string):Promise<void> {
  const root=path.parse(absolute).root;let current=root;
  for(const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,segment);
    if((await lstat(current)).isSymbolicLink())denied();
  }
}
export class WorkspaceFiles {
  private constructor(readonly root:string,private readonly identity:{dev:number;ino:number}){}
  static async open(input:string):Promise<WorkspaceFiles> {
    if(typeof input!=='string'||/[\x00-\x1f]/.test(input)||input.replace(/\\/g,'/').split('/').includes('..'))denied();
    const abs=path.resolve(input),home=os.homedir();
    if(abs.slice(path.parse(abs).root.length).split(path.sep).some(sensitive))denied();
    const systemRoots=[process.env.WINDIR,process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.ProgramData,process.env.APPDATA,process.env.LOCALAPPDATA,...(process.platform==='win32'?[]:['/etc','/proc','/sys','/dev','/usr','/bin','/sbin','/System','/Library'])].filter((x):x is string=>!!x);
    if(systemRoots.some(root=>within(pathKey(root),pathKey(abs))))denied();
    const forbidden=[path.parse(abs).root,home,...['Desktop','Downloads','Documents'].map(n=>path.join(home,n)),process.env.WINDIR,process.env.ProgramFiles].filter((x):x is string=>!!x);
    if(forbidden.some(p=>pathKey(p)===pathKey(abs)))denied();
    if(process.platform==='win32'&&(/^[\\/]{2}/.test(input)))denied();
    await validateParents(abs);
    const real=await realpath(abs),stat=await lstat(real);
    if(!stat.isDirectory()||pathKey(abs)!==pathKey(real))denied();
    return new WorkspaceFiles(real,{dev:stat.dev,ino:stat.ino});
  }
  protectDirectory(directory:string):void {protectedDirectories.add(pathKey(directory));}
  private async verifyRoot():Promise<void> {
    await validateParents(this.root);
    const st=await lstat(this.root);
    if(!st.isDirectory()||st.isSymbolicLink()||st.dev!==this.identity.dev||st.ino!==this.identity.ino||pathKey(await realpath(this.root))!==pathKey(this.root))denied();
  }
  async resolve(relative:string,opts:{allowMissing?:boolean;allowRoot?:boolean}={}):Promise<string> {
    const parts=parseRelative(relative,opts.allowRoot??false);await this.verifyRoot();let current=this.root;
    for(let i=0;i<parts.length;i++) {
      current=path.join(current,parts[i]!);
      if([...protectedDirectories].some(root=>within(root,pathKey(current))))denied();
      let st;
      try{st=await lstat(current);}catch(e){if(opts.allowMissing&&i===parts.length-1&&errno(e,'ENOENT'))return current;return ioError(e);}
      if(st.isSymbolicLink()||(st.isFile()&&st.nlink!==1))denied();
      if(i<parts.length-1&&!st.isDirectory())throw new BridgeError('INVALID_ARGUMENT',400,'Parent is not a directory');
      if(!within(this.root,await realpath(current)))denied();
    }
    return current;
  }
  async readBytes(relative:string):Promise<Buffer> {
    const filename=await this.resolve(relative),pre=await lstat(filename);
    if(!pre.isFile())throw new BridgeError('INVALID_ARGUMENT',400,'Expected an ordinary file');
    if(pre.size>WORKSPACE_LIMITS.fileBytes)throw new BridgeError('FILE_TOO_LARGE',413,'File exceeds the 1 MiB budget');
    const handle=await open(filename,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW));
    try{
      const opened=await handle.stat();
      if(opened.ino!==pre.ino||opened.dev!==pre.dev||opened.nlink!==1)throw new BridgeError('VERSION_CONFLICT',409,'File identity changed');
      const buf=Buffer.alloc(WORKSPACE_LIMITS.fileBytes+1);let count=0;
      while(count<buf.length){const r=await handle.read(buf,count,buf.length-count,count);if(!r.bytesRead)break;count+=r.bytesRead;}
      if(count>WORKSPACE_LIMITS.fileBytes)throw new BridgeError('FILE_TOO_LARGE',413,'File grew beyond the read budget');
      const post=await handle.stat(),visible=await lstat(await this.resolve(relative));
      if(post.size!==pre.size||post.mtimeMs!==pre.mtimeMs||post.ctimeMs!==pre.ctimeMs||visible.ino!==pre.ino||visible.dev!==pre.dev||visible.size!==pre.size||visible.mtimeMs!==pre.mtimeMs)throw new BridgeError('VERSION_CONFLICT',409,'File changed during read');
      return buf.subarray(0,count);
    }finally{await handle.close();}
  }
  async hashFile(relative:string):Promise<string|null> {
    const absolute=await this.resolve(relative,{allowMissing:true});
    try{const st=await lstat(absolute);if(!st.isFile())denied();return sha256(await this.readBytes(relative));}catch(e){if(errno(e,'ENOENT'))return null;throw e;}
  }
  decode(bytes:Buffer):ReturnType<typeof decodeUtf8>{return decodeUtf8(bytes);}
  async readFiles(arg:{files:{path:string;start_line?:number;end_line?:number}[]}):Promise<{files:FileRead[];truncated:boolean}> {
    if(arg.files.length<1||arg.files.length>16)throw new BridgeError('RESOURCE_LIMIT',400,'Read between 1 and 16 files per call');
    const result:FileRead[]=[];let budget:number=WORKSPACE_LIMITS.outputBytes;
    for(const request of arg.files){
      const bytes=await this.readBytes(request.path),decoded=decodeUtf8(bytes),lines=decoded.text.match(/[^\n]*\n|[^\n]+$/g)??[];
      const start=request.start_line??1,end=request.end_line??Math.max(1,lines.length);
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end>1000000)throw new BridgeError('INVALID_ARGUMENT',400,'Invalid line range');
      let text='',next:number|null=null;
      for(let i=start-1;i<Math.min(end,lines.length);i++){const line=lines[i]!;if(Buffer.byteLength(line)>budget){next=i+1;break;}text+=line;budget-=Buffer.byteLength(line);}
      result.push({path:normalizeRelative(request.path),text,version_hash:sha256(bytes),encoding:'utf-8',eol:decoded.eol,bom:decoded.bom,unsaved:false,truncated:next!==null,next_line:next});
    }
    return {files:result,truncated:result.some(r=>r.truncated)};
  }
  async listDirectory(arg:{path?:string;limit?:number;cursor?:number}={}):Promise<{entries:DirectoryEntry[];truncated:boolean;next_cursor:number|null}> {
    page(arg.limit,arg.cursor);const rel=arg.path??'.',limit=arg.limit??50,cursor=arg.cursor??0;
    const directory=await this.resolve(rel,{allowRoot:true});
    if(!(await lstat(directory)).isDirectory())throw new BridgeError('INVALID_ARGUMENT',400,'Expected a directory');
    const entries:DirectoryEntry[]=[];let inspected=0,cap=false;
    for await(const ent of await opendir(directory)){
      if(++inspected>WORKSPACE_LIMITS.directoryEntries){cap=true;break;}if(sensitive(ent.name))continue;
      const item=rel==='.'?ent.name:`${rel}/${ent.name}`;
      try{const st=await lstat(await this.resolve(item));if(st.isDirectory()||st.isFile())entries.push({path:normalizeRelative(item),name:ent.name,type:st.isDirectory()?'directory':'file',...(st.isFile()?{size:st.size}:{})});}
      catch(e){if(!(e instanceof BridgeError)||!['PATH_DENIED','NOT_FOUND'].includes(e.code))throw e;}
    }
    entries.sort((a,b)=>a.path.localeCompare(b.path,'en'));const more=cursor+limit<entries.length;
    return {entries:entries.slice(cursor,cursor+limit),truncated:cap||more,next_cursor:more?cursor+limit:null};
  }
  private async walk(root:string):Promise<{files:string[];truncated:boolean}> {
    const queue:[string,number][]=[[root,0]],files:string[]=[];let inspected=0,truncated=false;
    while(queue.length){
      const [directory,depth]=queue.shift()!,abs=await this.resolve(directory,{allowRoot:true});
      if(!(await lstat(abs)).isDirectory())throw new BridgeError('INVALID_ARGUMENT',400,'Search root must be a directory');
      for await(const ent of await opendir(abs)){
        if(++inspected>WORKSPACE_LIMITS.walkEntries){truncated=true;break;}if(sensitive(ent.name))continue;
        const rel=directory==='.'?ent.name:`${directory}/${ent.name}`;
        try{const st=await lstat(await this.resolve(rel));if(st.isFile())files.push(normalizeRelative(rel));else if(st.isDirectory()){if(depth>=WORKSPACE_LIMITS.depth-1)truncated=true;else queue.push([rel,depth+1]);}}
        catch(e){if(!(e instanceof BridgeError)||!['PATH_DENIED','NOT_FOUND'].includes(e.code))throw e;}
      }
      if(inspected>WORKSPACE_LIMITS.walkEntries)break;
    }
    return {files:files.sort((a,b)=>a.localeCompare(b,'en')),truncated};
  }
  private matcher(globs:string[]):(v:string)=>boolean {
    if(!globs.length||globs.length>16||globs.some(g=>g.length>200||g.includes('..')||g.includes('(')||g.includes(')')))throw new BridgeError('INVALID_ARGUMENT',400,'Glob budget exceeded or unsupported extended pattern');
    return picomatch(globs,{dot:true,nocase:process.platform==='win32',noext:true,nonegate:true});
  }
  async findFiles(arg:{root?:string;globs:string[];exclude?:string[];limit?:number;cursor?:number}):Promise<{files:string[];truncated:boolean;next_cursor:number|null}> {
    page(arg.limit,arg.cursor);const root=arg.root??'.';
    const relative=(p:string)=>root==='.'?p:p.slice(root.replace(/\\/g,'/').length+1);
    const include=this.matcher(arg.globs),exclude=arg.exclude?.length?this.matcher(arg.exclude):()=>false;
    const all=await this.walk(root),filtered=all.files.filter(p=>include(relative(p))&&!exclude(relative(p)));
    const cursor=arg.cursor??0,limit=arg.limit??50,more=cursor+limit<filtered.length;
    return {files:filtered.slice(cursor,cursor+limit),truncated:all.truncated||more,next_cursor:more?cursor+limit:null};
  }
  async searchFiles(arg:{root?:string;pattern:string;case_sensitive?:boolean;regex?:boolean;globs?:string[];limit?:number;cursor?:number}):Promise<{matches:{path:string;line:number;text:string}[];truncated:boolean;next_cursor:number|null}> {
    page(arg.limit,arg.cursor);
    if(!arg.pattern||arg.pattern.length>1024)throw new BridgeError('INVALID_ARGUMENT',400,'Search pattern must contain 1-1024 characters');
    // Compiled before anything is read, so a bad pattern costs nothing and fails with a message
    // that says what is wrong with it.
    const expression=arg.regex?compilePattern(arg.pattern,arg.case_sensitive===true):null;
    const root=arg.root??'.',all=await this.walk(root),glob=this.matcher(arg.globs??['**/*']);
    const match=(p:string)=>glob(root==='.'?p:p.slice(root.replace(/\\/g,'/').length+1));
    const matches:{path:string;line:number;text:string}[]=[],cursor=arg.cursor??0,limit=arg.limit??50;
    const pattern=arg.case_sensitive?arg.pattern:arg.pattern.toLowerCase();let totalBytes=0,truncated=all.truncated,finished=false;
    // Regex mode cannot decide per line whether to stop: matching happens in one batch on the
    // worker, so the lines have to be collected first. The byte budget above and the line ceiling
    // here are what keep that batch bounded.
    const candidates:{path:string;line:number;text:string}[]=[];
    for(const file of all.files.filter(match)){
      const bytes=await this.readBytes(file);totalBytes+=bytes.length;if(totalBytes>8*WORKSPACE_LIMITS.fileBytes){truncated=true;break;}
      const lines=decodeUtf8(bytes).text.split('\n');
      if(expression){
        for(let i=0;i<lines.length;i++){
          // A single very long line is where backtracking explodes, so those are skipped and
          // reported as truncation rather than risking the daemon's event loop on them.
          if(lines[i]!.length>REGEX_MAX_LINE){truncated=true;continue;}
          candidates.push({path:file,line:i+1,text:lines[i]!});
          if(candidates.length>=REGEX_MAX_LINES){truncated=true;break;}
        }
        if(candidates.length>=REGEX_MAX_LINES)break;
        continue;
      }
      for(let i=0;i<lines.length;i++)if((arg.case_sensitive?lines[i]!:lines[i]!.toLowerCase()).includes(pattern)){
        matches.push({path:file,line:i+1,text:Array.from(lines[i]!).slice(0,1000).join('')});if(lines[i]!.length>1000)truncated=true;
        if(matches.length>cursor+limit){finished=true;break;}
      }
      if(finished)break;
    }
    if(expression){
      const hits=await regexLineMatches(candidates.map(candidate=>candidate.text),expression);
      for(const index of hits){
        const candidate=candidates[index];
        if(!candidate)continue;
        matches.push({path:candidate.path,line:candidate.line,text:Array.from(candidate.text).slice(0,1000).join('')});
        if(candidate.text.length>1000)truncated=true;
      }
    }
    const more=matches.length>cursor+limit;
    return {matches:matches.slice(cursor,cursor+limit),truncated:truncated||more,next_cursor:more?cursor+limit:null};
  }
}
