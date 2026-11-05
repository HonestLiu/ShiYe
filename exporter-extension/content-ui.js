(() => {
  if (globalThis.__archiveOverlay) return;
  const C=ArchiveCore;
  const host=document.createElement('div');
  host.id='conversation-archive';
  const root=host.attachShadow({mode:'open'});
  const roleIcon=ArchiveRoleIcons.install(root);
  const style=document.createElement('link');style.rel='stylesheet';style.href=chrome.runtime.getURL('content.css');root.append(style);
  const toolbar=document.createElement('div');toolbar.className='button-bar';
  toolbar.innerHTML='<div class="split"><button data-action="select">SELECT</button><button data-action="selection-menu" aria-label="选择范围" aria-haspopup="menu">▾</button></div><div class="split"><button data-action="export" disabled>EXPORT</button><button data-action="export-menu" disabled aria-label="选择导出格式" aria-haspopup="menu">▾</button></div>';
  root.append(toolbar);
  const panel=document.createElement('aside');panel.className='selector';panel.hidden=true;panel.setAttribute('aria-label','选择消息');
  panel.innerHTML=`<div class="resize" role="separator" aria-label="调整选择器宽度" aria-orientation="vertical" tabindex="0"></div>
    <header><button data-action="dock" class="icon" title="停靠到左侧" aria-label="停靠到左侧">⇤</button><h2>选择消息</h2><button data-action="reload" class="icon" title="重新读取" aria-label="重新读取">↻</button><button data-action="close" class="icon" title="关闭选择器" aria-label="关闭选择器">×</button></header>
    <div class="tips">Shift 点击可连续选择；点击消息可展开预览。<button data-action="tips" aria-label="隐藏提示">×</button></div>
    <nav aria-label="批量选择"><button data-selection="all">全部</button><button data-selection="questions">提问</button><button data-selection="answers">回答</button><button data-selection="none">清空</button><button data-selection="invert">反选</button></nav>
    <p class="source" role="status"></p><div class="list" tabindex="-1"></div><button class="bottom icon" data-action="bottom" aria-label="滚动到底部" title="滚动到底部">↓</button>
    <footer><div class="summary"><input type="checkbox" aria-label="全选消息" id="archive-all"><span class="count">0/0</span><button data-action="expand">展开</button><button data-action="reverse" class="icon" aria-label="最新消息在前" title="最新消息在前" aria-pressed="false">⇅</button><button data-action="settings" class="icon settings" aria-label="导出设置" title="导出设置">⚙</button></div>
    <div class="actions"><button data-action="close" class="cancel">取消</button><button data-action="format" aria-haspopup="menu">MD ▾</button><button data-action="export" class="primary" disabled>导出</button></div><p class="status" role="status" aria-live="polite"></p></footer>`;
  root.append(panel);
  const state={prefs:{...C.defaults},conversation:{messages:[]},selected:new Set(),expanded:new Set(),open:false,loading:false,busy:false,last:null,href:location.href,revision:0,dialog:null};
  const find=s=>root.querySelector(s);
  const persist=async patch=>{state.prefs={...state.prefs,...patch};await C.savePreferences(patch);};
  const selected=()=>state.conversation.messages.filter(m=>state.selected.has(m.id));
  const message=text=>{find('.status').textContent=text;};

  function layout(){
    const left=state.prefs.side==='left';panel.dataset.side=left?'left':'right';
    panel.style.width=Math.min(innerWidth,Math.max(260,Math.min(800,state.prefs.width)))+'px';
    const dock=find('[data-action=dock]');dock.textContent=left?'⇥':'⇤';dock.title=dock.ariaLabel=left?'停靠到右侧':'停靠到左侧';
    const reverse=find('[data-action=reverse]');reverse.ariaPressed=String(state.prefs.reversed);reverse.title=reverse.ariaLabel=state.prefs.reversed?'最早消息在前':'最新消息在前';
    host.dataset.theme=document.documentElement.classList.contains('dark')||document.documentElement.dataset.theme==='dark'?'dark':'light';
  }
  function update(){
    const total=state.conversation.messages.length,n=selected().length;
    find('.count').textContent=`${n}/${total}`;
    const all=find('#archive-all');all.checked=total>0&&n===total;all.indeterminate=n>0&&n<total;
    for(const input of root.querySelectorAll('[data-message]'))input.checked=state.selected.has(input.dataset.message);
    for(const button of root.querySelectorAll('[data-action=export],[data-action=export-menu]'))button.disabled=!state.open||!n||state.loading||state.busy;
    find('[data-action=format]').textContent=(state.prefs.format==='txt'?'TEXT':state.prefs.format.toUpperCase())+' ▾';
    find('.actions [data-action=export]').textContent=state.busy?'处理中…':state.prefs.format!=='pdf'&&state.prefs.copyToClipboard?'复制':'导出';
    find('.button-bar [data-action=export]').textContent=state.prefs.format!=='pdf'&&state.prefs.copyToClipboard?'COPY':'EXPORT';
    find('[data-action=select]').textContent=state.open?'CANCEL':'SELECT';
    find('[data-action=expand]').textContent=state.expanded.size?'折叠':'展开';
  }
  function render(){
    const list=find('.list');list.replaceChildren();
    const messages=state.prefs.reversed?[...state.conversation.messages].reverse():state.conversation.messages;
    for(const m of messages){
      const row=document.createElement('div');row.className='row '+m.role;
      const label=document.createElement('label');label.className='row-check';label.title=m.role==='user'?'用户':'助手';
      const input=document.createElement('input');input.type='checkbox';input.dataset.message=m.id;input.ariaLabel=`选择${m.role==='user'?'提问':'回答'}：${(m.text||m.markdown).slice(0,60)}`;
      input.onclick=event=>toggle(m.id,event.shiftKey);
      label.append(input,roleIcon(m.role));
      const preview=document.createElement('button');preview.className='preview';preview.textContent=m.text||m.markdown||'…';preview.title=preview.textContent;
      preview.ariaLabel=`预览${m.role==='user'?'提问':'回答'}：${preview.textContent.slice(0,60)}`;
      const expand=()=>{const open=state.expanded.has(m.id);preview.ariaExpanded=String(open);preview.classList.toggle('expanded',open);};
      preview.onclick=()=>{state.expanded.has(m.id)?state.expanded.delete(m.id):state.expanded.add(m.id);expand();update();};expand();row.append(label,preview);list.append(row);
    }
    if(!messages.length&&!state.loading){const empty=document.createElement('p');empty.className='empty';empty.textContent='未找到消息。请先打开一条已有对话，或发送至少一条消息后重新读取。';list.append(empty);}
    update();
  }
  function toggle(id,shift){
    const order=state.conversation.messages,idx=order.findIndex(m=>m.id===id),checked=!state.selected.has(id);
    if(shift){const anchor=state.last??(state.prefs.reversed?order.length-1:0);for(let i=Math.min(anchor,idx);i<=Math.max(anchor,idx);i++)checked?state.selected.add(order[i].id):state.selected.delete(order[i].id);}
    else checked?state.selected.add(id):state.selected.delete(id);
    state.last=idx;update();
  }
  function selection(type,save=true){
    for(const m of state.conversation.messages){const checked=type==='invert'?!state.selected.has(m.id):type==='all'||type==='questions'&&m.role==='user'||type==='answers'&&m.role==='assistant';checked?state.selected.add(m.id):state.selected.delete(m.id);}
    state.last=null;if(save&&type!=='invert')void persist({selectType:type});update();
  }
  async function open(type){
    if(state.loading)return;
    state.open=true;panel.hidden=false;layout();state.loading=true;update();find('.source').textContent='正在读取消息…';
    const revision=++state.revision;
    try{
      const conversation=await captureConversation();if(revision!==state.revision||location.href!==state.href)return;
      state.conversation=conversation;state.selected.clear();state.expanded=new Set(state.prefs.expandAll?conversation.messages.map(m=>m.id):[]);
      selection(type||state.prefs.selectType,false);find('.source').textContent=`${conversation.source} · ${conversation.messages.length} 条消息`;
    }catch(error){message(error.message);}
    finally{if(revision===state.revision){state.loading=false;render();if(state.open)find('#archive-all').focus();}}
  }
  function close(){if(state.dialog?.open)state.dialog.close();state.open=false;panel.hidden=true;update();}
  function menu(trigger,items,choose){
    for(const old of root.querySelectorAll('.menu'))old.remove();
    const menu=document.createElement('div');menu.className='menu';menu.popover='auto';menu.setAttribute('role','menu');
    for(const [value,label] of items){const button=document.createElement('button');button.setAttribute('role','menuitem');button.textContent=label;button.onclick=()=>{menu.hidePopover();menu.remove();choose(value);};menu.append(button);}
    root.append(menu);const r=trigger.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(innerWidth-190,r.left))+'px';menu.style.top=Math.max(8,r.top-items.length*38-10)+'px';menu.showPopover();menu.querySelector('button').focus();
    menu.onkeydown=e=>{const buttons=[...menu.querySelectorAll('button')],i=buttons.indexOf(root.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}};
    menu.addEventListener('toggle',()=>{if(!menu.matches(':popover-open')){menu.remove();trigger.focus();}},{once:false});
  }
  const formats=[['csv','CSV'],['json','JSON'],['txt','TEXT'],['md','MARKDOWN'],['pdf','PDF']];
  async function exportChosen(format=state.prefs.format){
    if(state.busy||state.loading||!selected().length)return;
    state.busy=true;update();
    try{
      await persist({format});
      if(format==='pdf'){pdfDialog();return;}
      await C.exportText(state.conversation,selected(),{...state.prefs,format});complete(state.prefs.copyToClipboard?'已复制到剪贴板':'导出成功','文件已交给浏览器下载。');
    }
    catch(error){message(error.message);}finally{state.busy=false;update();}
  }
  function dialog(title,html){
    if(state.dialog?.open)state.dialog.close();
    const node=document.createElement('dialog');node.className='modal';node.setAttribute('closedby','any');node.setAttribute('aria-labelledby','archive-dialog-title');
    node.innerHTML=`<header><h2 id="archive-dialog-title"></h2><button type="button" class="icon" aria-label="关闭">×</button></header>${html}`;
    node.querySelector('h2').textContent=title;node.querySelector('header button').onclick=()=>node.close();
    if(!('closedBy' in HTMLDialogElement.prototype)){
      let outside=false;const isOutside=e=>{const r=node.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;};
      node.addEventListener('pointerdown',e=>{outside=isOutside(e);});node.addEventListener('pointerup',e=>{if(outside&&isOutside(e))node.close();});
    }
    node.addEventListener('close',()=>{node.returnValue='';node.remove();if(state.dialog===node)state.dialog=null;},{once:true});
    root.append(node);state.dialog=node;node.showModal();return node;
  }
  function pdfDialog(){
    const node=dialog('导出为 PDF',`<form class="pdf-form" method="post">
      <label>生成方式<select name="engine"><option value="chromium">网页原貌（推荐）</option><option value="pandoc">Pandoc 排版</option></select></label>
      <label>文件名<input name="fileName" required autofocus></label><label>内容标题<input name="contentTitle" required></label>
      <div class="pair"><label>页面格式<select name="pageSize"><option value="a4">A4</option><option value="a5">A5</option><option value="letter">Letter</option></select></label><label>方向<select name="pageOrient"><option value="portrait">纵向</option><option value="landscape">横向</option></select></label></div>
      <div class="pair"><label>页面边距<select name="margin"><option value="normal">普通</option><option value="narrow">窄</option><option value="wide">宽</option></select></label><label>字体<select name="fontFamily"><option value="default">默认</option><option value="serif">衬线</option><option value="mono">等宽</option></select></label></div>
      <div class="pair"><label>字体大小（%）<input name="fontSize" type="number" min="50" max="200"></label><label>语言<select name="lang"><option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option></select></label></div>
      <div class="checks">${[['darkMode','暗黑模式'],['outline','目录'],['toc','目录页'],['pageBreakPerPrompt','每个提问分页'],['removePageNumber','移除页码'],['includeConvoLink','对话链接'],['includeModelName','模型名称'],['includePerMsgTime','消息时间戳']].map(([key,text])=>`<label><input name="${key}" type="checkbox">${text}</label>`).join('')}</div>
      <p class="hint">“目录”控制 PDF 侧栏书签，“目录页”在正文前插入可点击的目录页面。网页原貌会滚动收集所选消息的网页样式；仍无法读取的消息经确认后重新排版。字体和额外元信息使用 Pandoc 排版。</p><p class="pdf-status" role="status"></p><div class="dialog-actions"><button type="button" data-cancel>取消</button><button type="submit" class="primary">导出 PDF</button></div></form>`);
    const form=node.querySelector('form');
    for(const [key,value] of Object.entries(state.prefs)){const input=form.elements.namedItem(key);if(input){if(input.type==='checkbox')input.checked=value===true;else input.value=value;}}
    form.elements.fileName.value=C.filename(C.selectionTitle(state.conversation,selected()),'pdf');form.elements.contentTitle.value=state.conversation.title;form.elements.lang.value=state.prefs.lang||'zh-CN';
    ArchiveCustomSelect.enhance(node);
    node.querySelector('[data-cancel]').onclick=()=>node.close();
    form.onsubmit=async event=>{
      event.preventDefault();if(state.busy)return;
      state.busy=true;update();const button=form.querySelector('[type=submit]');button.disabled=true;
      const opt={...state.prefs,...Object.fromEntries(new FormData(form)),format:'pdf'};
      for(const input of form.querySelectorAll('[type=checkbox]'))opt[input.name]=input.checked;opt.fontSize=Number(opt.fontSize);
      const {fileName,contentTitle,...prefs}=opt;
      const messages=selected(),conversation=state.conversation;
      const progress=text=>{node.querySelector('.pdf-status').textContent=text;message(text);};
      try{
        await persist(prefs);
        progress('正在捕获网页原貌…');const job=await C.createPdf(conversation,messages,opt,{progress,confirmFallback:info=>window.confirm(`已捕获 ${info.domCount}/${info.messageCount} 条消息的网页样式。仍有 ${info.fallbackCount} 条无法读取网页节点。\n\n是否使用会话正文重新排版补全？补全部分可能缺少网页独有图表。选择取消将停止导出。`)});
        progress('正在生成 PDF，可继续浏览；任务也可在设置中恢复。');
        const deadline=Date.now()+30*60*1000;
        while(Date.now()<deadline){
          const result=await C.request({path:'/api/pdf/v1/'+job.jobId,server:job.server});
          if(result.status==='failed')throw Error(result.errmsg||'PDF 生成失败');
          if(result.status==='done'){
            await C.request({path:'/api/pdf/v1/'+job.jobId+'/download',download:true,server:job.server,filename:C.filename(conversation.title,'pdf',opt.fileName),saveAs:opt.saveAs});
            if(node.open)node.close();complete('导出成功','PDF 已交给浏览器下载。');return;
          }
          await new Promise(resolve=>setTimeout(resolve,1500));
        }
        throw Error('等待超时。请在导出设置中的最近任务继续查询。');
      }catch(error){progress(error.message);}
      finally{state.busy=false;button.disabled=false;update();}
    };
  }
  function complete(title,description){
    message(title);if(state.prefs.autoCloseSelector)close();
    if(!state.prefs.muteExport){const node=dialog(title,'<p class="success-description"></p><div class="dialog-actions"><button class="primary" autofocus>完成</button></div>');node.querySelector('p').textContent=title==='已复制到剪贴板'?'所选消息已复制。':description;node.querySelector('.dialog-actions button').onclick=()=>node.close();}
  }
  root.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.selection){selection(button.dataset.selection);return;}
    const action=button.dataset.action;
    if(action==='select'){state.open?close():void open();}
    if(action==='close')close();
    if(action==='reload')void open();
    if(action==='dock'){void persist({side:state.prefs.side==='right'?'left':'right'});layout();}
    if(action==='reverse'){void persist({reversed:!state.prefs.reversed});layout();render();}
    if(action==='expand'){const expand=state.expanded.size===0;state.expanded=new Set(expand?state.conversation.messages.map(m=>m.id):[]);void persist({expandAll:expand});render();}
    if(action==='bottom')find('.list').scrollTo({top:find('.list').scrollHeight,behavior:'smooth'});
    if(action==='tips')find('.tips').hidden=true;
    if(action==='settings')void C.request({action:'settings'});
    if(action==='selection-menu')menu(button,[['all','全部'],['questions','仅提问'],['answers','仅回答'],['none','不选择']],type=>{void persist({selectType:type});void open(type);});
    if(action==='format')menu(button,formats.map(([value,label])=>[value,label+(state.prefs.format===value?' ✓':'')]),format=>{void persist({format});update();});
    if(action==='export-menu')menu(button,formats.map(([value,label])=>[value,'导出为 '+label]),format=>void exportChosen(format));
    if(action==='export')void exportChosen();
  });
  find('#archive-all').onchange=e=>selection(e.target.checked?'all':'none',false);
  const resize=find('.resize');let drag=null;
  resize.onpointerdown=event=>{drag={id:event.pointerId};resize.setPointerCapture(event.pointerId);event.preventDefault();};
  resize.onpointermove=event=>{if(drag){state.prefs.width=Math.max(260,Math.min(800,state.prefs.side==='right'?innerWidth-event.clientX:event.clientX));layout();}};
  const endResize=()=>{if(drag){drag=null;void persist({width:state.prefs.width});}};resize.onpointerup=endResize;resize.onpointercancel=endResize;
  resize.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const delta=(event.key==='ArrowRight'?1:-1)*(state.prefs.side==='right'?-1:1)*20;void persist({width:Math.max(260,Math.min(800,state.prefs.width+delta))});layout();}};
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!state.dialog?.open&&!root.querySelector('.menu:popover-open')&&state.open)close();});
  function mount(){
    // Follow the composer through ChatGPT's client-side navigations; float only when absent.
    const composer=document.querySelector('#prompt-textarea');
    const form=composer?.closest('form');const anchor=form?.parentElement;
    // Keep the overlay outside transformed/clipped composer ancestors.
    if(host.parentElement!==document.body)document.body.append(host);
    if(anchor&&anchor!==document.body){
      const rect=form.getBoundingClientRect();host.dataset.placement='composer';
      toolbar.style.cssText=`position:fixed;left:${Math.min(innerWidth-128,Math.max(8,rect.right+10))}px;top:${Math.max(8,Math.min(innerHeight-92,rect.bottom-80))}px`;
    } else {host.dataset.placement='floating';toolbar.style.cssText='';}
    toolbar.hidden=state.prefs.displayBtns===false;layout();
    if(state.href!==location.href){state.href=location.href;state.revision++;state.loading=false;state.conversation={messages:[]};state.selected.clear();close();message('');}
  }
  let scheduled=false;
  const observer=new MutationObserver(()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;mount();});});
  observer.observe(document.documentElement,{subtree:true,childList:true});
  new MutationObserver(layout).observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme']});
  window.addEventListener('resize',mount);
  document.addEventListener('scroll',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;mount();});}},{capture:true,passive:true});
  chrome.runtime.onMessage.addListener((event,sender,respond)=>{if(sender.id!==chrome.runtime.id)return;if(event.action==='open-selector'){void open(event.selectType);respond({ok:true});}if(event.action==='export-selected'){void exportChosen(event.format);respond({ok:true});}});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.preferences){state.prefs={...C.defaults,...changes.preferences.newValue};mount();update();}});
  globalThis.__archiveOverlay={open,close};
  void C.preferences().then(prefs=>{state.prefs=prefs;mount();update();});
})();
