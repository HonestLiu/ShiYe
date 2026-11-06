import '../../exporter-extension/custom-select.js';
export function mountBulk({cmd,run,status,getItems,getVisible,refresh,openExport}){
 const ids=new Set(),$=s=>document.querySelector(s);
 const tools=document.createElement('div');tools.className='list-tools';tools.innerHTML='<label class="select-visible"><input type="checkbox" id="select-visible">全选当前结果</label><label class="sort-control"><span class="sr-only">收藏排序</span><select aria-label="收藏排序" name="sort"><option value="newest">最近保存</option><option value="oldest">最早保存</option><option value="title">标题顺序</option></select></label>';
 $('.search').after(tools);
 const bar=document.createElement('div');bar.className='bulk-bar';bar.hidden=true;bar.innerHTML='<div class="bulk-summary"><strong id="chosen-count"></strong><button id="clear-chosen">清空选择</button></div><div class="bulk-actions"><button data-bulk-state="read:true">标为已读</button><button data-bulk-state="read:false">标为未读</button><button data-bulk-state="starred:true">添加星标</button><button data-bulk-state="starred:false">取消星标</button><button data-bulk-state="trashed:true">移入回收站</button><button data-bulk-state="trashed:false">恢复收藏</button><button id="bulk-organize">整理</button><button id="bulk-export" class="primary">导出所选</button></div>';
 tools.after(bar);
 const taskButton=document.createElement('button');taskButton.id='batch-tasks';taskButton.textContent='批量导出任务';$('.sidebar-bottom').prepend(taskButton);
 const organize=document.createElement('dialog');organize.id='bulk-dialog';organize.setAttribute('aria-labelledby','bulk-dialog-title');organize.innerHTML='<form id="bulk-form"><header><h2 id="bulk-dialog-title">批量整理</h2><button type="button" data-close aria-label="关闭">×</button></header><p>为选中的收藏设置收藏夹，或追加标签。已有标签会保留。</p><label class="service-choice"><input id="bulk-change-folder" type="checkbox">修改收藏夹</label><input id="bulk-folder" aria-label="目标收藏夹" maxlength="100" placeholder="留空将移出原收藏夹"><label for="bulk-tags">追加标签（逗号分隔）</label><input id="bulk-tags" maxlength="500"><footer><button type="button" data-close>取消</button><button class="primary">保存整理</button></footer></form>';
 const tasks=document.createElement('dialog');tasks.id='batch-dialog';tasks.setAttribute('aria-labelledby','batch-dialog-title');tasks.innerHTML='<header><h2 id="batch-dialog-title">批量导出任务</h2><button type="button" data-close aria-label="关闭">×</button></header><p class="subtle">可以关闭此窗口，后台会继续导出。取消会停止后续文件，当前文件处理结束后取消。</p><p id="batch-status" role="status" aria-live="polite"></p><div id="batch-list"></div>';
 document.body.append(organize,tasks);
 for(const d of [organize,tasks])for(const b of d.querySelectorAll('[data-close]'))b.onclick=()=>d.close();
 const sortInput=tools.querySelector('select');sortInput.value=localStorage.getItem('collection-sort')||'newest';globalThis.ArchiveCustomSelect.enhance(tools);
 tools.addEventListener('change',e=>{if(e.target===sortInput){localStorage.setItem('collection-sort',sortInput.value);renderList();}});
 const sort=values=>[...values].sort((a,b)=>sortInput.value==='title'?a.title.localeCompare(b.title,'zh-CN'):sortInput.value==='oldest'?a.savedAt-b.savedAt:b.savedAt-a.savedAt);
 function renderList(){refresh(false);}
 function update(){for(const id of ids)if(!getItems().some(i=>i.id===id))ids.delete(id);bar.hidden=!ids.size;const hidden=[...ids].filter(id=>!getVisible().some(i=>i.id===id)).length;$('#chosen-count').textContent=`已选 ${ids.size} 条`+(hidden?`（${hidden} 条在其他结果中）`:'');
  const visible=getVisible(),count=visible.filter(i=>ids.has(i.id)).length;const input=$('#select-visible');input.checked=visible.length>0&&count===visible.length;input.indeterminate=count>0&&count<visible.length;input.disabled=!visible.length;
 }
 const toggle=id=>{const focused=document.activeElement?.dataset.itemId===id;ids.has(id)?ids.delete(id):ids.add(id);renderList();if(focused)document.querySelector(`[data-item-id="${CSS.escape(id)}"]`)?.focus();};
 $('#select-visible').onchange=e=>{for(const i of getVisible())if(e.target.checked)ids.add(i.id);else ids.delete(i.id);renderList();};
 $('#clear-chosen').onclick=()=>{ids.clear();renderList();};
 for(const b of bar.querySelectorAll('[data-bulk-state]'))b.onclick=()=>run(async()=>{const [key,value]=b.dataset.bulkState.split(':');const result=await cmd({action:'batch_update',ids:[...ids],patch:{[key]:value==='true'}});await refresh();status(`已更新 ${result.count} 条收藏`);});
 $('#bulk-organize').onclick=()=>{organize.querySelector('h2').textContent=`整理 ${ids.size} 条收藏`;$('#bulk-change-folder').checked=false;$('#bulk-folder').value='';$('#bulk-tags').value='';organize.showModal();};
 $('#bulk-form').onsubmit=e=>{e.preventDefault();run(async()=>{const patch={},tagsAdd=$('#bulk-tags').value.trim();if($('#bulk-change-folder').checked)patch.folder=$('#bulk-folder').value.trim();if(!Object.keys(patch).length&&!tagsAdd)throw Error('请选择修改收藏夹或填写追加标签');const result=await cmd({action:'batch_update',ids:[...ids],patch,tagsAdd});await refresh();organize.close();status(`已整理 ${result.count} 条收藏`);});};
 $('#bulk-export').onclick=()=>openExport([...ids]);
 let timer;tasks.addEventListener('close',()=>clearTimeout(timer));
 async function refreshBatches(){
  clearTimeout(timer);const batches=await cmd({action:'batch_list'});const list=$('#batch-list');const opened=new Set([...list.querySelectorAll('.batch-entry')].filter(n=>n.querySelector('details')?.open).map(n=>n.dataset.batchId));const summary=batches.some(b=>b.active)?`${batches.filter(b=>b.active).length} 个批次正在处理`:'所有批次已结束';if($('#batch-status').textContent!==summary)$('#batch-status').textContent=summary;list.replaceChildren();
  if(!batches.length){const p=document.createElement('p');p.textContent='还没有批量导出任务。请在列表中勾选收藏，然后点击“导出所选”。';list.append(p);return;}
  for(const batch of batches){const section=document.createElement('section');section.className='batch-entry';section.dataset.batchId=batch.batchId;const h=document.createElement('h3');h.textContent=batch.active?(batch.cancelRequested?'正在取消':'正在导出'):batch.failed?'有文件导出失败':batch.cancelled?'任务已取消':'导出完成';const p=document.createElement('p');p.textContent=`${batch.done}/${batch.total} 已完成`+(batch.failed?`，${batch.failed} 失败`:'')+(batch.cancelled?`，${batch.cancelled} 取消`:'');const location=document.createElement('p');location.className='subtle batch-path';location.textContent=batch.directory;section.append(h,p,location);
   const progress=document.createElement('progress');progress.max=batch.total;progress.value=batch.total-batch.active;progress.setAttribute('aria-label','批量导出进度');section.append(progress);
   if(batch.active&&!batch.cancelRequested){const cancel=document.createElement('button');cancel.textContent='取消此批次';cancel.onclick=()=>run(async()=>{await cmd({action:'batch_cancel',batchId:batch.batchId});await refreshBatches();});section.append(cancel);}
   const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='文件与状态';details.open=opened.has(batch.batchId);details.append(summary);for(const job of batch.jobs){const row=document.createElement('p');row.textContent=({'queued':'等待','processing':'正在处理','done':'完成','failed':'失败','cancelled':'取消'}[job.status]||job.status)+'　'+job.filename+(job.error?'：'+job.error:'');row.className=job.status==='failed'?'batch-error':'';details.append(row);}section.append(details);list.append(section);
  }
  if(tasks.open&&batches.some(b=>b.active))timer=setTimeout(()=>run(refreshBatches),1000);
 }
 async function showBatches(){tasks.showModal();await refreshBatches();}
 taskButton.onclick=()=>run(showBatches);
 return {ids,sort,update,toggle,showBatches};
}
