// Runs before dependencies on initial injection and extension reload recovery.
(() => {
  const previous = globalThis.__archiveOverlay;
  const version = chrome.runtime.getManifest().version;
  if (previous?.version === version && previous.alive?.()) return;
  const host = document.getElementById('conversation-archive');
  const root = host?.shadowRoot;
  const panel = root?.querySelector('.selector');
  if (panel && !panel.hidden) globalThis.__archiveRestore = { url: location.href, selected: [...root.querySelectorAll('[data-message]:checked')].map(n => n.dataset.message) };
  try { previous?.dispose?.(); } catch { }
  try { previous?.close?.(); } catch { }
  if (host) {
    // Versions before dispose() may still have observers which reattach their
    // old host. Keep any such host inert and permanently hidden.
    host.id = 'conversation-archive-retired-' + Date.now(); host.hidden = true; host.inert = true;
    host.style.setProperty('display', 'none', 'important'); host.remove();
  }
  delete globalThis.__archiveOverlay;
})();
