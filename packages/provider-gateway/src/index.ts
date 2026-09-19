import { BridgeError, POLICY_VERSION, digest, newId, publicError, type Principal, type Run } from '../../contracts/src/index.js';
import { Store } from '../../storage/src/index.js';
import { parseChatRequest, validateOutcome, validateParameters, type ChatRequest, type Outcome, type ProviderAdapter, type ProviderEvent, type ToolCall, type Usage } from './contracts.js';
export { GatewayConfigSchema, ChatRequestSchema } from './contracts.js';
export { buildAdapter } from './adapters.js';

export interface GatewayLimits {max_inflight:number;max_queued:number;queue_wait_ms:number;first_response_ms:number;idle_ms:number;total_ms:number;health_ms:number;health_ttl_ms:number;}
const DEFAULT_LIMITS:GatewayLimits={max_inflight:2,max_queued:8,queue_wait_ms:5000,first_response_ms:15000,idle_ms:15000,total_ms:60000,health_ms:5000,health_ttl_ms:30000};
interface Completion {id:string;object:'chat.completion';created:number;model:string;choices:[{index:0;message:{role:'assistant';content:string|null;tool_calls?:ToolCall[];refusal?:string};finish_reason:Outcome['finish_reason']}];usage?:Usage;}
interface SavedSuccess {kind:'completion';completion:Completion;run_id:string;}
interface SavedError {kind:'error';status:number;code:string;message:string;}
interface Prepared {request:ChatRequest;principal:Principal;key:string|undefined;scope:string;run:Run;request_id:string;id:string;created:number;admission_deadline:number;}
interface QueueItem {resolve:(release:()=>void)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;signal:AbortSignal;onAbort:()=>void;}
class Admission {
  private active=0;private readonly waiting:QueueItem[]=[];
  constructor(private readonly limits:GatewayLimits){}
  snapshot(){return {active:this.active,queued:this.waiting.length,max_inflight:this.limits.max_inflight,max_queued:this.limits.max_queued};}
  async acquire(signal:AbortSignal):Promise<()=>void>{
    if(signal.aborted)throw signal.reason instanceof BridgeError?signal.reason:new BridgeError('CLIENT_DISCONNECTED',499,'Client disconnected before admission');
    if(this.active<this.limits.max_inflight){this.active++;return this.release();}
    if(this.waiting.length>=this.limits.max_queued)throw new BridgeError('QUEUE_FULL',429,'Inference queue is full');
    return new Promise((resolve,reject)=>{
      const remove=()=>{const index=this.waiting.indexOf(item);if(index>=0)this.waiting.splice(index,1);clearTimeout(item.timer);signal.removeEventListener('abort',item.onAbort);};
      const item:QueueItem={resolve,reject,signal,onAbort:()=>{remove();reject(signal.reason instanceof BridgeError?signal.reason:new BridgeError('CLIENT_DISCONNECTED',499,'Client disconnected while queued'));},timer:setTimeout(()=>{remove();reject(new BridgeError('DEADLINE_EXCEEDED',504,'Queue wait deadline exceeded',{phase:'queue_wait'}));},this.limits.queue_wait_ms)};
      this.waiting.push(item);signal.addEventListener('abort',item.onAbort,{once:true});
    });
  }
  private release():()=>void{let used=false;return ()=>{if(used)return;used=true;const next=this.waiting.shift();if(next){clearTimeout(next.timer);next.signal.removeEventListener('abort',next.onAbort);next.resolve(this.release());}else this.active--;};}
}
function responseError(error:unknown):Response{
  const e=publicError(error);return Response.json({error:{message:e.message,type:'arena_bridge_error',code:e.code,param:e.details?.param??null,...(e.details?{details:e.details}:{})}},{status:e.status,headers:{'Cache-Control':'no-store','X-ArenaBridge-Execution-Owner':'client'}});
}
function failure(error:unknown):BridgeError{
  if(error instanceof BridgeError)return error;
  return new BridgeError('UPSTREAM_UNAVAILABLE',503,'Inference failed or the connection was lost; no tool was executed by the gateway');
}
function withDeadline<T>(promise:Promise<T>,controller:AbortController,ms:number,phase:string):Promise<T>{
  return new Promise((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',aborted);};
    const aborted=()=>{stop();reject(controller.signal.reason instanceof BridgeError?controller.signal.reason:new BridgeError('CLIENT_DISCONNECTED',499,'Inference cancelled'));};
    const timer=setTimeout(()=>controller.abort(new BridgeError('DEADLINE_EXCEEDED',504,`${phase} deadline exceeded`,{phase})),Math.max(1,ms));
    controller.signal.addEventListener('abort',aborted,{once:true});
    if(controller.signal.aborted){aborted();return;}
    promise.then(value=>{stop();resolve(value);},error=>{stop();reject(error);});
  });
}
function chunks(text:string,size=64):string[]{
  const points=Array.from(text),result:string[]=[];for(let i=0;i<points.length;i+=size)result.push(points.slice(i,i+size).join(''));return result;
}
function chunk(completion:Pick<Completion,'id'|'created'|'model'>,delta:unknown,finish_reason:string|null=null):Record<string,unknown>{
  return {...completion,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]};
}
function* buffered(completion:Completion,includeUsage:boolean):Generator<string>{
  const info={id:completion.id,created:completion.created,model:completion.model},message=completion.choices[0].message;
  yield `data: ${JSON.stringify(chunk(info,{role:'assistant',content:''}))}\n\n`;
  for(const text of chunks(message.content??''))yield `data: ${JSON.stringify(chunk(info,{content:text}))}\n\n`;
  for(const text of chunks(message.refusal??''))yield `data: ${JSON.stringify(chunk(info,{refusal:text}))}\n\n`;
  for(const [index,call] of (message.tool_calls??[]).entries()){
    yield `data: ${JSON.stringify(chunk(info,{tool_calls:[{index,id:call.id,type:'function',function:{name:call.function.name,arguments:''}}]}))}\n\n`;
    for(const part of chunks(call.function.arguments))yield `data: ${JSON.stringify(chunk(info,{tool_calls:[{index,function:{arguments:part}}]}))}\n\n`;
  }
  yield `data: ${JSON.stringify(chunk(info,{},completion.choices[0].finish_reason))}\n\n`;
  if(includeUsage&&completion.usage)yield `data: ${JSON.stringify({...info,object:'chat.completion.chunk',choices:[],usage:completion.usage})}\n\n`;
  yield 'data: [DONE]\n\n';
}
function streamResponse(iterator:AsyncGenerator<string,unknown>,headers:HeadersInit,onCancel:()=>void,signal?:AbortSignal):Response{
  const encoder=new TextEncoder();let ended=false,streamController:ReadableStreamDefaultController<Uint8Array>|undefined;
  const detach=()=>signal?.removeEventListener('abort',aborted);
  const endError=(error:unknown)=>{
    if(ended)return;ended=true;detach();const e=failure(error);
    streamController?.enqueue(encoder.encode(`data: ${JSON.stringify({error:{code:e.code,message:e.message,type:'arena_bridge_error'}})}\n\n`));streamController?.close();
  };
  const aborted=()=>{
    endError(signal?.reason);
    // Return resumes a generator suspended by downstream backpressure, so its finally releases admission.
    void iterator.return(undefined).catch(()=>undefined);
  };
  const stream=new ReadableStream<Uint8Array>({
    start(controller){streamController=controller;signal?.addEventListener('abort',aborted,{once:true});},
    async pull(controller){
      if(ended)return;
      try{const next=await iterator.next();if(ended)return;if(next.done){ended=true;detach();controller.close();return;}controller.enqueue(encoder.encode(next.value));}
      catch(error){endError(error);}
    },
    async cancel(){ended=true;detach();onCancel();await iterator.return(undefined).catch(()=>undefined);}
  },{highWaterMark:1});
  return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no',...Object.fromEntries(new Headers(headers))}});
}
export class ProviderGateway {
  readonly limits:GatewayLimits;
  private readonly admission:Admission;
  private healthState={ready:false,reason:'Not checked',checked_at:0};
  private checking:Promise<void>|undefined;
  private readonly controllers=new Map<string,AbortController>();
  constructor(private readonly store:Store,private readonly adapter:ProviderAdapter|undefined,limits:Partial<GatewayLimits>={}){
    this.limits={...DEFAULT_LIMITS,...limits};
    for(const [key,value] of Object.entries(this.limits))if(!Number.isSafeInteger(value)||value<0||(key!=='max_queued'&&value===0))throw new BridgeError('INVALID_CONFIG',400,'Invalid inference budget');
    this.admission=new Admission(this.limits);
  }
  capabilities(){return {
    enabled:!!this.adapter,execution_owner:'client',tools_executed_by_gateway:false,
    provider:this.adapter?.capabilities??null,health:{...this.healthState},budgets:{...this.limits},queue:this.admission.snapshot(),
    idempotency:'Stable client Idempotency-Key only; local response replay, not exactly-once client tool execution',
    replay_streaming:'buffered_emulated',unknown_usage:'omitted, never zero-filled',arena_enabled:false,
    validation_scope:'bounded function JSON Schema subset; strict generation unsupported',
    certification:'Mock/adapter conformance is not live model or WorkBuddy/TRAE host certification'
  };}
  private async refresh():Promise<void>{
    if(!this.adapter){this.healthState={ready:false,reason:'No provider is configured',checked_at:Date.now()};return;}
    if(Date.now()-this.healthState.checked_at<this.limits.health_ttl_ms)return;
    if(this.checking)return this.checking;
    this.checking=(async()=>{
      const controller=new AbortController();
      try{const health=await withDeadline(this.adapter!.health(controller.signal),controller,this.limits.health_ms,'health');this.healthState={...health,checked_at:Date.now()};}
      catch{this.healthState={ready:false,reason:'Provider health check failed; details redacted',checked_at:Date.now()};}
    })();
    try{await this.checking;}finally{this.checking=undefined;}
  }
  cancelRun(runId:string):void{this.controllers.get(runId)?.abort(new BridgeError('CLIENT_DISCONNECTED',499,'Local operator cancelled the inference run'));}
  async close():Promise<void>{for(const controller of this.controllers.values())controller.abort(new BridgeError('CLIENT_DISCONNECTED',499,'Daemon is stopping'));for(let turn=0;turn<8&&this.controllers.size;turn++)await new Promise<void>(resolve=>setImmediate(resolve));}
  async models():Promise<unknown>{await this.refresh();return {object:'list',data:this.adapter&&this.healthState.ready?[{id:this.adapter.capabilities.alias,object:'model',created:Math.floor(this.healthState.checked_at/1000),owned_by:this.adapter.capabilities.kind==='mock'?'arenabridge-mock':'approved-api-provider'}]:[]};}
  async ready():Promise<boolean>{await this.refresh();return this.healthState.ready;}
  async handle(request:Request,principal:Principal):Promise<Response>{
    try{
      if(principal.kind!=='api_client')throw new BridgeError('POLICY_DENIED',403,'This identity is not an authenticated model API client');
      const route=new URL(request.url).pathname;
      if(request.method==='GET'&&route==='/v1/models')return Response.json(await this.models(),{headers:{'Cache-Control':'no-store','X-ArenaBridge-Execution-Owner':'client'}});
      if(request.method==='GET'&&route==='/readyz'){const ready=await this.ready();return Response.json({ready,production_ready:false,reason:this.healthState.reason},{status:ready?200:503,headers:{'Cache-Control':'no-store'}});}
      if(route==='/v1/responses'||route==='/v1/messages') throw new BridgeError('UNSUPPORTED_PROTOCOL',422,'unsupported_protocol: only Chat Completions is implemented');
      if(request.method!=='POST'||route!=='/v1/chat/completions')throw new BridgeError('NOT_FOUND',404,'No model gateway route');
      if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new BridgeError('INVALID_ARGUMENT',415,'Content-Type must be application/json');
      const raw=await request.text();if(Buffer.byteLength(raw)>1048576)throw new BridgeError('RESOURCE_LIMIT',413,'Request exceeds byte budget');
      // 后端缺席时必须先答 503：否则无网关时会把「没有可用推理后端」误报成请求体非法，
      // 调用方会去修 payload 而不是修配置。适配器存在后才做契约校验。
      if(!this.adapter)throw new BridgeError('UPSTREAM_UNAVAILABLE',503,'No approved inference backend is configured');
      let value:unknown;try{value=JSON.parse(raw);}catch{throw new BridgeError('INVALID_JSON',400,'Invalid JSON request');}
      const input=parseChatRequest(value);
      if(input.model!==this.adapter.capabilities.alias)throw new BridgeError('UNSUPPORTED_PARAMETER',400,'Requested model alias is not configured',{param:'model'});
      validateParameters(input,this.adapter.capabilities);await this.refresh();
      if(!this.healthState.ready)throw new BridgeError('UPSTREAM_UNAVAILABLE',503,'Configured inference backend failed its health check');
      const scope=`model:${principal.id}:client:/v1/chat/completions`,key=request.headers.get('idempotency-key')??undefined;
      const record=this.store.beginIdempotency(scope,key,digest(input));
      const headers={'X-ArenaBridge-Execution-Owner':'client','X-ArenaBridge-Backend':this.adapter.capabilities.kind,'X-ArenaBridge-Streaming':input.response_format?.type==='json_object'?'buffered_emulated':this.adapter.capabilities.text_streaming,'X-ArenaBridge-Tool-Streaming':'buffered_validated','Cache-Control':'no-store'};
      if(record.cached!==undefined){
        const cached=record.cached as SavedSuccess|SavedError;
        if(cached.kind==='error')return responseError(new BridgeError(cached.code,cached.status,cached.message));
        const replayHeaders={...headers,'X-ArenaBridge-Streaming':'buffered_emulated','X-ArenaBridge-Idempotency-Replay':'true','X-ArenaBridge-Run-Id':cached.run_id};
        if(!input.stream)return Response.json(cached.completion,{headers:replayHeaders});
        return streamResponse((async function*(){yield* buffered(cached.completion,input.stream_options?.include_usage??false);})(),replayHeaders,()=>undefined);
      }
      const run:Run={id:newId('run'),workspace_id:'model_api_no_workspace',principal_id:principal.id,mode:'provider_gateway_client_tools',execution_owner:'client',state:'queued',reason:null,policy_version:POLICY_VERSION,created_at:Date.now(),updated_at:Date.now()};
      this.store.put('runs',run);const requestId=newId('req');this.store.event('model.queued',{execution_owner:'client',body_hash:digest(input)},{run_id:run.id,request_id:requestId});
      const prepared:Prepared={request:input,principal,key,scope,run,request_id:requestId,id:newId('chatcmpl'),created:Math.floor(Date.now()/1000),admission_deadline:Date.now()+this.limits.total_ms};
      const controller=new AbortController();const disconnect=()=>controller.abort(new BridgeError('CLIENT_DISCONNECTED',499,'Client disconnected; gateway executed no tools'));
      request.signal.addEventListener('abort',disconnect,{once:true});if(request.signal.aborted)disconnect();
      this.controllers.set(run.id,controller);
      const iterator=this.execute(prepared,controller,()=>{request.signal.removeEventListener('abort',disconnect);this.controllers.delete(run.id);});
      if(input.stream)return streamResponse(iterator,{...headers,'X-ArenaBridge-Run-Id':run.id},disconnect,controller.signal);
      let result:IteratorResult<string,Completion>;do{result=await iterator.next();}while(!result.done);
      return Response.json(result.value,{headers:{...headers,'X-ArenaBridge-Run-Id':run.id}});
    }catch(error){return responseError(error instanceof BridgeError?error:failure(error));}
  }
  private async *execute(p:Prepared,controller:AbortController,dispose:()=>void):AsyncGenerator<string,Completion>{
    let release:(()=>void)|undefined,upstream:AsyncIterator<ProviderEvent>|undefined,total:ReturnType<typeof setTimeout>|undefined;
    let streamedText='',streamedRefusal='',roleSent=false,sourceEvents=0,completed:Outcome|undefined;
    const streaming=p.request.stream??false,bufferText=this.adapter!.capabilities.text_streaming==='buffered_emulated'||p.request.response_format?.type==='json_object';
    const info={id:p.id,created:p.created,model:p.request.model};
    try{
      total=setTimeout(()=>controller.abort(new BridgeError('DEADLINE_EXCEEDED',504,'Total execution deadline exceeded',{phase:'total'})),Math.max(1,p.admission_deadline-Date.now()));
      release=await this.admission.acquire(controller.signal);
      this.store.transition(p.run.id,'assigned','inference_budget_admitted');this.store.transition(p.run.id,'running','provider_inference_no_local_tools');
      upstream=this.adapter!.invoke(p.request,controller.signal)[Symbol.asyncIterator]();
      while(true){
        const item=await withDeadline(Promise.resolve(upstream.next()),controller,sourceEvents?this.limits.idle_ms:this.limits.first_response_ms,sourceEvents?'idle':'first_response');
        if(item.done)break;
        if(completed)throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Backend emitted events after completion');
        sourceEvents++;
        const event=item.value;
        if(event.type==='complete'){completed=event.outcome;continue;}
        if(event.type==='tool_delta')continue; // No unvalidated tool proposal ever reaches the client.
        if(event.type==='text_delta'&&event.text||event.type==='refusal_delta'&&event.text){
          if(!streamedText&&!streamedRefusal)this.store.event('model.first_visible_output',{duration_ms:Date.now()-p.run.created_at,execution_owner:'client'},{run_id:p.run.id,request_id:p.request_id});
        }
        if(event.type==='text_delta')streamedText+=event.text;
        if(event.type==='refusal_delta')streamedRefusal+=event.text;
        if(Buffer.byteLength(streamedText)+Buffer.byteLength(streamedRefusal)>524288)throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Stream exceeds output budget');
        if(streaming&&!bufferText){
          if(!roleSent){yield `data: ${JSON.stringify(chunk(info,{role:'assistant',content:''}))}\n\n`;roleSent=true;}
          if(event.text)yield `data: ${JSON.stringify(chunk(info,event.type==='text_delta'?{content:event.text}:{refusal:event.text}))}\n\n`;
        }
      }
      if(controller.signal.aborted)throw controller.signal.reason;
      if(!completed)throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Backend returned no terminal completion');
      if(streamedText&&streamedText!==(completed.content??''))throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Backend final text does not match observed deltas');
      if(streamedRefusal&&streamedRefusal!==(completed.refusal??''))throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Backend final refusal does not match observed deltas');
      const outcome=validateOutcome(p.request,completed);
      const result:Completion={...info,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:outcome.content,...(outcome.tool_calls?.length?{tool_calls:outcome.tool_calls}:{}),...(outcome.refusal?{refusal:outcome.refusal}:{})},finish_reason:outcome.finish_reason}],...(outcome.usage?{usage:outcome.usage}:{})};
      this.store.finishIdempotency(p.scope,p.key,{kind:'completion',completion:result,run_id:p.run.id} satisfies SavedSuccess);
      this.store.transition(p.run.id,'completed',outcome.tool_calls?.length?'tool_proposals_returned_client_executes':'inference_result_returned');
      this.store.event('model.completed',{execution_owner:'client',count:outcome.tool_calls?.length??0,state:'proposals_not_executed'},{run_id:p.run.id,request_id:p.request_id});
      if(total){clearTimeout(total);total=undefined;}
      release?.();release=undefined;dispose();
      if(streaming){
        if(bufferText||!roleSent){yield* buffered(result,p.request.stream_options?.include_usage??false);}
        else{
          const remaining:Completion={...result,choices:[{...result.choices[0],message:{...result.choices[0].message,content:null,refusal:undefined}}]};
          let first=true;for(const piece of buffered(remaining,p.request.stream_options?.include_usage??false)){if(first){first=false;continue;}yield piece;}
        }
      }
      return result;
    }catch(error){
      const e=controller.signal.aborted&&controller.signal.reason instanceof BridgeError?controller.signal.reason:failure(error);
      const state=e.code==='CLIENT_DISCONNECTED'?'cancelled':e.code==='DEADLINE_EXCEEDED'?'expired':'failed';
      const current=this.store.get<Run>('runs',p.run.id);
      if(current&&!['completed','failed','cancelled','expired','unknown'].includes(current.state))this.store.transition(p.run.id,state,e.code);
      this.store.finishIdempotency(p.scope,p.key,{kind:'error',status:e.status,code:e.code,message:e.message} satisfies SavedError);
      this.store.event('model.failed',{execution_owner:'client',code:e.code},{run_id:p.run.id,request_id:p.request_id});
      // Preserve the actual protocol/validation failure before closing the transport.
      if(!controller.signal.aborted)controller.abort(e);
      throw e;
    }finally{
      if(total)clearTimeout(total);
      const current=this.store.get<Run>('runs',p.run.id);
      if(current&&!['completed','failed','cancelled','expired','unknown'].includes(current.state)){
        this.store.transition(p.run.id,'cancelled','CLIENT_DISCONNECTED');
        this.store.finishIdempotency(p.scope,p.key,{kind:'error',status:499,code:'CLIENT_DISCONNECTED',message:'Response consumer cancelled; gateway executed no tools'} satisfies SavedError);
      }
      if(this.store.get<Run>('runs',p.run.id)?.state!=='completed')controller.abort(new BridgeError('CLIENT_DISCONNECTED',499,'Inference exchange closed'));
      if(upstream?.return)void Promise.resolve(upstream.return()).catch(()=>undefined);
      release?.();dispose();
    }
  }
}
