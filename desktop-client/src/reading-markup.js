// Reading-only resources. Exports always use the untouched, self-contained source.
const activeImages=new Set(),entries=new Map(),MAX_BYTES=64*1024*1024;let bytes=0;
const yieldTask=()=>globalThis.scheduler?.yield?.()||new Promise(resolve=>setTimeout(resolve,0));
function release(entry){if(entry.revoked)return;entry.revoked=true;bytes-=entry.bytes;for(const url of entry.urls){activeImages.delete(url);URL.revokeObjectURL(url);}}
function trim(){for(const [snapshot,entry]of entries){if(bytes<=MAX_BYTES&&entries.size<=4||entries.size<=1)break;if(!entry.users){entries.delete(snapshot);release(entry);}}}
export function evictReadingMarkup(snapshot){const entry=entries.get(snapshot);if(entry){entry.discard=true;if(!entry.users){entries.delete(snapshot);release(entry);}}}
export async function acquireReadingMarkup(snapshot,clean,cancelled=()=>false){
 const start=performance.now(),measure=()=>{performance.clearMeasures('reader:markup');performance.measure('reader:markup',{start,end:performance.now()});};
 let entry=entries.get(snapshot);if(entry&&entry.source===snapshot.html){entries.delete(snapshot);entries.set(snapshot,entry);entry.users++;measure();return lease(entry);}
 if(entry){entry.discard=true;if(!entry.users){entries.delete(snapshot);release(entry);}}
 const source=snapshot.html,urls=[],tokens=new Map(),assets=new Map();let resourceBytes=0;
 const check=()=>{if(cancelled())throw new DOMException('阅读已切换','AbortError');};
 try{
  check();let input=source;
  if(source.length>512*1024&&source.includes('data:image')){
   const doc=new DOMParser().parseFromString(source,'text/html');doc.querySelectorAll('template[data-shiye-reading-versions]').forEach(n=>n.remove());
   function image(uri){if(uri.length<4096)return uri;if(assets.has(uri))return assets.get(uri);const match=/^data:(image\/(?:png|jpeg|jpg|gif|webp|avif|svg\+xml|x-icon));(?:charset=[\w-]+;)?base64,([a-z\d+/=]+)(#[^\s]*)?$/i.exec(uri);if(!match)return uri;
    try{const data=typeof Uint8Array.fromBase64==='function'?Uint8Array.fromBase64(match[2]):Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([data],{type:match[1]}));urls.push(url);activeImages.add(url);resourceBytes+=data.byteLength;const token='data:image/png;base64,AA==#shiye-'+crypto.randomUUID();tokens.set(token,url+(match[3]||''));assets.set(uri,token);return token;}catch{return uri;}
   }
   let batch=0;for(const node of doc.querySelectorAll('img[src],video[poster]')){check();const key=node.matches('img')?'src':'poster';node.setAttribute(key,image(node.getAttribute(key)));if(++batch%4===0)await yieldTask();}
   const css=text=>text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,(whole,a,b,c)=>{const uri=(a??b??c??'').trim(),next=image(uri);return next===uri?whole:'url("'+next+'")';});
   for(const node of doc.querySelectorAll('[style],style')){check();if(node.matches('style'))node.textContent=css(node.textContent);else if(node.getAttribute('style').includes('data:image'))node.setAttribute('style',css(node.getAttribute('style')));if(++batch%100===0)await yieldTask();}
   input=doc.documentElement.outerHTML;assets.clear();
  }
  check();await yieldTask();check();let html=clean(input,false,0,{frames:0,readingBlobs:tokens.size>0});check();
  if(tokens.size){for(const [token,url]of tokens)html=html.replaceAll(token,url);}
  entry={source,html,urls,bytes:resourceBytes+html.length*2,users:1};entries.set(snapshot,entry);bytes+=entry.bytes;trim();measure();return lease(entry);
 }catch(error){for(const url of urls){activeImages.delete(url);URL.revokeObjectURL(url);}throw error;}
 function lease(value){let released=false;return {html:value.html,release(){if(released)return;released=true;value.users--;if(!value.users&&value.discard){if(entries.get(snapshot)===value)entries.delete(snapshot);release(value);}trim();}};}
}

// Media previews may reuse only our own active image URLs. Keep exports separate.
export function cleanReadingMedia(html,clean){
 const tokens=new Map();for(const url of activeImages)if(html.includes(url)){const token='data:image/png;base64,AA==#shiye-'+crypto.randomUUID();html=html.replaceAll(url,token);tokens.set(token,url);}
 html=clean(html,false,0,{frames:0,readingBlobs:tokens.size>0});for(const [token,url]of tokens)html=html.replaceAll(token,url);return html;
}
