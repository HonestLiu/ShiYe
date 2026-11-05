import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {open,save} from '@tauri-apps/plugin-dialog';
import {mountReader,cleanSnapshot,printDocument} from './reader.js';
import {pdfSettingsMarkup,readPdfOptions,normalizePdfOptions} from './pdf-options.js';
import '../../exporter-extension/custom-select.js';
import './style.css';
const app=document.querySelector('#app');
app.innerHTML=`<aside class="sidebar"><div class="brand"><span class="brand-icon">▤</span><strong>拾页</strong></div><p class="sidebar-hint">留住值得再读的内容</p><nav aria-label="内容库"><button data-view="all" class="active">全部收藏<span id="total">0</span></button><button data-view="unread">未读</button><button data-view="starred">星标</button><button data-view="read">已读</button><button data-view="trashed">回收站</button></nav><div class="section-label">收藏夹与标签</div><div id="groups"></div><div class="sidebar-bottom"><button id="import">导入内容</button><button id="settings">连接与备份</button><span class="local-label">保存在这台电脑</span></div></aside><section class="collection" aria-label="收藏列表"><header><h1 id="view-title">全部收藏</h1><button id="refresh" class="icon" aria-label="刷新">↻</button></header><div class="search"><input id="search" type="search" placeholder="搜索标题、正文、标签" aria-label="搜索收藏"></div><p id="list-count"></p><div id="items" role="list"></div></section><main class="reader"><div id="empty"><div class="empty-mark">▤</div><h2>为下一次阅读留一页</h2><p>在 ChatGPT 选择消息并保存到客户端，<br>或导入已有的归档文件。</p><button id="empty-connect">连接浏览器扩展</button></div><section id="document" hidden><header class="reader-header"><div><p id="source"></p><h2 id="title"></h2></div><div class="reader-tools"><button id="star" class="icon" aria-label="切换星标">☆</button><button id="mark-read">标为已读</button><button id="edit">整理</button><button id="toc-toggle" aria-expanded="true">目录</button><button id="export" class="primary">导出</button></div></header><div class="document-meta"><button id="source-link">查看原文</button><span id="saved-at"></span><button id="trash">移到回收站</button></div><p id="warnings" hidden></p><div class="reading-area"><iframe id="frame" sandbox="allow-same-origin" title="收藏的网页原貌" referrerpolicy="no-referrer"></iframe><nav id="toc" aria-label="文章目录"></nav></div></section></main><p id="status" role="status" aria-live="polite"></p><dialog id="settings-dialog"><form method="dialog"><header><h2>连接与备份</h2><button aria-label="关闭">×</button></header><p>安装扩展后，在扩展设置页复制 ID，粘贴到这里完成连接。之后保存内容时会自动启动拾页。</p><label for="extension-id">扩展 ID</label><input id="extension-id" placeholder="32 位字母"><button id="register" type="button" class="primary">连接浏览器</button><p id="connection-status" role="status"></p><hr><h3>内容备份</h3><p>包含网页、资源、收藏夹、标签和阅读状态。</p><button id="backup" type="button">导出完整备份</button><button id="restore" type="button">从备份恢复</button><p id="data-dir" class="subtle"></p></form></dialog><dialog id="edit-dialog"><form id="edit-form"><header><h2>整理收藏</h2><button type="button" data-close="edit-dialog" aria-label="关闭">×</button></header><label for="edit-title">标题</label><input id="edit-title" required maxlength="300"><label for="edit-folder">收藏夹</label><input id="edit-folder" maxlength="100" list="folders"><datalist id="folders"></datalist><label for="edit-tags">标签（逗号分隔）</label><input id="edit-tags" maxlength="500"><label for="edit-notes">备注</label><textarea id="edit-notes" rows="5"></textarea><footer><button type="button" data-close="edit-dialog">取消</button><button class="primary">保存</button></footer></form></dialog><dialog id="export-dialog"><form id="export-form"><header><h2>导出收藏</h2><button type="button" data-close="export-dialog" aria-label="关闭">×</button></header><fieldset><legend>文件格式</legend>${[['pdf','PDF'],['html','离线网页 HTML'],['md','Markdown'],['txt','纯文本'],['json','完整归档 JSON']].map(([v,l])=>`<label class="format"><input type="radio" name="format" value="${v}" ${v==='html'?'checked':''}>${l}</label>`).join('')}</fieldset>${pdfSettingsMarkup()}<p class="subtle">PDF 保持网页原貌，目录书签与目录页独立设置。Markdown 与纯文本不保留网页独有布局。</p><footer><button type="button" data-close="export-dialog">取消</button><button id="export-submit" class="primary">选择保存位置</button></footer></form></dialog>`;
const $=s=>document.querySelector(s),cmd=request=>invoke('command',{request});
const pdfForm=$('#export-form');
let storedPdf={};try{storedPdf=JSON.parse(localStorage.getItem('pdf-options')||'{}');}catch{}
for(const [key,value]of Object.entries(normalizePdfOptions(storedPdf))){const input=pdfForm.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value;else input.value=value;}}
globalThis.ArchiveCustomSelect.enhance(pdfForm);
const updatePdfFields=()=>{pdfForm.querySelector('.advanced-pdf').hidden=new FormData(pdfForm).get('format')!=='pdf';};
pdfForm.addEventListener('change',updatePdfFields);updatePdfFields();
let items=[],selected=null,archive=null,view='all',group='',query='',matches=null,disposeReader=()=>{},selectionRevision=0,searchRevision=0;
const titles={all:'全部收藏',unread:'未读',starred:'星标',read:'已读',trashed:'回收站',folder:'收藏夹',tag:'标签'};
let statusTimer;function status(text){$('#status').textContent=text;$('#status').classList.toggle('visible',!!text);clearTimeout(statusTimer);statusTimer=setTimeout(()=>$('#status').classList.remove('visible'),7000);}
async function run(fn){try{await fn();}catch(e){status(String(e));}}
function button(text,fn,className=''){const n=document.createElement('button');n.textContent=text;n.className=className;n.onclick=()=>run(fn);return n;}
const date=seconds=>new Date(seconds*1000).toLocaleDateString('zh-CN',{year:'numeric',month:'short',day:'numeric'});
function tags(item){return item.tags.split(/[,，]/).map(s=>s.trim()).filter(Boolean);}
async function refresh(){items=await cmd({action:'list'});if(query.trim()){matches=new Set(await cmd({action:'search',query}));}renderList();}
function renderList(){
 $('#total').textContent=items.filter(i=>!i.trashed).length;$('#view-title').textContent=group||titles[view];
 const filtered=items.filter(i=>(view==='trashed'?i.trashed:!i.trashed)&&(view!=='starred'||i.starred)&&(view!=='unread'||!i.read)&&(view!=='read'||i.read)&&(view!=='folder'||i.folder===group)&&(view!=='tag'||tags(i).includes(group))&&(!query||matches?.has(i.id)));
 $('#list-count').textContent=`${filtered.length} 条收藏`;$('#items').replaceChildren();
 for(const item of filtered){const row=button('',()=>select(item.id),'item'+(selected===item.id?' selected':''));row.setAttribute('role','listitem');const h=document.createElement('h2');h.textContent=item.title;const p=document.createElement('p');p.textContent=item.summary||'网页原貌快照';const meta=document.createElement('div');meta.className='item-meta';meta.textContent=(item.starred?'★  ':'')+(item.read?'已读':'未读')+'   '+date(item.savedAt);row.append(h,p,meta);$('#items').append(row);}
 if(!filtered.length){const p=document.createElement('p');p.className='no-items';p.textContent=query?'没有找到匹配内容':'这里还没有收藏';$('#items').append(p);}
 const groups=$('#groups');groups.replaceChildren();for(const [kind,values] of [['folder',new Set(items.filter(i=>!i.trashed).map(i=>i.folder).filter(Boolean))],['tag',new Set(items.filter(i=>!i.trashed).flatMap(tags))]])for(const name of values)groups.append(button((kind==='tag'?'# ':'▱ ')+name,()=>{view=kind;group=name;renderList();},'group'+(view===kind&&group===name?' active':'')));
 for(const b of document.querySelectorAll('[data-view]'))b.classList.toggle('active',b.dataset.view===view);
}
function updateToolbar(){const item=items.find(i=>i.id===selected);if(!item)return;$('#title').textContent=item.title;$('#star').textContent=item.starred?'★':'☆';$('#star').setAttribute('aria-pressed',String(item.starred));$('#mark-read').textContent=item.read?'标为未读':'标为已读';$('#trash').textContent=item.trashed?'恢复收藏':'移到回收站';$('#source').textContent=archive?.source==='chatgpt'?'ChatGPT 对话':'网页收藏';$('#saved-at').textContent='保存于 '+date(item.savedAt);$('#source-link').hidden=!item.url;}
async function select(id){
 const revision=++selectionRevision;const loaded=await cmd({action:'load',id});if(revision!==selectionRevision)return;
 disposeReader();selected=id;archive=loaded;const item=items.find(i=>i.id===id);$('#empty').hidden=true;$('#document').hidden=false;updateToolbar();renderList();
 const warnings=[...(archive.warnings||[]),...(archive.snapshot.warnings||[])];$('#warnings').textContent=[...new Set(warnings)].join('；');$('#warnings').hidden=!warnings.length;
 disposeReader=mountReader($('#frame'),{...archive,progress:item.progress},progress=>{const item=items.find(i=>i.id===id);if(item)item.progress=progress;return run(()=>cmd({action:'update',id,patch:{progress}}));},headings=>{if(id!==selected)return;$('#toc').replaceChildren();for(const h of headings){const b=button(h.text,()=>$('#frame').contentDocument.getElementById(h.id)?.scrollIntoView());b.style.paddingLeft=12+Math.max(0,h.level-1)*10+'px';$('#toc').append(b);}if(!headings.length)$('#toc').textContent='这条收藏没有标题目录';});
}
async function patch(value){if(!selected)return;await cmd({action:'update',id:selected,patch:value});await refresh();updateToolbar();}
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>{view=b.dataset.view;group='';renderList();};
$('#search').oninput=()=>{const revision=++searchRevision;query=$('#search').value;setTimeout(()=>run(async()=>{const result=await cmd({action:'search',query});if(revision!==searchRevision)return;matches=new Set(result);renderList();}),200);};
$('#refresh').onclick=()=>run(refresh);
$('#star').onclick=()=>run(()=>patch({starred:!items.find(i=>i.id===selected).starred}));
$('#mark-read').onclick=()=>run(()=>patch({read:!items.find(i=>i.id===selected).read}));
$('#trash').onclick=()=>run(()=>patch({trashed:!items.find(i=>i.id===selected).trashed}));
$('#toc-toggle').onclick=()=>{const hidden=!$('#toc').hidden;$('#toc').hidden=hidden;$('#toc-toggle').setAttribute('aria-expanded',String(!hidden));};
$('#source-link').onclick=()=>run(()=>cmd({action:'open_source',url:items.find(i=>i.id===selected).url}));
$('#edit').onclick=()=>{const i=items.find(i=>i.id===selected);for(const key of ['title','folder','tags','notes'])$('#edit-'+key).value=i[key];$('#edit-dialog').showModal();};
$('#edit-form').onsubmit=e=>{e.preventDefault();run(async()=>{const patchValue={};for(const key of ['title','folder','tags','notes'])patchValue[key]=$('#edit-'+key).value.trim();if(!patchValue.title)throw Error('请输入标题');await patch(patchValue);$('#edit-dialog').close();});};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$('#'+b.dataset.close).close();
$('#settings').onclick=$('#empty-connect').onclick=()=>$('#settings-dialog').showModal();
$('#register').onclick=()=>run(async()=>{const r=await cmd({action:'register',extensionId:$('#extension-id').value.trim()});$('#connection-status').textContent=r.browsers.length?'已配置：'+r.browsers.join('、')+'。请在扩展设置中检查连接。':'未发现支持的浏览器安装目录，请先打开浏览器后重试。';});
async function importFile(){const path=await open({multiple:false,filters:[{name:'网页归档与备份',extensions:['json','html','htm','readerbackup']}]});if(!path)return;status('正在导入…');const r=await cmd({action:'import_file',path});await refresh();if(r.id)await select(r.id);status(r.duplicate?'内容已在收藏中':r.count?'已恢复 '+r.count+' 条收藏':'已保存到内容库');}
$('#import').onclick=$('#restore').onclick=()=>run(importFile);
$('#backup').onclick=()=>run(async()=>{const path=await save({defaultPath:'拾页备份_'+new Date().toISOString().slice(0,10)+'.readerbackup'});if(!path)return;await cmd({action:'backup',path});status('完整备份已保存');});
$('#export').onclick=()=>{pdfForm.elements.contentTitle.value=items.find(i=>i.id===selected)?.title||'';$('#export-dialog').showModal();};
$('#export-form').onsubmit=e=>{e.preventDefault();run(async()=>{const format=new FormData(e.target).get('format'),item=items.find(i=>i.id===selected);const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','-');const name=item.title.replace(/[\\/:*?"<>|]/g,'_').slice(0,80)+'_'+stamp+'.'+format;const path=await save({defaultPath:name,filters:[{name:format.toUpperCase(),extensions:[format]}]});if(!path)return;const submit=$('#export-submit');submit.disabled=true;try{status('正在生成文件…');if(format==='pdf'){const options=readPdfOptions(pdfForm);localStorage.setItem('pdf-options',JSON.stringify(options));const document=await printDocument(archive,options);await invoke('print_pdf',{...document,path});}else await cmd({action:'export_file',id:selected,format,path,html:format==='html'?cleanSnapshot(archive.snapshot.html):undefined,text:$('#frame').contentDocument?.body.innerText||''});$('#export-dialog').close();status('文件已保存');}finally{submit.disabled=false;}});};
await run(async()=>{const info=await cmd({action:'info'});$('#data-dir').textContent='内容位置：'+info.dataDir;if(!info.nativePdf)$('[value=pdf]').disabled=true;await refresh();});
let processingExports=false;
async function processExports(){
 if(processingExports||document.querySelector('dialog[open]'))return;
 processingExports=true;$('#export').disabled=true;
 try{
  for(;;){
   const jobs=await cmd({action:'pending_exports'});if(!Array.isArray(jobs)||!jobs.length)break;
   const job=jobs[0];const claim=await cmd({action:'claim_export',jobId:job.jobId});if(!claim.claimed)continue;
   try{
    const content=await cmd({action:'load',id:job.itemId});await select(job.itemId);
    status('来自浏览器的 PDF 请求，请选择保存位置');
    const path=await save({defaultPath:job.filename,filters:[{name:'PDF',extensions:['pdf']}]});
    if(!path){await cmd({action:'finish_export',jobId:job.jobId,status:'cancelled'});status('已取消 PDF 保存');continue;}
    status('正在生成 PDF…');const document=await printDocument(content,job.options||{});await invoke('print_pdf',{...document,path});
    await cmd({action:'finish_export',jobId:job.jobId,status:'done',path});status('PDF 已保存');
   }catch(error){await cmd({action:'finish_export',jobId:job.jobId,status:'failed',error:String(error)});status('PDF 导出失败：'+String(error));}
  }
 }finally{processingExports=false;$('#export').disabled=false;}
}
await listen('library-changed',()=>run(async()=>{await refresh();await processExports();}));
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('close',()=>run(processExports));
await run(processExports);
