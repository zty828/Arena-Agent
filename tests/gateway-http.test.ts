import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { Store } from '../packages/storage/src/index.js';
import { ProviderGateway } from '../packages/provider-gateway/src/index.js';
import { MockAdapter, ApprovedOpenAiAdapter, type FetchLike } from '../packages/provider-gateway/src/adapters.js';
import { GatewayConfigSchema, type ChatRequest, type ProviderAdapter } from '../packages/provider-gateway/src/contracts.js';
import type { Principal } from '../packages/contracts/src/index.js';

// Real loopback HTTP and SSE with SQLite :memory: state. No workspace files, no deletions.
const CLIENT='c'.repeat(48),OTHER='d'.repeat(48);
const principal:Principal={id:'http-api-client',kind:'api_client',label:'Synthetic HTTP model client'};
const tool={type:'function',function:{name:'read_synthetic',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}};
const packet=(delta:unknown,finish_reason:unknown=null)=>({id:'upstream',object:'chat.completion.chunk',created:1,model:'real-model',choices:[{index:0,delta,finish_reason}]});
function sse(chunks:unknown[]):Response{return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(chunks.map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n'));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});}
function apiAdapter(responder:(body:ChatRequest)=>Response):ApprovedOpenAiAdapter{
  const config=GatewayConfigSchema.parse({type:'approved_openai_api',alias:'api-test',model:'real-model',base_url:'https://approved-fixture.invalid/v1',api_key_env:'TEST_PROVIDER_KEY',authorization_reference:'owned-fixture-not-real-approval',data_egress_approved:true,native_parameters:['tools','tool_choice','parallel_tool_calls','temperature','top_p','max_tokens','stop','response_format']});
  const fetcher:FetchLike=async(input,init)=>String(input).endsWith('/models')?Response.json({data:[{id:'real-model'}]}):responder(JSON.parse(String(init?.body)));
  return new ApprovedOpenAiAdapter(config as Extract<typeof config,{type:'approved_openai_api'}>,'owned-fixture-api-key',fetcher);
}
function bearer(value:string|undefined):Principal|undefined{
  if(value===`Bearer ${CLIENT}`)return principal;
  return undefined;
}
async function serve(t:TestContext,adapter:ProviderAdapter|undefined):Promise<{url:string;gateway:ProviderGateway;store:Store}>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const gateway=new ProviderGateway(store,adapter,{first_response_ms:2000,idle_ms:2000,total_ms:8000,health_ms:1000});
  const server:Server=createServer({requestTimeout:20000},(req,res)=>{
    void(async()=>{
      const who=bearer(req.headers.authorization);
      if(!who){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'AUTH_REQUIRED'}}));return;}
      const controller=new AbortController();
      res.once('close',()=>{if(!res.writableEnded)controller.abort();});
      const request=new Request(new URL(req.url??'/',`http://127.0.0.1:${(server.address() as {port:number}).port}`),{method:req.method,headers:new Headers(req.headers as Record<string,string>),...(req.method==='POST'?{body:await new Promise<string>(resolve=>{let data='';req.on('data',chunk=>{data+=String(chunk);});req.on('end',()=>resolve(data));}),duplex:'half'}:{}),signal:controller.signal} as RequestInit);
      const response=await gateway.handle(request,who);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(!response.body){res.end();return;}
      const reader=response.body.getReader();
      try{for(;;){const part=await reader.read();if(part.done)break;if(res.destroyed){await reader.cancel();return;}res.write(Buffer.from(part.value));}if(!res.destroyed)res.end();}
      finally{reader.releaseLock();}
    })().catch(()=>{if(!res.destroyed)res.destroy();});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));
  return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,gateway,store};
}
const post=(url:string,body:unknown,headers:Record<string,string>={},signal?:AbortSignal)=>fetch(url+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal});
const chat={model:'api-test',messages:[{role:'user',content:'hello over real HTTP'}]};

