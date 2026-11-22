import {paintSync} from './sync-indicator.js';
export function mountSync({cmd,listen}) {
 const panel=document.createElement('fieldset');
 panel.innerHTML='<legend>iCloud Drive 同步</legend><label class="setting-choice"><input id="icloud-enabled" type="checkbox"><span><strong>同步收藏与阅读数据</strong><small>开启后在 iCloud Drive 创建“拾页”文件夹。同步网页快照、收藏整理、阅读进度、笔记、高亮、正文编辑稿及删除记录。</small></span></label><p class="setting-note">请在每台 Mac 上登录同一 Apple 账号并开启 iCloud Drive。客户端运行期间每 30 秒检查一次；关闭此开关会保留本机和云端已有数据。</p><p class="setting-note">同一收藏同时修改时，后同步的版本优先；阅读笔记按各条修改合并。旧收藏版本保留在云端同步文件中。同步文件由 iCloud Drive 传输，首次同步可能需要等待系统上传或下载。</p><div class="setting-actions"><button id="icloud-now" type="button">立即同步</button></div><p id="icloud-path" class="storage-path"></p><p id="icloud-status" role="status" aria-live="polite"></p>';
 const badge=document.createElement('span');badge.id='icloud-badge';badge.className='sync-indicator';badge.setAttribute('role','status');badge.innerHTML='<span class="sync-dot" aria-hidden="true"></span><span data-sync-label></span>';panel.insertBefore(badge,panel.querySelector('label'));
 document.querySelector('#data').insertBefore(panel,document.querySelector('#data fieldset'));
 const toggle=panel.querySelector('#icloud-enabled'),button=panel.querySelector('#icloud-now'),status=panel.querySelector('#icloud-status');let busy=false,remoteRunning=false;
 function render(v){paintSync(badge,v,busy||remoteRunning);toggle.disabled=busy||remoteRunning;toggle.checked=v.enabled===true;button.disabled=busy||remoteRunning||!v.enabled;panel.querySelector('#icloud-path').textContent=v.path||'';status.textContent=v.error?`同步未完成：${v.error}`:v.enabled?(v.lastSync?`上次本机同步：${new Date(v.lastSync).toLocaleString()}。iCloud 上传和下载由系统继续处理。`:'已开启，等待首次同步。'):'同步已关闭。';}
 async function refresh(){if(busy||remoteRunning)return;try{render(await cmd({action:'sync_status'}));}catch(e){status.textContent=String(e);}}
 async function run(configure){if(busy||remoteRunning)return;busy=true;toggle.disabled=button.disabled=true;status.textContent='正在同步…';paintSync(badge,{enabled:true},true);let failure='';try{let v;if(configure){v=await cmd({action:'sync_configure',enabled:toggle.checked});}if(!configure||toggle.checked)v=await cmd({action:'sync_now'});render(v);}catch(e){failure=String(e);status.textContent=failure;}finally{busy=false;toggle.disabled=false;try{render(await cmd({action:'sync_status'}));}catch{} if(failure)status.textContent=`同步未完成：${failure}`; }}
 void listen('sync-state',e=>{remoteRunning=e.payload.running===true;if(remoteRunning){paintSync(badge,e.payload,true);button.disabled=toggle.disabled=true;}else if(!busy){render(e.payload);}}).catch(()=>{});
 toggle.onchange=()=>run(true);button.onclick=()=>run(false);void refresh();
 const timer=setInterval(()=>{if(!document.hidden&&!document.querySelector('#data').hidden)void refresh();},5000);
 window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
}
