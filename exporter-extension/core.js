// Shared by the page overlay and extension pages. No commercial runtime code.
globalThis.ArchiveCore = (() => {
  const defaults={format:'md',selectType:'all',side:'right',width:320,reversed:false,expandAll:false,copyToClipboard:false,autoCloseSelector:false,muteExport:false,displayBtns:true,saveAs:false,engine:'chromium',pageSize:'a4',pageOrient:'portrait',margin:'normal',fontSize:100,fontFamily:'default',toc:false,darkMode:false,removePageNumber:false,pageBreakPerPrompt:false,includeConvoLink:true,includeModelName:false,includePerMsgTime:false};
  const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(message) { const result=await chrome.runtime.sendMessage(message); if(!result)throw Error('扩展已重新加载，请刷新 ChatGPT 页面');if(result.error)throw Error(result.error);return result.data; }
  async function preferences(){const {preferences={}}=await chrome.storage.local.get('preferences');return {...defaults,...preferences};}
  async function savePreferences(patch){const current=await preferences();const next={...current,...patch};await chrome.storage.local.set({preferences:next});return next;}
  function filename(title,format,custom){return String(custom||title||'chat').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,120).replace(new RegExp('\\.'+format+'$','i'),'')+'.'+format;}
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
    else await request({action:'downloadText',format:opt.format,text,filename:filename(conversation.title,opt.format,opt.fileName),saveAs:opt.saveAs});
    try{await request({path:'/api/usage',body:{cmd:'record',payload:{format:opt.format}}});}catch{ /* offline text export remains successful */ }
  }
  async function createPdf(conversation,messages,opt,{progress,confirmFallback}={}){
    if(!messages.length)throw Error('请至少选择一条消息');
    const value=payload(conversation,messages,opt);
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
    return request({path:'/api/pdf/v1',body:{cmd:'create',payload:value},filename:filename(conversation.title,'pdf',opt.fileName)});
  }
  return {defaults,request,preferences,savePreferences,escapeHTML,filename,markdown,serialize,payload,exportText,createPdf};
})();
