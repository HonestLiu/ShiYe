// Quiet restoration on authorised sites. No page is saved and the client is never contacted.
(() => {
  if (globalThis.__shiyeNotes?.version === chrome.runtime.getManifest().version) return;
  globalThis.__shiyeReadingRestore?.dispose();
  let disposed = false,
    record = null,
    address = location.href,
    timer,
    debounce,
    painting = false;
  function paint() {
    if (disposed || !record) return;
    painting = true;
    try {
      ShiyeAnchors.paint(document, record);
    } catch {
    } finally {
      observer.takeRecords();
      painting = false;
    }
  }
  async function load() {
    try {
      if (
        (await chrome.storage.local.get('readingPreferences')).readingPreferences?.restoreHighlights === false
      ) {
        ShiyeAnchors.clear(document);
        dispose();
        return;
      }
      address = location.href;
      const result = await chrome.runtime.sendMessage({ action: 'readingGet', url: address });
      if (disposed || location.href !== address || result?.error) return;
      record = result.data;
      paint();
    } catch {
      dispose();
    }
  }
  const observer = new MutationObserver((changes) => {
    if (disposed || painting || !record?.annotations.length) return;
    if (
      !changes.some((m) => !m.target.parentElement?.closest('[data-shiye-page-ui],[data-shiye-reading-ui]'))
    )
      return;
    clearTimeout(debounce);
    debounce = setTimeout(paint, 700);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const storage = (changes, area) => {
    if (
      area === 'local' &&
      (changes.readingPreferences || Object.keys(changes).some((k) => k.startsWith('reading:')))
    )
      void load();
  };
  chrome.storage.onChanged.addListener(storage);
  const markClick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || !document.getSelection()?.isCollapsed) return;
    const mark = e.target.closest?.('mark[data-shiye-highlight]'),
      id = (mark?.dataset.readerNote || mark?.dataset.shiyeHighlight)?.split(' ')[0];
    if (!record?.annotations.some((a) => a.id === id)) return;
    e.preventDefault();
    e.stopPropagation();
    void chrome.runtime.sendMessage({ action: 'readingOpen', url: location.href, id }).catch(() => { });
  };
  document.addEventListener('click', markClick, true);
  function dispose() {
    disposed = true;
    document.removeEventListener('click', markClick, true);
    clearTimeout(debounce);
    clearInterval(timer);
    observer.disconnect();
    try {
      chrome.storage.onChanged.removeListener(storage);
    } catch { }
  }
  globalThis.__shiyeReadingRestore = { dispose };
  timer = setInterval(() => {
    if (location.href !== address) void load();
  }, 700);
  void load();
})();
