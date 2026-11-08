const DEFAULT_CONNECTION = {url:'http://127.0.0.1:8765',token:''};
function trusted(sender) {
  if(sender.id !== chrome.runtime.id)return false;
  if(!sender.url)return !sender.tab;
  try{
    const source=new URL(sender.url);
    // Extension pages can also be opened in tabs. A tab is not evidence that
    // the sender is a ChatGPT content script.
    if(source.protocol==='chrome-extension:'&&source.hostname===chrome.runtime.id)return true;
    if(!sender.tab||source.protocol!=='https:')return false;
    return ['https://chatgpt.com','https://chat.openai.com'].some(origin=>
      'Origin' in globalThis ? Origin.from(source.href).isSameOrigin(Origin.from(origin)) : source.origin===origin);
  }catch{return false;}
}
function safeFilename(value){return String(value||'chat').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/^\.+/,'_').slice(0,160);}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if(message.target==='webpage-processor'||['translateBing','edgeEnsure'].includes(message.action))return;
  if(['readingSyncAll','readingGet','readingMutate','readingSync','readingList','readingDownload','readingClip','readingLink','readingBackup','readingImport','readingImage','readingConfigure','readingOpen'].includes(message.action)){
    if(sender.id!==chrome.runtime.id)return;
    globalThis.ShiyeReadingBackground.handleReading(message,sender,{native:async request=>{const r=await chrome.runtime.sendNativeMessage('io.local.archive_reader',request);if(r?.error)throw Error(r.error);if(!r?.data)throw Error('客户端未响应');void ensureClientPresence(r.data,true).catch(()=>{});return r.data;}}).then(data=>respond({data}),e=>respond({error:e.message}));return true;
  }
  if(['webPermissionInfo','webPageRetry','webPageAuthorize','openWebPage','webPageSave','webPageStatus','webPageContinue','webPageCancel','webPageSettings','processorRead','processorProgress'].includes(message.action)){
    if(sender.id!==chrome.runtime.id)return;
    (async()=>{return globalThis.ShiyeWebPageBackground.handleWebPage(message,sender,{native:async request=>{const r=await chrome.runtime.sendNativeMessage('io.local.archive_reader',request);if(r?.error)throw Error(r.error);if(!r?.data)throw Error('客户端未响应');void ensureClientPresence(r.data,true).catch(()=>{});return r.data;}});})().then(data=>respond({data}),e=>respond({error:e.message}));return true;
  }
  if (!trusted(sender)) return;
  (async () => {
    if(message.action==='ensurePage')return ensurePage(message.tabId??sender.tab?.id);
    if(message.action==='clientHello'||message.action==='clientRequest'){
      const request=message.action==='clientHello'?{action:'hello'}:message.request;
      if(!request||!['hello','begin','chunk','commit','abort','export_status'].includes(request.action))throw Error('无效的客户端操作');
      let result;
      try{result=await chrome.runtime.sendNativeMessage('io.local.archive_reader',request);}
      catch(error){throw Error('无法连接拾页，请安装客户端并在“设置 → 浏览器连接”中完成扩展 ID 配对。'+error.message);}
      if(result?.error)throw Error(result.error);
      if(!result?.data)throw Error('拾页未返回有效响应');
      void ensureClientPresence(result.data,true).catch(()=>{});
      return result.data;
    }
    if(message.action==='clientDownload'){
      if(!/^[a-f0-9-]{36}$/.test(message.jobId||''))throw Error('无效的客户端任务ID');
      const native=async request=>{const r=await chrome.runtime.sendNativeMessage('io.local.archive_reader',request);if(r?.error)throw Error(r.error);if(!r?.data)throw Error('客户端未返回下载数据');return r.data;};
      const job=await native({action:'export_status',jobId:message.jobId});
      if(job.status!=='done'||job.delivery!=='browser')throw Error('PDF 尚未准备好供浏览器下载');
      const chunks=[];let offset=0,total;
      do{
        const part=await native({action:'export_chunk',jobId:message.jobId,offset});
        if(!Number.isSafeInteger(part.size)||part.size<=0||part.size>256*1024*1024||part.offset!==offset||!Number.isInteger(part.length)||part.length<=0||part.length>384*1024||typeof part.data!=='string'||part.data.length>524288)throw Error('客户端返回无效的PDF分块');
        if(total!==undefined&&total!==part.size)throw Error('下载期间PDF大小发生变化');total=part.size;
        const bytes=atob(part.data);if(bytes.length!==part.length||offset+bytes.length>total||offset+bytes.length<total&&bytes.length%3!==0)throw Error('PDF分块不完整');
        if(offset===0&&!bytes.startsWith('%PDF-'))throw Error('客户端返回的不是PDF');
        chunks.push(part.data);offset+=bytes.length;
      }while(offset<total);
      const downloadId=await chrome.downloads.download({url:'data:application/pdf;base64,'+chunks.join(''),filename:safeFilename(job.filename),saveAs:message.saveAs===true});
      return {ok:true,downloadId};
    }
    if(message.action==='snapshotResource'){
      const url=new URL(message.url);
      const allowed=['oaistatic.com','oaiusercontent.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host))||url.hostname==='cdn.openai.com'||['chatgpt.com','chat.openai.com'].includes(url.hostname);
      if(url.protocol!=='https:'||url.username||url.password||!allowed)throw Error('不支持的网页资源地址');
      const response=await fetch(url.href,{credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw Error('网页资源 HTTP '+response.status);
      if(Number(response.headers.get('content-length'))>16*1024*1024)throw Error('网页资源超过 16 MiB');
      const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>16*1024*1024)throw Error('网页资源超过 16 MiB');
      let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
      return {base64:btoa(binary),mime:response.headers.get('content-type')||'application/octet-stream'};
    }
    if(message.action==='settings'){await chrome.runtime.openOptionsPage();return {ok:true};}
    if(message.action==='downloadText'){
      if(!['md','txt','json','csv'].includes(message.format)||typeof message.text!=='string')throw Error('不支持的导出格式');
      const mime={md:'text/markdown',txt:'text/plain',json:'application/json',csv:'text/csv'}[message.format];
      await chrome.downloads.download({url:`data:${mime};charset=utf-8,`+encodeURIComponent(message.text),filename:safeFilename(message.filename),saveAs:message.saveAs===true});
      return {ok:true};
    }

    // Only path-based requests belong to the HTTP PDF service.
    // Unknown UI actions must never fall through to its path validation.
    if(message.action)throw Error('扩展后台不支持此操作，请重新加载插件，并关闭后重新打开笔记页');
    const { connection = DEFAULT_CONNECTION } = await chrome.storage.local.get('connection');
    const base = new URL(connection.url);
    if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('服务地址只能包含 HTTP(S) 域名或 IP 和端口');
    if (!/^\/(?:health|api\/(?:usage|pdf\/v1(?:\/[a-f0-9]{32}(?:\/download)?)?))$/.test(message.path||'')) throw Error('无效的服务路径');
    if(message.server && base.origin!==message.server)throw Error('服务器连接已更改，请切换回创建此任务的服务器');
    if(message.download && !/^\/api\/pdf\/v1\/[a-f0-9]{32}\/download$/.test(message.path))throw Error('无效的下载路径');
    const headers = connection.token ? {Authorization:`Bearer ${connection.token}`} : {};
    if (message.body) headers['Content-Type']='application/json';
    let response;
    try{response=await fetch(base.origin+message.path,{method:message.body?'POST':'GET',headers,body:message.body?JSON.stringify(message.body):undefined,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(120000)});}
    catch(error){throw Error('无法连接 PDF 服务 '+base.origin+'。如果使用拾页，请在 PDF 弹窗选择“拾页客户端”；如果使用服务端，请启动该服务并检查地址。');}
    if (message.download) {
      if (!response.ok) throw Error(`下载失败：${response.status}`);
      const bytes=new Uint8Array(await response.arrayBuffer()); let binary='';
      for(let i=0;i<bytes.length;i+=32768) binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
      await chrome.downloads.download({url:'data:application/pdf;base64,'+btoa(binary),filename:safeFilename(message.filename),saveAs:message.saveAs===true});
      return {ok:true};
    }
    const data=await response.json();
    if(!response.ok || (data.errcode && data.errcode!==0)) throw Error(data.errmsg||`服务响应 ${response.status}`);
    if(message.path==='/api/pdf/v1' && data.jobId){
      const {jobs=[]}=await chrome.storage.local.get('jobs');
      await chrome.storage.local.set({jobs:[{id:data.jobId,title:message.body.payload.title,filename:safeFilename(message.filename||'chat.pdf'),server:base.origin,at:Date.now()},...jobs].slice(0,30)});
    }
    return {...data,server:base.origin};
  })().then(data=>respond({data}),error=>respond({error:error.message}));
  return true;
});

