import {loadArchiveBytes} from './archive-loader.js';
import {createArchiveCache} from './archive-cache.js';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {setReadingWindowActive} from './reading-observer.js';
import {restoreVersions,readingVersion} from './reading-versions.js';
import {readingMarksHTML} from './reading-marks.js';
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
import './workspace.css';
import './theme.css';
import {applyTheme} from './theme.js';
import {workspaceLayout} from './workspace-layout.js';
import {uiIcon,iconControl,sourceLabel,disclosure} from './ui.js';
import {mountContextMenus} from './context-menu.js';
const app=document.querySelector('#app');
app.innerHTML=workspaceLayout(pdfSettingsMarkup());
const $=s=>document.querySelector(s),cmd=request=>invoke('command',{request}),archiveCache=createArchiveCache();
const pdfForm=$('#export-form');
let storedPdf={};try{storedPdf=JSON.parse(localStorage.getItem('pdf-options')||'{}');}catch{}
for(const [key,value]of Object.entries(normalizePdfOptions(storedPdf))){const input=pdfForm.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value;else input.value=value;}}
globalThis.ArchiveCustomSelect.enhance(pdfForm);
const updatePdfFields=()=>{pdfForm.querySelector('.advanced-pdf').hidden=new FormData(pdfForm).get('format')!=='pdf';};
pdfForm.addEventListener('change',updatePdfFields);updatePdfFields();
let items=[],selected=null,archive=null,savedArchive=null,versionState=null,view='all',group='',query='',matches=null,disposeReader=()=>{},selectionRevision=0,readingRevision=0,searchRevision=0,searchTimer=null,articleEditor=null,showArticleBase=false;
const titles={all:'全部收藏',unread:'未读',starred:'星标',read:'已读',trashed:'回收站',folder:'收藏夹',tag:'标签'};
let statusTimer;function status(text){$('#status').textContent=text;$('#status').classList.toggle('visible',!!text);clearTimeout(statusTimer);statusTimer=setTimeout(()=>$('#status').classList.remove('visible'),7000);}
async function run(fn){try{await fn();}catch(e){status(String(e));}}
function button(text,fn,className=''){const n=document.createElement('button');n.textContent=text;n.className=className;n.onclick=()=>run(fn);return n;}
const date=seconds=>new Date(seconds*1000).toLocaleDateString('zh-CN',{year:'numeric',month:'short',day:'numeric'});
function tags(item){return item.tags.split(/[,，]/).map(s=>s.trim()).filter(Boolean);}
async function refresh(){items=await cmd({action:'list'});archiveCache.retain(new Set(items.map(i=>i.id)));if(selected&&!items.some(i=>i.id===selected))clearSelection();if(query.trim()){matches=new Set(await cmd({action:'search',query}));}renderList();}
function visibleItems(){return items.filter(i=>(view==='trashed'?i.trashed:!i.trashed)&&(view!=='starred'||i.starred)&&(view!=='unread'||!i.read)&&(view!=='read'||i.read)&&(view!=='folder'||i.folder===group)&&(view!=='tag'||tags(i).includes(group))&&(!query||matches?.has(i.id)));}
function renderList(){
 $('#empty-trash').hidden=view!=='trashed'||!items.some(i=>i.trashed);
 $('#total').textContent=items.filter(i=>!i.trashed).length;$('#view-title').textContent=group||titles[view];
 const filtered=bulk.sort(visibleItems());
 $('#list-count').textContent=`${filtered.length} 条收藏`;$('#items').replaceChildren();
 for(const item of filtered){const row=document.createElement('article');row.dataset.itemId=item.id;row.className='item'+(selected===item.id?' selected':'')+(bulk.ids.has(item.id)?' chosen':'');row.setAttribute('role','listitem');const label=document.createElement('label');label.className='bulk-check';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.itemId=item.id;checkbox.checked=bulk.ids.has(item.id);checkbox.setAttribute('aria-label','选择收藏：'+item.title);checkbox.onchange=()=>bulk.toggle(item.id);label.append(checkbox);const open=button('',()=>select(item.id),'item-open');open.setAttribute('aria-label',item.title);if(selected===item.id)open.setAttribute('aria-current','true');const h=document.createElement('h2');h.textContent=item.title;const p=document.createElement('p');p.textContent=item.summary||'已保存离线内容';const origin=document.createElement('div');origin.className='item-origin';const glyph=document.createElement('span');glyph.className='source-glyph';glyph.innerHTML=uiIcon(item.source==='chatgpt'?'comment':'note');const domain=document.createElement('span');domain.textContent=sourceLabel(item);const when=document.createElement('time');const savedDate=new Date(item.savedAt*1000);when.textContent=savedDate.toLocaleDateString('zh-CN',savedDate.getFullYear()===new Date().getFullYear()?{month:'short',day:'numeric'}:{year:'numeric',month:'2-digit',day:'2-digit'});origin.append(glyph,domain,when);const meta=document.createElement('div');meta.className='item-meta';const state=document.createElement('span');state.textContent=item.read?'已读':'未读';meta.append(state);if(item.starred){const star=document.createElement('span');star.className='item-star';star.innerHTML=uiIcon('star');star.title='星标';meta.append(star);}open.append(origin,h,p,meta);row.append(label,open);$('#items').append(row);}
 bulk.update();
 if(!filtered.length){const p=document.createElement('p');p.className='no-items';p.textContent=query?'没有找到匹配内容':'这里还没有收藏';$('#items').append(p);}
 const groups=$('#groups');groups.replaceChildren();for(const [kind,values,title,icon]of [['folder',new Set(items.filter(i=>!i.trashed).map(i=>i.folder).filter(Boolean)),'收藏夹','folder'],['tag',new Set(items.filter(i=>!i.trashed).flatMap(tags)),'标签','tag']]){const heading=document.createElement('div');heading.className='sidebar-section-label';heading.textContent=title;groups.append(heading);if(!values.size){const hint=document.createElement('p');hint.className='group-empty';hint.textContent=kind==='folder'?'整理收藏时添加收藏夹':'给收藏添加标签';groups.append(hint);}for(const name of [...values].sort((a,b)=>a.localeCompare(b,'zh-CN'))){const b=button('',()=>{view=kind;group=name;renderList();},'group'+(view===kind&&group===name?' active':''));b.dataset.kind=kind;b.dataset.name=name;b.title=name+' · 右键管理';b.innerHTML=uiIcon(icon);const label=document.createElement('span');label.textContent=name;const count=document.createElement('small');count.className='group-count';count.textContent=items.filter(i=>!i.trashed&&(kind==='folder'?i.folder===name:tags(i).includes(name))).length;b.append(label,count);groups.append(b);}}
 for(const b of document.querySelectorAll('[data-view]')){const active=b.dataset.view===view;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
 for(const state of ['unread','read','starred','trashed'])$('#count-'+state).textContent=items.filter(i=>state==='trashed'?i.trashed:!i.trashed&&(state==='starred'?i.starred:state==='read'?i.read:!i.read)).length||'';

}
const groupDialog=document.createElement('dialog');groupDialog.id='group-manage-dialog';groupDialog.innerHTML='<form><header><h2 id="group-manage-title"></h2><button type="button" aria-label="关闭">×</button></header><p id="group-manage-description"></p><label for="group-manage-name">新名称</label><input id="group-manage-name" maxlength="100"><footer><button type="button" data-cancel>取消</button><button class="primary" type="submit">保存</button></footer></form>';document.body.append(groupDialog);
groupDialog.querySelector('[aria-label=关闭]').onclick=()=>groupDialog.close();groupDialog.querySelector('[data-cancel]').onclick=()=>groupDialog.close();
function manageGroup(kind,name,remove){
 const label=kind==='folder'?'收藏夹':'标签',affected=items.filter(i=>kind==='folder'?i.folder===name:tags(i).includes(name));
 $('#group-manage-title').textContent=(remove?'删除':'重命名')+label;$('#group-manage-description').textContent=remove?`将从 ${affected.length} 条收藏中移除「${name}」，收藏和笔记会保留。`:`更新「${name}」及其关联收藏；回收站中的收藏也会同步更新。`;
 const input=$('#group-manage-name');input.value=name;input.hidden=remove;groupDialog.querySelector('label').hidden=remove;const submit=groupDialog.querySelector('[type=submit]');submit.textContent=remove?'删除':'保存';submit.classList.toggle('danger-primary',remove);
 groupDialog.querySelector('form').onsubmit=e=>{e.preventDefault();run(async()=>{const next=remove?'':input.value.trim();if(!remove&&(!next||next.length>100||/[，,]/.test(next)))throw Error('请输入有效名称，名称不能包含逗号');if(!remove&&next===name){groupDialog.close();return;}submit.disabled=true;let completed=0;try{for(const item of affected){const patch=kind==='folder'?{folder:next}:{tags:[...new Set(tags(item).flatMap(t=>t===name?(next?[next]:[]):[t]))].join(',')};await cmd({action:'update',id:item.id,patch});completed++;}if(view===kind&&group===name){if(remove){view='all';group='';}else group=next;}groupDialog.close();status(`${label}已${remove?'移除':'重命名'}，共处理 ${completed} 条收藏`);}catch(err){status(`已处理 ${completed} / ${affected.length} 条收藏：${err}`);}finally{submit.disabled=false;await refresh();}});};groupDialog.showModal();if(!remove)input.select();
}
function updateToolbar(){const item=items.find(i=>i.id===selected);if(!item)return;$('#delete-permanently').hidden=!item.trashed;$('#title').textContent=item.title;$('#title').title=item.title;iconControl($('#star'),'star','切换星标');$('#star').setAttribute('aria-pressed',String(item.starred));iconControl($('#mark-read'),item.read?'read':'check',item.read?'标为未读':'标为已读');iconControl($('#trash'),item.trashed?'import':'trash',item.trashed?'恢复收藏':'移到回收站',true);$('#source').textContent=archive?.source==='chatgpt'?'ChatGPT 对话':archive?.source==='article'?'正文剪藏':'网页收藏';$('#saved-at').textContent='保存于 '+date(item.savedAt);$('#source-link').hidden=!item.url;}
async function select(id){
 if(annotations.hasDraft())throw Error('请先保存正在编辑的笔记，再切换收藏');
 if(articleEditor?.isOpen())await articleEditor.leave();$('.reader').classList.remove('article-editing');
 const loadStart=performance.now(),revision=++selectionRevision;++readingRevision;$('#reader-loading').hidden=false;for(const row of $('#items').children){const active=row.dataset.itemId===id;row.classList.toggle('selected',active);const target=row.querySelector('.item-open');if(target){if(active)target.setAttribute('aria-current','true');else target.removeAttribute('aria-current');}}let loaded;try{loaded=await archiveCache.load(id,()=>window.__TAURI_INTERNALS__?.metadata?.currentWindow?loadArchiveBytes(invoke,id):cmd({action:'load',id}),()=>revision===selectionRevision);}catch(error){if(revision!==selectionRevision)return;$('#reader-loading').hidden=true;throw error;}if(revision!==selectionRevision)return;
 disposeReader();showArticleBase=false;selected=id;const freshItem=items.find(i=>i.id===id);loaded.library={...loaded.library,...freshItem};if(/^https?:/.test(loaded.url||'')){const freshReading=await cmd({action:'reading_get',url:loaded.url});if(revision!==selectionRevision)return;if(freshReading?.version)loaded.reading=freshReading;}savedArchive=restoreVersions(loaded);performance.clearMeasures('reader:archive');performance.measure('reader:archive',{start:loadStart,end:performance.now()});archive=savedArchive;const item=items.find(i=>i.id===id);$('#empty').hidden=true;$('#document').hidden=false;updateToolbar();for(const row of $('#items').children){const active=row.dataset.itemId===id;row.classList.toggle('selected',active);const target=row.querySelector('.item-open');if(target){if(active)target.setAttribute('aria-current','true');else target.removeAttribute('aria-current');}}
 let preference={};try{preference=JSON.parse(localStorage.getItem('reading-version:'+id)||'{}');}catch{}
 versionState={version:(savedArchive.articleSnapshot?.html||savedArchive.source==='article')?'article':'snapshot',progress:preference.progress&&typeof preference.progress==='object'?preference.progress:{}};
 await showVersion(versionState.version);
}
async function showVersion(version){
 if(articleEditor?.isOpen())await articleEditor.leave();$('.reader').classList.remove('article-editing');$('#frame').hidden=false;
 if(annotations.hasDraft())throw Error('请先保存正在编辑的笔记，再切换版本');
 const revision=++readingRevision,id=selected,item=items.find(i=>i.id===id);if(!savedArchive||!item)return;
 if(version==='article'&&!savedArchive.articleSnapshot?.html&&savedArchive.source!=='article')throw Error(savedArchive.articleError||'这条收藏未保存正文版本，请从插件重新收藏');
 if(archive?.reading)savedArchive.reading=archive.reading;
 $('#reader-loading').hidden=false;disposeReader();versionState.version=version;if(version==='article'&&savedArchive.articleEdit?.hasDocument&&!showArticleBase){if(savedArchive.editedSnapshot?.revision!==savedArchive.articleEdit.revision)savedArchive.editedSnapshot=await cmd({action:'article_render',id});if(revision!==readingRevision||id!==selected)return;}archive=readingVersion(savedArchive,version,showArticleBase);
 const state=versionState,persist=()=>{try{localStorage.setItem('reading-version:'+id,JSON.stringify(state));}catch{}};persist();
 const hasVersions=!!(savedArchive.articleSnapshot||savedArchive.articleError||savedArchive.source==='article');$('#version-snapshot').textContent=savedArchive.source==='article'?'采集正文':'原貌快照';$('#version-article').textContent=savedArchive.articleEdit?.hasDocument?'正文编辑稿':'正文剪藏';$('#article-edit-body').hidden=!(version==='article'||savedArchive.source==='article');$('#article-view-base').hidden=!(version==='article'&&savedArchive.articleEdit?.hasDocument);$('#article-view-base').textContent=showArticleBase?'查看编辑稿':'查看采集底稿';$('#reading-versions').hidden=!hasVersions;$('#version-snapshot').setAttribute('aria-pressed',String(version==='snapshot'));$('#version-article').setAttribute('aria-pressed',String(version==='article'));$('#version-article').disabled=!savedArchive.articleSnapshot?.html&&savedArchive.source!=='article';$('#version-article').title=savedArchive.articleError||'';$('#frame').title=version==='article'?'收藏的文章正文':'收藏的网页原貌';updateToolbar();
 const warnings=[...(archive.warnings||[]),...(archive.snapshot.warnings||[]),...(savedArchive.articleError?['正文版本未生成：'+savedArchive.articleError]:[])];$('#warnings').textContent=[...new Set(warnings)].join('；');$('#warnings').hidden=!warnings.length;
 reading.prepare(query.trim());
 await (globalThis.scheduler?.yield?.()||new Promise(resolve=>setTimeout(resolve,0)));if(revision!==readingRevision||id!==selected)return;
 archive.progress=Number.isFinite(state.progress[version])?state.progress[version]:version==='snapshot'?item.progress:0;disposeReader=mountReader($('#frame'),archive,progress=>{const item=items.find(i=>i.id===id);if(!item)return;item.progress=progress;state.progress[version]=progress;persist();return run(()=>cmd({action:'update',id,patch:{progress}}));},headings=>{if(id!==selected)return;$('#toc').replaceChildren();for(const h of headings){const b=button(h.text,()=>reading.goHeading(h.id));b.dataset.heading=h.id;b.style.paddingLeft=12+Math.max(0,h.level-1)*10+'px';$('#toc').append(b);}if(!headings.length)$('#toc').textContent='这条收藏没有标题目录';},{onReady:()=>{if(id===selected&&revision===readingRevision)$('#reader-loading').hidden=true;},onError:error=>{if(id===selected&&revision===readingRevision){$('#reader-loading').hidden=true;status(String(error));}},enhance:args=>{const enhancement=reading.enhance(args),notes=annotations.attach(args);return {...enhancement,dispose(){notes.dispose();enhancement.dispose();}};}});
}
$('#article-view-base').onclick=()=>run(()=>{showArticleBase=!showArticleBase;return showVersion('article');});
$('#article-edit-body').onclick=()=>run(async()=>{
 if(annotations.hasDraft())throw Error('请先保存正在编辑的笔记');if(articleEditor?.isOpen())return;
 if(!articleEditor){const {mountArticleEditor}=await import('./article-editor.js');articleEditor=mountArticleEditor({container:$('.reading-area'),cmd,status,onSource:(id,record)=>{if(id===selected){savedArchive.reading=record;if(archive)archive.reading=record;}},onSaved:async(id,metadata)=>{if(id===selected){savedArchive.articleEdit=metadata;delete savedArchive.editedSnapshot;}await refresh();},onClosed:()=>{showArticleBase=false;return showVersion('article');},onOutline:headings=>{$('#toc').replaceChildren();for(const h of headings){const b=button(h.text,h.go);b.style.paddingLeft=12+Math.max(0,h.level-1)*10+'px';$('#toc').append(b);}if(!headings.length)$('#toc').textContent='这条收藏没有标题目录';}});$('.reading-area').insertBefore($('#article-editor'),$('#toc'));}
 disposeReader();$('#frame').srcdoc='';$('#frame').hidden=true;$('.reader').classList.add('article-editing');$('#reader-loading').hidden=true;
 try{await articleEditor.open(selected,(savedArchive.articleSnapshot||savedArchive.snapshot).html,{url:savedArchive.url,reading:savedArchive.reading});}catch(error){await showVersion(versionState.version);throw error;}
});
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
async function importFile(){if(articleEditor?.isOpen()){await articleEditor.leave();await showVersion(versionState.version);}const path=await open({multiple:false,filters:[{name:'网页归档与备份',extensions:['json','html','htm','readerbackup']}]});if(!path)return;status('正在导入…');const r=await cmd({action:'import_file',path});archiveCache.invalidate();await refresh();if(r.id)await select(r.id);status(r.duplicate?'内容已在收藏中':r.count?'已恢复 '+r.count+' 条收藏':'已保存到内容库');}
$('#import').onclick=()=>run(importFile);
let exportIds=null;
function openExport(ids=null){if(annotations.hasDraft()){status('请先保存正在编辑的笔记，再导出收藏');return;}exportIds=ids;const title=ids?`导出 ${ids.length} 条收藏`:'导出收藏';$('#export-dialog h2').textContent=title;pdfForm.elements.contentTitle.closest('label').hidden=!!ids;pdfForm.elements.contentTitle.value=ids?'':items.find(i=>i.id===selected)?.title||'';$('#export-submit').textContent=ids?'选择导出文件夹':'选择保存位置';$('#export-dialog').showModal();}
$('#export').onclick=()=>run(async()=>{if(articleEditor?.isOpen()){await articleEditor.save();await articleEditor.leave();await showVersion('article');}openExport();});
$('#export-form').onsubmit=e=>{e.preventDefault();run(async()=>{
 const format=new FormData(e.target).get('format'),options=readPdfOptions(pdfForm);
 const now=new Date(),pad=n=>String(n).padStart(2,'0');const stamp=now.getFullYear()+pad(now.getMonth()+1)+pad(now.getDate())+'-'+pad(now.getHours())+pad(now.getMinutes())+pad(now.getSeconds());
 if(exportIds){
  const directory=await open({directory:true,multiple:false,title:'选择批量导出文件夹'});if(!directory)return;const submit=$('#export-submit');submit.disabled=true;
  try{options.contentTitle='';localStorage.setItem('pdf-options',JSON.stringify(options));await cmd({action:'batch_create',ids:exportIds,format,options,directory,stamp});$('#export-dialog').close();await bulk.showBatches();}finally{submit.disabled=false;}return;
 }
 const item=items.find(i=>i.id===selected),name=item.title.replace(/[\\/:*?"<>|]/g,'_').slice(0,80)+'_'+stamp+'.'+format;
 const path=await save({defaultPath:name,filters:[{name:format.toUpperCase(),extensions:[format]}]});if(!path)return;const submit=$('#export-submit');submit.disabled=true;
 try{status('正在生成文件…');if(format==='pdf'){localStorage.setItem('pdf-options',JSON.stringify(options));const document=await printDocument(archive,options);await invoke('print_pdf',{...document,path,jobId:null});}else await cmd({action:'export_file',id:selected,format,path,edited:archive.edited===true,html:format==='html'?cleanSnapshot(readingMarksHTML(archive.snapshot.html,archive.reading,archive.snapshot),archive.edited===true):undefined,text:snapshotText(archive)});$('#export-dialog').close();status('文件已保存');}finally{submit.disabled=false;}
});};
const reading=mountReadingTools({cmd,run,status});
const annotations=mountAnnotations({cmd,run,status});
const bulk=mountBulk({cmd,run,status,getItems:()=>items,getVisible:visibleItems,refresh:reload=>reload===false?renderList():refresh().then(updateToolbar),openExport,purge:requestPurge});

function clearSelection(){++selectionRevision;++readingRevision;disposeReader();disposeReader=()=>{};selected=null;archive=null;savedArchive=null;versionState=null;$('#frame').srcdoc='';$('#reader-loading').hidden=true;$('#document').hidden=true;$('#empty').hidden=false;$('#toc').replaceChildren();}
const deleteDialog=document.createElement('dialog');deleteDialog.id='delete-dialog';deleteDialog.setAttribute('aria-labelledby','delete-title');deleteDialog.setAttribute('aria-describedby','delete-description');deleteDialog.innerHTML='<form><header><h2 id="delete-title">永久删除收藏</h2></header><p id="delete-description"></p><p>离线网页、正文编辑稿及历史、专属标注和笔记将被删除，无法从回收站恢复。已导出到其他位置的文件会保留。</p><footer><button type="button" id="delete-cancel" autofocus>取消</button><button class="danger-primary" id="delete-confirm">永久删除</button></footer><p id="delete-error" role="alert" hidden></p></form>';document.body.append(deleteDialog);
let deleteRequest=null,deleting=false;
function requestPurge(ids=null){if(deleting)return;const candidates=ids?items.filter(i=>ids.includes(i.id)):items.filter(i=>i.trashed);if(!candidates.length)return;if(candidates.some(i=>!i.trashed)){status('请先将收藏移到回收站');return;}deleteRequest=ids?{ids:[...new Set(ids)]}:{all:true};$('#delete-title').textContent=ids?'永久删除收藏':'清空回收站';$('#delete-description').textContent=candidates.length===1?'永久删除“'+candidates[0].title+'”？':'永久删除 '+candidates.length+' 条收藏？';$('#delete-error').hidden=true;deleteDialog.showModal();}
$('#delete-cancel').onclick=()=>deleteDialog.close();deleteDialog.addEventListener('cancel',e=>{if(deleting)e.preventDefault();});
deleteDialog.querySelector('form').onsubmit=e=>{e.preventDefault();if(deleting)return;deleting=true;$('#delete-confirm').disabled=true;$('#delete-cancel').disabled=true;void(async()=>{try{const request=deleteRequest;const affected=request.all?items.some(i=>i.id===selected&&i.trashed):request.ids.includes(selected);if(affected&&annotations.hasDraft())throw Error('请先保存正在编辑的笔记，再永久删除');if(affected&&articleEditor?.isOpen()){await articleEditor.leave();await showVersion(versionState.version);}const result=await cmd({action:'purge',...request});for(const id of request.ids||items.filter(i=>i.trashed).map(i=>i.id)){bulk.ids.delete(id);localStorage.removeItem('reading-version:'+id);}archiveCache.invalidate();await refresh();deleteDialog.close();status('已永久删除 '+result.count+' 条收藏'+(result.cleanupPending?'；部分缓存将在下次启动时重试清理':''));}catch(error){$('#delete-error').textContent=String(error);$('#delete-error').hidden=false;}finally{deleting=false;$('#delete-confirm').disabled=false;$('#delete-cancel').disabled=false;}})();};
$('#delete-permanently').onclick=()=>requestPurge([selected]);$('#empty-trash').onclick=()=>requestPurge();
async function changeItems(ids,patchValue){if(ids.length===1)await cmd({action:'update',id:ids[0],patch:patchValue});else await cmd({action:'batch_update',ids,patch:patchValue});await refresh();updateToolbar();}
mountContextMenus({cmd,run,status,resolve:({target,doc,text,restore})=>{
 const noteActions=doc===document?annotations.contextActions(target):null;if(noteActions)return noteActions;
 const row=target.closest('.item'),item=row?items.find(i=>i.id===row.dataset.itemId):doc!==document||target.closest('.reader')?items.find(i=>i.id===selected):null;
 if(item){const ids=row&&bulk.ids.has(item.id)&&bulk.ids.size>1?[...bulk.ids]:[item.id],chosen=items.filter(i=>ids.includes(i.id)),allTrash=chosen.every(i=>i.trashed),actions=[];
  if(row&&ids.length===1)actions.push({label:'打开收藏',icon:'note',action:()=>select(item.id)});
  if(text&&doc!==document){for(const [label,id,icon]of [['高亮选区','annotate-selection','highlight'],['为选区批注','annotate-note','comment']]){const button=$('#'+id);if(button?.getClientRects().length)actions.push({label,icon,action:()=>{restore();button.click();}});}}
  if(doc!==document)actions.push({label:'全选正文',action:()=>{const r=doc.createRange();r.selectNodeContents(doc.body);const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(r);}});
  if(!allTrash)actions.push({label:chosen.every(i=>i.starred)?'取消星标':'添加星标',icon:'star',action:()=>changeItems(ids,{starred:!chosen.every(i=>i.starred)})},{label:chosen.every(i=>i.read)?'标为未读':'标为已读',icon:'read',action:()=>changeItems(ids,{read:!chosen.every(i=>i.read)})});
  if(ids.length===1)actions.push({label:'整理',icon:'folder',action:async()=>{if(selected!==item.id)await select(item.id);$('#edit').click();}});
  actions.push({label:ids.length>1?'导出所选 '+ids.length+' 条':'导出',icon:'export',action:async()=>{if(ids.length===1){if(selected!==item.id)await select(item.id);$('#export').click();}else openExport(ids);}});
  if(item.url&&ids.length===1)actions.push({label:'查看原文',icon:'external',action:()=>cmd({action:'open_source',url:item.url})},{label:'复制原文链接',action:()=>cmd({action:'copy_text',text:item.url})});
  actions.push(null,allTrash?{label:'恢复收藏',icon:'import',action:()=>changeItems(ids,{trashed:false})}:{label:'移到回收站',icon:'trash',action:()=>changeItems(ids,{trashed:true})});
  if(allTrash)actions.push({label:ids.length>1?'永久删除所选 '+ids.length+' 条':'永久删除',icon:'trash',danger:true,action:()=>requestPurge(ids)});
  return actions;
 }
 const viewButton=target.closest('[data-view]');if(viewButton)return [{label:'打开'+(titles[viewButton.dataset.view]||'收藏'),icon:'folder',action:()=>viewButton.click()},...(viewButton.dataset.view==='trashed'&&items.some(i=>i.trashed)?[null,{label:'清空回收站',icon:'trash',danger:true,action:()=>requestPurge()}]:[])];
 const folder=target.closest('.sidebar .group');if(folder){const {kind,name}=folder.dataset;return [{label:'打开'+name,icon:'folder',action:()=>folder.click()},null,{label:'重命名',action:()=>manageGroup(kind,name,false)},{label:kind==='folder'?'删除收藏夹':'删除标签',danger:true,action:()=>manageGroup(kind,name,true)}];}
 if(doc!==document)return [{label:'全选正文',action:()=>{const range=doc.createRange();range.selectNodeContents(doc.body);const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);}}];
 return [{label:'刷新内容库',icon:'refresh',action:()=>{archiveCache.invalidate();return refresh();}},...(view==='trashed'&&items.some(i=>i.trashed)?[{label:'清空回收站',icon:'trash',danger:true,action:()=>requestPurge()}]:[]),null,{label:'设置',icon:'settings',action:()=>cmd({action:'open_settings'})}];
}});

disclosure($('#reader-more'),$('#reader-more-menu'),{menu:true});
$('#selection-toggle').onclick=()=>{const active=app.classList.toggle('selection-mode');$('#selection-toggle').setAttribute('aria-pressed',String(active));if(!active){bulk.ids.clear();renderList();}};
for(const [id,icon,label]of [['notebook-open','note','阅读笔记'],['batch-tasks','task','批量导出任务']])if($('#'+id))iconControl($('#'+id),icon,label,true);
$('#annotate-selection')&&iconControl($('#annotate-selection'),'highlight','高亮选区');$('#annotate-note')&&iconControl($('#annotate-note'),'comment','为选区批注');
if($('.annotation-bar')){$('.document-meta').append($('.annotation-bar'));$('.annotation-bar>span')?.remove();}


await run(async()=>{const info=await cmd({action:'info'});if(!info.nativePdf)$('[value=pdf]').disabled=true;await refresh();});
await listen('library-changed',()=>run(refresh));

await listen('reader-find',()=>{if(archive&&!articleEditor?.isOpen())reading.find();});

function applyPreferences(preferences={}){
 if(preferences.theme)applyTheme(preferences.theme);
 if(preferences.readerAppearance){localStorage.setItem('reader-appearance',JSON.stringify(preferences.readerAppearance));window.dispatchEvent(new Event('shiye-reader-appearance-change'));}
 if(preferences.reading){localStorage.setItem('reading-options',JSON.stringify(preferences.reading));reading.preferences(preferences.reading);}
 if(preferences.pdf){localStorage.setItem('pdf-options',JSON.stringify(preferences.pdf));for(const [key,value] of Object.entries(normalizePdfOptions(preferences.pdf))){if(key==='contentTitle')continue;const input=pdfForm.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value;else{input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));}}}}
}
await listen('preferences-changed',e=>applyPreferences(e.payload));
window.addEventListener('storage',e=>{try{if(e.key==='reading-options')applyPreferences({reading:JSON.parse(e.newValue)});if(e.key==='pdf-options')applyPreferences({pdf:JSON.parse(e.newValue)});}catch{}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'&&!articleEditor?.isOpen()&&!document.querySelector('dialog[open]')){e.preventDefault();$('#search').focus();$('#search').select();}if((e.metaKey||e.ctrlKey)&&e.key===','){e.preventDefault();run(()=>cmd({action:'open_settings'}));}});

// Native focus also covers macOS application switching and minimized windows.
if(window.__TAURI_INTERNALS__?.metadata?.currentWindow){const current=getCurrentWindow();await current.onFocusChanged(event=>setReadingWindowActive(event.payload));setReadingWindowActive(await current.isFocused());}
