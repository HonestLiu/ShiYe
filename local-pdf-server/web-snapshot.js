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
  const OMIT = 'script, style, link, meta, base, iframe, object, embed, form, button, input, textarea, select, noscript, .chatgpt-exporter-checkbox, .turn-action-controls, .turn-action-controls';
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function idsIn(root) {
    const nodes = [root, ...root.querySelectorAll('[data-dil-message-id], [data-message-id]')];
    const section = root.closest('section[data-turn-id]');
    if (section) nodes.push(section);
    return new Set(nodes.flatMap(node => ['data-dil-message-id', 'data-chatgpt-search-message-ids', 'data-message-id', 'data-turn-id']
      .flatMap(key => (node.getAttribute(key) || '').split(/\s+/))).filter(Boolean));
  }

  function selectedRoots(messages) {
    const candidates = LocalExporter.messageRoots();
    const indexed = candidates.map(root => ({ root, ids: idsIn(root) }));
    const used = new Set();
    return messages.map(message => {
      const ids = [message.turnId, ...(message.messageIds || [])].filter(Boolean);
      const matches = indexed.filter(item => ids.some(id => item.ids.has(id)) && !used.has(item.root));
      if (!matches.length) throw new Error('部分已选消息尚未在网页中加载。请先滚动加载这些消息，或改用 Pandoc 排版模式。');
      matches.forEach(item => used.add(item.root));
      return { message, roots: matches.map(item => item.root) };
    });
  }

  async function capture(payload) {
    const entries = selectedRoots(payload.messages);
    if (document.fonts?.ready) await document.fonts.ready;
    const warnings = [];
    const resources = new Map();
    const rules = new Map();
    const getStyle = (node, pseudo) => node.ownerDocument.defaultView.getComputedStyle(node, pseudo);
    async function fetchAsset(address) {
      try { return await fetch(address); }
      catch (error) {
        const host = new URL(address).hostname;
        if (!(/(^|\.)(oaistatic\.com|oaiusercontent\.com)$/i.test(host) || host === 'cdn.openai.com')) throw error;
        const response = await chrome.runtime.sendMessage({ cmd: 'snapshot_resource', url: address });
        if (response.errcode) throw new Error(response.errmsg);
        return new Response(Uint8Array.from(atob(response.base64), char => char.charCodeAt(0)), { headers: { 'Content-Type': response.mime } });
      }
    }
    const cacheResource = (address, base = document.baseURI) => {
      const url = new URL(address, base).href;
      if (url.startsWith('data:')) return Promise.resolve(url);
      if (!resources.has(url)) resources.set(url, (async () => {
        const response = await fetchAsset(url);
        if (!response.ok) throw new Error(`Resource HTTP ${response.status}`);
        const blob = await response.blob();
        if (blob.size > 16 * 1024 * 1024) throw new Error('Resource exceeds 16 MiB');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
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
    function styleClass(node, pseudo) {
      const computed = getStyle(node, pseudo);
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
      const originals = [source, ...source.querySelectorAll('*')];
      const copies = [copy, ...copy.querySelectorAll('*')];
      for (let index = 0; index < originals.length; index++) {
        const node = originals[index], clone = copies[index];
        if (node.matches(OMIT) || node.closest('button, .turn-action-controls')) { clone.remove(); continue; }
        const { name } = styleClass(node);
        clone.classList.add(name);
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
          const { name: pseudoClass, computed } = styleClass(node, pseudo);
          const content = computed.getPropertyValue('content');
          if (!content || ['none', 'normal', '""', "''"].includes(content)) continue;
          if (!/^["'].*["']$/.test(content)) continue;
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
    const widths = entries.flatMap(entry => entry.roots.map(root => root.getBoundingClientRect().width));
    const width = Math.max(320, Math.min(1200, Math.max(...widths.filter(value => value > 0), 0) || 760));
    const sections = [];
    for (const entry of entries) {
      const bodies = [];
      for (const root of entry.roots) bodies.push(await freezeRoot(root));
      sections.push(`<section class="pdf-message" data-role="${escape(entry.message.role)}">${bodies.join('\n')}</section>`);
    }
    const fonts = new Set();
    const visited = new Set();
    async function fontRules(items, base) {
      for (const rule of items) {
        if (rule.type === 5) fonts.add(await freezeUrls(rule.cssText, base));
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
          for (const match of (await response.text()).matchAll(/@font-face\s*\{[^}]*\}/gi)) fonts.add(await freezeUrls(match[0], sheet.href));
        } catch { warnings.push('部分网页字体可能使用系统字体替代。'); }
      }
    }
    for (const sheet of document.styleSheets) await collectFonts(sheet);
    const css = [];
    for (const [style, name] of rules) css.push(`.${name}{${await freezeUrls(style)}}`);
    const bodyStyle = getStyle(document.body);
    let background = bodyStyle.backgroundColor;
    let ancestor = entries[0].roots[0].parentElement;
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
      .pdf-message pre,.pdf-message table,.pdf-message svg,.pdf-message img{break-inside:avoid}
      ${payload.options?.pageBreakPerPrompt ? '.pdf-message[data-role="Prompt"]:not(:first-child){break-before:page}' : ''}
      </style></head><body><main class="pdf-document">${sections.join('\n')}</main></body></html>`;
    return { html, css: '', width, theme, warnings: [...new Set(warnings)] };
  }
  globalThis.LocalWebSnapshot = { capture, selectedRoots, STYLE_PROPERTIES };
})();
