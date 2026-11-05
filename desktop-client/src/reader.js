import DOMPurify from 'dompurify';
import {preparePagination} from '../../local-pdf-server/pdf-pagination.mjs';
const CSP="default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function cleanSnapshot(html){
 const safe=DOMPurify.sanitize(String(html),{WHOLE_DOCUMENT:true,ADD_TAGS:['style'],FORBID_TAGS:['script','iframe','object','embed','form','input','button','textarea','select','base','link','meta'],FORBID_ATTR:['srcdoc','autofocus','contenteditable']});
 const doc=new DOMParser().parseFromString(safe,'text/html');
 for(const node of doc.querySelectorAll('[href]'))if(!node.getAttribute('href').startsWith('#'))node.removeAttribute('href');
 for(const node of doc.querySelectorAll('[src]'))if(!node.getAttribute('src').startsWith('data:'))node.removeAttribute('src');
 const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content=CSP;doc.head.prepend(policy);
 const viewport=doc.createElement('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';doc.head.append(viewport);
 const headings=[...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],[data-d-component=title]')].filter(n=>!n.closest('pre,code,[hidden],.sr-only,[aria-hidden=true]'));
 for(let i=0;i<headings.length;i++)headings[i].id='reader-heading-'+i;
 return '<!doctype html>'+doc.documentElement.outerHTML;
}
export function mountReader(frame,archive,onProgress,onToc){
 let disposed=false,timer;
 frame.onload=()=>{
  if(disposed)return;
  const doc=frame.contentDocument,win=frame.contentWindow;if(!doc)return;
  const headings=[...doc.querySelectorAll('[id^="reader-heading-"]')].filter(n=>win.getComputedStyle(n).display!=='none');
  onToc(headings.map(n=>({id:n.id,text:n.textContent.trim(),level:Number(n.tagName.slice(1))||Number(n.getAttribute('aria-level'))||2})));
  win.addEventListener('scroll',()=>{clearTimeout(timer);timer=setTimeout(()=>{if(disposed)return;const max=doc.documentElement.scrollHeight-win.innerHeight;onProgress(max>0?win.scrollY/max:0);},600);},{passive:true});
  const max=doc.documentElement.scrollHeight-win.innerHeight;win.scrollTo(0,max*(archive.progress||0));
  doc.addEventListener('click',event=>{const a=event.target.closest('a');if(a?.hash){event.preventDefault();doc.getElementById(a.hash.slice(1))?.scrollIntoView();}});
 };
 frame.srcdoc=cleanSnapshot(archive.snapshot.html);
 return ()=>{disposed=true;clearTimeout(timer);frame.onload=null;};
}
export async function printDocument(archive){
 const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-same-origin');frame.style.cssText='position:fixed;left:-20000px;top:0;width:900px;height:1000px;border:0';
 const loaded=new Promise((resolve,reject)=>{frame.onload=resolve;frame.onerror=()=>reject(Error('网页加载失败'));});
 frame.srcdoc=cleanSnapshot(archive.snapshot.html);document.body.append(frame);
 try{await loaded;const doc=frame.contentDocument;await Promise.race([doc.fonts.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('字体加载超时')),15000))]);
 const width=Math.ceil(doc.documentElement.scrollWidth);
 preparePagination({pageHeight:width*769.89/523.28,document:doc});
 const style=doc.createElement('style');style.textContent='@page{size:A4;margin:12.7mm}html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}';doc.head.append(style);
 const height=Math.ceil(Math.max(doc.documentElement.scrollHeight,doc.body.scrollHeight));
 const pageHeight=width*769.89/523.28;
 const protectedRects=[...doc.querySelectorAll('[data-local-pdf-figure],img,svg,tr')].filter(n=>!n.parentElement?.closest('[data-local-pdf-figure]')).map(n=>n.getBoundingClientRect());
 const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT);
 while(walker.nextNode()){
   const node=walker.currentNode;if(!node.textContent.trim()||node.parentElement.closest('style,script'))continue;
   const range=doc.createRange();range.selectNodeContents(node);protectedRects.push(...range.getClientRects());
 }
 const cuts=[0];let start=0;
 while(start<height){
   let end=Math.min(height,start+pageHeight);
   for(let pass=0;pass<100;pass++){
     const intersect=protectedRects.filter(r=>r.top>start+.5&&r.top<end-.2&&r.bottom>end+.2);
     if(!intersect.length)break;
     const previous=end;end=Math.min(...intersect.map(r=>r.top));if(previous-end<.1)break;
   }
   if(end<=start+.5)throw Error('无法为此内容计算安全分页');
   cuts.push(end);start=end;if(cuts.length>1000)throw Error('PDF页数过多');
 }
 return {html:'<!doctype html>'+doc.documentElement.outerHTML,layout:{width,height,cuts}};
 }finally{frame.remove();}
}
