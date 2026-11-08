(() => {
  const version = chrome.runtime.getManifest().version;
  if (globalThis.__shiyeNotes?.version === version) return;
  globalThis.__shiyeReadingRestore?.dispose();
  globalThis.__shiyeNotes?.dispose();
  const host = document.createElement('div');
  host.dataset.shiyeReadingUi = '';
  host.style.cssText =
    'all:initial!important;position:fixed!important;right:22px!important;bottom:22px!important;z-index:2147483100!important';
  const root = host.attachShadow({ mode: 'open' });
  for (const file of ['webpage.css', 'reading.css', 'webpage-theme.css']) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL(file);
    root.append(link);
  }
  const box = document.createElement('div');
  box.innerHTML =
    '<section id="shiye-notes-panel" popover="auto" aria-labelledby="notes-heading" style="position:fixed;inset:20px 20px 20px auto;margin:0;width:min(400px,calc(100vw - 32px));max-height:calc(100dvh - 40px);overflow:auto;border:1px solid #d7e1d6;border-radius:16px;padding:22px;background:#fffdf8;color:#253b33;box-shadow:0 15px 65px #1b352731;font:13px/1.7 system-ui"><header><div><span class="eyebrow">留下一点自己的思考</span><h2 id="notes-heading">标注与笔记</h2></div><button class="close" popovertarget="shiye-notes-panel" popovertargetaction="hide" aria-label="关闭笔记面板">×</button></header><p class="site"></p><div data-editor></div><p class="notes-status" role="status" aria-live="polite"></p></section><div id="shiye-selection" popover="manual" style="position:fixed;inset:auto;margin:0;border:1px solid #d7e1d6;border-radius:10px;padding:6px;background:#fffdf8;color:#253b33;box-shadow:0 5px 25px #1b352731;font:12px system-ui"><button data-copy aria-live="polite">复制</button><button data-highlight>高亮</button><button data-note>批注</button><button data-clip>收藏选区</button><button data-translate>翻译</button><button data-dismiss aria-label="关闭划词工具">×</button></div>';
  root.append(box);
  document.documentElement.append(host);
  const $ = (s) => root.querySelector(s),
    panel = $('#shiye-notes-panel'),
    toolbar = $('#shiye-selection');
  let currentUrl = location.href,
    record = ShiyeReading.empty(currentUrl),
    preferences = {},
    editor = null,
    selection = null,
    copyText = '',
    disposed = false,
    updating = false,
    capturing = false,
    debounce = null,
    raf = null,
    paintQueued = false;
  const request = async (m) => {
    const r = await chrome.runtime.sendMessage({ ...m, url: location.href });
    if (r?.error) throw Error(r.error);
    if (!r?.data) throw Error('笔记未保存，请重新打开拾页');
    return r.data;
  };
  const status = (t) => ($('.notes-status').textContent = t);
  function hide() {
    if (toolbar.matches(':popover-open')) toolbar.hidePopover();
  }
  function paint(value, { visible = true } = {}) {
    record = value;
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (disposed || capturing) return;
      updating = true;
      try {
        const result = ShiyeAnchors.paint(document, record, { visible });
        editor?.showMissing(result.missing);
      } catch (e) {
        status(e.message);
      } finally {
        observer.takeRecords();
        updating = false;
      }
    });
  }
  async function mutate(op) {
    if (location.href !== currentUrl) throw Error('网页已切换，请返回原页面保存笔记草稿');
    if (!record.meta.title && op.kind !== 'meta')
      record = await request({
        action: 'readingMutate',
        op: { kind: 'meta', patch: { title: (document.title || location.hostname).slice(0, 300) } }
      });
    const next = await request({ action: 'readingMutate', op });
    record = next;
    return next;
  }
  async function load() {
    try {
      preferences = (await chrome.storage.local.get('readingPreferences')).readingPreferences || {};
      currentUrl = location.href;
      record = await request({ action: 'readingGet' });
      if (disposed) return;
      editor?.dispose();
      editor = ShiyeReadingEditor.mount({
        container: $('[data-editor]'),
        record,
        mutate,
        status,
        locate: (id) => ShiyeAnchors.go(document, record, id),
        sync: () => request({ action: 'readingSync' }),
        exportNotes: (value) => request({ action: 'readingDownload', format: 'md' }),
        changed: paint
      });
      $('.site').textContent = document.title || location.hostname;
      const saveTitle = document.getElementById('shiye-webpage')?.shadowRoot?.querySelector('#page-title');
      if (saveTitle && record.meta.title) saveTitle.value = record.meta.title;
    } catch (e) {
      status(e.message);
    }
  }
  function open(id) {
    if (!panel.matches(':popover-open')) panel.showPopover();
    if (id) editor?.focus(id);
  }
  const saveHost = document.getElementById('shiye-webpage');
  const entry = document.createElement('button');
  entry.textContent = '标注与笔记';
  entry.onclick = () => open();
  saveHost?.shadowRoot?.querySelector('.bottom').prepend(entry);
  async function add(note = false) {
    if (!selection) return;
    const s = selection;
    hide();
    try {
      const id = crypto.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
        existing = record.annotations.find(
          (a) => a.selector.start === s.start && a.selector.exact === s.exact
        );
      const a = existing || {
        id,
        selector: s,
        color: Object.hasOwn(ShiyeReading.colors, preferences.color) ? preferences.color : 'yellow',
        note: ''
      };
      const updated = note ? { ...a, kind: 'note' } : a;
      const next = existing && !note ? record : await mutate({ kind: 'upsert', annotation: updated, ...(existing ? { expected: existing } : {}) });
      editor.set(next);
      document.getSelection()?.removeAllRanges();
      selection = null;
      if (note) open(a.id);
      else status('高亮已保存在本机');
    } catch (e) {
      open();
      status(e.message);
    }
  }
  const translation=document.createElement('section');translation.id='shiye-translation';translation.setAttribute('popover','auto');translation.setAttribute('aria-label','选区翻译');translation.innerHTML='<header><h2>选区翻译</h2><button class="close" aria-label="关闭翻译">×</button></header><p class="translation-info">仅翻译选中文字，由必应提供服务</p><blockquote data-original></blockquote><p data-result role="status" aria-live="polite"></p><div class="notes-actions"><button data-target="zh-Hans">译为中文</button><button data-target="en">译为英语</button><button data-save-translation disabled>保存为批注</button></div>';root.append(translation);
  let translated=null,translationSelector=null,translationUrl=null,translationRevision=0;
  translation.querySelector('.close').onclick=()=>translation.hidePopover();
  async function translateSelection(to='zh-Hans'){
    const own=++translationRevision,selector=translationSelector,url=translationUrl;if(!selector)return;
    translated=null;translation.querySelector('[data-save-translation]').disabled=true;translation.querySelector('[data-result]').textContent='正在翻译…';
    try{const result=await request({action:'translateBing',text:selector.display||selector.exact,to});if(disposed||own!==translationRevision||location.href!==url)return;translated=result;translation.querySelector('[data-result]').textContent=result.text+(result.cached?'\n（本地缓存）':'');translation.querySelector('[data-save-translation]').disabled=false;}catch(e){if(own===translationRevision)translation.querySelector('[data-result]').textContent=e.message;}
  }
  for(const b of translation.querySelectorAll('[data-target]'))b.onclick=()=>translateSelection(b.dataset.target);
  $('[data-translate]').onclick=()=>{if(!selection)return;translationSelector={...selection};translationUrl=location.href;hide();translation.querySelector('[data-original]').textContent=translationSelector.display||translationSelector.exact;translation.showPopover();void translateSelection();};
  translation.querySelector('[data-save-translation]').onclick=async()=>{
    if(!translated||!translationSelector)return;const b=translation.querySelector('[data-save-translation]');b.disabled=true;
    try{if(location.href!==translationUrl)throw Error('网页已切换，请重新选择文字');if(editor?.hasDraft())throw Error('请先保存正在编辑的笔记');const existing=record.annotations.find(a=>a.selector.start===translationSelector.start&&a.selector.exact===translationSelector.exact),note=(existing?.note?existing.note+'\n\n':'')+'必应译文：\n'+translated.text;
      const next=await mutate({kind:'upsert',annotation:{...(existing||{id:crypto.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),selector:translationSelector,color:Object.hasOwn(ShiyeReading.colors,preferences.color)?preferences.color:'yellow'}),kind:'note',note},...(existing?{expected:existing}:{})});editor.set(next);translation.hidePopover();open(existing?.id||next.annotations.find(a=>a.note===note)?.id);status('译文已保存为批注');
    }catch(e){translation.querySelector('[data-result]').textContent=e.message;b.disabled=false;}
  };
  $('[data-highlight]').onclick = () => add(false);
  $('[data-note]').onclick = () => add(true);
  $('[data-clip]').onclick = async () => {
    if (!selection) return;
    const text = selection.display || selection.exact;
    hide();
    try {
      const result = await request({ action: 'readingClip', text, title: document.title });
      open();
      status(result.duplicate ? '摘录已在内容库中' : '选区已收藏到客户端');
    } catch (e) {
      open();
      status(e.message);
    }
  };
  $('[data-copy]').onpointerdown = e => e.preventDefault();
  $('[data-copy]').onclick = async () => {
    if (!copyText) return;
    const button = $('[data-copy]');
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(copyText);
      else {
        // HTTP pages lack Clipboard API; keep this fallback inside the user's click.
        const ranges = [...Array(document.getSelection().rangeCount)].map((_, i) => document.getSelection().getRangeAt(i).cloneRange());
        const active = document.activeElement, input = document.createElement('textarea');
        input.value = copyText;
        input.dataset.shiyeReadingUi = '';
        input.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
        document.body.append(input);
        try {
          input.focus({preventScroll:true}); input.select();
          if (!document.execCommand('copy')) throw Error('复制失败，请使用系统复制快捷键');
        } finally {
          input.remove(); active?.focus({preventScroll:true});
          const selected = document.getSelection(); selected.removeAllRanges();
          for (const range of ranges) selected.addRange(range);
        }
      }
      button.textContent = '已复制'; button.title = '已复制选中文字';
    } catch {
      button.textContent = '复制失败'; button.title = '请按 ⌘C / Ctrl+C 复制';
    }
  };
  $('[data-dismiss]').onclick = hide;
  function checkSelection() {
    if (
      disposed ||
      preferences.selectionMenu === false ||
      panel.matches(':popover-open') ||
      root.activeElement
    ) {
      if (preferences.selectionMenu === false) hide();
      return;
    }
    try {
      const s = ShiyeAnchors.capture(document);
      if (!s) {
        hide();
        return;
      }
      selection = s;
      const selectedText = document.getSelection().toString();
      if (copyText !== selectedText) {
        copyText = selectedText;
        $('[data-copy]').textContent = '复制';
        $('[data-copy]').title = '复制选中文字';
      }
      const r = document.getSelection().getRangeAt(0).getBoundingClientRect();
      toolbar.style.left = Math.max(8, Math.min(innerWidth - 295, r.left)) + 'px';
      toolbar.style.top = Math.max(8, Math.min(innerHeight - 52, r.bottom + 8)) + 'px';
      if (!toolbar.matches(':popover-open')) toolbar.showPopover();
      toolbar.style.left = Math.max(8, Math.min(innerWidth - toolbar.getBoundingClientRect().width - 8, r.left)) + 'px';
    } catch {
      hide();
    }
  }
  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(checkSelection);
  };
  document.addEventListener('mouseup', schedule);
  document.addEventListener('keyup', schedule);
  document.addEventListener('selectionchange', schedule);
  const dismiss = (e) => {
    if (e.key === 'Escape') hide();
  };
  document.addEventListener('keydown', dismiss);
  // Re-anchor only on source text/subtree changes; our UI and mark mutations are excluded.
  const observer = new MutationObserver((changes) => {
    if (updating || disposed || capturing) return;
    if (
      changes.some((m) => !m.target.parentElement?.closest('[data-shiye-page-ui],[data-shiye-reading-ui]'))
    ) {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (!editor?.hasDraft()) paint(record);
      }, 700);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const timer = setInterval(() => {
    if (location.href !== currentUrl) {
      ++translationRevision;translated=null;translationSelector=null;translation.hidePopover();
      hide();
      if (editor?.hasDraft()) {
        status('网页已切换，当前笔记草稿仍保留；请返回原页面保存。');
        return;
      }
      ShiyeAnchors.clear(document);
      void load();
    }
  }, 700);
  const beforeUnload = (e) => {
    if (editor?.hasDraft()) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  const storage = (changes, area) => {
    if (area !== 'local') return;
    if (changes.readingPreferences) {
      preferences = changes.readingPreferences.newValue || {};
      if (preferences.selectionMenu === false) hide();
    }
    for (const [k, v] of Object.entries(changes))
      if (k.startsWith('reading:') && v.newValue?.record?.url === ShiyeReading.url(location.href)) {
        record = v.newValue.record;
        if(editor?.hasDraft()){paint(record);status('阅读记录已在另一处更新，当前草稿仍保留；请先复制草稿再重新打开记录');}
        else editor?.set(record);
      }
  };
  chrome.storage.onChanged.addListener(storage);
  const markClick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || !document.getSelection()?.isCollapsed) return;
    const mark = e.target.closest?.('mark[data-shiye-highlight]'),
      id = (mark?.dataset.readerNote || mark?.dataset.shiyeHighlight)?.split(' ')[0];
    if (!record.annotations.some((a) => a.id === id)) return;
    e.preventDefault();
    e.stopPropagation();
    open(id);
  };
  document.addEventListener('click', markClick, true);
  const listener = (m, s, reply) => {
    if (m.action === 'reading-context-highlight') {
      selection = ShiyeAnchors.capture(document);
      void ready.then(() => add(m.note));
      reply({ ok: true });
    }
    if (m.action === 'reading-context-save') {
      void ready.then(async () => {
        try {
          open();
          status('正在收藏到客户端…');
          const r = await request({
            action: m.image ? 'readingImage' : m.link ? 'readingLink' : 'readingClip',
            text: m.text,
            link: m.link,
            image: m.image,
            title: m.image
              ? '图片 · ' +
              ([...document.images].find((n) => (n.currentSrc || n.src) === m.image)?.alt || document.title)
              : m.link
                ? '链接 · ' +
                ([...document.querySelectorAll('a[href]')]
                  .find((n) => n.href === m.link)
                  ?.textContent.trim() || new URL(m.link).hostname)
                : document.title + ' · 摘录'
          });
          open();
          status(r.duplicate ? '内容已在收藏中' : '已收藏到客户端');
        } catch (e) {
          open();
          status(e.message);
        }
      });
      reply({ ok: true });
    }
    if (m.action === 'reading-open') {
      void ready.then(() => open(m.id));
      reply({ ok: true });
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  globalThis.__shiyeNotes = {
    version,
    open,
    get: () => record,
    hasDraft: () => !!editor?.hasDraft(),
    captureStart() {
      capturing = true;
      hide();
      updating = true;
      ShiyeAnchors.clear(document);
      observer.takeRecords();
      updating = false;
    },
    captureEnd() {
      capturing = false;
      paint(record);
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      clearTimeout(debounce);
      clearInterval(timer);
      cancelAnimationFrame(raf);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', markClick, true);
      document.removeEventListener('mouseup', schedule);
      document.removeEventListener('keyup', schedule);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('keydown', dismiss);
      chrome.storage.onChanged.removeListener(storage);
      chrome.runtime.onMessage.removeListener(listener);
      entry.remove();
      ShiyeAnchors.clear(document);
      host.remove();
    }
  };
  const ready = load();
})();
