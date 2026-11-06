import {loadArchiveBytes} from './archive-loader.js';
import {createArchiveCache} from './archive-cache.js';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {setReadingWindowActive} from './reading-observer.js';
import {restoreVersions,readingVersion} from './reading-versions.js';
import {mountAnnotations} from './annotations.js';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {open,save} from '@tauri-apps/plugin-dialog';
import {mountReader,cleanSnapshot,printDocument,snapshotText} from './reader.js';
import {pdfSettingsMarkup,readPdfOptions,normalizePdfOptions} from './pdf-options.js';
import '../../exporter-extension/custom-select.js';
import {mountBulk} from './bulk.js';
import {mountReadingTools} from './reading-tools.js';
import './style.css';
const app=document.querySelector('#app');
app.innerHTML=`<aside class="sidebar"><div class="brand"><span class="brand-icon">▤</span><strong>拾页</strong></div><p class="sidebar-hint">留住值得再读的内容</p><nav aria-label="内容库"><button data-view="all" class="active">全部收藏<span id="total">0</span></button><button data-view="unread">未读</button><button data-view="starred">星标</button><button data-view="read">已读</button><button data-view="trashed">回收站</button></nav><div class="section-label">收藏夹与标签</div><div id="groups"></div><div class="sidebar-bottom"><button id="import">导入内容</button><button id="settings">设置<span class="settings-shortcut">⌘,</span></button><span class="local-label">保存在这台电脑</span></div></aside><section class="collection" aria-label="收藏列表"><header><h1 id="view-title">全部收藏</h1><button id="refresh" class="icon" aria-label="刷新">↻</button></header><div class="search"><input id="search" type="search" placeholder="搜索标题、正文、标签" aria-label="搜索收藏"></div><p id="list-count"></p><div id="items" role="list"></div></section><main class="reader"><div id="empty"><div class="empty-mark">▤</div><h2>为下一次阅读留一页</h2><p>在网页保存离线快照，或在 ChatGPT 选择消息，<br>也可导入已有的归档文件。</p><button id="empty-connect">连接浏览器扩展</button></div><section id="document" hidden><header class="reader-header"><div><p id="source"></p><h2 id="title"></h2></div><div class="reader-tools"><button id="star" class="icon" aria-label="切换星标">☆</button><button id="mark-read">标为已读</button><button id="edit">整理</button><button id="toc-toggle" aria-expanded="true">目录</button><button id="export" class="primary">导出</button></div></header><div class="document-meta"><button id="source-link">查看原文</button><span id="saved-at"></span><div id="reading-versions" role="group" aria-label="阅读版本" hidden><button id="version-snapshot" aria-pressed="true">原貌快照</button><button id="version-article" aria-pressed="false">正文剪藏</button></div><button id="trash">移到回收站</button></div><p id="warnings" hidden></p><p id="reader-loading" role="status" hidden>正在打开收藏…</p><div class="reading-area"><iframe id="frame" sandbox="allow-same-origin" title="收藏的网页原貌" referrerpolicy="no-referrer"></iframe><nav id="toc" aria-label="文章目录"></nav></div></section></main><p id="status" role="status" aria-live="polite"></p><dialog id="edit-dialog"><form id="edit-form"><header><h2>整理收藏</h2><button type="button" data-close="edit-dialog" aria-label="关闭">×</button></header><label for="edit-title">标题</label><input id="edit-title" required maxlength="300"><label for="edit-folder">收藏夹</label><input id="edit-folder" maxlength="100" list="folders"><datalist id="folders"></datalist><label for="edit-tags">标签（逗号分隔）</label><input id="edit-tags" maxlength="500"><label for="edit-notes">备注</label><textarea id="edit-notes" rows="5"></textarea><footer><button type="button" data-close="edit-dialog">取消</button><button class="primary">保存</button></footer></form></dialog><dialog id="export-dialog"><form id="export-form"><header><h2>导出收藏</h2><button type="button" data-close="export-dialog" aria-label="关闭">×</button></header><fieldset><legend>文件格式</legend>${[['pdf','PDF'],['html','离线网页 HTML'],['md','Markdown'],['txt','纯文本'],['json','完整归档 JSON']].map(([v,l])=>`<label class="format"><input type="radio" name="format" value="${v}" ${v==='html'?'checked':''}>${l}</label>`).join('')}</fieldset>${pdfSettingsMarkup()}<p class="subtle">HTML/PDF 使用当前查看的版本；完整 JSON 保留所有已存版本。目录书签与目录页独立设置。Markdown 与纯文本不保留网页独有布局。</p><footer><button type="button" data-close="export-dialog">取消</button><button id="export-submit" class="primary">选择保存位置</button></footer></form></dialog>`;
const $=s=>document.querySelector(s),cmd=request=>invoke('command',{request}),archiveCache=createArchiveCache();
const pdfForm=$('#export-form');
let storedPdf={};try{storedPdf=JSON.parse(localStorage.getItem('pdf-options')||'{}');}catch{}
for(const [key,value]of Object.entries(normalizePdfOptions(storedPdf))){const input=pdfForm.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value;else input.value=value;}}
globalThis.ArchiveCustomSelect.enhance(pdfForm);
const updatePdfFields=()=>{pdfForm.querySelector('.advanced-pdf').hidden=new FormData(pdfForm).get('format')!=='pdf';};
pdfForm.addEventListener('change',updatePdfFields);updatePdfFields();
let items=[],selected=null,archive=null,savedArchive=null,versionState=null,view='all',group='',query='',matches=null,disposeReader=()=>{},selectionRevision=0,readingRevision=0,searchRevision=0,searchTimer=null;
const titles={all:'全部收藏',unread:'未读',starred:'星标',read:'已读',trashed:'回收站',folder:'收藏夹',tag:'标签'};
let statusTimer;function status(text){$('#status').textContent=text;$('#status').classList.toggle('visible',!!text);clearTimeout(statusTimer);statusTimer=setTimeout(()=>$('#status').classList.remove('visible'),7000);}
async function run(fn){try{await fn();}catch(e){status(String(e));}}
function button(text,fn,className=''){const n=document.createElement('button');n.textContent=text;n.className=className;n.onclick=()=>run(fn);return n;}
const date=seconds=>new Date(seconds*1000).toLocaleDateString('zh-CN',{year:'numeric',month:'short',day:'numeric'});
function tags(item){return item.tags.split(/[,，]/).map(s=>s.trim()).filter(Boolean);}
async function refresh(){items=await cmd({action:'list'});archiveCache.retain(new Set(items.map(i=>i.id)));if(query.trim()){matches=new Set(await cmd({action:'search',query}));}renderList();}
function visibleItems(){return items.filter(i=>(view==='trashed'?i.trashed:!i.trashed)&&(view!=='starred'||i.starred)&&(view!=='unread'||!i.read)&&(view!=='read'||i.read)&&(view!=='folder'||i.folder===group)&&(view!=='tag'||tags(i).includes(group))&&(!query||matches?.has(i.id)));}
function renderList(){
 $('#total').textContent=items.filter(i=>!i.trashed).length;$('#view-title').textContent=group||titles[view];
 const filtered=bulk.sort(visibleItems());
 $('#list-count').textContent=`${filtered.length} 条收藏`;$('#items').replaceChildren();
 for(const item of filtered){const row=document.createElement('article');row.dataset.itemId=item.id;row.className='item'+(selected===item.id?' selected':'')+(bulk.ids.has(item.id)?' chosen':'');row.setAttribute('role','listitem');const label=document.createElement('label');label.className='bulk-check';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.itemId=item.id;checkbox.checked=bulk.ids.has(item.id);checkbox.setAttribute('aria-label','选择收藏：'+item.title);checkbox.onchange=()=>bulk.toggle(item.id);label.append(checkbox);const open=button('',()=>select(item.id),'item-open');const h=document.createElement('h2');h.textContent=item.title;const p=document.createElement('p');p.textContent=item.summary||'网页原貌快照';const meta=document.createElement('div');meta.className='item-meta';meta.textContent=(item.starred?'★  ':'')+(item.read?'已读':'未读')+'   '+date(item.savedAt);open.append(h,p,meta);row.append(label,open);$('#items').append(row);}
 bulk.update();
 if(!filtered.length){const p=document.createElement('p');p.className='no-items';p.textContent=query?'没有找到匹配内容':'这里还没有收藏';$('#items').append(p);}
 const groups=$('#groups');groups.replaceChildren();for(const [kind,values] of [['folder',new Set(items.filter(i=>!i.trashed).map(i=>i.folder).filter(Boolean))],['tag',new Set(items.filter(i=>!i.trashed).flatMap(tags))]])for(const name of values)groups.append(button((kind==='tag'?'# ':'▱ ')+name,()=>{view=kind;group=name;renderList();},'group'+(view===kind&&group===name?' active':'')));
 for(const b of document.querySelectorAll('[data-view]'))b.classList.toggle('active',b.dataset.view===view);
}
function updateToolbar(){const item=items.find(i=>i.id===selected);if(!item)return;$('#title').textContent=item.title;$('#title').title=item.title;$('#star').textContent=item.starred?'★':'☆';$('#star').setAttribute('aria-pressed',String(item.starred));$('#mark-read').textContent=item.read?'标为未读':'标为已读';$('#trash').textContent=item.trashed?'恢复收藏':'移到回收站';$('#source').textContent=archive?.source==='chatgpt'?'ChatGPT 对话':archive?.source==='article'?'正文剪藏':'网页收藏';$('#saved-at').textContent='保存于 '+date(item.savedAt);$('#source-link').hidden=!item.url;}
async function select(id){
 if(annotations.hasDraft())throw Error('请先保存正在编辑的笔记，再切换收藏');
 const loadStart=performance.now(),revision=++selectionRevision;++readingRevision;$('#reader-loading').hidden=false;for(const row of $('#items').children)row.classList.toggle('selected',row.dataset.itemId===id);let loaded;try{loaded=await archiveCache.load(id,()=>window.__TAURI_INTERNALS__?.metadata?.currentWindow?loadArchiveBytes(invoke,id):cmd({action:'load',id}),()=>revision===selectionRevision);}catch(error){if(revision!==selectionRevision)return;$('#reader-loading').hidden=true;throw error;}if(revision!==selectionRevision)return;
 disposeReader();selected=id;const freshItem=items.find(i=>i.id===id);loaded.library={...loaded.library,...freshItem};if(/^https?:/.test(loaded.url||'')){const freshReading=await cmd({action:'reading_get',url:loaded.url});if(revision!==selectionRevision)return;if(freshReading?.version)loaded.reading=freshReading;}savedArchive=restoreVersions(loaded);performance.clearMeasures('reader:archive');performance.measure('reader:archive',{start:loadStart,end:performance.now()});archive=savedArchive;const item=items.find(i=>i.id===id);$('#empty').hidden=true;$('#document').hidden=false;updateToolbar();for(const row of $('#items').children)row.classList.toggle('selected',row.dataset.itemId===id);
 let preference={};try{preference=JSON.parse(localStorage.getItem('reading-version:'+id)||'{}');}catch{}
 versionState={version:preference.version==='article'&&savedArchive.articleSnapshot?.html?'article':'snapshot',progress:preference.progress&&typeof preference.progress==='object'?preference.progress:{}};
 await showVersion(versionState.version);
}
async function showVersion(version){
 if(annotations.hasDraft())throw Error('请先保存正在编辑的笔记，再切换版本');
 const revision=++readingRevision,id=selected,item=items.find(i=>i.id===id);if(!savedArchive||!item)return;
 if(version==='article'&&!savedArchive.articleSnapshot?.html)throw Error(savedArchive.articleError||'这条收藏未保存正文版本，请从插件重新收藏');
 if(archive?.reading)savedArchive.reading=archive.reading;
 $('#reader-loading').hidden=false;disposeReader();versionState.version=version;archive=readingVersion(savedArchive,version);
 const state=versionState,persist=()=>{try{localStorage.setItem('reading-version:'+id,JSON.stringify(state));}catch{}};persist();
 const hasVersions=!!(savedArchive.articleSnapshot||savedArchive.articleError);$('#reading-versions').hidden=!hasVersions;$('#version-snapshot').setAttribute('aria-pressed',String(version==='snapshot'));$('#version-article').setAttribute('aria-pressed',String(version==='article'));$('#version-article').disabled=!savedArchive.articleSnapshot?.html;$('#version-article').title=savedArchive.articleError||'';$('#frame').title=version==='article'?'收藏的文章正文':'收藏的网页原貌';updateToolbar();
 const warnings=[...(archive.warnings||[]),...(archive.snapshot.warnings||[]),...(savedArchive.articleError?['正文版本未生成：'+savedArchive.articleError]:[])];$('#warnings').textContent=[...new Set(warnings)].join('；');$('#warnings').hidden=!warnings.length;
 reading.prepare(query.trim());
 await (globalThis.scheduler?.yield?.()||new Promise(resolve=>setTimeout(resolve,0)));if(revision!==readingRevision||id!==selected)return;
 archive.progress=Number.isFinite(state.progress[version])?state.progress[version]:version==='snapshot'?item.progress:0;disposeReader=mountReader($('#frame'),archive,progress=>{const item=items.find(i=>i.id===id);if(item)item.progress=progress;state.progress[version]=progress;persist();return run(()=>cmd({action:'update',id,patch:{progress}}));},headings=>{if(id!==selected)return;$('#toc').replaceChildren();for(const h of headings){const b=button(h.text,()=>reading.goHeading(h.id));b.dataset.heading=h.id;b.style.paddingLeft=12+Math.max(0,h.level-1)*10+'px';$('#toc').append(b);}if(!headings.length)$('#toc').textContent='这条收藏没有标题目录';},{onReady:()=>{if(id===selected&&revision===readingRevision)$('#reader-loading').hidden=true;},onError:error=>{if(id===selected&&revision===readingRevision){$('#reader-loading').hidden=true;status(String(error));}},enhance:args=>{const enhancement=reading.enhance(args),notes=annotations.attach(args);return {...enhancement,dispose(){notes.dispose();enhancement.dispose();}};}});
}
$('#version-snapshot').onclick=()=>run(()=>showVersion('snapshot'));
$('#version-article').onclick=()=>run(()=>showVersion('article'));
async function patch(value){if(!selected)return;await cmd({action:'update',id:selected,patch:value});await refresh();updateToolbar();}
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>{view=b.dataset.view;group='';renderList();};
$('#search').oninput=()=>{const revision=++searchRevision;query=$('#search').value;clearTimeout(searchTimer);searchTimer=setTimeout(()=>run(async()=>{if(revision!==searchRevision)return;const result=await cmd({action:'search',query});if(revision!==searchRevision)return;matches=new Set(result);renderList();}),200);};
$('#refresh').onclick=()=>run(()=>{archiveCache.invalidate();return refresh();});
$('#star').onclick=()=>run(()=>patch({starred:!items.find(i=>i.id===selected).starred}));
$('#mark-read').onclick=()=>run(()=>patch({read:!items.find(i=>i.id===selected).read}));
$('#trash').onclick=()=>run(()=>patch({trashed:!items.find(i=>i.id===selected).trashed}));

