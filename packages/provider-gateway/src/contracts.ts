import { z } from 'zod';
import { BridgeError } from '../../contracts/src/index.js';
import { parseToolArguments, schemaMatches, validateSchema, type JsonSchema } from './schema.js';

const FunctionName=z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const CallId=z.string().min(1).max(128);
const TextContent=z.union([z.string().max(262144),z.array(z.object({type:z.literal('text'),text:z.string().max(262144)}).strict()).max(32)]);
export const ToolCallSchema=z.object({id:CallId,type:z.literal('function'),function:z.object({name:FunctionName,arguments:z.string().max(65536)}).strict()}).strict();
const HumanMessage=(role:'system'|'developer'|'user')=>z.object({role:z.literal(role),content:TextContent,name:FunctionName.optional()}).strict();
const Assistant=z.object({role:z.literal('assistant'),content:TextContent.nullable().optional(),tool_calls:z.array(ToolCallSchema).min(1).max(16).optional(),refusal:z.string().max(8192).nullable().optional(),name:FunctionName.optional()}).strict();
const ToolMessage=z.object({role:z.literal('tool'),tool_call_id:CallId,content:TextContent}).strict();
export const MessageSchema=z.discriminatedUnion('role',[HumanMessage('system'),HumanMessage('developer'),HumanMessage('user'),Assistant,ToolMessage]);
export const FunctionToolSchema=z.object({type:z.literal('function'),function:z.object({name:FunctionName,description:z.string().max(8192).optional(),parameters:z.record(z.string(),z.unknown()).default({type:'object',properties:{},additionalProperties:false}),strict:z.boolean().optional()}).strict()}).strict();
export const ChatRequestSchema=z.object({
  model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),messages:z.array(MessageSchema).min(1).max(200),
  tools:z.array(FunctionToolSchema).max(32).optional(),
  tool_choice:z.union([z.enum(['auto','none','required']),z.object({type:z.literal('function'),function:z.object({name:FunctionName}).strict()}).strict()]).optional(),
  parallel_tool_calls:z.boolean().optional(),
  stream:z.boolean().optional(),stream_options:z.object({include_usage:z.boolean().optional()}).strict().nullable().optional(),
  temperature:z.number().min(0).max(2).optional(),top_p:z.number().min(0).max(1).optional(),
  max_tokens:z.number().int().positive().max(1048576).optional(),max_completion_tokens:z.number().int().positive().max(1048576).optional(),
  stop:z.union([z.string().min(1).max(1024),z.array(z.string().min(1).max(1024)).min(1).max(4)]).nullable().optional(),
  response_format:z.union([z.object({type:z.literal('text')}).strict(),z.object({type:z.literal('json_object')}).strict()]).optional(),
  n:z.literal(1).optional()
}).strict();
export type ChatRequest=z.infer<typeof ChatRequestSchema>;
export type ChatMessage=z.infer<typeof MessageSchema>;
export type ToolCall=z.infer<typeof ToolCallSchema>;
export interface Usage {prompt_tokens:number;completion_tokens:number;total_tokens:number;}
export type FinishReason='stop'|'length'|'tool_calls'|'content_filter';
export interface Outcome {content:string|null;tool_calls?:ToolCall[];refusal?:string;finish_reason:FinishReason;usage?:Usage;}
export type ProviderEvent =
  | {type:'text_delta';text:string}
  | {type:'refusal_delta';text:string}
  | {type:'tool_delta';index:number;id?:string;name?:string;arguments?:string}
  | {type:'complete';outcome:Outcome};
