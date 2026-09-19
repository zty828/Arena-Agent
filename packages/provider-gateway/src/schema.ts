import { BridgeError } from '../../contracts/src/index.js';

export type JsonSchema = Record<string, unknown>;
const KEYS=new Set(['type','properties','required','additionalProperties','items','enum','const','description','title','minLength','maxLength','minimum','maximum','minItems','maxItems']);
const TYPES=new Set(['object','array','string','number','integer','boolean','null']);
const plain=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function invalid(param:string,message:string):never{throw new BridgeError('UNSUPPORTED_PARAMETER',422,message,{param});}

/** Deliberately bounded JSON Schema subset. Unknown keywords are rejected, not ignored. */
export function validateSchema(schema:unknown,param:string,depth=0,budget={nodes:0}):asserts schema is JsonSchema{
  if(!plain(schema)||depth>8||++budget.nodes>256)invalid(param,'Tool schema must be a bounded JSON Schema object');
  for(const key of Object.keys(schema))if(!KEYS.has(key))invalid(`${param}.${key}`,'This JSON Schema keyword is not supported by the gateway validator');
  if(schema.type!==undefined){
    const types=Array.isArray(schema.type)?schema.type:[schema.type];
    if(!types.length||types.length>7||types.some(t=>typeof t!=='string'||!TYPES.has(t)))invalid(`${param}.type`,'Unsupported schema type');
  }
  if(schema.properties!==undefined){
    if(!plain(schema.properties)||Object.keys(schema.properties).length>64)invalid(`${param}.properties`,'Invalid or oversized schema properties');
    for(const [key,value] of Object.entries(schema.properties)){if(key.length>128||['__proto__','prototype','constructor'].includes(key))invalid(param,'Reserved schema property');validateSchema(value,`${param}.properties.${key}`,depth+1,budget);}
  }
  if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.length>64||schema.required.some(v=>typeof v!=='string')||new Set(schema.required).size!==schema.required.length))invalid(`${param}.required`,'required must be a bounded unique string array');
  if(schema.additionalProperties!==undefined&&typeof schema.additionalProperties!=='boolean')invalid(`${param}.additionalProperties`,'Only boolean additionalProperties is supported');
  if(schema.items!==undefined)validateSchema(schema.items,`${param}.items`,depth+1,budget);
  if(schema.enum!==undefined&&(!Array.isArray(schema.enum)||!schema.enum.length||schema.enum.length>128||schema.enum.some(v=>v!==null&&typeof v==='object')))invalid(`${param}.enum`,'Only bounded primitive enum values are supported');
  if(Object.hasOwn(schema,'const')&&schema.const!==null&&typeof schema.const==='object')invalid(`${param}.const`,'Only primitive const is supported');
  for(const key of ['description','title'])if(schema[key]!==undefined&&(typeof schema[key]!=='string'||schema[key].length>8192))invalid(`${param}.${key}`,'Schema annotation exceeds limits');
  for(const key of ['minLength','maxLength','minItems','maxItems'])if(schema[key]!==undefined&&(!Number.isSafeInteger(schema[key])||Number(schema[key])<0||Number(schema[key])>1000000))invalid(`${param}.${key}`,'Invalid schema size bound');
  for(const key of ['minimum','maximum'])if(schema[key]!==undefined&&(typeof schema[key]!=='number'||!Number.isFinite(schema[key])))invalid(`${param}.${key}`,'Invalid numeric bound');
  for(const [low,high] of [['minLength','maxLength'],['minItems','maxItems'],['minimum','maximum']] as const)if(typeof schema[low]==='number'&&typeof schema[high]==='number'&&Number(schema[low])>Number(schema[high]))invalid(param,'Contradictory schema bounds');
}
function matchesType(value:unknown,type:string):boolean{
  if(type==='null')return value===null;
  if(type==='object')return plain(value);
  if(type==='array')return Array.isArray(value);
  if(type==='integer')return typeof value==='number'&&Number.isSafeInteger(value);
  if(type==='number')return typeof value==='number'&&Number.isFinite(value);
  return typeof value===type;
}
export function schemaMatches(schema:JsonSchema,value:unknown,depth=0,budget={nodes:0}):boolean{
  if(depth>16||++budget.nodes>4096)return false;
  const types=schema.type===undefined?[]:Array.isArray(schema.type)?schema.type:[schema.type];
  if(types.length&&!types.some(t=>matchesType(value,String(t))))return false;
  if(Array.isArray(schema.enum)&&!schema.enum.some(v=>Object.is(v,value)))return false;
  if(Object.hasOwn(schema,'const')&&!Object.is(schema.const,value))return false;
  if(typeof value==='string'){
    const size=Array.from(value).length;
    if(typeof schema.minLength==='number'&&size<schema.minLength)return false;
    if(typeof schema.maxLength==='number'&&size>schema.maxLength)return false;
  }
  if(typeof value==='number'){
    if(typeof schema.minimum==='number'&&value<schema.minimum)return false;
    if(typeof schema.maximum==='number'&&value>schema.maximum)return false;
  }
  if(Array.isArray(value)){
    if(typeof schema.minItems==='number'&&value.length<schema.minItems)return false;
    if(typeof schema.maxItems==='number'&&value.length>schema.maxItems)return false;
    if(plain(schema.items)&&!value.every(item=>schemaMatches(schema.items as JsonSchema,item,depth+1,budget)))return false;
  }
  if(plain(value)){
    const properties=plain(schema.properties)?schema.properties:{};
    if(Array.isArray(schema.required)&&schema.required.some(key=>!Object.hasOwn(value,String(key))))return false;
    for(const [key,item] of Object.entries(value)){
      if(['__proto__','prototype','constructor'].includes(key))return false;
      if(Object.hasOwn(properties,key)){if(!schemaMatches(properties[key] as JsonSchema,item,depth+1,budget))return false;}
      else if(schema.additionalProperties===false)return false;
    }
  }
  return true;
}
export function parseToolArguments(value:string,param:string):Record<string,unknown>{
  if(Buffer.byteLength(value)>65536)throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Tool arguments exceed the validation budget',{param});
  let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Tool arguments are not complete valid JSON',{param});}
  if(!plain(parsed))throw new BridgeError('UPSTREAM_INVALID_RESPONSE',502,'Function arguments must be a JSON object',{param});
  return parsed;
}
