const DEFAULT_CONNECTION = {url:'http://127.0.0.1:8765',token:''};
function trusted(sender) {
  if(sender.id !== chrome.runtime.id)return false;
  if(!sender.tab)return true;
  try{return ['https://chatgpt.com','https://chat.openai.com'].includes(new URL(sender.url).origin);}catch{return false;}
}
function safeFilename(value){return String(value||'chat').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/^\.+/,'_').slice(0,160);}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!trusted(sender)) return;
  (async () => {
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

    const { connection = DEFAULT_CONNECTION } = await chrome.storage.local.get('connection');
    const base = new URL(connection.url);
    if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('服务地址只能包含 HTTP(S) 域名或 IP 和端口');
    if (!/^\/(?:health|api\/(?:usage|pdf\/v1(?:\/[a-f0-9]{32}(?:\/download)?)?))$/.test(message.path||'')) throw Error('无效的服务路径');
    if(message.server && base.origin!==message.server)throw Error('服务器连接已更改，请切换回创建此任务的服务器');
    if(message.download && !/^\/api\/pdf\/v1\/[a-f0-9]{32}\/download$/.test(message.path))throw Error('无效的下载路径');
    const headers = connection.token ? {Authorization:`Bearer ${connection.token}`} : {};
    if (message.body) headers['Content-Type']='application/json';
    const response = await fetch(base.origin+message.path,{method:message.body?'POST':'GET',headers,body:message.body?JSON.stringify(message.body):undefined,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(120000)});
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
