// Shared by the page overlay and extension pages. No commercial runtime code.
globalThis.ArchiveCore = (() => {
  const defaults={format:'md',selectType:'all',side:'right',width:320,reversed:false,expandAll:false,copyToClipboard:false,autoCloseSelector:false,muteExport:false,displayBtns:true,saveAs:false,pdfTarget:'client',saveToClient:true,engine:'chromium',pageSize:'a4',pageOrient:'portrait',margin:'normal',fontSize:100,fontFamily:'default',outline:true,toc:false,darkMode:false,removePageNumber:false,pageBreakPerPrompt:false,includeConvoLink:true,includeModelName:false,includePerMsgTime:false};
  const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function connectionError(error){
    if(/context invalidated/i.test(error?.message||'')){
      globalThis.__archiveOverlay?.markDisconnected?.();
      return Error(globalThis.location?.protocol==='chrome-extension:'?'此扩展页面已失效，请关闭后重新打开，客户端无需重新配对':'扩展已更新，正在恢复网页连接。若按钮未恢复，请从浏览器工具栏点击“选择消息”重新连接，无需检查客户端设置');
    }
    return error;
  }
  async function request(message) {
    let result;
    try{result=await chrome.runtime.sendMessage(message);}
    catch(error){
      throw connectionError(error);
    }
    if(!result)throw Error('扩展后台未返回响应。请在扩展管理页重新加载扩展，并关闭后重新打开此设置页');
    if(result.error)throw Error(result.error);
    if(!Object.prototype.hasOwnProperty.call(result,'data'))throw Error('扩展后台返回了无效响应，请确认加载的是 exporter-extension 目录');
    return result.data;
  }
  async function preferences(){try{const {preferences={}}=await chrome.storage.local.get('preferences');return {...defaults,...preferences};}catch(error){throw connectionError(error);}}
  async function savePreferences(patch){try{const current=await preferences();const next={...current,...patch};await chrome.storage.local.set({preferences:next});return next;}catch(error){throw connectionError(error);}}
  function filename(title,format,custom){
    const now=new Date(),pad=value=>String(value).padStart(2,'0');
    const stamp=String(now.getFullYear())+pad(now.getMonth()+1)+pad(now.getDate())+'-'+pad(now.getHours())+pad(now.getMinutes())+pad(now.getSeconds());
    const name=custom||String(title||'chat').slice(0,80)+'_'+stamp;
    return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,140).replace(new RegExp('\\.'+format+'$','i'),'')+'.'+format;
  }
  function markdownHeading(markdown){
    const lines=String(markdown||'').replace(/<!--[\s\S]*?(?:-->|$)/g,'').split(/\r?\n/);let fence=null,best=null;
    const add=(level,text)=>{
      text=text.replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]*>/g,'').replace(/(\*\*|__|~~)(.*?)\1/g,'$2').replace(/(^|[\s(])([*_])(\S(?:.*?\S)?)\2(?=$|[\s).,!?:;])/g,'$1$3').replace(/`+([^`]+)`+/g,'$1').replace(/\\([\\`*_{}[\]()#+\-.!])/g,'$1').replace(/\s+/g,' ').trim();
      if(text&&(!best||level<best.level))best={level,text};
    };
    for(let i=0;i<lines.length;i++){
      const line=lines[i],marker=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if(fence){if(marker&&marker[1][0]===fence.char&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;continue;}
      if(marker){fence={char:marker[1][0],length:marker[1].length};continue;}
      if(/^(?: {4}|\t)/.test(line))continue;
      const atx=line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
      if(atx){add(atx[1].length,atx[2].replace(/[ \t]+#+[ \t]*$/,''));continue;}
      const underline=lines[i+1]?.match(/^ {0,3}(=+|-+)[ \t]*$/);
      if(underline&&line.trim()&&!/^\s*(?:>|[-+*]\s|\d+[.)]\s|#{1,6}\s)/.test(line)){add(underline[1][0]==='='?1:2,line);i++;}
    }
    return best;
  }
  function selectionTitle(conversation,messages){
    if(messages.length!==1||messages[0].role!=='assistant')return conversation.title;
    const message=messages[0],source=message.markdownFromDom?null:markdownHeading(message.markdown),visible=message.filenameHeading;
    const heading=visible?.text&&(!source||visible.level<=source.level)?visible:source;
    return heading?.text||conversation.title;
  }
  function markdown(conversation,messages,opt){return '# '+(opt.contentTitle||conversation.title)+'\n\n'+(opt.includeConvoLink?conversation.url+'\n\n':'')+messages.map(m=>'## '+(m.role==='user'?'用户':'助手')+'\n\n'+m.markdown.trim()).join('\n\n---\n\n');}
  function serialize(conversation,messages,opt){
    if(opt.format==='json')return JSON.stringify({...conversation,messages:messages.map(({html,...m})=>m)},null,2);
    if(opt.format==='txt')return (opt.contentTitle||conversation.title)+'\n\n'+messages.map(m=>(m.role==='user'?'用户':'助手')+'\n'+(m.text||m.markdown)).join('\n\n');
    if(opt.format==='csv'){const quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';return '\ufeff'+[['role','content','time','model'],...messages.map(m=>[m.role,m.markdown,m.createTime,m.model])].map(row=>row.map(quote).join(',')).join('\r\n');}
    return markdown(conversation,messages,opt);
  }
  function payload(conversation,messages,opt){
    const title=opt.contentTitle||conversation.title;
    const value={engine:opt.engine,title,options:{...opt,contentTitle:title,removeBrand:true},exportInfo:{name:title,convoLink:conversation.url},messages:messages.map(({html,text,...m})=>({...m,heading:m.role==='user'?'用户':'助手'}))};
    if(opt.engine==='chromium'){
      const missing=messages.filter(m=>!m.html).length;
      value.webDocument={html:`<main><h1>${escapeHTML(title)}</h1>${messages.map(m=>`<section data-role="${m.role}"><h2>${m.role==='user'?'用户':'助手'}</h2>${m.html||'<div data-local-pdf-markdown="true"><pre>'+escapeHTML(m.markdown)+'</pre></div>'}</section>`).join('')}${opt.includeConvoLink?`<p>${escapeHTML(conversation.url)}</p>`:''}</main>`,css:`body{font:16px/1.7 system-ui;background:${opt.darkMode?'#151a1a':'#fff'};color:${opt.darkMode?'#eee':'#172323'}}main{padding:24px}section{margin:32px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #888;padding:6px}${opt.pageBreakPerPrompt?'section[data-role="user"]:not(:first-of-type){break-before:page}':''}`,width:900,theme:opt.darkMode?'dark':'light',messageCount:messages.length,domCount:messages.length-missing,fallbackCount:missing,warnings:missing?[`${missing} 条未加载消息由服务端重新排版补全`]:[]};
    }
    return value;
  }
  async function exportText(conversation,messages,opt){
    if(!messages.length)throw Error('请至少选择一条消息');
    const text=serialize(conversation,messages,opt);
    if(opt.copyToClipboard)await navigator.clipboard.writeText(text);
    else await request({action:'downloadText',format:opt.format,text,filename:filename(selectionTitle(conversation,messages),opt.format,opt.fileName),saveAs:opt.saveAs});
    try{await request({path:'/api/usage',body:{cmd:'record',payload:{format:opt.format}}});}catch{ /* offline text export remains successful */ }
  }
  async function createPdf(conversation,messages,opt,{progress,confirmFallback}={}){
    if(!messages.length)throw Error('请至少选择一条消息');
    const exportFilename=filename(selectionTitle(conversation,messages),'pdf',opt.fileName);
    const value=payload(conversation,messages,{...opt,fileName:exportFilename});
    if(opt.engine==='chromium'){
      if(!globalThis.ArchiveWebSnapshot)throw Error('请重新加载扩展并刷新 ChatGPT 页面，以启用网页原貌捕获');
      const originalUrl=location.href;
      if(originalUrl!==conversation.url)throw Error('对话页面已切换，请重新选择消息');
      const previous=ArchiveSnapshotAdapter.exportProgress;
      ArchiveSnapshotAdapter.exportProgress=text=>{if(location.href!==originalUrl)throw Error('捕获过程中对话页面已切换，请重新导出');progress?.(text);};
      try{
        value.webDocument=await ArchiveWebSnapshot.capture({title:opt.contentTitle||conversation.title,options:opt,messages:messages.map(m=>({...m,turnId:m.turnId||m.id,messageIds:[...new Set([m.id,...(m.messageIds||[])])]}))});
      }finally{ArchiveSnapshotAdapter.exportProgress=previous;}
      if(location.href!==originalUrl)throw Error('捕获过程中对话页面已切换，请重新导出');
      if(value.webDocument.fallbackCount){
        const health=await request({path:'/health'});
        if(!health.supportsMarkdownFallback)throw Error('服务器不支持 Markdown 排版补全，请升级至支持该能力的服务版本，或等待消息在网页加载后重试');
        if(confirmFallback && !await confirmFallback(value.webDocument))throw Error('已取消导出，尚未提交 PDF 任务');
      }
    }
    progress?.('正在提交 PDF…');
    return request({path:'/api/pdf/v1',body:{cmd:'create',payload:value},filename:exportFilename});
  }
  async function saveClient(conversation,messages,opt,{progress}={}){
    if(!messages.length)throw Error('请至少选择一条消息');
    progress?.('正在检测并唤起拾页客户端…');
    const hello=await request({action:'clientHello'});
    if(opt.exportRequest&&!hello.nativePdfJobs)throw Error('请将拾页客户端升级至0.2.0或以上，以支持网页直接导出PDF');
    if(opt.exportRequest?.options&&hello.pdfOptionsVersion!==1)throw Error('请将拾页客户端升级至0.2.0或以上，以支持高级PDF设置');
    if(opt.exportRequest?.saveToLibrary===false&&!hello.pdfOnly)throw Error('仅导出PDF需要拾页0.3.1或以上版本，请升级客户端；本次未提交内容');
    if(location.href!==conversation.url)throw Error('对话页面已切换，请重新选择消息');
    const title=opt.exportRequest?(opt.contentTitle||selectionTitle(conversation,messages)):selectionTitle(conversation,messages),previous=ArchiveSnapshotAdapter.exportProgress;
    ArchiveSnapshotAdapter.exportProgress=progress;
    let snapshot;
    try{snapshot=await ArchiveWebSnapshot.capture({title,options:opt,messages:messages.map(m=>({...m,turnId:m.turnId||m.id,messageIds:[...new Set([m.id,...(m.messageIds||[])])]}))});}
    finally{ArchiveSnapshotAdapter.exportProgress=previous;}
    if(location.href!==conversation.url)throw Error('捕获过程中对话页面已切换，请重新选择消息');
    if(snapshot.fallbackCount)throw Error('部分消息未能读取完整网页。请让这些消息在网页中加载后重试，以保证客户端原貌完整。');
    progress?.(opt.exportRequest?.saveToLibrary===false?'正在提交 PDF 导出任务…':'正在保存到拾页…');
    const archive={version:1,title,url:conversation.url,source:'chatgpt',capturedAt:new Date().toISOString(),snapshot,messages:messages.map(({html,...message})=>message)};
    if(opt.exportRequest)archive.exportRequest=opt.exportRequest;
    return saveArchive(archive,{progress});
  }
  async function saveArchive(archive,{progress,cancelled=()=>false}={}){
    const bytes=new TextEncoder().encode(JSON.stringify(archive));
    if(bytes.length>256*1024*1024)throw Error('收藏内容超过256MiB');
    const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const native=value=>request({action:'clientRequest',request:value});
    if(cancelled())throw Error('已取消保存');
    const {upload}=await native({action:'begin',size:bytes.length,sha256});
    try{
    // Chunk before crossing either extension messaging or native messaging.
    for(let offset=0;offset<bytes.length;offset+=384*1024){
      if(cancelled())throw Error('已取消保存');
      const chunk=bytes.subarray(offset,offset+384*1024);let binary='';
      for(let i=0;i<chunk.length;i+=32768)binary+=String.fromCharCode(...chunk.subarray(i,i+32768));
      await native({action:'chunk',upload,offset,data:btoa(binary)});
      await progress?.('正在保存到拾页… '+Math.round(Math.min(bytes.length,offset+chunk.length)/bytes.length*100)+'%');
    }
    if(cancelled())throw Error('已取消保存');
    await progress?.('正在完成保存…',{committing:true});
    if(cancelled())throw Error('已取消保存');
    return await native({action:'commit',upload});
    }catch(e){try{await native({action:'abort',upload});}catch{}throw e;}
  }
  return {defaults,request,saveArchive,preferences,savePreferences,escapeHTML,filename,selectionTitle,markdown,serialize,payload,exportText,createPdf,saveClient};
})();
