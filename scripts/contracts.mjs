import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ToolSchemas, ToolDescriptions } from '../dist/apps/daemon/src/tools.js';
import { capabilities, ConfigSchema } from '../dist/apps/daemon/src/server.js';
import { PairingInput, ACCESS_MODES } from '../dist/packages/policy-engine/src/index.js';
import { ToolResultSchema } from '../dist/packages/contracts/src/index.js';
import { ChatRequestSchema, GatewayConfigSchema } from '../dist/packages/provider-gateway/src/contracts.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'outputs');await fs.mkdir(out,{recursive:true});
const write=(name,data)=>fs.writeFile(path.join(out,name),JSON.stringify(data,null,2)+'\n');
const object=(properties={},required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'},bool={type:'boolean'},int={type:'integer'},confirm=object({confirm:{const:true}});
const schemas={
  Error:object({error:object({code:string,message:string,details:{type:'object',additionalProperties:true}},['code','message']),request_id:string},['error']),
  Config:z.toJSONSchema(ConfigSchema,{io:'input'}),
  ToolResult:z.toJSONSchema(ToolResultSchema,{io:'output'}),
  PairingCreate:z.toJSONSchema(PairingInput,{io:'input'}),
  // Derived from the engine rather than hand-written: this file publishes the contract, and a
  // published contract that disagrees with the daemon is worse than no contract at all. It said
  // `ask|plan|code` after `exec` shipped, so anything validating against it would have rejected
  // a request the daemon accepts.
  PairingRequest:object({code:{type:'string',minLength:32,maxLength:256},remote_label:{type:'string',minLength:1,maxLength:80},access_mode:{enum:[...ACCESS_MODES],default:'ask'}},['code','remote_label']),
  PairingDecision:object({approve:bool,access_mode:{enum:[...ACCESS_MODES]},data_egress_ack:{const:true}}),
  PairingClaim:object({pair_id:string,claim_secret:{type:'string',minLength:32,maxLength:256}}),
  ApprovalDecision:object({approve:bool}),
  RunCreate:object({mode:{enum:['remote_workspace','provider_gateway_client_tools','provider_gateway_bridge_tools','mcp_task_service']},workspace_id:string}),
  Run:object({id:string,workspace_id:string,principal_id:string,mode:{enum:['remote_workspace','provider_gateway_client_tools','provider_gateway_bridge_tools','mcp_task_service']},execution_owner:{enum:['remote_workspace','client','bridge']},state:{enum:['created','queued','assigned','running','waiting_for_tool','waiting_for_approval','needs_user_resume','completed','failed','cancelled','expired','unknown']},reason:{type:['string','null']},policy_version:string,created_at:int,updated_at:int}),
  Event:object({schema_version:{const:'1.0'},event_id:string,run_id:{type:['string','null']},request_id:{type:['string','null']},job_id:{type:['string','null']},source:string,seq:{type:'integer',minimum:1},timestamp:{type:'string',format:'date-time'},type:string,payload:{type:'object',additionalProperties:{type:['string','number','boolean','null']}}}),
  Confirm:confirm,
  Recover:object({workspace_id:string,confirm:{const:true}}),
  Models:object({object:{const:'list'},data:{type:'array',items:{type:'object',properties:{id:string,object:{const:'model'},created:int,owned_by:string},required:['id','object','created','owned_by'],additionalProperties:false}}}),
  ChatCompletionsRequest:z.toJSONSchema(ChatRequestSchema,{io:'input'}),
  ChatCompletionsResponse:object({id:string,object:{const:'chat.completion'},created:int,model:string,choices:{type:'array',minItems:1,maxItems:1,items:object({index:{const:0},message:object({role:{const:'assistant'},content:{type:['string','null']},tool_calls:{type:'array',items:{type:'object'}},refusal:string},['role','content']),finish_reason:{enum:['stop','length','tool_calls','content_filter']}},['index','message','finish_reason'])},usage:object({prompt_tokens:int,completion_tokens:int,total_tokens:int},['prompt_tokens','completion_tokens','total_tokens'])},['id','object','created','model','choices']),
  ProviderConfig:z.toJSONSchema(GatewayConfigSchema,{io:'input'})
};
const securitySchemes={AdminBearer:{type:'http',scheme:'bearer',description:'Independent local control credential. Never send to the MCP or model endpoint.'},ClientBearer:{type:'http',scheme:'bearer',description:'Independent local model-client credential. It grants no workspace access.'},WorkspaceBearer:{type:'http',scheme:'bearer',description:'Short-lived paired grant, scoped to one workspace/run, revocable. Not an OAuth implementation.'}};
const origins={admin:'http://127.0.0.1:48272',api:'http://127.0.0.1:48270',mcp:'http://127.0.0.1:48271'};
const paths={};
function add(method,route,{role='admin',summary,body,responseSchema,status=200,security,description,parameters=[],implemented=true}){
  const response={description:'Successful application response',content:{'application/json':{schema:responseSchema?{$ref:`#/components/schemas/${responseSchema}`}:{type:'object'}}}};
  const errors={};for(const code of [400,401,403,404,409,413,415,422,429,500,503])errors[code]={description:'Application error; code is not an MCP JSON-RPC error code',content:{'application/json':{schema:{$ref:'#/components/schemas/Error'}}}};
  const params=[...route.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:string}));
  const operation={summary,description:description??summary,operationId:`${method}_${route.replace(/[^A-Za-z0-9]+/g,'_')}`,servers:[{url:origins[role]}],security:security===false?[]:[{[security??(role==='admin'?'AdminBearer':role==='api'?'ClientBearer':'WorkspaceBearer')]:[]}],parameters:[...params,...parameters],responses:{...errors,[status]:response},'x-arenabridge-implemented':implemented};
  if(body)operation.requestBody={required:true,content:{'application/json':{schema:typeof body==='string'?{$ref:`#/components/schemas/${body}`} : body}}};
  paths[route]??={};paths[route][method]=operation;
}
add('get','/healthz',{role:'api',summary:'Authenticated model-port process health',description:'Also exists on the admin port with AdminBearer. Alive does not imply a usable inference provider.'});
add('get','/readyz',{role:'api',summary:'Model readiness; 503 until a configured backend passes its health check',description:'The admin port also exposes /readyz, which reports only control-plane readiness.'});
add('get','/bridge/v1/capabilities',{role:'api',summary:'Application capability matrix, not OpenAI or MCP standard metadata',description:'Also exists on the admin port with AdminBearer.'});
add('get','/v1/models',{role:'api',summary:'Health-gated model aliases; empty when no approved backend passes its check',responseSchema:'Models'});
add('post','/v1/chat/completions',{role:'api',summary:'Bounded client-tools Chat Completions; returns tool proposals, never executes them',body:'ChatCompletionsRequest',responseSchema:'ChatCompletionsResponse',description:'Implemented as an alpha for the client-tools execution mode. The gateway validates messages, tools and streamed tool-call deltas, then returns proposals with finish_reason=tool_calls. It never executes a tool. 503 when no provider is configured or healthy. Unknown parameters are rejected with 422 rather than dropped. Streaming may be native or explicitly labelled buffered_emulated.'});
add('post','/v1/responses',{role:'api',summary:'unsupported_protocol',body:{},status:422,responseSchema:'Error',implemented:false});
add('post','/v1/messages',{role:'api',summary:'unsupported_protocol',body:{},status:422,responseSchema:'Error',implemented:false});
add('get','/admin/v1/status',{summary:'Local status, sanitized workspace names, pending approval facts'});
add('post','/admin/v1/pairings',{summary:'Create a short-lived single-use pairing invitation',body:'PairingCreate',status:201});
add('post','/admin/v1/pairings/{pair_id}/decision',{summary:'Local operator approves requested access and acknowledges data egress',body:'PairingDecision'});
add('post','/pair/request',{role:'mcp',summary:'Request local pairing using a single-use random invitation',body:'PairingRequest',status:202,security:false,description:'Pre-grant bootstrap only; possession of the short-lived invitation is required. No file access.'});
add('post','/pair/claim',{role:'mcp',summary:'Claim locally approved grant once with the claim secret',body:'PairingClaim',security:false,description:'Returns pending until local approval, then a token/challenge once. Never log the response.'});
add('post','/admin/v1/approvals/{approval_id}/decision',{summary:'Approve or deny an exact one-use patch action',body:'ApprovalDecision'});
add('get','/admin/v1/workspaces/{workspace_id}/patches/{patch_id}',{summary:'Read locally stored patch preview and real diff'});
add('post','/admin/v1/revoke-all',{summary:'Revoke grants and cached legacy sessions; not a process kill',body:'Confirm'});
add('post','/admin/v1/recover',{summary:'Explicit local recovery of committing patch journals',body:'Recover'});
add('get','/admin/v1/tool-schemas',{summary:'Actual schemas for the implemented or explicitly unavailable tools'});
add('get','/admin/v1/events',{summary:'Redacted event page',parameters:[{name:'after',in:'query',schema:{type:'integer',minimum:0,default:0}}]});
add('post','/bridge/v1/runs',{summary:'Create a manual remote_workspace record, not an Orchestrator job',body:'RunCreate',responseSchema:'Run',status:201,description:'Custom application API. Only remote_workspace is accepted. Other modes return 422. A manual record confers no workspace access; pairing creates a separately bound remote run.',parameters:[{name:'Idempotency-Key',in:'header',schema:{type:'string',minLength:1,maxLength:128},description:'Same identity/scope/key+body returns registered result; conflicting body fails. Missing key never deduplicates identical bodies.'}]});
add('get','/bridge/v1/runs/{run_id}',{summary:'Inspect run record, todos and progress'});
add('get','/bridge/v1/runs/{run_id}/events',{summary:'Inspect run-scoped application events',parameters:[{name:'after',in:'query',schema:{type:'integer',minimum:0,default:0}}]});
add('post','/bridge/v1/runs/{run_id}/cancel',{summary:'Stop admission of new run actions',body:'Confirm',responseSchema:'Run'});
add('post','/bridge/v1/runs/{run_id}/complete',{summary:'Local operator reports completion; not independently verified success',body:'Confirm',responseSchema:'Run'});
const spec={openapi:'3.1.0',info:{title:'ArenaBridge stage1 application API',version:'0.1.0-stage1',description:'Local trusted-development build. /bridge and /admin paths are custom protocols, not OpenAI/MCP standards. The /mcp wire contract is separately defined by the MCP specification and tool schemas. No production Arena backend.'},servers:[{url:origins.admin}],paths,components:{securitySchemes,schemas},'x-arenabridge-mcp-endpoint':origins.mcp+'/mcp','x-arenabridge-status':'development; full regression blocked by local file-protection policy'};
await write('openapi.json',spec);
await write('mcp-tools.schema.json',{schema_version:'1.0',source:'generated from the code used by the server',tools:Object.entries(ToolSchemas).map(([name,schema])=>({name,description:ToolDescriptions[name],inputSchema:z.toJSONSchema(schema,{io:'input'}),outputSchema:schemas.ToolResult,availability:['lsp','get_diagnostics'].includes(name)?'capability_unavailable':'implemented',execution_owner:'remote_workspace'}))});
await write('events.schema.json',{$schema:'https://json-schema.org/draft/2020-12/schema',...schemas.Event,description:'Application events, not MCP protocol notifications. Nullable run/request/job IDs indicate applicability. Payloads are allowlisted summaries, never source or credentials.'});
await write('runtime-config.schema.json',schemas.Config);
await write('capability-matrix.json',{checked_at:new Date().toISOString(),...capabilities(),gateway_contract:{request:'ChatCompletionsRequest',response:'ChatCompletionsResponse',provider_config:'ProviderConfig',execution_owner:'client',tools_executed_by_gateway:false,declared_unsupported:['n>1','logprobs','seed','attachments','json_schema response_format','strict generation','Responses API','Anthropic Messages']},test_matrix:[{client:'Owned HTTP fixture',versions:['2026-07-28','2025-11-25'],transport:'JSON/request SSE',historical_group:'pass',latest_full_regression:'blocked'},{client:'Official SDK 2.0.0',versions:['2026-07-28','2025-11-25'],transport:'HTTP and stdio relay',historical_group:'pass',latest_full_regression:'blocked'},{client:'Model gateway in-memory suite',versions:['G01-G21'],transport:'in-process fetch',latest_group:'pass 21/21'},{client:'Model gateway real loopback HTTP',versions:['H01-H06'],transport:'node:http JSON/SSE',latest_group:'pass 6/6'},{client:'Model gateway via daemon API port',versions:['D01-D02'],transport:'node:http',latest_group:'pass 2/2'},{client:'WorkBuddy desktop',build:'unknown',status:'not_tested'},{client:'TRAE desktop',build:'unknown',status:'not_tested'},{client:'Arena Agent',build:'unknown',status:'blocked',reason:'permission and data agreement missing'}]});
await write('state-model.json',{schema_version:'1.0',execution_owners:{remote_workspace:'remote_workspace',provider_gateway_client_tools:'client',provider_gateway_bridge_tools:'bridge',mcp_task_service:'bridge'},immutable_run_fields:['workspace_id','principal_id','mode','execution_owner'],transitions:{created:['queued','running','cancelled','expired'],queued:['assigned','running','cancelled','expired','failed'],assigned:['running','needs_user_resume','cancelled','expired','unknown'],running:['waiting_for_tool','waiting_for_approval','needs_user_resume','completed','failed','cancelled','expired','unknown'],waiting_for_tool:['running','failed','cancelled','expired','unknown'],waiting_for_approval:['running','failed','cancelled','expired','unknown'],needs_user_resume:['running','cancelled','expired','failed','unknown'],completed:[],failed:[],cancelled:[],expired:[],unknown:[]},restart_rule:'Unfinished runs become unknown; grants fail on epoch mismatch; pending idempotency records become unknown; never replay side effects.'});
process.stdout.write('Emitted OpenAPI, tool/event/config schemas, capabilities and state model.\n');
