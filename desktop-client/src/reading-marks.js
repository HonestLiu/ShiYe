import {locateArticleQuote,sourceIds} from './article-highlights.js';

export const isNote=a=>a.kind==='note'||!!a.note?.trim();
const sourceStyles=new WeakMap();
export function mappedRecord(doc,record,snapshot={}) {
 const A=globalThis.ShiyeAnchors,index=A.index(doc),source=new Set([...doc.querySelectorAll('mark[data-source-highlights]')].flatMap(n=>sourceIds(n.dataset.sourceHighlights)));
 return {...record,annotations:record.annotations.filter(a=>!(snapshot.sourceHighlights&&Object.hasOwn(snapshot.sourceHighlights,a.id)&&!source.has(a.id)&&!isNote(a))).map(a=>{
  if(A.locate(index,a.selector))return a;
  const found=locateArticleQuote({text:index.text},a.selector);if(!found)return a;
  return {...a,selector:{...a.selector,exact:index.text.slice(found.start,found.end),start:found.start,end:found.end,prefix:index.text.slice(Math.max(0,found.start-64),found.start),suffix:index.text.slice(found.end,found.end+64)}};
 })};
}
export function paintReadingMarks(doc,record,{visible=true,snapshot={}}={}) {
 const A=globalThis.ShiyeAnchors,M=globalThis.ShiyeReading,byId=new Map(record.annotations.map(a=>[a.id,a]));
 A.clear(doc);let originals=sourceStyles.get(doc);if(!originals){originals=new Map();sourceStyles.set(doc,originals);}
 for(const mark of doc.querySelectorAll('mark[data-source-highlights]')){
  if(!originals.has(mark))originals.set(mark,mark.getAttribute('style'));const style=originals.get(mark);if(style===null)mark.removeAttribute('style');else mark.setAttribute('style',style);
  const ids=sourceIds(mark.dataset.sourceHighlights),live=ids.map(id=>byId.get(id)).filter(Boolean),notes=live.filter(isNote),deleted=new Set((record.deleted||[]).map(a=>a.id));
  if(ids.length&&ids.every(id=>deleted.has(id))){mark.replaceWith(...mark.childNodes);continue;}
  if(!visible&&live.length)mark.style.setProperty('background-color','transparent','important');
  if(notes.length){mark.style.setProperty('color','inherit','important');const plain=live.filter(a=>!isNote(a)).sort((a,b)=>b.updatedAt-a.updatedAt);mark.style.setProperty('background-color',visible&&plain.length?M.colors[plain[0].color]:'transparent','important');}
 }
 const mapped=mappedRecord(doc,record,snapshot),result=A.paint(doc,mapped,{visible});
 for(const mark of doc.querySelectorAll('mark[data-shiye-highlight]')){
  const ids=mark.dataset.shiyeHighlight.split(' '),items=ids.map(id=>byId.get(id)).filter(Boolean),notes=items.filter(isNote).sort((a,b)=>b.updatedAt-a.updatedAt),plain=items.filter(a=>!isNote(a)).sort((a,b)=>b.updatedAt-a.updatedAt);
  if(notes.length){mark.dataset.readerNote=notes.map(a=>a.id).join(' ');mark.style.setProperty('background-color',plain.length?M.colors[plain[0].color]:'transparent','important');mark.style.setProperty('color','inherit','important');mark.style.setProperty('text-decoration-line','underline','important');mark.style.setProperty('text-decoration-color',M.underlineColors[notes[0].color],'important');mark.style.setProperty('text-decoration-thickness','3px','important');mark.style.setProperty('text-underline-offset','.22em','important');mark.style.setProperty('text-decoration-skip-ink','auto');mark.style.setProperty('cursor','pointer','important');mark.setAttribute('title','查看标注与笔记');}
 }
 return {...result,mapped};
}
export function readingMarksHTML(source,record,snapshot={}) {
 if(!record)return source;
 const doc=new DOMParser().parseFromString(globalThis.ShiyeAnchors.html(source,record),'text/html');paintReadingMarks(doc,record,{snapshot});return '<!doctype html>'+doc.documentElement.outerHTML;
}
