// Runs in the isolated world; capture begins only when the user opens the selector.
async function captureConversation() {
  const dom=new Map(),aliases=new Map();
  const roots=ArchiveSnapshotAdapter.messageRoots();
  for(const [index,node] of roots.entries()) {
    const identity=ArchiveSnapshotAdapter.domTurnIdentity(node,index),role=identity.role;
    if(!['user','assistant'].includes(role)) continue;
    const body=node.querySelector('.markdown')||node;
    const id=identity.turnId,messageIds=ArchiveSnapshotAdapter.idsIn(node);
    const entry={id,turnId:id,messageIds,role,markdown:toMarkdown(body),text:body.innerText};
    dom.set(id,entry);for(const alias of new Set([id,...messageIds]))aliases.set(alias,entry);
  }
  let title=document.title.replace(/\s*[-|]\s*ChatGPT$/,'');
  let messages=[],source='网页（仅已加载消息）';
  const conversationId=location.pathname.match(/\/(?:c|share)\/([a-zA-Z0-9-]+)/)?.[1];
  if(conversationId && !location.pathname.startsWith('/share/')) try {
    const session=await (await fetch('/api/auth/session',{signal:AbortSignal.timeout(15000)})).json();
    if(!session.accessToken) throw Error('No session');
    const response=await fetch(`/backend-api/conversation/${conversationId}`,{headers:{Authorization:`Bearer ${session.accessToken}`},signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw Error('Conversation unavailable');
    const data=await response.json(); title=data.title||title;
    let current=data.current_node; const seen=new Set();
    while(current && data.mapping?.[current] && !seen.has(current)) {
      seen.add(current); const item=data.mapping[current],m=item.message;
      if(m && ['user','assistant'].includes(m.author?.role) && !m.metadata?.is_visually_hidden_from_conversation) {
        const markdown=(m.content?.parts||[]).filter(p=>typeof p==='string').join('\n\n')||m.content?.text||'';
        if(markdown){const visible=aliases.get(m.id)||aliases.get(current)||aliases.get(item.id);messages.unshift({id:m.id,turnId:current,messageIds:[...new Set([m.id,current,item.id,...(visible?.messageIds||[])].filter(Boolean))],role:m.author.role,markdown,text:visible?.text||markdown,createTime:m.create_time,model:m.metadata?.model_slug});}
      }
      current=item.parent;
    }
    if(messages.length) source='会话当前分支';
  } catch { /* visible page remains available when internal APIs change */ }
  if(!messages.length) messages=[...dom.values()];
  return {title,url:location.href,messages,source,capturedAt:new Date().toISOString()};

  function toMarkdown(node){
    if(node.nodeType===Node.TEXT_NODE) return node.textContent;
    if(node.nodeType!==Node.ELEMENT_NODE) return '';
    const tag=node.tagName;
    if(['BUTTON','SCRIPT','STYLE','NAV'].includes(tag)||node.getAttribute('aria-hidden')==='true') return '';
    if(node.matches('.katex')) return '$'+(node.querySelector('annotation')?.textContent||node.textContent)+'$';
    if(tag==='PRE') return '\n\n```'+(node.querySelector('code')?.className.match(/language-([\w+-]+)/)?.[1]||'')+'\n'+(node.querySelector('code')||node).textContent+'\n```\n\n';
    const body=[...node.childNodes].map(toMarkdown).join('');
    if(/^H[1-6]$/.test(tag)) return '\n\n'+'#'.repeat(Number(tag[1]))+' '+body+'\n\n';
    if(tag==='CODE') return '`'+body+'`';
    if(tag==='STRONG'||tag==='B') return '**'+body+'**';
    if(tag==='EM'||tag==='I') return '*'+body+'*';
    if(tag==='A') return '['+body+']('+node.href+')';
    if(tag==='IMG') return '!['+(node.alt||'图片')+']('+node.src+')';
    if(tag==='BR') return '\n';
    if(tag==='LI') return '\n'+(node.parentElement.tagName==='OL'?`${[...node.parentElement.children].indexOf(node)+1}. `:'- ')+body.trim();
    if(tag==='BLOCKQUOTE') return '\n\n'+body.trim().split('\n').map(s=>'> '+s).join('\n')+'\n\n';
    if(tag==='HR') return '\n\n---\n\n';
    if(tag==='TR') {const cells=[...node.children].map(n=>toMarkdown(n).trim().replaceAll('|','\\|'));return '| '+cells.join(' | ')+' |\n'+(node.querySelector('th')?'| '+cells.map(()=>'---').join(' | ')+' |\n':'');}
    return ['P','DIV','UL','OL','TABLE'].includes(tag)?'\n\n'+body.trim()+'\n\n':body;
  }
}
