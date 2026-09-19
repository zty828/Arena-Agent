import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { BridgeError, LEGACY_VERSION, MODERN_VERSION } from '../../../packages/contracts/src/index.js';

function localEndpoint(value:string):URL {
  const endpoint=new URL(value);
  if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.pathname!=='/mcp'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password)throw new BridgeError('POLICY_DENIED',403,'stdio may only forward to http://127.0.0.1:<port>/mcp');
  return endpoint;
}
function encodedName(value:string):string {
  return /[^\x20-\x7e]/.test(value)||value.trim()!==value||/^=\?base64\?.*\?=$/.test(value)?`=?base64?${Buffer.from(value,'utf8').toString('base64')}?=`:value;
}
/** A bounded stdio-to-loopback transport relay. It neither executes tools nor owns a second workspace grant. */
export async function serveStdioRelay(value:string,token:string):Promise<void>{
  const endpoint=localEndpoint(value);
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw new BridgeError('AUTH_REQUIRED',401,'Set ARENABRIDGE_MCP_TOKEN to a short-lived paired grant');
  const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:1048576});
  let session:string|undefined,era:'modern'|'legacy'|undefined,queued=0,closed=false;
  let chain=Promise.resolve();
  const error=async(message:JSONRPCMessage,code:number,text:string)=>{
    if('id'in message&&'method'in message)await transport.send({jsonrpc:'2.0',id:message.id,error:{code,message:text}});
  };
  const sendFrames=async(response:Response):Promise<void>=>{
    if(!response.body)return;
    const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='';
    try{
      for(;;){
        const read=await reader.read();buffer+=decoder.decode(read.value,{stream:!read.done});
        if(Buffer.byteLength(buffer)>4*1048576)throw new Error('MCP response exceeds relay budget');
        let match:RegExpExecArray|null;
        while((match=/\r?\n\r?\n/.exec(buffer))!==null){
          const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);
          const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
          if(data)await transport.send(JSON.parse(data) as JSONRPCMessage);
        }
        if(read.done){if(buffer.trim())throw new Error('Incomplete SSE frame');break;}
      }
    }finally{reader.releaseLock();}
  };
  transport.onmessage=(message)=>{
    if(queued>=16){void error(message,-32603,'Relay queue full; request was not forwarded');return;}
    queued++;
    chain=chain.then(async()=>{
      if(closed)return;
      const rpc=message as unknown as {id?:string|number;method?:string;params?:Record<string,unknown>};
      const meta=rpc.params?._meta as Record<string,unknown>|undefined;
      const version=meta?.['io.modelcontextprotocol/protocolVersion'];
      const current=version!==undefined?'modern':'legacy';
      if(era&&era!==current&&rpc.method&&!rpc.method.startsWith('notifications/')){await error(message,-32600,'The stdio connection is pinned to a different protocol era');return;}
      const headers:Record<string,string>={Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
      if(current==='modern'){
        headers['MCP-Protocol-Version']=typeof version==='string'?version:MODERN_VERSION;
        if(rpc.method)headers['Mcp-Method']=rpc.method;
        if(rpc.method==='tools/call'||rpc.method==='prompts/get')headers['Mcp-Name']=encodedName(String(rpc.params?.name??''));
        if(rpc.method==='resources/read')headers['Mcp-Name']=encodedName(String(rpc.params?.uri??''));
      }else if(session){headers['Mcp-Session-Id']=session;headers['MCP-Protocol-Version']=LEGACY_VERSION;}
      const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(message),signal:AbortSignal.timeout(30000),redirect:'error'});
      if(response.headers.has('mcp-session-id'))session=response.headers.get('mcp-session-id')!;
      if(response.status===202||response.status===204){await response.body?.cancel();return;}
      if(response.headers.get('content-type')?.includes('text/event-stream')){await sendFrames(response);if(response.ok)era=current;return;}
      const raw=await response.text();
      if(Buffer.byteLength(raw)>4*1048576)throw new Error('MCP response exceeds relay budget');
      const result=JSON.parse(raw) as Record<string,unknown>;
      if(result.jsonrpc==='2.0'){
        await transport.send(result as unknown as JSONRPCMessage);
        if(response.ok&&result.result)era=current;
      }else await error(message,-32603,`Loopback MCP refused the request (HTTP ${response.status}); check grant and daemon status`);
    }).catch(async()=>{await error(message,-32603,'Loopback transport failed; side-effect result may be unknown. Do not automatically retry.');}).finally(()=>{queued--;});
  };
  await new Promise<void>((resolve,reject)=>{
    transport.onclose=()=>{closed=true;resolve();};
    transport.onerror=()=>{process.stderr.write('ArenaBridge stdio transport error; details redacted.\n');};
    process.stdin.once('end',()=>{void chain.finally(async()=>{closed=true;await transport.close();resolve();});});
    transport.start().catch(reject);
  });
}
