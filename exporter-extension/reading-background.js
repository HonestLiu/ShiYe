import './reading-model.js';
const M = globalThis.ShiyeReading;
let queue = Promise.resolve(), pendingLocal = true;
const key = async (url) =>
  'reading:' +
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(M.url(url)))),
    (n) => n.toString(16).padStart(2, '0')
  ).join('');
export async function localReading(url) {
  const k = await key(url),
    v = (await chrome.storage.local.get(k))[k];
  return v ? M.validate(v.record, url) : M.empty(url);
}
async function restoreSite(record) {
  if (!record.annotations.length) return;
  const { readingPreferences = {} } = await chrome.storage.local.get('readingPreferences');
  if (readingPreferences.restoreHighlights === false) return;
  const u = new URL(record.url),
    site = u.protocol + '//' + u.hostname,
    id = 'shiye-restore-' + (await key(site)).slice(8),
    scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!scripts.length && (await chrome.permissions.contains({ origins: [site + '/*'] })))
    await chrome.scripting.registerContentScripts([
      {
        id,
        matches: [site + '/*'],
        js: ['reading-model.js', 'reading-anchors.js', 'reading-restore.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true
      }
    ]);
}
async function persist(record, extra = {}) {
  record = M.validate(record);
  const k = await key(record.url),
    old = (await chrome.storage.local.get(k))[k] || {};
  if (extra.syncPending !== false) pendingLocal = true;
  await chrome.storage.local.set({ [k]: { ...old, ...extra, record, updatedAt: Date.now() } });
  try {
    await restoreSite(record);
  } catch (e) {
    console.warn('高亮自动恢复需长期站点授权', e.message);
  }
  return record;
}

