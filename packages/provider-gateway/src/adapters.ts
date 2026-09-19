import { BridgeError, newId } from '../../contracts/src/index.js';
import { textOf, validateUsage, GatewayConfigSchema, type ChatRequest, type GatewayConfig, type Outcome, type ProviderAdapter, type ProviderCapabilities, type ProviderEvent, type ToolCall } from './contracts.js';

export type FetchLike=(input:string|URL|Request,init?:RequestInit)=>Promise<Response>;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function invalid(message:string):never{throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,message);}
function capabilityBase(alias:string,kind:ProviderCapabilities['kind']):ProviderCapabilities{return {
  alias,kind,context_isolation:'per_request_full_history',context_window_tokens:null,
  text_streaming:kind==='mock'?'buffered_emulated':'native',tool_streaming:'buffered_validated',
  roles:kind==='mock'?'mock_only_no_model_priority':'native_api_roles',parameter_support:{},strict_function_calling:false,
  model_identity:kind==='mock'?'mock_not_a_model':'configured_api_model',live_model_tested:false
};}
export class MockAdapter implements ProviderAdapter{
  readonly capabilities:ProviderCapabilities;
  constructor(private readonly config:Extract<GatewayConfig,{type:'mock'}>){
    this.capabilities={...capabilityBase(config.alias,'mock'),parameter_support:{tools:'emulated',tool_choice:'emulated',parallel_tool_calls:'emulated',response_format:'emulated'}};
    if(config.scenario==='tool_roundtrip'&&!config.tool_name)throw new BridgeError('INVALID_CONFIG',400,'Mock tool_roundtrip requires an explicit synthetic tool_name');
  }
  async health(signal:AbortSignal):Promise<{ready:boolean;reason:string}>{signal.throwIfAborted();return {ready:true,reason:'Owned deterministic Mock fixture, not a model'};}
  async *invoke(request:ChatRequest,signal:AbortSignal):AsyncIterable<ProviderEvent>{
    signal.throwIfAborted();
    const last=request.messages.at(-1)!;
    if(last.role==='tool'){
      yield {type:'complete',outcome:{content:`[MOCK; no model inference] Tool result received: ${textOf(last.content)}`,finish_reason:'stop'}};return;
    }
    if(this.config.scenario==='tool_roundtrip'&&request.tool_choice!=='none'&&(request.tools?.length??0)>0){
      const name=this.config.tool_name!;
      if(typeof request.tool_choice==='object'&&request.tool_choice.function.name!==name)throw new BridgeError('UNSUPPORTED_PARAMETER',422,'Mock fixture cannot select a different configured function',{param:'tool_choice'});
      if(!request.tools?.some(tool=>tool.function.name===name))throw new BridgeError('UNSUPPORTED_PARAMETER',422,'Mock fixture function is missing from tools',{param:'tools'});
      yield {type:'complete',outcome:{content:null,tool_calls:[{id:newId('call'),type:'function',function:{name,arguments:JSON.stringify(this.config.tool_arguments??{})}}],finish_reason:'tool_calls'}};return;
    }
    if(request.tool_choice==='required'||typeof request.tool_choice==='object')throw new BridgeError('UNSUPPORTED_PARAMETER',422,'Mock echo scenario cannot satisfy a forced tool choice',{param:'tool_choice'});
    const user=request.messages.findLast(m=>m.role==='user');
    yield {type:'complete',outcome:{content:`[MOCK; no model inference] ${textOf(user?.content)}`,finish_reason:'stop'}};
  }
}
async function boundedText(response:Response,max=1048576):Promise<string>{
  if(!response.body)return '';
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
  try{for(;;){const part=await reader.read();if(part.done){text+=decoder.decode();break;}size+=part.value.length;if(size>max)invalid('Upstream response exceeds byte budget');text+=decoder.decode(part.value,{stream:true});}return text;}
  finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
async function* sseData(response:Response):AsyncIterable<string>{
  if(!response.body)invalid('Upstream returned no SSE body');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',bytes=0;
  try{
    for(;;){
      const part=await reader.read();bytes+=part.value?.length??0;
      if(bytes>2097152)invalid('Upstream SSE exceeds byte budget');
      buffer+=decoder.decode(part.value,{stream:!part.done});
      if(Buffer.byteLength(buffer)>524288)invalid('Upstream SSE frame exceeds byte budget');
      let separator:RegExpExecArray|null;
      while((separator=/\r?\n\r?\n/.exec(buffer))!==null){
        const frame=buffer.slice(0,separator.index);buffer=buffer.slice(separator.index+separator[0].length);
        const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
        if(data)yield data;
      }
      if(part.done){if(buffer.trim())invalid('Incomplete final upstream SSE frame');break;}
    }
  }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
function parsedJson(text:string):unknown{try{return JSON.parse(text);}catch{invalid('Upstream returned invalid JSON');}}
function upstreamFailure(response:Response):never{
  if(response.status===429)throw new BridgeError('RATE_LIMITED',429,'Approved inference backend rate limited the request');
  if(response.status===401||response.status===403)throw new BridgeError('UPSTREAM_UNAVAILABLE',503,'Approved inference backend rejected its credential or scope');
  throw new BridgeError('UPSTREAM_UNAVAILABLE',503,'Approved inference backend is unavailable',{upstream_status:response.status});
}
function parseSnapshot(value:unknown):Outcome{
  if(!object(value)||!Array.isArray(value.choices)||value.choices.length!==1)invalid('Expected exactly one Chat Completions choice');
  const choice=value.choices[0];if(!object(choice)||choice.index!==0||!object(choice.message)||choice.message.role!=='assistant')invalid('Invalid Chat Completions assistant choice');
  const message=choice.message;
  if(message.function_call!==undefined||message.audio!==undefined)invalid('Unsupported upstream assistant payload');
  const outcome:Outcome={content:message.content===undefined?null:message.content as string|null,finish_reason:choice.finish_reason as Outcome['finish_reason']};
  if(message.tool_calls!==undefined){if(!Array.isArray(message.tool_calls))invalid('Invalid upstream tool calls');outcome.tool_calls=message.tool_calls as ToolCall[];}
  if(message.refusal!==undefined&&message.refusal!==null){if(typeof message.refusal!=='string')invalid('Invalid refusal');outcome.refusal=message.refusal;}
  if(value.usage!==undefined&&value.usage!==null)outcome.usage=validateUsage(value.usage);
  return outcome;
}
export class ApprovedOpenAiAdapter implements ProviderAdapter{
  readonly capabilities:ProviderCapabilities;
  private readonly base:URL;
  constructor(private readonly config:Extract<GatewayConfig,{type:'approved_openai_api'}>,private readonly key:string,private readonly fetcher:FetchLike=fetch){
    if(!config.authorization_reference||!config.data_egress_approved)throw new BridgeError('AUTHORIZATION_REQUIRED',403,'Provider usage and data egress must be explicitly approved');
    const url=new URL(config.base_url);
    const loopback=url.protocol==='http:'&&url.hostname==='127.0.0.1'&&config.allow_loopback_http;
    if((url.protocol!=='https:'&&!loopback)||url.username||url.password||url.search||url.hash)throw new BridgeError('INVALID_CONFIG',400,'Inference base URL must be approved HTTPS, or explicitly approved loopback HTTP');
    if(['arena.ai','lmarena.ai'].some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))throw new BridgeError('AUTHORIZATION_REQUIRED',403,'No verified Arena production inference adapter exists; this adapter cannot target Arena');
    if(!key||key.length<8||key.length>4096||/[\r\n]/.test(key))throw new BridgeError('AUTH_REQUIRED',401,'The selected inference credential environment variable is empty or invalid');
    url.pathname=url.pathname.replace(/\/$/,'');this.base=url;
    this.capabilities={...capabilityBase(config.alias,'approved_openai_api'),parameter_support:Object.fromEntries((config.native_parameters??[]).map(name=>[name,'native']))};
  }
  private url(suffix:'models'|'chat/completions'):string{return this.base.toString().replace(/\/$/,'')+'/'+suffix;}
  private headers():Record<string,string>{return {Authorization:`Bearer ${this.key}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};}
  async health(signal:AbortSignal):Promise<{ready:boolean;reason:string}>{
    const response=await this.fetcher(this.url('models'),{method:'GET',headers:this.headers(),signal,redirect:'error'});
    if(!response.ok){await response.body?.cancel();return {ready:false,reason:`Approved backend models check returned HTTP ${response.status}`};}
    const value=parsedJson(await boundedText(response));
    const found=object(value)&&Array.isArray(value.data)&&value.data.some(model=>object(model)&&model.id===this.config.model);
    return {ready:found,reason:found?'Configured API model was present in the authenticated model list; inference quality not certified':'Configured model is not in the authenticated model list'};
  }
  async *invoke(request:ChatRequest,signal:AbortSignal):AsyncIterable<ProviderEvent>{
    signal.throwIfAborted();
    // Full message history is submitted on every call; never reuse a web conversation or hidden context.
    const body={...request,model:this.config.model};
    const response=await this.fetcher(this.url('chat/completions'),{method:'POST',headers:this.headers(),body:JSON.stringify(body),signal,redirect:'error'});
    if(!response.ok){await response.body?.cancel();upstreamFailure(response);}
    if(!request.stream){
      if(!response.headers.get('content-type')?.includes('application/json'))invalid('Expected JSON for non-streaming Chat Completions');
      yield {type:'complete',outcome:parseSnapshot(parsedJson(await boundedText(response)))};return;
    }
    if(!response.headers.get('content-type')?.includes('text/event-stream'))invalid('Backend does not provide the declared native SSE stream');
    let content='',refusal='',finish:Outcome['finish_reason']|undefined,done=false,usage:Outcome['usage'];
    const calls=new Map<number,{id:string;name:string;arguments:string}>();
    for await(const data of sseData(response)){
      signal.throwIfAborted();
      if(data==='[DONE]'){if(done)invalid('Duplicate upstream DONE');done=true;continue;}
      if(done)invalid('Upstream sent data after DONE');
      const frame=parsedJson(data);
      if(!object(frame)||frame.error!==undefined)invalid('Upstream SSE reported an error or malformed chunk');
      if(!Array.isArray(frame.choices))invalid('Upstream SSE chunk is missing choices');
      if(frame.usage!==undefined&&frame.usage!==null)usage=validateUsage(frame.usage);
      if(frame.choices.length===0){if(frame.usage===undefined||frame.usage===null)invalid('Empty choices chunk must contain usage');continue;}
      if(frame.choices.length!==1)invalid('Only one streamed choice is supported');
      const choice=frame.choices[0];if(!object(choice)||choice.index!==0||!object(choice.delta))invalid('Invalid streamed choice index or delta');
      const delta=choice.delta;
      if(finish!==undefined&&(Object.keys(delta).length>0||choice.finish_reason!==null))invalid('Unexpected delta after the terminal choice');
      if(delta.role!==undefined&&delta.role!=='assistant')invalid('Unexpected streamed role');
      if(delta.function_call!==undefined||delta.audio!==undefined)invalid('Unsupported streamed payload');
      if(delta.content!==undefined&&delta.content!==null){
        if(typeof delta.content!=='string')invalid('Text delta must be a string');content+=delta.content;
        if(Buffer.byteLength(content)>524288)invalid('Text output exceeds budget');
        if(delta.content)yield {type:'text_delta',text:delta.content};
      }
      if(delta.refusal!==undefined&&delta.refusal!==null){if(typeof delta.refusal!=='string')invalid('Invalid refusal delta');refusal+=delta.refusal;if(refusal.length>8192)invalid('Refusal exceeds budget');if(delta.refusal)yield {type:'refusal_delta',text:delta.refusal};}
      if(delta.tool_calls!==undefined){
        if(!Array.isArray(delta.tool_calls))invalid('tool_calls delta must be an array');
        for(const tool of delta.tool_calls){
          if(!object(tool)||!Number.isInteger(tool.index)||Number(tool.index)<0||Number(tool.index)>15||!object(tool.function))invalid('Invalid tool-call delta index');
          if(tool.type!==undefined&&tool.type!=='function')invalid('Unsupported tool-call type');
          const index=Number(tool.index),existing=calls.get(index)??{id:'',name:'',arguments:''};
          if(tool.id!==undefined){if(typeof tool.id!=='string'||(existing.id&&existing.id!==tool.id))invalid('Inconsistent tool-call ID');existing.id=tool.id;}
          if(tool.function.name!==undefined){if(typeof tool.function.name!=='string'||(existing.name&&existing.name!==tool.function.name))invalid('Inconsistent function name');existing.name=tool.function.name;}
          if(tool.function.arguments!==undefined){if(typeof tool.function.arguments!=='string')invalid('Function argument delta must be a string');existing.arguments+=tool.function.arguments;}
          if(existing.id.length>128||existing.name.length>64||Buffer.byteLength(existing.arguments)>65536)invalid('Tool delta exceeds budget');
          calls.set(index,existing);
          yield {type:'tool_delta',index,...(tool.id===undefined?{}:{id:tool.id as string}),...(tool.function.name===undefined?{}:{name:tool.function.name as string}),...(tool.function.arguments===undefined?{}:{arguments:tool.function.arguments as string})};
        }
      }
      if(choice.finish_reason!==null&&choice.finish_reason!==undefined){if(finish!==undefined)invalid('Multiple terminal choices');finish=choice.finish_reason as Outcome['finish_reason'];}
    }
    if(!done||finish===undefined)invalid('Upstream stream ended without terminal choice and DONE');
    const sorted=[...calls.entries()].sort(([a],[b])=>a-b);
    if(sorted.some(([index],position)=>index!==position))invalid('Non-contiguous tool-call indexes');
    const outcome:Outcome={content:content||null,finish_reason:finish,...(refusal?{refusal}:{}),...(usage?{usage}:{})};
    if(sorted.length)outcome.tool_calls=sorted.map(([,call])=>({id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}));
    yield {type:'complete',outcome};
  }
}
export function buildAdapter(config:GatewayConfig,environment:Record<string,string|undefined>,fetcher:FetchLike=fetch):ProviderAdapter|undefined{
  if(config.type==='disabled')return undefined;
  if(config.type==='mock')return new MockAdapter(config);
  // Validate through the schema so defaults (native_parameters, allow_loopback_http)
  // are applied even when the caller constructed the object by hand.
  const parsed=GatewayConfigSchema.safeParse(config);
  if(!parsed.success||parsed.data.type!=='approved_openai_api')throw new BridgeError('INVALID_CONFIG',400,'Invalid approved_openai_api configuration');
  return new ApprovedOpenAiAdapter(parsed.data,environment[parsed.data.api_key_env]??'',fetcher);
}
