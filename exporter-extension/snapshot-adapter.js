// DOM conventions shared with our existing self-hosted snapshot implementation.
globalThis.ArchiveSnapshotAdapter = (() => {
  const split=value=>String(value||'').split(/[\s,\[\]"]+/).filter(Boolean);
  function messageRoots(){
    const current='[data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]';
    const nodes=[...new Set([...document.querySelectorAll('div.group\\/turn-messages'),...document.querySelectorAll(current)])];
    const known=new Set(nodes),outer=new Set();
    for(const node of nodes)for(let parent=node.parentElement;parent;parent=parent.parentElement)if(known.has(parent))outer.add(parent);
    const canonical=nodes.filter(node=>!outer.has(node)),ancestors=new Set(),chosen=new Set(canonical);
    for(const node of canonical)for(let parent=node.parentElement;parent;parent=parent.parentElement)ancestors.add(parent);
    const extras=[...document.querySelectorAll('[data-message-author-role], [data-dil-message-id]')].filter(node=>{
      if(ancestors.has(node))return false;
      for(let parent=node;parent;parent=parent.parentElement)if(chosen.has(parent))return false;
      return !node.parentElement?.closest('[data-message-author-role]');
    });
    return [...canonical,...extras].sort((a,b)=>a===b?0:a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_PRECEDING?1:-1);
  }
  function idsIn(node){
    const found=[node,...node.querySelectorAll('[data-message-id], [data-dil-message-id], [data-chatgpt-search-message-ids]')];
    for(const selector of ['[data-turn-id]','[data-chatgpt-search-message-ids]']){const parent=node.closest(selector);if(parent)found.push(parent);}
    return [...new Set(found.flatMap(item=>['data-message-id','data-dil-message-id','data-chatgpt-search-message-ids','data-turn-id'].flatMap(key=>split(item.getAttribute(key)))))];
  }
  function domTurnIdentity(node,index){
    const section=node.closest('[data-turn-id]'),key=node.getAttribute('data-chatgpt-search-unit-key')||node.closest('[data-chatgpt-search-unit-key]')?.getAttribute('data-chatgpt-search-unit-key')||'';
    const role=node.getAttribute('data-message-author-role')||node.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role')||section?.getAttribute('data-turn')||(key.endsWith(':user')?'user':key.endsWith(':assistant')?'assistant':index%2===0?'user':'assistant');
    return {turnId:node.getAttribute('data-message-id')||idsIn(node)[0]||`dom-turn-${index}`,role:role==='user'?'user':'assistant'};
  }
  return {messageRoots,idsIn,domTurnIdentity,exportProgress:null};
})();
