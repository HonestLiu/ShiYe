import {cleanSnapshot} from './reader.js';
export const highlightColors={yellow:'#ffe89a',green:'#bde8c7',blue:'#bcdcff',pink:'#f7c9da',purple:'#dfcafa'};
export const highlightNames={yellow:'黄色',green:'绿色',blue:'蓝色',pink:'粉色',purple:'紫色'};
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(id);
export const sourceIds=value=>typeof value==='string'?[...new Set(value.split(' ').filter(validId))].sort():[];
// Track highlight meaning, so a note-only revision cannot resurrect a cleared mark.
const stamp=a=>JSON.stringify([a.color,a.selector?.exact,a.selector?.prefix||'',a.selector?.suffix||'']);
function plan(record,ledger={},force=false){
 const annotations=(record?.annotations||[]).filter(a=>validId(a.id)&&Object.hasOwn(highlightColors,a.color)&&typeof a.selector?.exact==='string'&&a.selector.exact.trim()),byId=new Map(annotations.map(a=>[a.id,a]));
 const known=new Set([...byId.keys(),...(record?.deleted||[]).map(a=>a.id)]);ledger=Object.fromEntries(Object.entries(ledger||{}).filter(([id])=>known.has(id)));
 const pending=annotations.filter(a=>force||!Object.hasOwn(ledger||{},a.id)||ledger[a.id]!==stamp(a));
 const deleted=(record?.deleted||[]).filter(a=>validId(a.id)&&!byId.has(a.id)&&(force||ledger?.[a.id]!=='deleted:'+stamp(a)));
 return {byId,pending,deleted,remove:new Set([...pending,...deleted].map(a=>a.id)),ledger:{...ledger,...Object.fromEntries(deleted.map(a=>[a.id,'deleted:'+stamp(a)]))}};
}
function colorFor(ids,byId,fallback='yellow'){
 const found=ids.map(id=>byId.get(id)).filter(Boolean).sort((a,b)=>b.updatedAt-a.updatedAt||String(b.mutationId).localeCompare(String(a.mutationId))||a.id.localeCompare(b.id));
 return found[0]?.color||fallback;
}
const strip=s=>String(s||'').replace(/\s/g,'');
function suffixScore(a,b){let i=0;while(i<Math.min(a.length,b.length)&&a[a.length-1-i]===b[b.length-1-i])i++;return i;}
function prefixScore(a,b){let i=0;while(i<Math.min(a.length,b.length)&&a[i]===b[i])i++;return i;}
function normalized(index){
 if(index.normalized)return index.normalized;
 const offsets=new Uint32Array(index.text.length);let at=0;const parts=[];
 for(const match of index.text.matchAll(/\S+/g)){parts.push(match[0]);for(let i=0;i<match[0].length;i++)offsets[at++]=match.index+i;}
 return index.normalized={text:parts.join(''),offsets};
}
// Source offsets are not reused after extraction. Duplicate quotes need distinct context.
export function locateArticleQuote(index,selector){
 if(!selector?.exact?.trim())return null;
 const locate=(text,quote,map)=>{
  const hits=[];let at=-1;const prefix=strip(selector.prefix).slice(-100),suffix=strip(selector.suffix).slice(0,100);
  while((at=text.indexOf(quote,at+1))!==-1){const start=map?map[at]:at,end=map?map[at+quote.length-1]+1:at+quote.length;const before=strip(index.text.slice(Math.max(0,start-300),start)),after=strip(index.text.slice(end,end+300));hits.push({start,end,score:suffixScore(before,prefix)+prefixScore(after,suffix)});if(hits.length>500)return null;}
  hits.sort((a,b)=>b.score-a.score);if(!hits.length)return null;if(hits.length>1&&(hits[0].score===hits[1].score||hits[0].score<Math.max(1,Math.min(8,prefix.length+suffix.length))))return null;return hits[0];
 };
 const exact=locate(index.text,selector.exact);if(exact)return exact;
 // Whitespace-only differences include paragraph joins made by the article extractor.
 const quote=strip(selector.exact);if(quote.length<4)return null;const n=normalized(index);return locate(n.text,quote,n.offsets);
}
function chunksIn(index,range){return index.chunks.filter(c=>c.end>range.start&&c.start<range.end);}
function pmIndex(doc,type){
 const chunks=[],parts=[];let length=0;
 doc.descendants((node,pos,parent)=>{
  if(node.isText){const text=node.text;parts.push(text);chunks.push({start:length,end:length+text.length,pos,allowed:parent.type.allowsMarkType(type)});length+=text.length;}
  else if(node.isLeaf){const text=node.type.name==='hardBreak'?'\n':'\ufffc';parts.push(text);length+=text.length;}
 });return {text:parts.join(''),chunks};
}
export function applySourceHighlights(editor,record,ledger={},force=false,preserveLocal=true){
 const p=plan(record,ledger,force),type=editor.schema.marks.highlight;if(!type||!p.remove.size)return {ledger:p.ledger,changed:false,applied:0,missing:0};
 const tr=editor.state.tr,index=pmIndex(editor.state.doc,type);let applied=0,missing=0;
 // Remove only source-owned layers; manually recolored highlights have no source IDs.
 editor.state.doc.descendants((node,pos)=>{if(!node.isText)return;const mark=type.isInSet(node.marks);if(!mark)return;const ids=sourceIds(mark.attrs.sourceIds);if(!ids.some(id=>p.remove.has(id)))return;const keep=ids.filter(id=>!p.remove.has(id));tr.removeMark(pos,pos+node.nodeSize,type);if(keep.length)tr.addMark(pos,pos+node.nodeSize,type.create({color:colorFor(keep,p.byId,mark.attrs.color),sourceIds:keep.join(' ')}));});
 for(const a of p.pending){
  const match=locateArticleQuote(index,a.selector),chunks=match?chunksIn(index,match):[];
  if(!match||!chunks.length||chunks.some(c=>!c.allowed)){missing++;continue;}
  const ranges=chunks.map(c=>({from:c.pos+Math.max(0,match.start-c.start),to:c.pos+Math.min(c.end-c.start,match.end-c.start)}));
  p.ledger[a.id]=stamp(a);
  for(const r of ranges){const segments=[];tr.doc.nodesBetween(r.from,r.to,(n,pos)=>{if(!n.isText)return;const previous=type.isInSet(n.marks);if(preserveLocal&&previous&&!sourceIds(previous.attrs.sourceIds).length)return;const ids=[...new Set([...sourceIds(previous?.attrs.sourceIds),a.id])].sort();segments.push({from:Math.max(r.from,pos),to:Math.min(r.to,pos+n.nodeSize),ids});});for(const segment of segments)tr.addMark(segment.from,segment.to,type.create({color:colorFor(segment.ids,p.byId),sourceIds:segment.ids.join(' ')}));}
  applied++;
 }
 const changed=tr.docChanged||JSON.stringify(ledger||{})!==JSON.stringify(p.ledger);if(tr.docChanged)editor.view.dispatch(tr);
 return {ledger:p.ledger,changed,applied,missing};
}
const prepared=new WeakMap();
function domIndex(doc){
 const parts=[],chunks=[];let length=0;const opaque='iframe,pre,svg,math,[data-editor-protected]';
 const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode(node){if(node.nodeType===1){if(node.matches('script,style,template,[hidden],.sr-only')||node.parentElement?.closest(opaque))return NodeFilter.FILTER_REJECT;return node.matches(opaque)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP;}return node.parentElement?.closest(opaque)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
 while(walker.nextNode()){const node=walker.currentNode;if(node.nodeType!==3){parts.push('\ufffc');length++;continue;}parts.push(node.data);chunks.push({node,start:length,end:length+node.length});length+=node.length;}
 return {text:parts.join(''),chunks};
}
function decorate(mark,ids,byId){mark.dataset.articleHighlight=colorFor(ids,byId,mark.dataset.articleHighlight);mark.dataset.sourceHighlights=ids.join(' ');mark.style.backgroundColor=highlightColors[mark.dataset.articleHighlight];mark.style.color='#172b23';}
// Existing saved articles gain source highlights in reading/export without loading Tiptap.
export function withSourceHighlights(snapshot,record){
 if(!snapshot?.html||!record)return snapshot;const ledger=snapshot.sourceHighlights||{},p=plan(record,ledger);if(!p.remove.size)return snapshot;
 const key=JSON.stringify([...(record.annotations||[]).map(a=>[a.id,stamp(a)]),...(record.deleted||[]).map(a=>['deleted',a.id])]),cached=prepared.get(snapshot);if(cached?.key===key)return cached.value;
 const doc=new DOMParser().parseFromString(cleanSnapshot(snapshot.html),'text/html');
 for(const mark of [...doc.querySelectorAll('mark[data-source-highlights]')]){const ids=sourceIds(mark.dataset.sourceHighlights);if(!ids.some(id=>p.remove.has(id)))continue;const keep=ids.filter(id=>!p.remove.has(id));if(keep.length)decorate(mark,keep,p.byId);else mark.replaceWith(...mark.childNodes);}
 const index=domIndex(doc),parts=new Map();
 for(const a of p.pending){const range=locateArticleQuote(index,a.selector),chunks=range?chunksIn(index,range):[];if(!chunks.length)continue;
  p.ledger[a.id]=stamp(a);for(const c of chunks){if(c.node.parentElement.closest('mark[data-article-highlight]:not([data-source-highlights]),mark[data-source-highlights=""]'))continue;if(!parts.has(c.node))parts.set(c.node,[]);parts.get(c.node).push({start:Math.max(0,range.start-c.start),end:Math.min(c.node.length,range.end-c.start),id:a.id});}
 }
 for(const [node,list]of parts){const base=sourceIds(node.parentElement.closest('mark[data-source-highlights]')?.dataset.sourceHighlights),cuts=[...new Set([0,node.length,...list.flatMap(x=>[x.start,x.end])])].sort((a,b)=>a-b),frag=doc.createDocumentFragment();for(let i=0;i<cuts.length-1;i++){const start=cuts[i],end=cuts[i+1],ids=[...new Set([...base,...list.filter(x=>x.start<=start&&x.end>=end).map(x=>x.id)])].sort();const text=node.data.slice(start,end);if(!ids.length)frag.append(doc.createTextNode(text));else{const mark=doc.createElement('mark');decorate(mark,ids,p.byId);mark.textContent=text;frag.append(mark);}}node.replaceWith(frag);}
 const value={...snapshot,html:'<!doctype html>'+doc.documentElement.outerHTML,sourceHighlights:p.ledger};prepared.set(snapshot,{key,value});return value;
}
