const $ = (s) => document.querySelector(s);
let entries = [],
  current = null,
  editor = null,
  filter = 'all',
  revision = 0;
const status = (t) => ($('#status').textContent = t);
async function request(m) {
  const r = await chrome.runtime.sendMessage(m);
  if (r?.error) throw Error(r.error);
  return r.data;
}
const run = (fn) =>
  Promise.resolve()
    .then(fn)
    .catch((e) => status(e.message));
function draw() {
  const q = $('#search').value.trim().toLocaleLowerCase(),
    shown = entries.filter((e) => {
      const v = e.record;
      if (
        (filter === 'starred' && !v.meta.starred) ||
        (filter === 'unread' && v.meta.read) ||
        (filter === 'notes' && !v.note.text && !v.annotations.some((a) => a.note))
      )
        return false;
      return [
        v.url,
        ...Object.values(v.meta),
        v.note.text,
        ...v.annotations.flatMap((a) => [a.selector.exact, a.note])
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(q);
    });
  $('#count').textContent = shown.length + ' 个网页 · 高亮与笔记均保存在本机';
  $('#pages').replaceChildren(
    ...shown.map((e) => {
      const v = e.record,
        b = document.createElement('button');
      b.className = current === v.url ? 'active' : '';
      const title = document.createElement('strong');
      title.textContent = (v.meta.starred ? '★ ' : '') + (v.meta.title || new URL(v.url).hostname);
      const meta = document.createElement('small');
      meta.textContent =
        new URL(v.url).hostname +
        ' · ' +
        v.annotations.length +
        ' 条标注' +
        (v.meta.folder ? ' · ' + v.meta.folder : '') +
        (v.meta.tags ? ' · ' + v.meta.tags : '');
      const p = document.createElement('p');
      p.textContent =
        v.note.text ||
        v.annotations.find((a) => a.note)?.note ||
        v.annotations[0]?.selector.exact ||
        '尚未添加笔记';
      b.append(title, meta, p);
      b.onclick = () => run(() => open(v.url));
      return b;
    })
  );
}
async function refresh() {
  entries = await request({ action: 'readingList' });
  draw();
}
async function open(url) {
  if (current !== url && editor?.hasDraft()) throw Error('请先保存正在编辑的笔记');
  const rev = ++revision,
    value = await request({ action: 'readingGet', url });
  if (rev !== revision) return;
  current = url;
  editor?.dispose();
  $('#detail').hidden = false;
  $('#empty').hidden = true;
  $('#title').textContent = value.meta.title || new URL(url).hostname;
  $('#url').textContent = url;
  editor = ShiyeReadingEditor.mount({
    container: $('#editor'),
    record: value,
    status,
    mutate: async (op) => {
      const next = await request({ action: 'readingMutate', url, op });
      await refresh();
      return next;
    },
    sync: () => request({ action: 'readingSync', url }),
    locate: () => {
      status('请打开原网页定位标注');
      return false;
    },
    exportNotes: () => request({ action: 'readingDownload', url, format: 'md' })
  });
  draw();
}
$('#search').oninput = draw;
for (const b of document.querySelectorAll('[data-filter]'))
  b.onclick = () => {
    filter = b.dataset.filter;
    for (const n of document.querySelectorAll('[data-filter]'))
      n.setAttribute('aria-pressed', String(n === b));
    draw();
  };
$('#source').onclick = () => {
  if (current) chrome.tabs.create({ url: current });
};
$('#settings').onclick = () => chrome.runtime.openOptionsPage();
$('#backup').onclick = () =>
  run(async () => {
    await request({ action: 'readingBackup' });
    status('笔记备份已交给浏览器下载');
  });
$('#restore').onclick = () => $('#backup-file').click();
$('#backup-file').onchange = (e) =>
  run(async () => {
    const file = e.target.files[0];
    if (!file) return;
    if (editor?.hasDraft()) throw Error('请先保存正在编辑的笔记');
    if (file.size > 20 * 1024 * 1024) throw Error('笔记备份超过20MiB');
    const backup = JSON.parse(await file.text());
    await request({ action: 'readingImport', backup });
    await refresh();
    if (current) await open(current);
    status('笔记已合并导入；删除记录不会复活');
    e.target.value = '';
  });
void run(refresh);

let changeTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.keys(changes).some((k) => k.startsWith('reading:'))) return;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(
    () =>
      run(async () => {
        await refresh();
        const next = entries.find((e) => e.record.url === current);
        if (next && editor && !editor.isBusy()) editor.set(next.record);
      }),
    150
  );
});
