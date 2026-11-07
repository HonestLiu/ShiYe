import DOMPurify from 'dompurify';
import {cleanSnapshot} from './reader.js';
import {highlightColors} from './article-highlights.js';
export const ARTICLE_STYLE='body{margin:0;padding:28px 24px;font:17px/1.9 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#253b33;background:#fffdf8}.shiye-article{max-width:760px;margin:auto}h1,h2,h3{line-height:1.5}p{margin:.9em 0}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf1e8;padding:16px;font:14px/1.7 ui-monospace,monospace}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #cbd5ca;padding:8px 12px;vertical-align:top}blockquote{border-left:3px solid #9db79e;margin:20px 0;padding-left:16px}figure{margin:18px 0}iframe[data-shiye-frame]{border:0;max-width:100%}mark[data-article-highlight]{color:inherit;box-decoration-break:clone;-webkit-box-decoration-break:clone;-webkit-print-color-adjust:exact;print-color-adjust:exact}';
const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);};
export const encodeHTML=html=>b64(new TextEncoder().encode(html));
export function decodeHTML(data){return new TextDecoder().decode(Uint8Array.from(atob(data),c=>c.charCodeAt(0)));}
export async function importArticle(html,assets,progress=()=>{}){
 const doc=new DOMParser().parseFromString(html,'text/html'),body=doc.querySelector('.shiye-article>article')||doc.body,title=doc.querySelector('.shiye-article>header h1');
 const content=doc.createElement('div');if(title)content.append(title.cloneNode(true));content.append(...[...body.childNodes].map(n=>n.cloneNode(true)));
 for(const node of content.querySelectorAll('*'))for(const key of ['data-editor-protected','data-asset','data-label','data-height','data-source-highlights'])node.removeAttribute(key);
 content.querySelectorAll('script,style,link,meta,form,input,button,textarea,select,[data-shiye-note-appendix]').forEach(n=>n.remove());const fonts=[...doc.querySelectorAll('style')].flatMap(n=>n.textContent.match(/@font-face\s*\{[^}]*\}/gi)||[]).join('\n');
 const roots=[...content.querySelectorAll('.katex,math,svg,[data-d-component="row"],[data-d-component="box"][data-d-has-border]')].filter(n=>!n.parentElement?.closest('.katex,math,svg,[data-d-component="row"],[data-d-component="box"][data-d-has-border]'));
 for(const [index,node]of roots.entries()){
  const inline=!!node.closest('p,h1,h2,h3,h4,h5,h6,li')&&(node.matches('.katex,math')||node.getAttribute('display')==='inline');const label=node.matches('.katex,math')?'公式':'图表';
  const source=cleanSnapshot('<!doctype html><style>'+fonts+'body{margin:0;width:max-content;max-width:1200px;font:17px/1.9 sans-serif}</style>'+node.outerHTML);
  const asset=await assets.put('protected','text/html',encodeHTML(source));const placeholder=doc.createElement(inline?'span':'div');placeholder.dataset.editorProtected=inline?'inline':'block';placeholder.dataset.asset=asset.id;placeholder.dataset.label=label;placeholder.dataset.height=String(inline?48:240);node.replaceWith(placeholder);progress('保留'+label+' '+(index+1));
 }
 let missing=0;for(const [index,img]of [...content.querySelectorAll('img')].entries()){
  const src=img.getAttribute('src')||'',match=/^data:(image\/(?:png|jpeg|gif|webp|avif|svg\+xml));(?:charset=[\w-]+;)?base64,([a-z\d+/=]+)$/i.exec(src);
  if(!match){const text=doc.createElement('span');text.textContent=img.alt?'[图片：'+img.alt+']':'[此图片未离线保存]';img.replaceWith(text);missing++;continue;}
  const asset=await assets.put('image',match[1].toLowerCase(),match[2]);img.src='shiye-image:'+asset.id;const width=Number(img.getAttribute('data-snapshot-width')||img.getAttribute('width'));if(width>0)img.setAttribute('width',String(Math.min(1600,width)));img.removeAttribute('height');img.removeAttribute('style');progress('整理离线图片 '+(index+1));
 }
 for(const mark of content.querySelectorAll('mark')){const value=mark.dataset.articleHighlight||mark.style.backgroundColor||'';const color=Object.keys(highlightColors).find(key=>value===key||value.toLowerCase()===highlightColors[key]||value===('rgb('+highlightColors[key].slice(1).match(/../g).map(v=>parseInt(v,16)).join(', ')+')'));mark.dataset.articleHighlight=color||'yellow';}
 for(const n of content.querySelectorAll('*'))if(!n.hasAttribute('data-editor-protected')){n.removeAttribute('style');if(n.matches('a')){const href=n.getAttribute('href')||'';if(!/^(https?:\/\/|mailto:|#)/.test(href))n.removeAttribute('href');}}
 return {html:DOMPurify.sanitize(content.innerHTML,{FORBID_TAGS:['script','style','iframe','object','embed','form','input','textarea','select','svg','math'],ALLOWED_URI_REGEXP:/^(?:(?:https?|mailto):|#|shiye-image:[a-f0-9]{64}$)/i,ADD_ATTR:['data-editor-protected','data-asset','data-label','data-height','data-source-highlights']}),warnings:[...(roots.length?['公式与图表作为保留内容块，可移动、删除或替换。']:[]),...(missing?[missing+' 张未离线保存的图片已保留文字提示。']:[])]};
}
export function editorDocument(editor,sourceHighlights={}){return {schemaVersion:1,sourceHighlights,content:editor.getJSON(),text:editor.getText(),htmlTemplate:'<!doctype html><meta charset="utf-8"><style>'+ARTICLE_STYLE+'</style><main class="shiye-article">'+editor.getHTML()+'</main>'};}
