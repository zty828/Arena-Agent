import { McpServer, createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport, type McpHttpHandler, type ServerContext } from '@modelcontextprotocol/server';
import { APP_VERSION, LEGACY_VERSION, MODERN_VERSION, ToolResultSchema, newId, newSecret, type InvocationContext } from '../../contracts/src/index.js';
import { PolicyEngine } from '../../policy-engine/src/index.js';
import { ToolHost, ToolDescriptions, ToolSchemas } from '../../../apps/daemon/src/tools.js';

export function buildMcpServer(host:ToolHost,resolveContext:()=>InvocationContext,era:'modern'|'legacy'):McpServer {
  const server=new McpServer({name:'ArenaBridge',version:APP_VERSION},{
    capabilities:{tools:{}},supportedProtocolVersions:era==='modern'?[MODERN_VERSION,LEGACY_VERSION]:[LEGACY_VERSION],
    instructions:'ArenaBridge stage1: use only the granted workspace. Never edit a cloud sandbox copy. Ask/Plan are read-only. Patch preview needs a separate local approval. Terminal, IDE semantics, model inference and external MCP federation are unavailable. File output leaves the local process; do not request secrets.'
  });
  for(const name of host.catalog(resolveContext())){
    server.registerTool(name,{
      description:ToolDescriptions[name],inputSchema:ToolSchemas[name],outputSchema:ToolResultSchema,
      annotations:{readOnlyHint:!['apply_patch','set_todos','report_progress'].includes(name),destructiveHint:name==='apply_patch',openWorldHint:false}
    },async (args:unknown,ctx:ServerContext)=>{
      const context=resolveContext();
      const result=await host.call(name,args,{...context,request_id:newId('req')},ctx.mcpReq.signal);
      return {isError:!result.ok,content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:{...result}};
    });
  }
  return server;
}
function rpcError(status:number,id:unknown,code:number,message:string,data?:unknown):Response {
  return Response.json({jsonrpc:'2.0',id:typeof id==='number'||typeof id==='string'?id:null,error:{code,message,...(data===undefined?{}:{data})}},{status});
}
interface LegacySession {id:string;grant_id:string;transport:WebStandardStreamableHTTPServerTransport;server:McpServer;initialized:boolean;expires_at:number;}
export class McpGateway {
  private readonly modern:McpHttpHandler;
  private readonly sessions=new Map<string,LegacySession>();
  constructor(private readonly host:ToolHost,private readonly policy:PolicyEngine,readonly responseMode:'json'|'sse'='json',private readonly auth:{allowLocal:boolean;workspaceId:string}={allowLocal:false,workspaceId:''}){
    const resolve=(auth:string|undefined)=>policy.resolveMcpContext(auth,newId('req'),this.auth);
    this.modern=createMcpHandler(ctx=>{
      const header=ctx.requestInfo?.headers.get('authorization')??undefined;
      return buildMcpServer(host,()=>resolve(header),'modern');
    },{legacy:'reject',responseMode,maxSubscriptions:0,onerror:()=>{host.store.event('mcp.protocol_error',{transport:'http',protocol_version:MODERN_VERSION});}});
  }
  async fetch(request:Request,parsedBody?:unknown,resolved?:InvocationContext):Promise<Response>{
    // Authentication is checked on every request, including discovery and existing sessions.
    // The caller may pass a context it already resolved; otherwise resolve here.
    const context=resolved??this.policy.resolveMcpContext(request.headers.get('authorization')??undefined,newId('req'),this.auth);
    if(request.method==='POST'&&!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return rpcError(415,null,-32600,'Content-Type must be application/json');
    const body=parsedBody??(request.method==='POST'?await request.clone().json().catch(()=>null):undefined);
    const rpc=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:undefined;
    if(Array.isArray(body))return rpcError(400,null,-32600,'JSON-RPC batches are not supported');
    const legacy=await isLegacyRequest(request,body);
    if(!legacy){
      if(request.headers.has('mcp-session-id'))return rpcError(400,rpc?.id,-32602,'Protocol sessions are not used in the modern era');
      if(typeof rpc?.method==='string'&&(rpc.method.startsWith('subscriptions/')||rpc.method.startsWith('tasks/')))return rpcError(404,rpc.id,-32601,'This extension is not supported');
      return this.modern.fetch(request,{parsedBody:body});
    }
    return this.legacyFetch(request,rpc,context);
  }
  private async legacyFetch(request:Request,rpc:Record<string,unknown>|undefined,context:InvocationContext):Promise<Response>{
    for(const [id,s] of this.sessions)if(s.expires_at<=Date.now()){await s.server.close();this.sessions.delete(id);}
    const sid=request.headers.get('mcp-session-id');
    const auth=request.headers.get('authorization')??undefined;
    if(request.method==='GET')return new Response(null,{status:405,headers:{Allow:'POST, DELETE'}});
    if(!sid){
      if(request.method!=='POST'||rpc?.method!=='initialize')return rpcError(400,rpc?.id,-32600,'Legacy MCP requires initialize before other methods');
      if(this.sessions.size>=64)return rpcError(429,rpc.id,-32603,'Session budget exceeded');
      const id=newSecret();
      const server=buildMcpServer(this.host,()=>this.policy.resolveMcpContext(auth,newId('req'),this.auth),'legacy');
      const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:()=>id,enableJsonResponse:this.responseMode==='json'});
      const session:LegacySession={id,grant_id:context.grant.id,transport,server,initialized:false,expires_at:context.grant.expires_at};
      await server.connect(transport);
      const response=await transport.handleRequest(request,{parsedBody:rpc});
      if(response.ok&&response.headers.get('mcp-session-id')===id)this.sessions.set(id,session);
      else await server.close();
      return response;
    }
    const session=this.sessions.get(sid);
    if(!session)return rpcError(404,rpc?.id,-32000,'Legacy session expired; reinitialize without the old session ID');
    if(session.grant_id!==context.grant.id)return rpcError(403,rpc?.id,-32600,'Session belongs to a different grant');
    if(request.headers.get('mcp-protocol-version')!==LEGACY_VERSION)return rpcError(400,rpc?.id,-32602,'MCP-Protocol-Version must match the negotiated legacy version');
    if(request.method==='DELETE'){
      const response=await session.transport.handleRequest(request);await session.server.close();this.sessions.delete(sid);return response;
    }
    if(rpc?.method==='initialize')return rpcError(400,rpc.id,-32600,'Session has already been initialized');
    if(!session.initialized&&rpc?.method!=='notifications/initialized')return rpcError(400,rpc?.id,-32600,'notifications/initialized is required');
    const response=await session.transport.handleRequest(request,{parsedBody:rpc});
    if(rpc?.method==='notifications/initialized'&&response.ok)session.initialized=true;
    return response;
  }
  async closeSessions():Promise<void>{for(const s of this.sessions.values())await s.server.close();this.sessions.clear();}
  async close():Promise<void>{await this.modern.close();await this.closeSessions();}
}
