import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Store } from '../packages/storage/src/index.js';
import { ProviderGateway } from '../packages/provider-gateway/src/index.js';
import { MockAdapter, ApprovedOpenAiAdapter, type FetchLike } from '../packages/provider-gateway/src/adapters.js';
import { GatewayConfigSchema, parseChatRequest, type ChatRequest, type Outcome, type ProviderAdapter, type ProviderCapabilities, type ProviderEvent } from '../packages/provider-gateway/src/contracts.js';
import { BridgeError, type Principal, type Run } from '../packages/contracts/src/index.js';

// All state is SQLite :memory:, network responses are owned fixtures. No files are deleted.
const principal:Principal={id:'test-api-one',kind:'api_client',label:'Synthetic model client'};
const second:Principal={id:'test-api-two',kind:'api_client',label:'Second synthetic client'};
const tool={type:'function',function:{name:'read_synthetic',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}};
const basic={model:'mock-test',messages:[{role:'user',content:'Hello 中文'}]};
const limits={first_response_ms:1000,idle_ms:1000,total_ms:5000,health_ms:1000};
function setup(t:TestContext,adapter:ProviderAdapter|undefined=new MockAdapter({type:'mock',acknowledge_mock:true,alias:'mock-test',scenario:'echo'}),extra={}){
  const store=new Store(':memory:');t.after(()=>store.close());const gateway=new ProviderGateway(store,adapter,{...limits,...extra});
  const call=(body:unknown,headers:Record<string,string>={},who=principal,signal?:AbortSignal)=>gateway.handle(new Request('http://127.0.0.1/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal}),who);
  return {store,gateway,call};
}
async function json(response:Response):Promise<any>{return response.json();}
function frames(text:string):any[]{return text.split(/\r?\n\r?\n/).map(frame=>frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(value=>value&&value!=='[DONE]').map(value=>JSON.parse(value));}
function snapshot(content:string|null,tool_calls?:unknown[],usage?:unknown):Response{return Response.json({id:'upstream-id',object:'chat.completion',created:1,model:'real-model',choices:[{index:0,message:{role:'assistant',content,...(tool_calls?{tool_calls}:{})},finish_reason:tool_calls?'tool_calls':'stop'}],...(usage?{usage}:{})});}
function sse(chunks:unknown[],done=true,split=false):Response{
  const text=chunks.map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+(done?'data: [DONE]\n\n':'');const encoded=new TextEncoder().encode(text);
  return new Response(new ReadableStream({start(controller){if(split){for(let i=0;i<encoded.length;i+=3)controller.enqueue(encoded.slice(i,i+3));}else controller.enqueue(encoded);controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
}
const packet=(delta:unknown,finish_reason:unknown=null)=>({id:'upstream',object:'chat.completion.chunk',created:1,model:'real-model',choices:[{index:0,delta,finish_reason}]});
function apiAdapter(responder:(body:ChatRequest)=>Response|Promise<Response>,options:{parameters?:string[];health?:boolean;capture?:(request:ChatRequest,init?:RequestInit)=>void}={}):ApprovedOpenAiAdapter{
  const config=GatewayConfigSchema.parse({type:'approved_openai_api',alias:'api-test',model:'real-model',base_url:'https://approved-fixture.invalid/v1',api_key_env:'TEST_PROVIDER_KEY',authorization_reference:'owned-mock-fixture-not-real-approval',data_egress_approved:true,native_parameters:options.parameters??['tools','tool_choice','parallel_tool_calls','temperature','top_p','max_tokens','max_completion_tokens','stop','response_format','response_format.json_object']});
  assert.equal(config.type,'approved_openai_api');
  const fetcher:FetchLike=async(input,init)=>{
    if(String(input).endsWith('/models'))return Response.json({data:options.health===false?[]:[{id:'real-model'}]});
    const body=JSON.parse(String(init?.body));options.capture?.(body,init);return responder(body);
  };
  return new ApprovedOpenAiAdapter(config as Extract<typeof config,{type:'approved_openai_api'}>,'owned-fixture-api-key',fetcher);
}

test('G01 disabled provider lists no model; Mock is explicit and reports honest metadata',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const disabled=new ProviderGateway(store,undefined);
  assert.deepEqual(await disabled.models(),{object:'list',data:[]});assert.equal(await disabled.ready(),false);
  const f=setup(t);const models=await f.gateway.models() as any;assert.equal(models.data[0].id,'mock-test');assert.equal(models.data[0].owned_by,'arenabridge-mock');
  const response=await f.call(basic);assert.equal(response.status,200);assert.equal(response.headers.get('x-arenabridge-execution-owner'),'client');assert.equal(response.headers.get('x-arenabridge-streaming'),'buffered_emulated');
  const data=await json(response);assert.equal(data.object,'chat.completion');assert.equal(data.choices[0].finish_reason,'stop');assert.match(data.choices[0].message.content,/MOCK/);assert.equal(data.usage,undefined);assert.ok(Math.abs(data.created-Math.floor(Date.now()/1000))<5);
  assert.equal(f.store.all<Run>('runs')[0]!.execution_owner,'client');assert.equal(f.gateway.capabilities().tools_executed_by_gateway,false);
});

test('G02 client-tools true multi-round: gateway proposes, test host executes once, role=tool returns',async t=>{
  const adapter=new MockAdapter({type:'mock',acknowledge_mock:true,alias:'mock-test',scenario:'tool_roundtrip',tool_name:'read_synthetic',tool_arguments:{path:'合成.txt'}});
  const f=setup(t,adapter);let hostExecutions=0;
  const first=await json(await f.call({...basic,tools:[tool],tool_choice:'required',parallel_tool_calls:false}));const call=first.choices[0].message.tool_calls[0];
  assert.equal(call.function.name,'read_synthetic');assert.deepEqual(JSON.parse(call.function.arguments),{path:'合成.txt'});assert.equal(first.choices[0].finish_reason,'tool_calls');assert.equal(hostExecutions,0);
  const execute=(args:any)=>{hostExecutions++;return JSON.stringify({path:args.path,text:'owned in-memory file content'});};
  const result=execute(JSON.parse(call.function.arguments));
  const next=await json(await f.call({...basic,messages:[...basic.messages,first.choices[0].message,{role:'tool',tool_call_id:call.id,content:result}],tools:[tool],tool_choice:'auto'}));
  assert.match(next.choices[0].message.content,/Tool result received/);assert.equal(next.choices[0].finish_reason,'stop');assert.equal(hostExecutions,1);
  assert.equal(f.store.events(0,200).filter(e=>e.type==='tool.completed').length,0);
});

test('G03 Mock SSE is buffered/emulated with correct Unicode, DONE and no invented usage',async t=>{
  const f=setup(t);const response=await f.call({...basic,stream:true,stream_options:{include_usage:true}});const text=await response.text(),chunks=frames(text);
  assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');assert.equal(chunks[0].choices[0].delta.role,'assistant');
  const answer=chunks.map(c=>c.choices[0]?.delta.content??'').join('');assert.match(answer,/Hello 中文/);assert.equal(answer.includes('\uFFFD'),false);
  assert.ok(text.endsWith('data: [DONE]\n\n'));assert.equal(chunks.at(-1).choices[0].finish_reason,'stop');assert.equal(chunks.some(c=>c.usage),false);
});

test('G04 Model body cannot change owner; unsupported parameters are explicit errors',async t=>{
  const f=setup(t);
  for(const [name,value] of Object.entries({execution_owner:'bridge',n:2,seed:1,logprobs:true,attachments:[],response_format:{type:'json_schema',json_schema:{}},temperature:0.3,top_p:0.8,max_tokens:10,stop:'END'})){
    const response=await f.call({...basic,[name]:value});assert.equal(response.status,422,name);assert.equal((await json(response)).error.code,'UNSUPPORTED_PARAMETER',name);
  }
  assert.equal((await f.call({...basic,tools:[{...tool,function:{...tool.function,strict:true}}]})).status,422);
  assert.equal((await f.call({...basic,tools:[{...tool,function:{...tool.function,parameters:{$ref:'#/unsafe'}}}]})).status,422);
  assert.equal((await f.call({...basic,stream_options:{include_usage:true}})).status,422);
  assert.equal((await f.call({...basic,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.invalid'}}]}]})).status,422);
});

test('G05 message role/tool_call_id consistency rejects orphan, missing, replay and malformed tool results',async t=>{
  const f=setup(t),call={id:'call_x',type:'function',function:{name:'read_synthetic',arguments:'{}'}};
  const invalid=[
    [{role:'tool',tool_call_id:'unknown',content:'x'}],
    [{role:'assistant',tool_calls:[call]}],
    [{role:'assistant',tool_calls:[call]},{role:'user',content:'skip execution'}],
    [{role:'assistant',tool_calls:[call]},{role:'tool',tool_call_id:'wrong',content:'x'}],
    [{role:'assistant',tool_calls:[call,call]},{role:'tool',tool_call_id:'call_x',content:'x'}],
    [{role:'assistant',tool_calls:[{...call,function:{...call.function,arguments:'{unfinished'}}]},{role:'tool',tool_call_id:'call_x',content:'x'}]
  ];
  for(const messages of invalid)assert.equal((await f.call({...basic,messages})).status,422);
  const accepted=parseChatRequest({...basic,messages:[{role:'system',content:'system'},{role:'developer',content:'developer'},{role:'user',content:[{type:'text',text:'user'}]}]});assert.deepEqual(accepted.messages.map(m=>m.role),['system','developer','user']);
});

test('G06 approved API adapter forwards all authorized fields and full history; no hidden shared context',async t=>{
  const captured:ChatRequest[]=[];
  const adapter=apiAdapter(body=>snapshot(body.messages.map(m=>m.role+':'+('content'in m?JSON.stringify(m.content):'')).join('|')), {capture(body,init){captured.push(body);assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer owned-fixture-api-key');}});
  const f=setup(t,adapter);
  const first={model:'api-test',messages:[{role:'system',content:'SYSTEM'},{role:'developer',content:'DEVELOPER'},{role:'user',content:'secret-first'}],temperature:0.2,top_p:0.9,max_completion_tokens:100,stop:['END'],n:1,tools:[tool],tool_choice:'none',parallel_tool_calls:false,response_format:{type:'text'}};
  assert.equal((await f.call(first)).status,200);
  const secondResult=await json(await f.call({model:'api-test',messages:[{role:'user',content:'independent-second'}]}));
  assert.deepEqual(captured[0]!.messages,first.messages);assert.equal(captured[0]!.model,'real-model');assert.equal(captured[0]!.max_completion_tokens,100);assert.deepEqual(captured[0]!.stop,['END']);
  assert.equal(captured[1]!.messages.length,1);assert.equal(secondResult.choices[0].message.content.includes('secret-first'),false);
});

test('G07 native upstream SSE handles byte-split UTF-8, usage-only empty choices and correct final DONE',async t=>{
  const adapter=apiAdapter(()=>sse([packet({role:'assistant',content:''}),packet({content:'你'}),packet({content:'好𠮷'}),packet({},'stop'),{choices:[],usage:{prompt_tokens:8,completion_tokens:2,total_tokens:10}}],true,true));
  const f=setup(t,adapter),response=await f.call({model:'api-test',messages:basic.messages,stream:true,stream_options:{include_usage:true}}),text=await response.text(),data=frames(text);
  assert.equal(response.headers.get('x-arenabridge-streaming'),'native');assert.equal(data.map(c=>c.choices[0]?.delta.content??'').join(''),'你好𠮷');assert.ok(text.endsWith('data: [DONE]\n\n'));
  assert.deepEqual(data.at(-1).choices,[]);assert.deepEqual(data.at(-1).usage,{prompt_tokens:8,completion_tokens:2,total_tokens:10});
});

test('G08 upstream interleaved tool indexes aggregate complete validated JSON; client receives start IDs then argument deltas',async t=>{
  const other={type:'function',function:{name:'count_synthetic',parameters:{type:'object',properties:{n:{type:'integer'}},required:['n'],additionalProperties:false}}};
  const adapter=apiAdapter(()=>sse([
    packet({role:'assistant',tool_calls:[{index:1,id:'call_b',type:'function',function:{name:'count_synthetic',arguments:'{"n":'}},{index:0,id:'call_a',type:'function',function:{name:'read_synthetic',arguments:'{"path":"'}}]}),
    packet({tool_calls:[{index:0,function:{arguments:'中文.txt"}'}},{index:1,function:{arguments:'3}'}}]}),packet({},'tool_calls')
  ],true,true));
  const f=setup(t,adapter),response=await f.call({model:'api-test',messages:basic.messages,tools:[tool,other],parallel_tool_calls:true,stream:true});
  const result=frames(await response.text()),calls=new Map<number,any>();
  for(const frame of result)for(const delta of frame.choices[0]?.delta.tool_calls??[]){const state=calls.get(delta.index)??{arguments:''};if(delta.id)state.id=delta.id;if(delta.function.name)state.name=delta.function.name;state.arguments+=delta.function.arguments??'';calls.set(delta.index,state);}
  assert.deepEqual(calls.get(0),{arguments:'{"path":"中文.txt"}',id:'call_a',name:'read_synthetic'});assert.deepEqual(calls.get(1),{arguments:'{"n":3}',id:'call_b',name:'count_synthetic'});assert.equal(result.at(-1).choices[0].finish_reason,'tool_calls');
  assert.equal(f.store.events(0,100).some(e=>e.type==='tool.completed'),false);
});

test('G09 incomplete, unknown or schema-invalid tool proposals never reach client as tool_calls',async t=>{
  for(const argumentsText of ['{unfinished','{"path":3}','{"path":"ok","extra":true}']){
    const adapter=apiAdapter(()=>sse([packet({tool_calls:[{index:0,id:'call_a',type:'function',function:{name:'read_synthetic',arguments:argumentsText}}]}),packet({},'tool_calls')]));
    const f=setup(t,adapter),response=await f.call({model:'api-test',messages:basic.messages,tools:[tool],stream:true});
    const text=await response.text(),data=frames(text);assert.ok(data.some(frame=>frame.error));assert.equal(data.some(frame=>frame.choices?.[0]?.delta.tool_calls),false);assert.equal(text.includes('[DONE]'),false);
  }
  const f=setup(t,apiAdapter(()=>snapshot(null,[{id:'call_x',type:'function',function:{name:'missing_tool',arguments:'{}'}}])));
  assert.equal((await f.call({model:'api-test',messages:basic.messages,tools:[tool]})).status,502);
});

test('G10 upstream truncation/error after visible text closes with an error, never fake success or DONE',async t=>{
  const f=setup(t,apiAdapter(()=>sse([packet({content:'partial'})],false)));
  const response=await f.call({model:'api-test',messages:basic.messages,stream:true});const text=await response.text(),data=frames(text);
  assert.equal(response.status,200);assert.ok(data.some(frame=>frame.error));assert.equal(text.includes('[DONE]'),false);assert.equal(data.some(frame=>frame.choices?.[0]?.finish_reason==='stop'),false);
  assert.equal(f.store.all<Run>('runs')[0]!.state,'failed');
});

test('G11 tool_choice none/required/specific/parallel violations reject rather than silently drop constraints',async t=>{
  const outcome=[{id:'call_a',type:'function',function:{name:'read_synthetic',arguments:'{"path":"ok"}'}}];
  const first=setup(t,apiAdapter(()=>snapshot(null,outcome)));
  assert.equal((await first.call({model:'api-test',messages:basic.messages,tools:[tool],tool_choice:'none'})).status,502);
  const secondCase=setup(t,apiAdapter(()=>snapshot('did not call')));
  assert.equal((await secondCase.call({model:'api-test',messages:basic.messages,tools:[tool],tool_choice:'required'})).status,502);
  const correct=setup(t,apiAdapter(()=>snapshot(null,outcome)));
  assert.equal((await correct.call({model:'api-test',messages:basic.messages,tools:[tool],tool_choice:{type:'function',function:{name:'read_synthetic'}},parallel_tool_calls:false})).status,200);
  const multi=setup(t,apiAdapter(()=>snapshot(null,[...outcome,{...outcome[0],id:'call_b'}])));
  assert.equal((await multi.call({model:'api-test',messages:basic.messages,tools:[tool],parallel_tool_calls:false})).status,502);
});

test('G12 idempotency is identity/key/body scoped; unkeyed equal requests are independent',async t=>{
  let count=0;const f=setup(t,apiAdapter(()=>{count++;return snapshot('count '+count);}));
  const body={model:'api-test',messages:basic.messages};
  const first=await json(await f.call(body,{'Idempotency-Key':'stable'})),same=await json(await f.call(body,{'Idempotency-Key':'stable'}));assert.equal(first.id,same.id);assert.equal(count,1);
  const conflict=await f.call({...body,messages:[{role:'user',content:'changed'}]},{'Idempotency-Key':'stable'});assert.equal(conflict.status,409);assert.equal(count,1);
  await f.call(body,{'Idempotency-Key':'stable'},second);assert.equal(count,2);
  const a=await json(await f.call(body)),b=await json(await f.call(body));assert.notEqual(a.id,b.id);assert.equal(count,4);
});

test('G13 failed upstream response is recorded and not automatically retried under the same key',async t=>{
  let count=0;const f=setup(t,apiAdapter(()=>{count++;return new Response('Do not expose provider key',{status:429});}));
  const body={model:'api-test',messages:basic.messages};
  assert.equal((await f.call(body,{'Idempotency-Key':'rate-limit'})).status,429);assert.equal((await f.call(body,{'Idempotency-Key':'rate-limit'})).status,429);assert.equal(count,1);
  assert.equal(JSON.stringify(f.store.events(0,200)).includes('Do not expose'),false);
});

class HangingAdapter implements ProviderAdapter{
  readonly capabilities:ProviderCapabilities={kind:'mock',alias:'mock-test',context_isolation:'per_request_full_history',context_window_tokens:null,text_streaming:'native',tool_streaming:'buffered_validated',roles:'mock_only_no_model_priority',parameter_support:{},strict_function_calling:false,model_identity:'mock_not_a_model',live_model_tested:false};
  constructor(private readonly textFirst=false){}
  async health(){return {ready:true,reason:'in-memory timeout fixture'};}
  async *invoke(_request:ChatRequest,signal:AbortSignal):AsyncIterable<ProviderEvent>{
    if(this.textFirst)yield {type:'text_delta',text:'start'};
    await new Promise<void>((_resolve,reject)=>{if(signal.aborted){reject(signal.reason);return;}signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }
}
test('G14 first-response and idle deadlines abort bounded work and mark expired',async t=>{
  for(const textFirst of [false,true]){
    const f=setup(t,new HangingAdapter(textFirst),{first_response_ms:25,idle_ms:25,total_ms:500});
    const response=await f.call({...basic,stream:textFirst});
    if(textFirst){const text=await response.text();assert.ok(frames(text).some(frame=>frame.error?.code==='DEADLINE_EXCEEDED'));assert.equal(text.includes('[DONE]'),false);}else assert.equal(response.status,504);
    assert.equal(f.store.all<Run>('runs')[0]!.state,'expired');assert.equal(f.gateway.capabilities().queue.active,0);
  }
});

test('G15 queue full, pending duplicate and disconnect do not leave infinite jobs',async t=>{
  const f=setup(t,new HangingAdapter(),{max_inflight:1,max_queued:0,first_response_ms:1000,total_ms:2000});
  const controller=new AbortController();const first=f.call(basic,{'Idempotency-Key':'active'},principal,controller.signal);
  await new Promise(resolve=>setImmediate(resolve));
  const duplicate=await f.call(basic,{'Idempotency-Key':'active'});assert.equal(duplicate.status,409);
  const full=await f.call(basic);assert.equal(full.status,429);
  controller.abort();assert.equal((await first).status,499);assert.equal(f.gateway.capabilities().queue.active,0);
  assert.equal(f.store.all<Run>('runs').filter(run=>run.state==='cancelled').length,1);
});

test('G16 stream consumer cancellation frees admission and ends the run without fake completion',async t=>{
  const f=setup(t,new HangingAdapter(true));const response=await f.call({...basic,stream:true}),reader=response.body!.getReader();
  await reader.read();await reader.cancel();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.gateway.capabilities().queue.active,0);assert.equal(f.store.all<Run>('runs')[0]!.state,'cancelled');
});

test('G17 wrong principal, unavailable model, invalid API permission and Arena destination fail closed',async t=>{
  const f=setup(t);assert.equal((await f.call(basic,{}, {...principal,kind:'worker'})).status,403);
  assert.equal((await f.call({...basic,model:'arena-agent-unverified'})).status,400);
  const missing=setup(t,apiAdapter(()=>snapshot('unused'),{health:false}));assert.deepEqual(await missing.gateway.models(),{object:'list',data:[]});assert.equal((await missing.call({model:'api-test',messages:basic.messages})).status,503);
  const config=GatewayConfigSchema.parse({type:'approved_openai_api',alias:'api-test',model:'unknown',base_url:'https://arena.ai/v1',api_key_env:'ANY_KEY',authorization_reference:'not-platform-permission',data_egress_approved:true});
  assert.throws(()=>new ApprovedOpenAiAdapter(config as any,'not-a-real-key'),{code:'AUTHORIZATION_REQUIRED'});
  assert.equal(GatewayConfigSchema.safeParse({type:'approved_openai_api',data_egress_approved:false}).success,false);
});

test('G19 total deadline releases a response abandoned under backpressure',async t=>{
  const f=setup(t,new HangingAdapter(true),{first_response_ms:100,idle_ms:100,total_ms:30});
  const response=await f.call({...basic,stream:true});
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(f.gateway.capabilities().queue.active,0);
  assert.ok(['expired','cancelled'].includes(f.store.all<Run>('runs')[0]!.state));
  const text=await response.text();assert.ok(frames(text).some(frame=>frame.error));assert.equal(text.includes('[DONE]'),false);
});

test('G20 local run cancellation aborts upstream without affecting other identities',async t=>{
  const f=setup(t,new HangingAdapter(),{first_response_ms:1000});
  const pending=f.call(basic);await new Promise(resolve=>setImmediate(resolve));
  const run=f.store.all<Run>('runs')[0]!;f.gateway.cancelRun(run.id);
  assert.equal((await pending).status,499);assert.equal(f.store.get<Run>('runs',run.id)!.state,'cancelled');assert.equal(f.gateway.capabilities().queue.active,0);
});

test('G21 JSON-object mode buffers native deltas for validation and explicitly labels emulation',async t=>{
  const good=setup(t,apiAdapter(()=>sse([packet({content:'{"ok":'}),packet({content:'true}'}),packet({},'stop')])));
  const response=await good.call({model:'api-test',messages:basic.messages,stream:true,response_format:{type:'json_object'}});
  assert.equal(response.headers.get('x-arenabridge-streaming'),'buffered_emulated');assert.ok((await response.text()).includes('[DONE]'));
  const bad=setup(t,apiAdapter(()=>sse([packet({content:'not JSON'}),packet({},'stop')])));
  const rejected=await bad.call({model:'api-test',messages:basic.messages,stream:true,response_format:{type:'json_object'}}),text=await rejected.text();
  assert.equal(text.includes('not JSON'),false);assert.equal(text.includes('[DONE]'),false);assert.ok(frames(text).some(frame=>frame.error?.code==='UPSTREAM_CONSTRAINT_VIOLATION'));
});

test('G18 no file, terminal, federation or hidden permission imports in runtime outcomes; log stays summarized',async t=>{
  const secret='SYNTHETIC_PRIVATE_CONTEXT_ABC';const f=setup(t);await f.call({...basic,messages:[{role:'user',content:secret}]});
  const log=JSON.stringify(f.store.events(0,200));assert.equal(log.includes(secret),false);assert.equal(log.includes('owned-fixture-api-key'),false);
  assert.ok(f.store.all<Run>('runs').every(run=>run.execution_owner==='client'&&run.workspace_id==='model_api_no_workspace'));
});
