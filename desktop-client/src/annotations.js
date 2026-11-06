import {observeReadingDocument} from './reading-observer.js';
import '../../exporter-extension/reading-model.js';
import '../../exporter-extension/reading-anchors.js';
import '../../exporter-extension/reading-editor.js';
import '../../exporter-extension/reading.css';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
const M = globalThis.ShiyeReading,
  A = globalThis.ShiyeAnchors;
export function mountAnnotations({ cmd, run, status }) {
  const notebookButton = document.createElement('button');
  notebookButton.id = 'notebook-open';
  notebookButton.textContent = '阅读笔记';
  document.querySelector('.sidebar nav').append(notebookButton);
  const notebook = document.createElement('dialog');
  notebook.id = 'notebook-dialog';
  notebook.innerHTML =
    '<header><div><p>所有网页的高亮与思考</p><h2>阅读笔记库</h2></div><button id="notebook-close" aria-label="关闭阅读笔记库">×</button></header><div class="notebook-body"><section><input id="notebook-query" type="search" aria-label="搜索阅读笔记" placeholder="搜索标题、摘录和笔记"><div id="notebook-pages"></div></section><section><div id="notebook-empty"><p>在浏览器添加高亮或笔记后，点击“同步客户端”，即可在这里查看。</p><p>这里也会保留尚未保存整页快照的阅读记录。</p></div><div id="notebook-detail" hidden><h3 id="notebook-title"></h3><button id="notebook-source">打开原网页 ↗</button><div id="notebook-editor"></div><p id="notebook-status" role="status" aria-live="polite"></p></div></section></div>';
  document.body.append(notebook);
  let pages = [],
    notebookUrl = null,
    notebookEditor = null;
  const exportRecord = async (value) => {
    const filename = M.filename((value.meta.title || '阅读笔记') + '_笔记', 'md'),
      path = await save({ defaultPath: filename, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (path) {
      await cmd({ action: 'export_notes', url: value.url, path });
      status('阅读笔记已保存为 Markdown');
    }
  };
  function drawPages() {
    const q = document.querySelector('#notebook-query').value.trim().toLocaleLowerCase();
    document.querySelector('#notebook-pages').replaceChildren(
      ...pages
        .filter((v) =>
          [
            v.meta.title,
            v.url,
            v.meta.tags,
            v.note.text,
            ...v.annotations.flatMap((a) => [a.selector.exact, a.note])
          ]
            .join(' ')
            .toLocaleLowerCase()
            .includes(q)
        )
        .map((value) => {
          const b = document.createElement('button');
          b.className = value.url === notebookUrl ? 'active' : '';
          const title = document.createElement('strong');
          title.textContent = value.meta.title || new URL(value.url).hostname;
          const hint = document.createElement('small');
          hint.textContent = new URL(value.url).hostname + ' · ' + value.annotations.length + ' 条标注';
          b.append(title, hint);
          b.onclick = () => run(() => openNotebookPage(value.url));
          return b;
        })
    );
  }
  async function refreshPages() {
    pages = (await cmd({ action: 'reading_list' })).sort(
      (a, b) =>
        Math.max(b.note.updatedAt, b.meta.updatedAt, ...b.annotations.map((a) => a.updatedAt)) -
        Math.max(a.note.updatedAt, a.meta.updatedAt, ...a.annotations.map((a) => a.updatedAt))
    );
    drawPages();
  }
  async function openNotebookPage(url) {
    if (notebookEditor?.hasDraft()) throw Error('请先保存当前笔记，再切换网页');
    notebookUrl = url;
    const value = await cmd({ action: 'reading_get', url });
    notebookEditor?.dispose();
    document.querySelector('#notebook-detail').hidden = false;
    document.querySelector('#notebook-empty').hidden = true;
    document.querySelector('#notebook-title').textContent = value.meta.title || new URL(url).hostname;
    notebookEditor = ShiyeReadingEditor.mount({
      container: document.querySelector('#notebook-editor'),
      record: value,
      status: (t) => {
        status(t);
        document.querySelector('#notebook-status').textContent = t;
      },
      mutate: async (op) => {
        const latest = await cmd({ action: 'reading_get', url }),
          next = await cmd({ action: 'reading_merge', url, record: M.mutate(latest, op) });
        await refreshPages();
        return next;
      },
      locate: () => {
        status('请在对应的网页快照或原网页中定位摘录');
        return false;
      },
      exportNotes: exportRecord
    });
    drawPages();
  }
  notebookButton.onclick = () =>
    run(async () => {
      await refreshPages();
      if (!notebook.open) notebook.showModal();
    });
  document.querySelector('#notebook-query').oninput = drawPages;
  document.querySelector('#notebook-source').onclick = () =>
    run(() => cmd({ action: 'open_source', url: notebookUrl }));
  const closeNotebook = () => {
    if (notebookEditor?.hasDraft()) {
      status('请先保存正在编辑的笔记');
      return;
    }
    notebook.close();
  };
  document.querySelector('#notebook-close').onclick = closeNotebook;
  notebook.addEventListener('cancel', (e) => {
    if (notebookEditor?.hasDraft()) {
      e.preventDefault();
      status('请先保存正在编辑的笔记');
    }
  });
  const bar = document.createElement('div');
  bar.className = 'annotation-bar';
  bar.innerHTML =
    '<span>阅读标注</span><button id="annotate-selection">高亮选区</button><button id="annotate-note">为选区批注</button><button id="annotation-toggle" aria-expanded="false">标注与笔记 <span id="annotation-count">0</span></button>';
  const pane = document.createElement('aside');
  pane.className = 'annotation-pane';
  pane.hidden = true;
  pane.innerHTML =
    '<header><div><p>拾页 · 阅读记录</p><h2>标注与笔记</h2></div><button id="annotation-close" aria-label="关闭笔记面板">×</button></header><div id="annotation-editor"></div><p class="annotation-hint">原文保持不变。浏览器中的记录可通过网页笔记面板“同步客户端”双向合并。</p>';
  document.querySelector('.reading-area').before(bar, pane);
  const $ = (s) => document.querySelector(s);
  let active = null,
    editor = null,
    stopObserving = () => {},
    selection = null,
    selectionStamp = '';
  const show = (value) => {
    pane.hidden = !value;
    $('#annotation-toggle').setAttribute('aria-expanded', String(value));
  };
  $('#annotation-toggle').onclick = () => show(pane.hidden);
  $('#annotation-close').onclick = () => show(false);
  function seed(archive) {
    const record = archive.reading || M.empty(archive.url);
    if (!record.meta.updatedAt)
      record.meta = {
        ...record.meta,
        ...Object.fromEntries(
          ['title', 'folder', 'tags', 'starred', 'read']
            .filter((k) => archive.library?.[k] !== undefined)
            .map((k) => [k, archive.library[k]])
        )
      };
    return M.validate(record);
  }
  function paint(record, options = {}) {
    if (!active) return;
    active.archive.reading = record;
    const result = A.paint(active.doc, record, options);
    editor?.showMissing(result.missing);
    $('#annotation-count').textContent = record.annotations.length;
  }
  async function mutate(op) {
    if (!active) throw Error('请先打开收藏');
    const target = active;
    let latest = await cmd({ action: 'reading_get', url: target.archive.url });
    if (!latest?.version) throw Error('客户端未返回有效的阅读记录');
    latest = M.merge(latest, seed(target.archive));
    const next = await cmd({
      action: 'reading_merge',
      url: target.archive.url,
      record: M.mutate(latest, op)
    });
    if (active === target) {
      target.archive.reading = next;
      return next;
    }
    throw Error('已切换收藏，记录已保存');
  }
  async function add(note) {
    if (!active) return;
    const selector = A.capture(active.doc) || selection;
    if (!selector) throw Error('请先在正文选中一段文字，再点击高亮或批注');
    const existing = active.archive.reading.annotations.find(
      (a) => a.selector.start === selector.start && a.selector.exact === selector.exact
    );
    const a = existing || { id: crypto.randomUUID(), selector, color: 'yellow', note: '' };
    const next = existing ? active.archive.reading : await mutate({ kind: 'upsert', annotation: a });
    editor.set(next);
    active.doc.defaultView.getSelection()?.removeAllRanges();
    selection = null;
    if (note) {
      show(true);
      editor.focus(a.id);
    }
    status(note ? '可以为这段话写下批注' : '高亮已保存在客户端');
  }
  $('#annotate-selection').onclick = () => run(() => add(false));
  $('#annotate-note').onclick = () => run(() => add(true));
  void listen('reading-changed', (event) => {
    if (notebook.open)
      void run(async () => {
        await refreshPages();
        if (notebookUrl && notebookEditor && !notebookEditor.isBusy() && !notebookEditor.hasDraft())
          notebookEditor.set(await cmd({ action: 'reading_get', url: notebookUrl }));
      });
    if (!active || editor?.isBusy()) return;
    const address = event.payload?.url;
    if (address && M.url(address) !== M.url(active.archive.url)) return;
    const target = active;
    if (editor?.hasDraft()) {
      status('阅读记录已在另一处更新，请先保存当前草稿再重新打开收藏');
      return;
    }
    void run(async () => {
      const fresh = await cmd({ action: 'reading_get', url: target.archive.url });
      if (active === target && fresh?.version) editor.set(M.merge(target.archive.reading, fresh));
    });
  });
  return {
    hasDraft: () => !!editor?.hasDraft(),
    attach({ doc, archive }) {
      stopObserving();
      active = null;
      editor?.dispose();
      editor = null;
      selection = null;
      selectionStamp = '';
      show(false);
      let record;
      try {
        record = seed(archive);
      } catch {
        bar.hidden = true;
        return { dispose() {} };
      }
      bar.hidden = false;
      active = { doc, archive };
      archive.reading = record;
      const target = active;
      editor = ShiyeReadingEditor.mount({
        container: $('#annotation-editor'),
        record,
        status,
        mutate,
        locate: (id) => A.go(doc, archive.reading, id),
        exportNotes: async (value) => {
          const filename = M.filename((value.meta.title || archive.title || '阅读笔记') + '_笔记', 'md'),
            path = await save({ defaultPath: filename, filters: [{ name: 'Markdown', extensions: ['md'] }] });
          if (path) {
            await cmd({ action: 'export_notes', url: value.url, path });
            status('阅读笔记已保存为 Markdown');
          }
        },
        changed: paint
      });
      // WKWebView disables scripts in snapshots, so trusted parent controls read selection.
      stopObserving = observeReadingDocument(doc,{selection(){
        if(active!==target)return;
        try{const next=A.capture(doc);if(next){selection=next;selectionStamp=next.start+':'+next.end;}}catch{}
      }});
      return {
        dispose() {
          if (active !== target) return;
          stopObserving();
          active = null;
          editor?.dispose();
          editor = null;
          selection = null;
        }
      };
    }
  };
}