// In-flight injection locks only; user state remains in chrome.storage/the page.
const pageRepairs=new Map();
const isChatTab=tab=>{try{return ['https://chatgpt.com','https://chat.openai.com'].includes(new URL(tab.url).origin);}catch{return false;}};
async function ensurePage(tabId){
  if(pageRepairs.has(tabId))return pageRepairs.get(tabId);
  const task=(async()=>{
    const tab=await chrome.tabs.get(tabId);
    if(!isChatTab(tab))throw Error('请先打开 ChatGPT 对话页面');
    try{const health=await chrome.tabs.sendMessage(tabId,{action:'archive-health'});if(health?.version===chrome.runtime.getManifest().version&&health.alive)return {ok:true};}catch{}
    const files=chrome.runtime.getManifest().content_scripts[0].js;
    await chrome.scripting.executeScript({target:{tabId},files});
    return {ok:true,repaired:true};
  })();
  pageRepairs.set(tabId,task);
  try{return await task;}finally{pageRepairs.delete(tabId);}
}
async function refreshOpenPages(){
  if(!chrome.tabs?.query)return;
  const tabs=await chrome.tabs.query({url:['https://chatgpt.com/*','https://chat.openai.com/*']});
  await Promise.allSettled(tabs.filter(tab=>!tab.discarded&&tab.status!=='loading').map(tab=>ensurePage(tab.id)));
}
chrome.runtime.onInstalled?.addListener(()=>void refreshOpenPages().catch(()=>{}));
chrome.runtime.onStartup?.addListener(()=>void refreshOpenPages().catch(()=>{}));
chrome.tabs?.onUpdated?.addListener((tabId,change,tab)=>{if(change.status==='complete'&&isChatTab(tab))void ensurePage(tabId).catch(()=>{});});
// Also covers re-enabling an extension whose old page UI was left behind.
void refreshOpenPages().catch(()=>{});