export function rememberReading(record, extra) {
  const task = queue.then(async () => persist(M.merge(await localReading(record.url), record), extra));
  queue = task.catch(() => { });
  return task;
}
let syncTask = null, lastSyncAttempt = 0, observedRevision = null;
const nativeContext = {native: async request => {
  const r = await chrome.runtime.sendNativeMessage('io.local.archive_reader', request);
  if (r?.error) throw Error(r.error);
  if (!r?.data) throw Error('客户端未响应');
  return r.data;
}};
export function syncAllReading(context = nativeContext) {
  if (syncTask) return syncTask;
  const task = queue.then(async () => {
    const hello = await context.native({action:'hello'});
    if (hello.readingSyncVersion !== 1) throw Error('自动同步需要更新拾页客户端');
    const all = await chrome.storage.local.get(null), urls = new Set(Object.entries(all).filter(([k])=>k.startsWith('reading:')).map(([,v])=>M.url(v.record.url)));
    let after = '', initialRevision, pages = 0;
    do {
      const inventory = await context.native({action:'reading_inventory',after});
      if (!Array.isArray(inventory.urls) || inventory.urls.length > 50 || ++pages > 2000) throw Error('客户端笔记列表异常');
      initialRevision ??= inventory.revision;
      for (const url of inventory.urls) urls.add(M.url(url));
      if (inventory.next && (typeof inventory.next !== 'string' || inventory.next <= after)) throw Error('客户端同步游标异常');
      after = inventory.next || '';
    } while(after);
    let count = 0;
    for (const url of urls) {
      const local = await localReading(url), k = await key(url);
      const merged = M.merge(local, await context.native({action:'reading_merge',url,record:local}));
      const stored = (await chrome.storage.local.get(k))[k];
      if (!stored || JSON.stringify(stored.record)!==JSON.stringify(merged) || stored.syncPending)
        await persist(merged,{syncPending:false,syncedAt:Date.now()});
      count++;
    }
    // Keep the pre-exchange revision: concurrent changes trigger another pass.
    observedRevision = initialRevision; pendingLocal = false;
    await chrome.storage.local.set({readingSyncStatus:{at:Date.now(),error:''}});
    return {count};
  });
  queue = task.catch(()=>{});
  syncTask = task.finally(()=>{syncTask=null;});
  return syncTask;
}
export async function autoSyncReading(revision) {
  if (typeof revision!=='string' || syncTask || Date.now()-lastSyncAttempt<15000) return;
  if (revision===observedRevision && !pendingLocal) return;
  lastSyncAttempt = Date.now();
  try {await syncAllReading();} catch(e) {await chrome.storage.local.set({readingSyncStatus:{at:Date.now(),error:e.message}});}
}
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
export async function saveClip({ url, title, text = '', link, image }, context) {
  url = M.url(url);
  if (typeof text !== 'string' || (!text.trim() && !link && !image) || text.length > 12000)
    throw Error('请先选中需要收藏的文字');
  if (link) {
    M.url(link);
    link = new URL(link).href;
  }
  const reading = await localReading(url),
    html =
      "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';style-src 'unsafe-inline';img-src data:;base-uri 'none';form-action 'none'\"><style>body{max-width:760px;margin:40px auto;padding:24px;font:17px/1.9 system-ui;color:#253b33}blockquote{margin:28px 0;padding:10px 22px;border-left:4px solid #b5cbb7;white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>" +
      escape(title || '网页摘录') +
      '</h1>' +
      (image
        ? '<figure><img style="max-width:100%;height:auto" src="' + image + '" alt="收藏的图片"></figure>'
        : link
          ? '<p><a href="' + escape(link) + '">' + escape(link) + '</a></p>'
          : '<blockquote>' + escape(text) + '</blockquote>') +
      '<p><a href="' +
      escape(url) +
      '">查看来源网页</a></p></body></html>',
    archive = {
      version: 1,
      source: image ? 'image' : link ? 'link' : 'clip',
      title: String(title || '网页摘录').slice(0, 300),
      url,
      capturedAt: new Date().toISOString(),
      text: link || text,
      snapshot: {
        html,
        width: 808,
        offline: true,
        warnings: link ? ['此收藏只保存链接，没有离线保存目标网页正文。'] : []
      },
      reading,
      library: Object.fromEntries(['folder', 'tags', 'starred', 'read'].map((k) => [k, reading.meta[k]]))
    };
  const info = await context.native({ action: 'hello' });
  if (info.readingAnnotationsVersion !== 1) throw Error('摘录收藏需要拾页0.8.0或以上版本');
  const bytes = new TextEncoder().encode(JSON.stringify(archive)),
    sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
      n.toString(16).padStart(2, '0')
    ).join(''),
    { upload } = await context.native({ action: 'begin', size: bytes.length, sha256 });
  try {
    for (let offset = 0; offset < bytes.length; offset += 384 * 1024) {
      let binary = '';
      const chunk = bytes.subarray(offset, offset + 384 * 1024);
      for (let i = 0; i < chunk.length; i += 32768)
        binary += String.fromCharCode(...chunk.subarray(i, i + 32768));
      await context.native({ action: 'chunk', upload, offset, data: btoa(binary) });
    }
    const result = await context.native({ action: 'commit', upload });
    await persist(reading, { savedId: result.id, savedAt: Date.now() });
    return result;
  } catch (e) {
    try {
      await context.native({ action: 'abort', upload });
    } catch { }
    throw e;
  }
}
export async function handleReading(message, sender, context) {
  const dashboard =
    sender.id === chrome.runtime.id &&
    sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('reading-library.html');
  let url;
  if (message.action === 'readingConfigure') {
    if (
      sender.id !== chrome.runtime.id ||
      sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('settings.html')
    )
      throw Error('请从插件设置修改阅读偏好');
    const p = message.preferences;
    if (
      typeof p?.selectionMenu !== 'boolean' ||
      typeof p.restoreHighlights !== 'boolean' ||
      !Object.hasOwn(M.colors, p.color)
    )
      throw Error('无效的阅读偏好');
    const task = queue.then(async () => {
      await chrome.storage.local.set({
        readingPreferences: {
          selectionMenu: p.selectionMenu,
          restoreHighlights: p.restoreHighlights,
          color: p.color
        }
      });
      if (!p.restoreHighlights) {
        const scripts = await chrome.scripting.getRegisteredContentScripts();
        const ids = scripts.filter((s) => s.id.startsWith('shiye-restore-')).map((s) => s.id);
        if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
      } else {
        const all = await chrome.storage.local.get(null);
        for (const [k, v] of Object.entries(all))
          if (k.startsWith('reading:'))
            try {
              await restoreSite(v.record);
            } catch { }
      }
      return { ok: true };
    });
    queue = task.catch(() => { });
    return task;
  }
  if (message.action === 'readingSyncAll') {if (!dashboard) throw Error('请从笔记库同步全部记录');return syncAllReading(context);}
  if (['readingList', 'readingBackup', 'readingImport'].includes(message.action)) {
    if (!dashboard) throw Error('只有笔记库可以访问全部记录');
    const task = queue.then(async () => {
      const all = await chrome.storage.local.get(null),
        entries = Object.entries(all)
          .filter(([k]) => k.startsWith('reading:'))
          .map(([, v]) => v)
          .sort((a, b) => b.updatedAt - a.updatedAt);
      if (message.action === 'readingList') return entries;
      if (message.action === 'readingBackup') {
        const body = JSON.stringify({ shiyeNotesVersion: 1, pages: entries.map((e) => e.record) }, null, 2);
        await chrome.downloads.download({
          url: 'data:application/json;charset=utf-8,' + encodeURIComponent(body),
          filename: M.filename('拾页笔记备份', 'json')
        });
        return { ok: true };
      }
      const backup = message.backup;
      if (backup?.shiyeNotesVersion !== 1 || !Array.isArray(backup.pages) || backup.pages.length > 1000)
        throw Error('无效的笔记备份');
      const updates = {};
      for (const raw of backup.pages) {
        const record = M.validate(raw),
          k = await key(record.url),
          old = updates[k] || all[k];
        updates[k] = {
          ...old,
          record: M.merge(old?.record || M.empty(record.url), record),
          updatedAt: Date.now(), syncPending:true
        };
      }
      pendingLocal = true;
      await chrome.storage.local.set(updates);
      return { ok: true };
    });
    queue = task.catch(() => { });
    return task;
  }
  if (dashboard) url = M.url(message.url);
  else {
    if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0)
      throw Error('不允许访问阅读笔记');
    const tab = await chrome.tabs.get(sender.tab.id);
    if (tab.url !== message.url || new URL(sender.url).origin !== new URL(tab.url).origin)
      throw Error('页面已切换，请重新打开笔记');
    url = M.url(tab.url);
  }
  if (message.action === 'readingOpen') {
    if (dashboard) throw Error('请从原网页打开标注');
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      files: [
        'capture-ui.js', 'webpage-prepare.js',
        'webpage-ui.js',
        'reading-model.js',
        'reading-anchors.js',
        'reading-editor.js',
        'webpage-notes.js'
      ]
    });
    await chrome.tabs.sendMessage(sender.tab.id, { action: 'reading-open', id: message.id });
    return { ok: true };
  }
  const task = queue.then(async () => {
    const local = await localReading(url);
    if (message.action === 'readingGet') return local;
    if (message.action === 'readingMutate') {
      const saved=await persist(M.mutate(local, message.op),{syncPending:true});
      if(['clear','delete'].includes(message.op?.kind)) void syncAllReading(context).catch(async e=>{await chrome.storage.local.set({readingSyncStatus:{at:Date.now(),error:e.message}});});
      return saved;
    }
    if (message.action === 'readingDownload') {
      if (!['md', 'json'].includes(message.format)) throw Error('不支持的笔记格式');
      const data = message.format === 'json' ? JSON.stringify(local, null, 2) : M.markdown(local),
        name = M.filename(local.meta.title || '阅读笔记', message.format);
      await chrome.downloads.download({
        url: 'data:application/octet-stream;charset=utf-8,' + encodeURIComponent(data),
        filename: name
      });
      return { ok: true };
    }
    if (message.action === 'readingImage') {
      const imageUrl = new URL(message.image);
      if (!['http:', 'https:'].includes(imageUrl.protocol) || imageUrl.username || imageUrl.password)
        throw Error('不支持此图片地址');
      const host = imageUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const privateAddress =
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.includes(':') ||
        /^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2[0-9]|3[01]))\./.test(host);
      if (privateAddress && imageUrl.origin !== new URL(url).origin)
        throw Error('不允许从公开网页读取内网图片');
      if (!(await chrome.permissions.contains({ origins: [imageUrl.origin + '/*'] })))
        throw Error('请从浏览器工具栏打开拾页，授权此网页的图片来源后重试');
      const response = await fetch(imageUrl.href, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok || !/^image\//i.test(response.headers.get('content-type') || ''))
        throw Error('无法读取此图片');
      const reader = response.body.getReader(),
        parts = [];
      let size = 0;
      for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024) {
          await reader.cancel();
          throw Error('图片超过16MiB');
        }
        parts.push(value);
      }
      const bitmap = await createImageBitmap(new Blob(parts, { type: response.headers.get('content-type') }));
      try {
        if (bitmap.width * bitmap.height > 40000000) throw Error('图片尺寸过大');
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        if (blob.size > 24 * 1024 * 1024) throw Error('转换后的图片过大');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768)
          binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return saveClip(
          {
            url,
            title: String(message.title || '网页图片').slice(0, 300),
            image: 'data:image/png;base64,' + btoa(binary)
          },
          context
        );
      } finally {
        bitmap.close();
      }
    }
    if (message.action === 'readingClip' || message.action === 'readingLink')
      return saveClip(
        {
          url,
          title: String(message.title || '网页摘录').slice(0, 300),
          text: message.text,
          link: message.action === 'readingLink' ? message.link : undefined
        },
        context
      );
    if (message.action === 'readingSync') {
      const hello = await context.native({ action: 'hello' });
      if (hello.readingAnnotationsVersion !== 1) throw Error('标注同步需要拾页0.8.0或以上版本');
      if(local.cleared && hello.readingSyncVersion!==1) throw Error('整页删除同步需要更新拾页客户端');
      const merged = await context.native({ action: 'reading_merge', url, record: local });
      return persist(M.merge(local, merged), { syncedAt: Date.now(), syncPending:false });
    }
    throw Error('无效的阅读笔记操作');
  });
  queue = task.catch(() => { });
  return task;
}
