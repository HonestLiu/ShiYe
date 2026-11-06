// Old single-version archives remain readable. Embedded payloads are inert JSON, never scripts.
export function restoreVersions(archive){
 if(!archive.articleSnapshot&&!archive.articleError&&archive.snapshot?.html?.includes('data-shiye-reading-versions'))try{
  const doc=new DOMParser().parseFromString(archive.snapshot.html,'text/html'),node=doc.querySelector('template[data-shiye-reading-versions="1"]');
  if(node){const data=JSON.parse(node.content.textContent);if(data.articleSnapshot&&typeof data.articleSnapshot.html==='string'&&data.articleSnapshot.html.length)archive.articleSnapshot={...data.articleSnapshot,mode:'article'};else if(typeof data.articleError==='string')archive.articleError=data.articleError.slice(0,500);}
 }catch{archive.articleError='正文版本数据无法读取，原貌快照仍可阅读。';}
 return archive;
}
export function readingVersion(archive,version){
 return version==='article'&&archive.articleSnapshot?.html?{...archive,source:'article',snapshot:archive.articleSnapshot}:{...archive};
}
