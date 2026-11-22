import './sync-indicator.css';
export function describeSync(value={},running=false){
 if(running)return {kind:'running',label:'正在同步',detail:'正在交换本机与 iCloud Drive 目录中的数据…'};
 if(typeof value.enabled!=='boolean')return {kind:'unknown',label:'同步状态不可用',detail:'暂时无法读取同步状态，请稍后重试。'};
 if(!value.enabled)return {kind:'off',label:'iCloud 同步已关闭',detail:'点击前往设置开启同步。'};
 if(value.error){const waiting=/等待|未就绪|未下载|下载.*重试/.test(value.error);return {kind:waiting?'waiting':'error',label:waiting?'等待 iCloud':'同步失败',detail:String(value.error)};}
 if(!value.lastSync)return {kind:'waiting',label:'等待首次同步',detail:'客户端将自动检查，也可点击立即同步。'};
 return {kind:'ready',label:'本机同步完成',detail:`上次同步：${new Date(value.lastSync).toLocaleString()}。iCloud 上传和其他设备接收仍由系统处理。点击立即同步。`};
}
export function paintSync(node,value,running=false){const state=describeSync(value,running);node.dataset.state=state.kind;node.setAttribute('aria-busy',String(running));node.title=state.detail;node.querySelector('[data-sync-label]').textContent=state.label;return state;}
export function mountSyncIndicator({cmd,listen}){
 const button=document.createElement('button');button.id='library-sync';button.className='sync-indicator';button.type='button';button.innerHTML='<span class="sync-dot" aria-hidden="true"></span><span><strong data-sync-label>正在读取同步状态</strong><small data-sync-time></small></span>';
 document.querySelector('.local-label').replaceWith(button);
 let value={},running=false,disposed=false,release=null,refreshing=false;
 function render(){const state=paintSync(button,value,running);button.disabled=running;button.setAttribute('aria-label',`${state.label}，${running?'请稍候':value.enabled?'立即同步':'打开同步设置'}`);button.querySelector('[data-sync-time]').textContent=state.kind==='ready'?new Date(value.lastSync).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):state.kind==='error'?'点击重试':state.kind==='waiting'?'自动重试中':state.kind==='off'?'离线内容库':'iCloud Drive';}
 async function refresh(){if(disposed||running||refreshing)return;refreshing=true;try{const next=await cmd({action:'sync_status'});if(!disposed&&!running){value=next;render();}}catch(e){if(!disposed&&!running){value={enabled:true,error:String(e)};render();}}finally{refreshing=false;}}
 button.onclick=async()=>{if(running)return;if(!value.enabled){await cmd({action:'open_settings',section:'data'});return;}running=true;render();try{value=await cmd({action:'sync_now'});}catch(e){value={...value,error:String(e)};}finally{running=false;if(!disposed)render();}};
 void listen('sync-state',event=>{if(disposed)return;running=event.payload.running===true;if(typeof event.payload.enabled==='boolean')value=event.payload;render();}).then(fn=>{if(disposed)fn();else release=fn;}).catch(()=>{});
 const timer=setInterval(()=>{if(!document.hidden)void refresh();},10000);window.addEventListener('focus',refresh);window.addEventListener('pagehide',()=>{disposed=true;clearInterval(timer);release?.();window.removeEventListener('focus',refresh);},{once:true});void refresh();
}
