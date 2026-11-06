import {evictReadingMarkup} from './reading-markup.js';
// At most three recent archives, with an approximate 192 MiB string budget.
export function createArchiveCache(){
 const entries=new Map(),pending=new Map();let bytes=0,generation=0,queue=Promise.resolve();
 const size=a=>2*((a.snapshot?.html?.length||0)+(a.articleSnapshot?.html?.length||0)+JSON.stringify(a.reading||{}).length);
 function drop(id){const a=entries.get(id);if(!a)return;entries.delete(id);bytes-=a.bytes;evictReadingMarkup(a.value.snapshot);if(a.value.articleSnapshot)evictReadingMarkup(a.value.articleSnapshot);}
 return {async load(id,fetch,wanted=()=>true){
  if(entries.has(id)){const a=entries.get(id);entries.delete(id);entries.set(id,a);return a.value;}
  if(pending.has(id)){const job=pending.get(id);job.wanted.add(wanted);return job.promise;}
  const epoch=generation,job={wanted:new Set([wanted])};
  job.promise=queue.then(async()=>{if(![...job.wanted].some(check=>check()))throw new DOMException('已切换收藏','AbortError');const value=await fetch();if(epoch===generation){drop(id);const entry={value,bytes:size(value)};entries.set(id,entry);bytes+=entry.bytes;while(entries.size>3||bytes>192*1024*1024&&entries.size>1)drop(entries.keys().next().value);}return value;}).finally(()=>{if(pending.get(id)===job)pending.delete(id);});
  pending.set(id,job);queue=job.promise.then(()=>{},()=>{});return job.promise;
 },retain(ids){for(const id of [...entries.keys()])if(!ids.has(id))drop(id);},invalidate(){generation++;pending.clear();for(const id of [...entries.keys()])drop(id);}};
}