export type ParameterSupport='native'|'emulated'|'unsupported';
export interface ProviderCapabilities {
  kind:'mock'|'approved_openai_api';
  alias:string;
  context_isolation:'per_request_full_history';
  context_window_tokens:number|null;
  text_streaming:'native'|'buffered_emulated';
  tool_streaming:'buffered_validated';
  roles:'native_api_roles'|'mock_only_no_model_priority';
  parameter_support:Record<string,ParameterSupport>;
  strict_function_calling:false;
  model_identity:'configured_api_model'|'mock_not_a_model';
  live_model_tested:false;
}
export interface ProviderAdapter {
  readonly capabilities:ProviderCapabilities;
  health(signal:AbortSignal):Promise<{ready:boolean;reason:string}>;
  invoke(request:ChatRequest,signal:AbortSignal):AsyncIterable<ProviderEvent>;
}
function paramError(param:string,message:string):never{throw new BridgeError('UNSUPPORTED_PARAMETER',422,message,{param});}
export function textOf(content:unknown):string {
  if(typeof content==='string')return content;
  if(Array.isArray(content))return content.map(part=>part&&typeof part==='object'&&'text'in part&&typeof part.text==='string'?part.text:'').join('');
  return '';
}
export function parseChatRequest(value:unknown):ChatRequest{
  const parsed=ChatRequestSchema.safeParse(value);
  if(!parsed.success){
    const issue=parsed.error.issues[0]!;
    const key=issue.code==='unrecognized_keys'?issue.keys[0]:issue.path.map(String).join('.');
    paramError(key||'request','Unsupported parameter value or invalid Chat Completions structure');
  }
  const request=parsed.data;
  if(Buffer.byteLength(JSON.stringify(request))>524288)paramError('messages','Normalized request exceeds the 512 KiB input budget; no history was dropped');
  if(request.max_tokens!==undefined&&request.max_completion_tokens!==undefined)paramError('max_completion_tokens','Use one output token-limit field, not both');
  if(request.stream_options&&!request.stream)paramError('stream_options','stream_options is only accepted when stream=true');
  const tools=request.tools??[],names=new Set(tools.map(t=>t.function.name));
  if(names.size!==tools.length)paramError('tools','Function names must be unique');
  for(const [index,tool] of tools.entries()){
    if(tool.function.strict===true)paramError(`tools.${index}.function.strict`,'Strict generation is not certified by this adapter; validation is not a generation guarantee');
    validateSchema(tool.function.parameters,`tools.${index}.function.parameters`);
    if(tool.function.parameters.type!=='object')paramError(`tools.${index}.function.parameters.type`,'Function parameters must declare type=object');
  }
  if(request.tool_choice==='required'&&!tools.length)paramError('tool_choice','required needs at least one function');
  if(typeof request.tool_choice==='object'&&!names.has(request.tool_choice.function.name))paramError('tool_choice','The chosen function is not in tools');
  if(!tools.length&&request.parallel_tool_calls!==undefined)paramError('parallel_tool_calls','parallel_tool_calls requires a tool catalog');
  const seen=new Set<string>(),pending=new Set<string>();
  for(const [index,message] of request.messages.entries()){
    if(message.role==='tool'){
      if(!pending.delete(message.tool_call_id))paramError(`messages.${index}.tool_call_id`,'Tool result must match one unresolved assistant tool call');
      continue;
    }
    if(pending.size)paramError(`messages.${index}`,'Resolve all assistant tool calls before the next non-tool message');
    if(message.role==='assistant'){
      if(message.content===undefined&&!message.tool_calls&&!message.refusal)paramError(`messages.${index}`,'Assistant message requires content, refusal or tool_calls');
      for(const call of message.tool_calls??[]){
        if(seen.has(call.id))paramError(`messages.${index}.tool_calls`,'Tool call IDs must be unique across the supplied history');
        seen.add(call.id);pending.add(call.id);
        try{parseToolArguments(call.function.arguments,`messages.${index}.tool_calls`);}catch{paramError(`messages.${index}.tool_calls`,'Historical tool arguments must be complete JSON objects');}
      }
    }
  }
  if(pending.size)paramError('messages','Assistant tool calls need their role=tool results before a new model request');
  return request;
}
export function validateParameters(request:ChatRequest,capabilities:ProviderCapabilities):void{
  for(const name of Object.keys(request)){
    if(['messages','model','stream','stream_options','n'].includes(name))continue;
    if((capabilities.parameter_support[name]??'unsupported')==='unsupported')paramError(name,`Parameter is unsupported by backend ${capabilities.kind}`);
  }
  if(request.response_format?.type==='json_object'&&capabilities.parameter_support['response_format.json_object']!=='native')paramError('response_format','This backend does not declare native JSON-object generation');
}
export function validateUsage(value:unknown):Usage{
  const schema=z.object({prompt_tokens:z.number().int().nonnegative(),completion_tokens:z.number().int().nonnegative(),total_tokens:z.number().int().nonnegative()});
  const parsed=schema.safeParse(value);
  if(!parsed.success||parsed.data.total_tokens!==parsed.data.prompt_tokens+parsed.data.completion_tokens)throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Invalid upstream token usage');
  return parsed.data;
}
export function validateOutcome(request:ChatRequest,result:Outcome):Outcome{
  if(!['stop','length','tool_calls','content_filter'].includes(result.finish_reason))throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Missing or unsupported finish_reason');
  if(result.content!==null&&typeof result.content!=='string')throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Assistant content must be text or null');
  const calls=result.tool_calls??[];
  if(calls.length>16||Buffer.byteLength(JSON.stringify(result))>524288)throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Completion exceeds the output budget');
  if((calls.length>0)!==(result.finish_reason==='tool_calls'))throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Tool calls and finish_reason disagree');
  if(request.tool_choice==='none'&&calls.length)throw new BridgeError('UPSTREAM_CONSTRAINT_VIOLATION',502,'Backend proposed a tool while tool_choice=none');
  const required=request.tool_choice==='required'||typeof request.tool_choice==='object';
  if(required&&!calls.length&&result.finish_reason!=='content_filter')throw new BridgeError('UPSTREAM_CONSTRAINT_VIOLATION',502,'Backend failed the requested tool constraint; no tools were executed');
  if(request.parallel_tool_calls===false&&calls.length>1)throw new BridgeError('UPSTREAM_CONSTRAINT_VIOLATION',502,'Backend returned multiple calls despite parallel_tool_calls=false');
  if(typeof request.tool_choice==='object'&&(calls.length!==1||calls[0]!.function.name!==request.tool_choice.function.name))throw new BridgeError('UPSTREAM_CONSTRAINT_VIOLATION',502,'Backend did not return the one specified function');
  const oldIds=new Set(request.messages.flatMap(m=>m.role==='assistant'?(m.tool_calls??[]).map(c=>c.id):[])),ids=new Set<string>();
  for(const [index,call] of calls.entries()){
    const parsed=ToolCallSchema.safeParse(call);if(!parsed.success)throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Invalid function-call structure');
    if(ids.has(call.id)||oldIds.has(call.id))throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Duplicate or replayed tool-call ID');ids.add(call.id);
    const definition=request.tools?.find(tool=>tool.function.name===call.function.name);
    if(!definition)throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Backend requested an unknown tool');
    const args=parseToolArguments(call.function.arguments,`tool_calls.${index}.arguments`);
    if(!schemaMatches(definition.function.parameters as JsonSchema,args))throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Tool arguments failed schema validation');
  }
  if(request.response_format?.type==='json_object'&&!calls.length&&result.finish_reason==='stop'){
    let value:unknown;try{value=JSON.parse(result.content??'');}catch{throw new BridgeError('UPSTREAM_CONSTRAINT_VIOLATION',502,'Backend did not return a JSON object');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw new BridgeError('UPSTREAM_CONSTRAINT_VIOLATION',502,'Backend did not return a JSON object');
  }
  if(result.usage)validateUsage(result.usage);
  return result;
}
export const GatewayConfigSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('disabled')}).strict(),
  z.object({type:z.literal('mock'),acknowledge_mock:z.literal(true),alias:z.string().regex(/^mock-[a-zA-Z0-9_-]{1,48}$/).default('mock-agent-local'),scenario:z.enum(['echo','tool_roundtrip']).default('echo'),tool_name:FunctionName.optional(),tool_arguments:z.record(z.string(),z.unknown()).optional()}).strict(),
  z.object({type:z.literal('approved_openai_api'),alias:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),model:z.string().min(1).max(128),base_url:z.string().url(),api_key_env:z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),authorization_reference:z.string().min(8).max(256),data_egress_approved:z.literal(true),allow_loopback_http:z.boolean().default(false),native_parameters:z.array(z.enum(['tools','tool_choice','parallel_tool_calls','temperature','top_p','max_tokens','max_completion_tokens','stop','response_format','response_format.json_object'])).max(10).default([])}).strict()
]);
export type GatewayConfig=z.infer<typeof GatewayConfigSchema>;
