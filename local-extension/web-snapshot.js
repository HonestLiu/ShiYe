/* Freeze selected rendered messages, without rebuilding their typography. */
(() => {
  const STYLE_PROPERTIES = (`display position box-sizing float clear visibility opacity
    font-family font-size font-style font-weight font-stretch font-variant font-feature-settings
    font-variation-settings line-height letter-spacing word-spacing text-align text-indent
    text-decoration text-transform text-shadow white-space word-break overflow-wrap tab-size
    color background-color background-image background-size background-position background-repeat background-clip background-origin
    margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left
    border-top border-right border-bottom border-left border-radius box-shadow
    width height min-width min-height max-width max-height aspect-ratio vertical-align top right bottom left
    transform transform-origin overflow overflow-x overflow-y clip clip-path
    flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-self justify-content
    gap row-gap column-gap grid-template-columns grid-template-rows grid-column grid-row
    list-style-type list-style-position list-style-image counter-reset counter-increment
    border-collapse border-spacing table-layout object-fit object-position
    fill fill-opacity fill-rule clip-rule stop-color stop-opacity stroke stroke-width stroke-opacity stroke-dasharray stroke-linecap stroke-linejoin
    text-anchor dominant-baseline paint-order`).split(/\s+/).filter(Boolean);
  const OMIT = 'script, style, link, meta, base, iframe, object, embed, form, button, input, textarea, select, noscript, .chatgpt-exporter-checkbox, .turn-action-controls, #local-export-progress';
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function idsIn(root) {
    const nodes = [root, ...root.querySelectorAll('[data-dil-message-id], [data-message-id], [data-chatgpt-search-message-ids], [data-turn-id]')];
    const section = root.closest('[data-turn-id]');
    if (section) nodes.push(section);
    const unit=root.closest('[data-chatgpt-search-message-ids]');if(unit)nodes.push(unit);
    return new Set(nodes.flatMap(node => ['data-dil-message-id', 'data-chatgpt-search-message-ids', 'data-message-id', 'data-turn-id']
      .flatMap(key => (node.getAttribute(key) || '').split(/[\s,\[\]"]+/))).filter(Boolean));
  }

  function selectedRoots(messages, {allowMissing=false}={}) {
    const candidates = LocalExporter.messageRoots();
    const indexed = new Map();
    candidates.forEach((root,index)=>{
      const ids=idsIn(root);
      const identity=LocalExporter.domTurnIdentity?.(root,index);
      if(identity?.turnId)ids.add(identity.turnId);
      for(const id of ids){if(!indexed.has(id))indexed.set(id,[]);indexed.get(id).push(root);}
    });
    const used = new Set();
    return messages.map(message => {
      const ids = [message.turnId, ...(message.messageIds || [])].filter(Boolean);
      const matches = [...new Set(ids.flatMap(id=>indexed.get(id)||[]))].filter(root=>!used.has(root));
      if (!matches.length && !allowMissing) throw new Error('所选消息尚未在网页中加载：'+(message.turnId || '未知 ID'));
      matches.forEach(root => used.add(root));
      return { message, roots: matches };
    });
  }

  async function capture(payload) {
    if(!payload.messages?.length)throw new Error('请至少选择一条消息');
    const entries = selectedRoots(payload.messages,{allowMissing:true});
    if (document.fonts?.ready) await new Promise(resolve=>{
      const timer=setTimeout(resolve,5000);document.fonts.ready.then(()=>{clearTimeout(timer);resolve();},()=>{clearTimeout(timer);resolve();});
    });
    const warnings = [];
    const resources = new Map();
    let activeAssets=0;const assetWaiters=[];
    async function acquireAsset(){if(activeAssets<6){activeAssets++;return;}await new Promise(resolve=>assetWaiters.push(resolve));}
    function releaseAsset(){if(assetWaiters.length)assetWaiters.shift()();else activeAssets--;}
    const rules = new Map();
    const getStyle = (node, pseudo) => node.ownerDocument.defaultView.getComputedStyle(node, pseudo);
    async function fetchAsset(address) {
      try { const result = await fetch(address,globalThis.AbortSignal?.timeout?{signal:AbortSignal.timeout(20000)}:{}); if (!result.ok) throw new Error('Resource HTTP '+result.status); return result; }
      catch (error) {
        if (!['http:', 'https:'].includes(new URL(address).protocol)) throw error;
        const response = await chrome.runtime.sendMessage({ cmd: 'snapshot_resource', url: address });
        if (response.errcode) throw new Error(response.errmsg);
        return new Response(Uint8Array.from(atob(response.base64), char => char.charCodeAt(0)), { headers: { 'Content-Type': response.mime } });
      }
    }
    const cacheResource = (address, base = document.baseURI) => {
      const url = new URL(address, base).href;
      if (url.startsWith('data:')) return Promise.resolve(url);
      if (!resources.has(url)) resources.set(url, (async () => {
        await acquireAsset();
        try{
        const response = await fetchAsset(url);
        if (!response.ok) throw new Error(`Resource HTTP ${response.status}`);
        const blob = await response.blob();
        if (blob.size > 16 * 1024 * 1024) throw new Error('Resource exceeds 16 MiB');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
        }finally{releaseAsset();}
      })());
      return resources.get(url);
    };
    async function freezeUrls(value, base) {
      const pattern = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
      const values = new Map();
      for (const match of value.matchAll(pattern)) {
        if (match[2].startsWith('#') || match[2].startsWith('data:')) continue;
        const address = new URL(match[2], base || document.baseURI);
        const current = new URL(document.baseURI);
        if (address.hash && address.origin === current.origin && address.pathname === current.pathname) {
          values.set(match[0], `url("${address.hash}")`);
          continue;
        }
        try { values.set(match[0], `url("${await cacheResource(match[2], base)}")`); }
        catch { values.set(match[0], 'none'); warnings.push('部分页面背景或字体资源未能读取。'); }
      }
      return value.replace(pattern, text => values.get(text) || text);
    }
    function styleClass(node, pseudo, computed = getStyle(node,pseudo)) {
      const style = STYLE_PROPERTIES.map(key => {
        let value = computed.getPropertyValue(key);
        if (!value) return '';
        if (key === 'position' && ['fixed', 'sticky'].includes(value)) value = 'static';
        return `${key}:${value};`;
      }).join('');
      if (!rules.has(style)) rules.set(style, `pdf-style-${rules.size}`);
      return { name: rules.get(style), computed };
    }
    async function freezeRoot(source) {
      const copy = source.cloneNode(true);
      copy.setAttribute('data-local-pdf-expand','true');
      const originals = [source, ...source.querySelectorAll('*')];
      const copies = [copy, ...copy.querySelectorAll('*')];
      for(const image of source.querySelectorAll('img')){const address=image.currentSrc || image.getAttribute('src');if(address)cacheResource(address).catch(()=>{});}
      for (let index = 0; index < originals.length; index++) {
        const node = originals[index], clone = copies[index];
        if (node.matches(OMIT) || node.closest('button, .turn-action-controls, form')) { clone.remove(); continue; }
        const { name } = styleClass(node);
        clone.classList.add(name);
        if(node.scrollHeight>node.clientHeight+2 && /auto|scroll/.test(getStyle(node).getPropertyValue('overflow-y')))clone.setAttribute('data-local-pdf-expand','true');
        // Inline styles are replaced by resolved values; no app JS is carried.
        clone.removeAttribute('style');
        for (const attribute of Array.from(clone.attributes)) {
          if (/^on/i.test(attribute.name) || ['srcdoc', 'autofocus', 'nonce', 'integrity', 'action', 'formaction', 'srcset', 'sizes', 'contenteditable', 'tabindex'].includes(attribute.name)) clone.removeAttribute(attribute.name);
          if (['href', 'xlink:href'].includes(attribute.name) && !/^(?:https?:|mailto:|#)/i.test(attribute.value)) clone.removeAttribute(attribute.name);
        }
        if (node.tagName === 'IMG') {
          const address = node.currentSrc || node.getAttribute('src');
          clone.removeAttribute('loading');
          clone.removeAttribute('decoding');
          if (address) {
            try { clone.setAttribute('src', await cacheResource(address)); }
            catch { clone.removeAttribute('src'); clone.setAttribute('alt', node.getAttribute('alt') || '图片无法读取'); warnings.push('部分图片未能读取。'); }
          }
          if (!node.naturalWidth && getStyle(node).getPropertyValue('height') === '0px') clone.setAttribute('style', 'height:auto!important');
        }
        if (node.tagName === 'SOURCE') clone.remove();
        if (node.tagName === 'CANVAS') {
          try {
            const img = document.createElement('img');
            img.className = clone.className;
            img.src = node.toDataURL('image/png');
            clone.replaceWith(img);
          } catch { warnings.push('部分画布内容未能读取。'); }
        }
        for (const [pseudo, position] of [['::before', 'afterbegin'], ['::after', 'beforeend']]) {
          const computed=getStyle(node,pseudo);
          const content = computed.getPropertyValue('content');
          if (!content || ['none', 'normal', '""', "''"].includes(content)) continue;
          if (!/^["'].*["']$/.test(content)) continue;
          const {name:pseudoClass}=styleClass(node,pseudo,computed);
          const span = document.createElement('span');
          span.className = pseudoClass;
          try { span.textContent = JSON.parse(content); } catch { span.textContent = content.slice(1, -1); }
          clone.insertAdjacentElement(position, span);
        }
        if (index && index % 200 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      // Native KaTeX visual output stays; its duplicate accessibility MathML
      // would otherwise interfere with PDF text extraction.
      copy.querySelectorAll('.katex-mathml').forEach(node => node.remove());
      return copy.outerHTML;
    }
    const widths=[],sections=new Map();
    const progress=text=>LocalExporter.exportProgress?.(text);
    async function collect(available){
      for(let index=0;index<available.length;index++){
        if(sections.has(index) || !available[index].roots.length)continue;
        const roots=available[index].roots.filter(root=>{
          if(root.isConnected===false)return false;
          const style=getStyle(root);
          if(style.getPropertyValue('display')==='none' || style.getPropertyValue('visibility')==='hidden')return false;
          if(root.getClientRects && !root.getClientRects().length && style.getPropertyValue('display')!=='contents')return false;
          return true;
        });
        if(!roots.length)continue;
        const bodies=[];
        for(const root of roots){
          widths.push(root.getBoundingClientRect().width);
          const restores=[];
          // content-visibility can skip off-screen layout even when the DOM exists.
          for(let ancestor=root;ancestor && ancestor!==document.body;ancestor=ancestor.parentElement){
            if(ancestor.style && ['auto','hidden'].includes(getStyle(ancestor).getPropertyValue('content-visibility'))){
              restores.push([ancestor,ancestor.style.getPropertyValue('content-visibility'),ancestor.style.getPropertyPriority('content-visibility')]);
              ancestor.style.setProperty('content-visibility','visible','important');
            }
          }
          try{bodies.push(await freezeRoot(root));}finally{for(const [node,value,priority] of restores){if(value)node.style.setProperty('content-visibility',value,priority);else node.style.removeProperty('content-visibility');}}
        }
        sections.set(index,`<section class="pdf-message" data-role="${escape(available[index].message.role)}">${bodies.join('\n')}</section>`);
        progress(`正在捕获对话：${sections.size}/${payload.messages.length} 条`);
      }
    }
    await collect(entries);
    // Recover virtualized messages incrementally; never require every message
    // to be mounted at the same instant and never retain a whole scroll history.
    if(sections.size<payload.messages.length && typeof document.querySelectorAll==='function'){
      // Use all mounted messages, including unselected ones: a selected message
      // may currently be completely outside the virtualized DOM window.
      const mounted=LocalExporter.messageRoots();
      const candidates=new Set();
      for(const root of mounted){
        for(let node=root.parentElement;node;node=node.parentElement){
          if(node.clientHeight>0 && node.scrollHeight>node.clientHeight+2 &&
             /auto|scroll/.test(getStyle(node).getPropertyValue('overflow-y')))candidates.add(node);
        }
      }
      if(document.scrollingElement)candidates.add(document.scrollingElement);
      const scroller=[...candidates].sort((a,b)=>{
        const score=node=>mounted.reduce((n,root)=>n+(node.contains(root)?1:0),0);
        return score(b)-score(a); // Stable order prefers the nearest transcript scroller.
      }).find(node=>node.clientHeight>0 && node.scrollHeight>node.clientHeight+2);
      if(scroller){
        const original=scroller.scrollTop;
        const saved=[];
        for(const node of new Set([scroller,document.documentElement])){
          for(const key of ['scroll-behavior','scroll-snap-type','overflow-anchor']){
            saved.push([node,key,node.style.getPropertyValue(key),node.style.getPropertyPriority(key)]);
            node.style.setProperty(key,key==='scroll-behavior'?'auto':'none','important');
          }
        }
        const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const started=Date.now();
        // This is a safety bound, not a no-new-message timeout. One answer can
        // occupy hundreds of screens; empty/unselected stretches must be crossed.
        const withinBudget=()=>Date.now()-started<300000;
        async function sample(top,delay=160){
          scroller.scrollTop=top;
          await pause(delay);
          await collect(selectedRoots(payload.messages,{allowMissing:true}));
        }
        try{
          // A reverse pass also catches messages mounted late or prepended while
          // moving to the beginning of an incrementally loaded conversation.
          for(const direction of [1,-1]){
            await sample(direction===1?0:scroller.scrollHeight,500);
            for(let step=0;step<10000 && withinBudget() && sections.size<payload.messages.length;step++){
              progress(`正在滚动收集长对话：${sections.size}/${payload.messages.length} 条`);
              const top=scroller.scrollTop;
              const edge=direction===1?Math.max(0,scroller.scrollHeight-scroller.clientHeight):0;
              const next=direction===1?Math.min(edge,top+Math.max(100,scroller.clientHeight*.7)):Math.max(0,top-Math.max(100,scroller.clientHeight*.7));
              if(Math.abs(next-top)<2){
                // Give lazy loading time to extend the list before declaring an end.
                const height=scroller.scrollHeight,before=sections.size;
                for(let retry=0;retry<4 && withinBudget();retry++){
                  await sample(direction===1?scroller.scrollHeight:0,350);
                  if(sections.size===payload.messages.length)break;
                }
                if(scroller.scrollHeight!==height || sections.size>before)continue;
                break;
              }
              await sample(next);
            }
            if(sections.size===payload.messages.length || !withinBudget())break;
          }
        }finally{
          scroller.scrollTop=original;
          for(const [node,key,value,priority] of saved){
            if(value)node.style.setProperty(key,value,priority);else node.style.removeProperty(key);
          }
        }
      }
    }
    let fallbackCount=0;
    for(let index=0;index<payload.messages.length;index++){
      if(sections.has(index))continue;
      const message=payload.messages[index];
      if(typeof message.markdown!=='string')throw new Error(`第 ${index+1} 条消息无法从网页或会话内容读取，请刷新聊天页后重试。`);
      const markdown=LocalExporter.prepareFallback ? await LocalExporter.prepareFallback(message.markdown) : message.markdown;
      sections.set(index,`<section class="pdf-message" data-role="${escape(message.role)}" data-local-pdf-markdown="true"><pre>${escape(markdown || '（此消息没有文本内容）')}</pre></section>`);
      fallbackCount++;
    }
    if(fallbackCount){warnings.push(`${fallbackCount} 条消息不在当前网页节点中，已使用会话正文补全；补全部分重新排版，网页独有图表需要页面可读取。`);progress(`已收集 ${payload.messages.length} 条消息，其中 ${fallbackCount} 条使用会话内容补全，正在排版…`);}
    const width = Math.max(320, Math.min(1200, widths.reduce((max,value)=>Math.max(max,value||0),0) || 760));
    const fonts = new Set();
    const fontTasks=[];
    const visited = new Set();
    async function fontRules(items, base) {
      for (const rule of items) {
        if (rule.type === 5) fontTasks.push(freezeUrls(rule.cssText, base).catch(()=>{warnings.push('部分网页字体可能使用系统字体替代。');return '';}));
        if (rule.styleSheet) await collectFonts(rule.styleSheet);
        if (rule.cssRules) await fontRules(rule.cssRules, base);
      }
    }
    async function collectFonts(sheet) {
      if (visited.has(sheet)) return;
      visited.add(sheet);
      try {
        await fontRules(sheet.cssRules, sheet.href || document.baseURI);
      } catch {
        if (!sheet.href) return;
        try {
          const response = await fetchAsset(sheet.href);
          if (!response.ok) throw new Error('Stylesheet unavailable');
          for (const match of (await response.text()).matchAll(/@font-face\s*\{[^}]*\}/gi)) fontTasks.push(freezeUrls(match[0],sheet.href).catch(()=>{warnings.push('部分网页字体可能使用系统字体替代。');return '';}));
        } catch { warnings.push('部分网页字体可能使用系统字体替代。'); }
      }
    }
    for (const sheet of document.styleSheets) await collectFonts(sheet);
    for(const rule of await Promise.all(fontTasks))if(rule)fonts.add(rule);
    const css = [];
    for (const [style, name] of rules) css.push(`.${name}{${await freezeUrls(style)}}`);
    const bodyStyle = getStyle(document.body);
    let background = bodyStyle.backgroundColor;
    let ancestor = entries.flatMap(entry=>entry.roots)[0]?.parentElement;
    while (ancestor && (!background || background === 'rgba(0, 0, 0, 0)' || background === 'transparent')) {
      background = getStyle(ancestor).backgroundColor;
      ancestor = ancestor.parentElement;
    }
    if (!background || background === 'rgba(0, 0, 0, 0)' || background === 'transparent') background = document.documentElement.dataset.theme === 'dark' ? '#212121' : '#fff';
    const theme = document.documentElement.dataset.theme || (background.match(/0, 0, 0/) ? 'dark' : 'light');
    const title = payload.title || document.title;
    const html = `<!doctype html><html lang="${escape(document.documentElement.lang || 'zh-CN')}"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}"><title>${escape(title)}</title><style>
      ${[...fonts].join('\n').replace(/<\/style/gi, '<\\/style')} ${css.join('\n').replace(/<\/style/gi, '<\\/style')}
      html,body{margin:0;padding:0;width:${width}px;background:${background};color:${bodyStyle.color};font-family:${bodyStyle.fontFamily};-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .pdf-document{width:${width}px;margin:0 auto}.pdf-message{position:relative;margin:0 0 24px;content-visibility:visible;contain:none}
      .pdf-message *{animation:none!important;transition:none!important;content-visibility:visible!important;contain:none!important}
      .pdf-message [data-local-pdf-expand]{height:auto!important;max-height:none!important;overflow:visible!important}
      .pdf-message pre,.pdf-message table,.pdf-message svg,.pdf-message img{break-inside:avoid}
      ${payload.options?.pageBreakPerPrompt ? '.pdf-message[data-role="Prompt"]:not(:first-child){break-before:page}' : ''}
      </style></head><body><main class="pdf-document">${payload.messages.map((_,index)=>sections.get(index)).join('\n')}</main></body></html>`;
    return { html, css: '', width, theme, messageCount:payload.messages.length,domCount:payload.messages.length-fallbackCount,fallbackCount,warnings: [...new Set(warnings)] };
  }
  globalThis.LocalWebSnapshot = { capture, selectedRoots, STYLE_PROPERTIES };
})();
