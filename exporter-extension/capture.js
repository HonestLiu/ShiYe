// Runs in the isolated world; capture begins only when the user opens the selector.
async function captureConversation() {
  const dom=new Map(),aliases=new Map();
  const roots=ArchiveSnapshotAdapter.messageRoots();
  for(const [index,node] of roots.entries()) {
    const identity=ArchiveSnapshotAdapter.domTurnIdentity(node,index),role=identity.role;
    if(!['user','assistant'].includes(role)) continue;
    const sourceBody=role==='user'?node:(node.querySelector('.markdown')||node);
    const body=cleanMessageBody(sourceBody);
    const id=identity.turnId,messageIds=ArchiveSnapshotAdapter.idsIn(node);
    const images=messageImages(sourceBody);
    const text=previewText(body);
    const entry={id,turnId:id,messageIds,role,images,markdown:toMarkdown(body),markdownFromDom:true,text:(images.length?'[图片 × '+images.length+']'+(text?'\n':''):'')+text,filenameHeading:highestHeading(sourceBody)};
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
        const parts=m.content?.parts||[],text=parts.filter(p=>typeof p==='string').join('\n\n')||m.content?.text||'';
        const visible=aliases.get(m.id)||aliases.get(current)||aliases.get(item.id);
        const imageParts=parts.filter(p=>p&&typeof p==='object'&&(p.content_type==='image_asset_pointer'||p.asset_pointer||p.image_url));
        const images=visible?.images||[],imageCount=Math.max(images.length,imageParts.length);
        const imageMarkdown=(m.author.role==='user'?images:[]).map(image=>'!['+image.alt.replace(/[\[\]\n]/g,' ')+']('+image.url+')').join('\n\n');
        const markdown=[text,imageMarkdown].filter(Boolean).join('\n\n')||(imageCount?'[图片 × '+imageCount+'，请在网页中加载后导出]':'');
        if(markdown||imageCount){messages.unshift({id:m.id,turnId:current,messageIds:[...new Set([m.id,current,item.id,...(visible?.messageIds||[])].filter(Boolean))],role:m.author.role,markdown,images,imageCount,text:visible?.text||((imageCount?'[图片 × '+imageCount+']'+(text?'\n':''):'')+text),filenameHeading:visible?.filenameHeading,createTime:m.create_time,model:m.metadata?.model_slug});}

      }
      current=item.parent;
    }
    if(messages.length) source='会话当前分支';
  } catch { /* visible page remains available when internal APIs change */ }
  if(!messages.length) messages=[...dom.values()];
  return {title,url:location.href,messages,source,capturedAt:new Date().toISOString()};

  function messageImages(body){
    return [...body.querySelectorAll('img')].filter(img=>!img.closest('[data-testid*=avatar],.avatar')).map(img=>({url:img.currentSrc||img.src,alt:img.alt||'上传的图片',width:img.naturalWidth,height:img.naturalHeight})).filter(img=>img.url);
  }

  function highestHeading(body){
    let best=null;
    for(const node of body.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],[data-d-component="title"]')){
      if(node.closest('pre,code,button,.sr-only,[hidden],[aria-hidden="true"]'))continue;
      let hidden=false;
      for(let ancestor=node;ancestor;ancestor=ancestor.parentElement){const style=getComputedStyle(ancestor);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0){hidden=true;break;}}
      if(hidden)continue;
      const level=Number(node.tagName.match(/^H([1-6])$/)?.[1]||node.getAttribute('aria-level')||({xl:1,lg:2,md:3,sm:4,xs:5}[node.dataset.dSize])||2);
      if(!Number.isInteger(level)||level<1||level>6)continue;
      const copy=node.cloneNode(true);copy.querySelectorAll('.katex-mathml,script,style,button').forEach(child=>child.remove());
      const text=copy.textContent.replace(/\s+/g,' ').trim();
      if(text&&(!best||level<best.level))best={level,text};
    }
    return best;
  }

  function cleanMessageBody(source){
    const copy=source.cloneNode(true);
    copy.querySelectorAll('.sr-only,[hidden],[data-message-role-label],[data-role-label],script,style,nav').forEach(node=>node.remove());
    for(const button of copy.querySelectorAll('button')){if(button.querySelector('img'))button.replaceWith(...button.childNodes);else button.remove();}
    // Remove page-owned speaker headings, without stripping phrases from actual prose.
    for(const node of copy.querySelectorAll('h5,h6,[data-testid="message-role"]')){
      if(!node.closest('.markdown')&&/^(?:ChatGPT|助手|用户|你)\s*(?:说|說|said|says)?\s*[:：]$/i.test(node.textContent.trim()))node.remove();
    }
    return copy;
  }
  function previewText(body){
    const copy=body.cloneNode(true);
    copy.querySelectorAll('.katex-mathml').forEach(node=>node.remove());
    copy.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,pre,blockquote,tr').forEach(node=>node.append('\n'));
    return copy.textContent.replace(/\n{3,}/g,'\n\n').trim();
  }

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