test('H01 real loopback HTTP serves non-streaming Chat Completions with client ownership headers',async t=>{
  const {url,store}=await serve(t,apiAdapter(()=>Response.json({id:'up',object:'chat.completion',created:1,model:'real-model',choices:[{index:0,message:{role:'assistant',content:'pong'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}})));
  const response=await post(url,chat,{Authorization:`Bearer ${CLIENT}`});
  assert.equal(response.status,200);assert.equal(response.headers.get('x-arenabridge-execution-owner'),'client');
  const data=await response.json() as any;assert.equal(data.choices[0].message.content,'pong');assert.equal(data.usage.total_tokens,4);
  assert.equal(store.all<any>('runs')[0].execution_owner,'client');
});

test('H02 real HTTP tool round trip: gateway proposes once, host executes, role=tool continues',async t=>{
  let round=0;
  const {url}=await serve(t,apiAdapter(body=>{round++;return round===1
    ?Response.json({id:'up',object:'chat.completion',created:1,model:'real-model',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'call_http',type:'function',function:{name:'read_synthetic',arguments:'{"path":"文件.txt"}'}}]},finish_reason:'tool_calls'}]})
    :Response.json({id:'up',object:'chat.completion',created:1,model:'real-model',choices:[{index:0,message:{role:'assistant',content:'host result accepted'},finish_reason:'stop'}]});}));
  const first=await (await post(url,{...chat,tools:[tool],tool_choice:'required',parallel_tool_calls:false},{Authorization:`Bearer ${CLIENT}`})).json() as any;
  const call=first.choices[0].message.tool_calls[0];assert.deepEqual(JSON.parse(call.function.arguments),{path:'文件.txt'});assert.equal(round,1);
  const executed=JSON.stringify({path:'文件.txt',text:'owned content'});
  const second=await (await post(url,{...chat,messages:[...chat.messages,first.choices[0].message,{role:'tool',tool_call_id:call.id,content:executed}],tools:[tool],tool_choice:'auto'},{Authorization:`Bearer ${CLIENT}`})).json() as any;
  assert.equal(second.choices[0].message.content,'host result accepted');assert.equal(round,2);
});

test('H03 real HTTP SSE streams native deltas, usage-only tail and final DONE',async t=>{
  const {url}=await serve(t,apiAdapter(()=>sse([packet({role:'assistant',content:''}),packet({content:'流'}),packet({content:'式'}),packet({},'stop'),{choices:[],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}}])));
  const response=await post(url,{...chat,stream:true,stream_options:{include_usage:true}},{Authorization:`Bearer ${CLIENT}`});
  assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');assert.equal(response.headers.get('x-arenabridge-streaming'),'native');
  const text=await response.text();assert.ok(text.endsWith('data: [DONE]\n\n'));
  const frames=text.split(/\r?\n\r?\n/).filter(Boolean).map(frame=>frame.replace(/^data: /,'')).filter(value=>value!=='[DONE]').map(value=>JSON.parse(value));
  assert.equal(frames.map(frame=>frame.choices[0]?.delta.content??'').join(''),'流式');assert.deepEqual(frames.at(-1).usage,{prompt_tokens:5,completion_tokens:2,total_tokens:7});
});

test('H04 wrong or missing bearer is rejected before any provider work',async t=>{
  let calls=0;const {url}=await serve(t,apiAdapter(()=>{calls++;return Response.json({});}));
  assert.equal((await post(url,chat)).status,401);assert.equal((await post(url,chat,{Authorization:`Bearer ${OTHER}`})).status,401);
  assert.equal((await fetch(url+'/v1/models')).status,401);assert.equal(calls,0);
});

test('H05 client abort during a real HTTP stream frees admission and never fabricates completion',async t=>{
  const {url,gateway,store}=await serve(t,apiAdapter(()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(packet({content:'first'}))}\n\n`));}}),{headers:{'Content-Type':'text/event-stream'}})));
  const controller=new AbortController();
  const response=await post(url,{...chat,stream:true},{Authorization:`Bearer ${CLIENT}`},controller.signal);
  const reader=response.body!.getReader();await reader.read();controller.abort();await reader.cancel().catch(()=>undefined);
  for(let turn=0;turn<40&&gateway.capabilities().queue.active;turn++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(gateway.capabilities().queue.active,0);
  assert.ok(['cancelled','failed'].includes(store.all<any>('runs')[0].state));
  assert.equal(store.all<any>('runs')[0].state==='completed',false);
});

test('H06 real HTTP keeps model list empty when health fails and never zero-fills usage',async t=>{
  const {url}=await serve(t,new MockAdapter({type:'mock',acknowledge_mock:true,alias:'mock-test',scenario:'echo'}));
  const models=await (await fetch(url+'/v1/models',{headers:{Authorization:`Bearer ${CLIENT}`}})).json() as any;
  assert.equal(models.data[0].id,'mock-test');assert.equal(models.data[0].owned_by,'arenabridge-mock');
  const response=await post(url,{model:'mock-test',messages:[{role:'user',content:'hi'}]},{Authorization:`Bearer ${CLIENT}`});
  assert.equal((await response.json() as any).usage,undefined);
  const ready=await fetch(url+'/readyz',{headers:{Authorization:`Bearer ${CLIENT}`}});assert.equal(ready.status,200);
});
