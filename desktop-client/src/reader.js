import {normalizePdfOptions,paperGeometry} from './pdf-options.js';
import DOMPurify from 'dompurify';
import {preparePagination} from '../../local-pdf-server/pdf-pagination.mjs';
const CSP="default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function cleanSnapshot(html,allowLinks=false){
 const safe=DOMPurify.sanitize(String(html),{WHOLE_DOCUMENT:true,ADD_TAGS:['style'],FORBID_TAGS:['script','iframe','object','embed','form','input','button','textarea','select','base','link','meta'],FORBID_ATTR:['srcdoc','autofocus','contenteditable']});
 const doc=new DOMParser().parseFromString(safe,'text/html');
 for(const node of doc.querySelectorAll('[href]'))if(!node.getAttribute('href').startsWith('#')){try{const u=new URL(node.getAttribute('href'));if(!allowLinks||!['http:','https:'].includes(u.protocol)||u.username||u.password)node.removeAttribute('href');}catch{node.removeAttribute('href');}}
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
export async function printDocument(archive,settings={}){
 const options=normalizePdfOptions(settings),paper=paperGeometry(options);
 const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-same-origin');frame.style.cssText='position:fixed;left:-20000px;top:0;width:900px;height:1px;border:0';
 const loaded=new Promise((resolve,reject)=>{frame.onload=resolve;frame.onerror=()=>reject(Error('网页加载失败'));});
 frame.srcdoc=cleanSnapshot(archive.snapshot.html,true);document.body.append(frame);
 try{
  await loaded;const doc=frame.contentDocument,win=frame.contentWindow;
  await Promise.race([doc.fonts.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('字体加载超时')),15000))]);
  doc.documentElement.lang=options.lang;
  const source=doc.createElement('main');source.className='reader-print-content';source.append(...doc.body.childNodes);doc.body.append(source);
  const graphicRoots=[...source.querySelectorAll('[data-d-component="row"][data-d-has-height],svg,img,canvas')].map(n=>n.closest('[data-d-component="box"][data-d-has-border]')||n);
  const protectedNode=n=>n.closest('.katex,math')||graphicRoots.some(g=>g===n||g.contains(n));
  // Change prose typography without changing formula metrics or chart geometry.
  const metrics=new Map([...source.querySelectorAll('*')].map(n=>{const c=win.getComputedStyle(n);return [n,{size:parseFloat(c.fontSize),line:parseFloat(c.lineHeight)}];}));
  for(const n of source.querySelectorAll('*')){
   if(n.namespaceURI!=='http://www.w3.org/1999/xhtml'||protectedNode(n))continue;
   const computed=win.getComputedStyle(n);
   if(options.fontSize!==100){const {size,line}=metrics.get(n);if(size)n.style.setProperty('font-size',size*options.fontSize/100+'px','important');if(line)n.style.setProperty('line-height',line*options.fontSize/100+'px','important');}
   if(options.fontFamily!=='default'&&!n.closest('pre,code'))n.style.setProperty('font-family',options.fontFamily==='serif'?'"Songti SC", "Noto Serif CJK SC", serif':'"SFMono-Regular", Menlo, monospace','important');
  }
  const neutral=color=>{const c=color.match(/[\d.]+/g)?.map(Number);return c&&c.length>=3&&(c.length<4||c[3]>.01)&&Math.max(...c.slice(0,3))-Math.min(...c.slice(0,3))<28;};
  for(const root of graphicRoots)root.style.setProperty('color',win.getComputedStyle(root).color,'important');
  if(options.fontSize!==100)for(const root of source.querySelectorAll('.katex,math'))if(!root.parentElement.closest('.katex,math'))root.style.setProperty('zoom',String((parseFloat(win.getComputedStyle(root).zoom)||1)*options.fontSize/100),'important');
  const background=options.darkMode?'#202524':'#ffffff',foreground=options.darkMode?'#e8ecea':'#222827';
  for(const n of [doc.documentElement,doc.body,source,...source.querySelectorAll('*')]){
   if(n.namespaceURI!=='http://www.w3.org/1999/xhtml'||protectedNode(n))continue;
   const c=win.getComputedStyle(n);
   if(neutral(c.backgroundColor))n.style.setProperty('background-color',background,'important');
   if(neutral(c.color))n.style.setProperty('color',foreground,'important');
  }
  doc.body.style.setProperty('background',background,'important');doc.body.style.setProperty('color',foreground,'important');
  const title=options.contentTitle||archive.library?.title||archive.title||'收藏';
  const header=doc.createElement('header');header.className='reader-print-header';const titleNode=doc.createElement('h1');titleNode.textContent=title;titleNode.style.fontSize=26*options.fontSize/100+'px';header.append(titleNode);
  if(options.includeConvoLink&&/^https?:\/\//.test(archive.url||'')){const a=doc.createElement('a');a.href=archive.url;a.textContent=archive.url;header.append(a);}
  doc.body.insertBefore(header,source);
  const sections=[...source.querySelectorAll('.pdf-message')];
  for(let index=0;index<sections.length;index++){
   const message=archive.messages?.[index];if(!message)continue;
   const pieces=[];
   if(options.includeModelName&&message.model)pieces.push('模型：'+message.model);
   if(options.includePerMsgTime&&message.createTime){const d=new Date(typeof message.createTime==='number'?message.createTime*1000:message.createTime);if(!Number.isNaN(d.valueOf()))pieces.push(d.toLocaleString(options.lang));}
   if(pieces.length){const metadata=doc.createElement('p');metadata.className='reader-print-meta';metadata.textContent=pieces.join('　');sections[index].prepend(metadata);}
  }
  const style=doc.createElement('style');style.textContent=`html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact;height:auto!important;max-height:none!important} .reader-print-header{padding:18px 0 24px;font:16px/1.7 system-ui;overflow-wrap:anywhere}.reader-print-header h1{font-size:26px;margin:0 0 10px}.reader-print-header a{font-size:12px;color:inherit}.reader-print-meta{font:12px/1.8 system-ui!important;opacity:.75;margin:0 0 12px}.reader-print-toc{font:14px/1.8 system-ui;padding:0 0 24px}.reader-print-toc h2{font-size:22px}.reader-print-toc a{display:flex;gap:12px;color:inherit;text-decoration:none;padding:6px 0}.reader-print-toc span:first-child{flex:1}.reader-print-toc .page{width:42px;flex:none;text-align:right}`;doc.head.append(style);
  const width=Math.ceil(doc.documentElement.scrollWidth),pageHeight=width*paper.contentHeight/paper.contentWidth;
  preparePagination({pageHeight,document:doc});
  const headingNodes=[...source.querySelectorAll('[id^="reader-heading-"]')].filter(n=>win.getComputedStyle(n).display!=='none'&&n.getBoundingClientRect().height);
  const level=n=>Number(n.tagName.slice(1))||Number(n.getAttribute('aria-level'))||({xl:1,lg:2,md:3,sm:4,xs:5}[n.dataset.dSize])||2;
  let toc=null;
  if(options.toc){toc=doc.createElement('nav');toc.className='reader-print-toc';const h=doc.createElement('h2');h.textContent='目录';toc.append(h);for(const node of headingNodes){const a=doc.createElement('a');a.href='#'+node.id;a.style.paddingLeft=Math.max(0,level(node)-1)*16+'px';const text=doc.createElement('span');text.textContent=node.textContent.trim();const number=doc.createElement('span');number.className='page';a.append(text,number);toc.append(a);}if(!headingNodes.length){const p=doc.createElement('p');p.textContent='此内容没有标题';toc.append(p);}doc.body.insertBefore(toc,source);}
  const height=Math.ceil(Math.max(doc.documentElement.scrollHeight,doc.body.scrollHeight));
  const protectedRects=[...doc.querySelectorAll('[data-local-pdf-figure],img,svg,tr')].filter(n=>!n.parentElement?.closest('[data-local-pdf-figure]')).map(n=>n.getBoundingClientRect());
  const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){const node=walker.currentNode;if(!node.textContent.trim()||node.parentElement.closest('style,script'))continue;const range=doc.createRange();range.selectNodeContents(node);protectedRects.push(...range.getClientRects());}
  const forced=[];if(toc)forced.push(source.getBoundingClientRect().top);
  if(options.pageBreakPerPrompt)for(const [index,section]of sections.entries())if(index>0&&section.dataset.role==='user')forced.push(section.getBoundingClientRect().top);
  const cuts=[0];let start=0;
  while(start<height){let end=Math.min(height,start+pageHeight);const next=forced.filter(y=>y>start+.5&&y<end-.1);if(next.length)end=Math.min(...next);
   for(let pass=0;pass<100;pass++){const intersect=protectedRects.filter(r=>r.top>start+.5&&r.top<end-.2&&r.bottom>end+.2);if(!intersect.length)break;const previous=end;end=Math.min(...intersect.map(r=>r.top));if(previous-end<.1)break;}
   if(end<=start+.5)throw Error('无法为此内容计算安全分页');cuts.push(end);start=end;if(cuts.length>1000)throw Error('PDF页数过多');
  }
  const pageFor=y=>Math.max(0,cuts.findIndex((cut,i)=>i<cuts.length-1&&y<cuts[i+1]-.1));
  const headings=headingNodes.map(n=>({id:n.id,text:n.textContent.trim(),level:level(n),y:n.getBoundingClientRect().top}));
  if(toc)for(const a of toc.querySelectorAll('a'))a.querySelector('.page').textContent=String(pageFor(doc.getElementById(a.hash.slice(1)).getBoundingClientRect().top)+1);
  const links=[];for(const a of doc.querySelectorAll('a[href]')){const href=a.getAttribute('href');const target=href.startsWith('#')?doc.getElementById(href.slice(1)):null;if(!target&&!/^https?:\/\//.test(href))continue;for(const r of a.getClientRects())if(r.width&&r.height)links.push({x:r.left,y:r.top,width:r.width,height:r.height,...(target?{targetY:target.getBoundingClientRect().top}:{url:href})});}
  return {html:'<!doctype html>'+doc.documentElement.outerHTML,layout:{width,height,cuts,paper,options,title,headings,links}};
 }finally{frame.remove();}
}