// Start only after an explicit client operation. Presence-only hosts never wake the app.
let clientPresencePort=null,clientPresenceTask=null,clientPresenceCapable=false,clientPresenceRetries=0;
async function ensureClientPresence(info={},explicit=false){
 if(info.connectionMonitorVersion===1)clientPresenceCapable=true;
 if(!clientPresenceCapable||typeof chrome.runtime.connectNative!=='function'||clientPresencePort)return;
 if(clientPresenceTask)return clientPresenceTask;
 if(explicit)clientPresenceRetries=0;
 clientPresenceTask=(async()=>{
  const ua=globalThis.navigator?.userAgent||'';
  let browser=/Edg\//.test(ua)?'Edge':/OPR\//.test(ua)?'Opera':/Chromium\//.test(ua)?'Chromium':'Chrome / Chromium';
  try{if(await globalThis.navigator?.brave?.isBrave?.())browser='Brave';}catch{}
  const port=chrome.runtime.connectNative('io.local.archive_reader');clientPresencePort=port;let timer,deadline,closed=false;
  const stop=()=>{clearInterval(timer);clearTimeout(deadline);};
  const finish=()=>{if(closed)return;closed=true;stop();if(clientPresencePort===port)clientPresencePort=null;if(clientPresenceRetries++<2)setTimeout(()=>void ensureClientPresence().catch(()=>{}),2000);};
  const close=()=>{finish();try{port.disconnect();}catch{}};
  const send=value=>{if(closed)return;try{port.postMessage(value);}catch{close();}};
  port.onMessage.addListener(reply=>{
   if(reply?.error){close();return;}
   if(reply?.data?.protocol===1){clearTimeout(deadline);if(!timer)timer=setInterval(()=>send({action:'connection_heartbeat'}),3000);clientPresenceRetries=0;}
   if(typeof reply?.data?.readingRevision==='string')void globalThis.ShiyeReadingBackground.autoSyncReading(reply.data.readingRevision).catch(()=>{});
   if(typeof reply?.data?.challenge==='string')send({action:'connection_pong',nonce:reply.data.challenge});
  });
  port.onDisconnect.addListener(()=>{void chrome.runtime.lastError;finish();});
  deadline=setTimeout(close,5000);
  send({action:'connection_open',version:chrome.runtime.getManifest().version,browser});
 })();
 try{await clientPresenceTask;}finally{clientPresenceTask=null;}
}
