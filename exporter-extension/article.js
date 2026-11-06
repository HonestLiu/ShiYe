// Readability is vendored from SiYuan Chrome; extraction stays entirely local.
// SiYuan's Zhihu cleanup below is adapted under MulanPSL-2.0 (see vendor notice).
import {SNAPSHOT_CSP} from './mhtml.js';
export function extractArticle(snapshot,metadata){
 const doc=new DOMParser().parseFromString(snapshot.html,'text/html');
 doc.querySelectorAll('nav,aside,[role=navigation],[role=banner],[data-shiye-page-ui],[data-shiye-reading-ui],script').forEach(n=>n.remove());
 const host=new URL(metadata.url).hostname;
 if(host==='zhihu.com'||host.endsWith('.zhihu.com')){
  doc.querySelectorAll('.HotSearchCard').forEach(n=>n.remove());
  for(const link of doc.querySelectorAll('a.RichContent-EntityWord')){link.querySelectorAll('svg,img').forEach(n=>n.remove());link.replaceWith(...link.childNodes);}
 }
 const fontFaces=[...doc.querySelectorAll('style')].flatMap(n=>n.textContent.match(/@font-face\s*\{[^}]*\}/gi)||[]).join('\n');
 doc.querySelectorAll('style,link,meta,button,input,select,textarea,form').forEach(n=>{if(n.matches('form'))n.replaceWith(...n.childNodes);else n.remove();});
 const protectedSelector='.katex,math,svg,[data-d-component="row"],[data-d-component="box"][data-d-has-border]';
 for(const n of doc.body.querySelectorAll('*')){
  if(!n.closest(protectedSelector))n.removeAttribute('style');
  if(n.classList?.contains('hljs-comment')){n.classList.remove('hljs-comment');n.classList.add('hljs-cmt');}
  if(n.matches('img')){const w=Number(n.getAttribute('data-snapshot-width')),h=Number(n.getAttribute('data-snapshot-height'));if(w>0&&h>0&&w<=64&&h<=64)n.style.cssText=`width:${w}px;height:${h}px;display:inline-block;vertical-align:middle`;else{n.removeAttribute('width');n.removeAttribute('height');n.style.cssText='max-width:100%;height:auto';}}
 }
 const article=new globalThis.Readability(doc,{keepClasses:true,charThreshold:120,maxElemsToParse:60000}).parse();
 if(!article?.content||article.textContent.trim().length<80)throw Error('未能识别足够的文章正文，原貌快照仍可阅读。');
 const firstHeading=new DOMParser().parseFromString(article.content,'text/html').querySelector('h1,h2');const headingTitle=firstHeading?.textContent.trim();if(headingTitle?.length>=6&&(article.title||metadata.title||'').includes(headingTitle))article.title=headingTitle;
 const clean=globalThis.DOMPurify.sanitize(article.content,{ADD_TAGS:['math'],FORBID_TAGS:['script','form','input','button','iframe','object','embed','link','meta'],FORBID_ATTR:['autofocus','contenteditable']});
 const out=document.implementation.createHTMLDocument(article.title||metadata.title||'文章');out.documentElement.lang=article.lang||'zh-CN';out.documentElement.dataset.shiyeOffline='1';out.documentElement.dataset.shiyeArticle='1';
 const csp=out.createElement('meta');csp.httpEquiv='Content-Security-Policy';csp.content=SNAPSHOT_CSP;out.head.prepend(csp);const charset=out.createElement('meta');charset.setAttribute('charset','utf-8');out.head.prepend(charset);
 const style=out.createElement('style');style.textContent=fontFaces+`html{background:#f6f5ef;color:#253b33}body{margin:0;padding:36px 24px;font:17px/1.9 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.shiye-article{max-width:760px;margin:0 auto}.shiye-article>header{border-bottom:1px solid #dce3d5;padding-bottom:22px;margin-bottom:28px}.shiye-article h1{font-size:30px;line-height:1.45;margin:0 0 16px}.shiye-article h2,.shiye-article h3{line-height:1.5;margin:1.6em 0 .6em}.article-source{font-size:12px;color:#687b6b;overflow-wrap:anywhere}.shiye-article p{margin:.9em 0}.shiye-article img{max-width:100%;object-fit:contain}.shiye-article pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:18px;background:#edf1e8;border-radius:8px;overflow:auto;font:14px/1.7 ui-monospace,monospace}.shiye-article blockquote{border-left:3px solid #9db79e;padding-left:18px;margin:22px 0;color:#5b6f5d}.shiye-article table{border-collapse:collapse;max-width:100%}.shiye-article td,.shiye-article th{padding:8px 12px;border:1px solid #ccd6c8}.shiye-article a{color:#245d49}.shiye-article svg{max-width:100%}`;out.head.append(style);
 const main=out.createElement('main');main.className='shiye-article';const header=out.createElement('header'),title=out.createElement('h1');title.textContent=metadata.customTitle?metadata.title:article.title||metadata.title;header.append(title);const info=out.createElement('p');info.className='article-source';info.textContent=[article.byline,article.siteName].filter(Boolean).join(' · ');const link=out.createElement('a');link.href=metadata.url;link.rel='noopener noreferrer';link.target='_blank';link.textContent=new URL(metadata.url).hostname;info.append(' ',link);header.append(info);const body=out.createElement('article');body.innerHTML=clean;for(const nested of body.querySelectorAll('article')){const section=out.createElement('section');for(const a of [...nested.attributes])section.setAttribute(a.name,a.value);section.append(...nested.childNodes);nested.replaceWith(section);}const duplicate=body.querySelector('h1,h2');if(duplicate&&duplicate.textContent.trim()===title.textContent.trim())duplicate.remove();main.append(header,body);out.body.append(main);
 const html='<!doctype html>'+out.documentElement.outerHTML;const missing=[...new Set([...body.querySelectorAll('[data-snapshot-missing-resource]')].map(n=>n.getAttribute('data-snapshot-missing-resource')))];if(body.querySelector('.katex,math'))missing.push(...snapshot.missingResources.filter(u=>/\.(?:woff2?|ttf|otf)(?:[?#]|$)/i.test(u)));const warnings=snapshot.warnings.filter(w=>!/^\d+ 项页面资源/.test(w));if(missing.length)warnings.push(missing.length+' 项正文图片或公式字体未能离线保存，请核对后确认。');
 return {...snapshot,missingResources:missing,missingResourceCount:missing.length,warnings,html,text:main.textContent.trim(),width:840,mode:'article',article:{title:title.textContent,byline:article.byline||'',siteName:article.siteName||'',excerpt:article.excerpt||''}};
}
