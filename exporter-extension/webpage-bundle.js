import {convertMhtml} from './mhtml.js';
import {extractArticle} from './article.js';
export function captureVersions(bytes,metadata,extraResources=[]){
 const snapshot={...convertMhtml(bytes,metadata,{extraResources}),mode:'snapshot'};
 let articleSnapshot=null,articleError='';
 try{articleSnapshot=extractArticle(snapshot,metadata);}catch(e){articleError=String(e.message||e).slice(0,500);}
 return {snapshot,articleSnapshot,articleError};
}
export function versionReview(archive){
 return {warnings:[...archive.snapshot.warnings,...(archive.articleError?['正文版本未生成：'+archive.articleError]:[])],resources:archive.snapshot.resourceCount,missingResources:archive.snapshot.missingResources};
}
// Passive offline HTML retains both versions; only the original renders in a browser.
export function bundledHtml(archive){
 const doc=new DOMParser().parseFromString(ShiyeAnchors.html(archive.snapshot.html,archive.reading),'text/html');
 const payload=doc.createElement('template');payload.setAttribute('data-shiye-reading-versions','1');payload.content.append(doc.createTextNode(JSON.stringify({articleSnapshot:archive.articleSnapshot,articleError:archive.articleError})));
 doc.body.append(payload);return '<!doctype html>'+doc.documentElement.outerHTML;
}