$('#source-link').onclick=()=>run(()=>cmd({action:'open_source',url:items.find(i=>i.id===selected).url}));
$('#edit').onclick=()=>{const i=items.find(i=>i.id===selected);for(const key of ['title','folder','tags','notes'])$('#edit-'+key).value=i[key];$('#edit-dialog').showModal();};
$('#edit-form').onsubmit=e=>{e.preventDefault();run(async()=>{const patchValue={};for(const key of ['title','folder','tags','notes'])patchValue[key]=$('#edit-'+key).value.trim();if(!patchValue.title)throw Error('请输入标题');await patch(patchValue);$('#edit-dialog').close();});};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$('#'+b.dataset.close).close();
$('#settings').onclick=()=>run(()=>cmd({action:'open_settings'}));
$('#empty-connect').onclick=()=>run(()=>cmd({action:'open_settings',section:'connection'}));
async function importFile(){const path=await open({multiple:false,filters:[{name:'网页归档与备份',extensions:['json','html','htm','readerbackup']}]});if(!path)return;status('正在导入…');const r=await cmd({action:'import_file',path});await refresh();if(r.id)await select(r.id);status(r.duplicate?'内容已在收藏中':r.count?'已恢复 '+r.count+' 条收藏':'已保存到内容库');}
$('#import').onclick=()=>run(importFile);
let exportIds=null;
function openExport(ids=null){if(annotations.hasDraft()){status('请先保存正在编辑的笔记，再导出收藏');return;}exportIds=ids;const title=ids?`导出 ${ids.length} 条收藏`:'导出收藏';$('#export-dialog h2').textContent=title;pdfForm.elements.contentTitle.closest('label').hidden=!!ids;pdfForm.elements.contentTitle.value=ids?'':items.find(i=>i.id===selected)?.title||'';$('#export-submit').textContent=ids?'选择导出文件夹':'选择保存位置';$('#export-dialog').showModal();}
$('#export').onclick=()=>openExport();
$('#export-form').onsubmit=e=>{e.preventDefault();run(async()=>{
 const format=new FormData(e.target).get('format'),options=readPdfOptions(pdfForm);
 const now=new Date(),pad=n=>String(n).padStart(2,'0');const stamp=now.getFullYear()+pad(now.getMonth()+1)+pad(now.getDate())+'-'+pad(now.getHours())+pad(now.getMinutes())+pad(now.getSeconds());
 if(exportIds){
  const directory=await open({directory:true,multiple:false,title:'选择批量导出文件夹'});if(!directory)return;const submit=$('#export-submit');submit.disabled=true;
  try{options.contentTitle='';localStorage.setItem('pdf-options',JSON.stringify(options));await cmd({action:'batch_create',ids:exportIds,format,options,directory,stamp});$('#export-dialog').close();await bulk.showBatches();}finally{submit.disabled=false;}return;
 }
 const item=items.find(i=>i.id===selected),name=item.title.replace(/[\\/:*?"<>|]/g,'_').slice(0,80)+'_'+stamp+'.'+format;
 const path=await save({defaultPath:name,filters:[{name:format.toUpperCase(),extensions:[format]}]});if(!path)return;const submit=$('#export-submit');submit.disabled=true;
 try{status('正在生成文件…');if(format==='pdf'){localStorage.setItem('pdf-options',JSON.stringify(options));const document=await printDocument(archive,options);await invoke('print_pdf',{...document,path,jobId:null});}else await cmd({action:'export_file',id:selected,format,path,html:format==='html'?cleanSnapshot(ShiyeAnchors.html(archive.snapshot.html,archive.reading)):undefined,text:snapshotText(archive)});$('#export-dialog').close();status('文件已保存');}finally{submit.disabled=false;}
});};
const reading=mountReadingTools({cmd,run,status});
const annotations=mountAnnotations({cmd,run,status});
const bulk=mountBulk({cmd,run,status,getItems:()=>items,getVisible:visibleItems,refresh:reload=>reload===false?renderList():refresh().then(updateToolbar),openExport});

await run(async()=>{const info=await cmd({action:'info'});if(!info.nativePdf)$('[value=pdf]').disabled=true;await refresh();});
await listen('library-changed',()=>run(refresh));

await listen('reader-find',()=>{if(archive)reading.find();});

function applyPreferences(preferences={}){
 if(preferences.reading){localStorage.setItem('reading-options',JSON.stringify(preferences.reading));reading.preferences(preferences.reading);}
 if(preferences.pdf){localStorage.setItem('pdf-options',JSON.stringify(preferences.pdf));for(const [key,value] of Object.entries(normalizePdfOptions(preferences.pdf))){if(key==='contentTitle')continue;const input=pdfForm.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value;else{input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));}}}}
}
await listen('preferences-changed',e=>applyPreferences(e.payload));
window.addEventListener('storage',e=>{try{if(e.key==='reading-options')applyPreferences({reading:JSON.parse(e.newValue)});if(e.key==='pdf-options')applyPreferences({pdf:JSON.parse(e.newValue)});}catch{}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key===','){e.preventDefault();run(()=>cmd({action:'open_settings'}));}});

// Native focus also covers macOS application switching and minimized windows.
if(window.__TAURI_INTERNALS__?.metadata?.currentWindow){const current=getCurrentWindow();await current.onFocusChanged(event=>setReadingWindowActive(event.payload));setReadingWindowActive(await current.isFocused());}
