import { localReading, rememberReading } from './reading-background.js';
const jobs = new Map(); let running = null, creating = null, initialized = false; const PROCESSOR = 'page-processor.html';
const publicJob = j => ({ id: j.id, state: j.state, message: j.message, warnings: j.warnings || [], missingOrigins: j.missingOrigins || [], result: j.result || null });
function update(j, state, message) { j.state = state; j.message = message; j.updated = Date.now(); }
function active(j) { if (j.cancelled) throw Error('已取消保存'); }
async function validateTab(j) { const tab = await chrome.tabs.get(j.tabId); if (tab.url !== j.url) throw Error('网页已切换，请重新保存当前页面'); const health = await chrome.tabs.sendMessage(j.tabId, { action: 'webpage-health' }); if (health?.pageToken !== j.pageToken) throw Error('网页已重新加载，请重新保存当前页面'); return tab; }
async function processor() { if (creating) return creating; creating = (async () => { const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(PROCESSOR)] }); if (!contexts.length) await chrome.offscreen.createDocument({ url: PROCESSOR, reasons: ['DOM_PARSER', 'BLOBS'], justification: '将用户主动保存的MHTML快照转换为无外部依赖的离线网页' }); if (!initialized) { await messageProcessor({ action: 'reset' }); initialized = true; } })(); try { await creating; } finally { creating = null; } }
async function messageProcessor(value) { const r = await chrome.runtime.sendMessage({ ...value, target: 'webpage-processor' }); if (r?.error) throw Error(r.error); if (!r?.data) throw Error('网页转换器没有响应'); return r.data; }
async function release(j) { j.bytes = null; try { await messageProcessor({ action: 'release', id: j.id }); } catch { } if (running === j.id) running = null; try { await chrome.offscreen.closeDocument(); } catch { } initialized = false; }
async function fail(j, e) { update(j, j.cancelled ? 'cancelled' : 'failed', j.cancelled ? '已取消保存' : String(e.message || e)); await release(j); }
async function awaitDownload(id) { for (let i = 0; i < 120; i++) { const [d] = await chrome.downloads.search({ id }); if (d?.state === 'complete') return; if (d?.state === 'interrupted') throw Error('下载已取消或中断：' + (d.error || '')); await new Promise(r => setTimeout(r, 500)); } throw Error('等待离线网页下载超时，请检查浏览器下载列表'); }
function privateHost(host) { host = host.toLowerCase().replace(/^\[|\]$/g, ''); if (host === 'localhost' || host.endsWith('.localhost')) return true; if (host.includes(':')) return host === '::1' || /^(?:f[cd][a-f0-9]{2}:|fe[89ab][a-f0-9]:|::ffff:)/i.test(host); if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false; const n = host.split('.').map(Number); return [0, 10, 127].includes(n[0]) || n[0] === 192 && n[1] === 168 || n[0] === 169 && n[1] === 254 || n[0] === 172 && n[1] >= 16 && n[1] <= 31; }
async function supplement(j, result) {
    const tried = new Set(); j.missingOrigins = []; const deadline = Date.now() + 60000; let total = 0;
    for (let round = 0; round < 3; round++) {
        const pending = (result.missingResources || []).filter(u => !tried.has(u)).slice(0, 64); if (!pending.length) break;
        for (const address of pending) {
            active(j); tried.add(address); if (Date.now() > deadline) break;
            let url; try { url = new URL(address, j.url); } catch { continue; } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
            if (privateHost(url.hostname) && url.origin !== new URL(j.url).origin) continue;
            if (!await chrome.permissions.contains({ origins: [url.origin + '/*'] })) { j.missingOrigins.push(url.origin); continue; }
            update(j, 'converting', '正在补齐离线资源… ' + tried.size + ' 项');
            try {
                const response = await fetch(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(Math.min(20000, Math.max(1, deadline - Date.now()))) }); if (!response.ok) continue; const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim(); if (!/^(?:image\/|font\/|text\/css$|application\/(?:font|x-font|octet-stream|vnd\.ms-fontobject))/.test(mime)) continue; if (Number(response.headers.get('content-length')) > 16 * 1024 * 1024) continue;
                const reader = response.body.getReader(), parts = []; let size = 0; while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16 * 1024 * 1024 || total + size > 48 * 1024 * 1024) { await reader.cancel(); throw Error('资源大小超限'); } parts.push(value); } if (!size) continue; total += size; const bytes = new Uint8Array(size); let start = 0; for (const part of parts) { bytes.set(part, start); start += part.length; }
                for (let offset = 0; offset < size; offset += 384 * 1024) { active(j); const chunk = bytes.subarray(offset, offset + 384 * 1024); let binary = ''; for (let i = 0; i < chunk.length; i += 32768)binary += String.fromCharCode(...chunk.subarray(i, i + 32768)); await messageProcessor({ action: 'supplement', id: j.id, url: address, mime, size, offset, data: btoa(binary) }); }
            } catch (e) { if (j.cancelled) throw e; }
        }
        active(j); result = await messageProcessor({ action: 'rebuild', id: j.id });
    }
    j.missingOrigins = [...new Set(j.missingOrigins)]; return result;
}
function reviewOrFinish(j, result) { j.warnings = result.warnings || []; if (j.warnings.length) { update(j, 'review', '快照已准备，请确认保存范围'); j.reviewTimer = setTimeout(() => { j.cancelled = true; void fail(j, Error('快照确认超时')); }, 5 * 60 * 1000); } else void finish(j); }
async function finish(j) { try { active(j); await validateTab(j); j.reading = await localReading(j.url); if (j.target === 'client' && (j.reading.annotations.length || j.reading.deleted.length || j.reading.note.text) && j.clientReadingVersion !== 1) throw Error('保存标注需要拾页0.8.0或以上版本，请先升级客户端'); update(j, 'saving', j.target === 'client' ? '正在保存到拾页…' : '正在准备离线 HTML…'); const result = await messageProcessor({ action: 'finish', id: j.id, destination: j.target, saveAs: j.saveAs, reading: j.reading }); if (j.target === 'html') { active(j); update(j, 'committing', '正在交给浏览器下载…'); const id = await chrome.downloads.download({ url: result.downloadUrl, filename: result.filename, saveAs: j.saveAs }); await awaitDownload(id); j.result = { downloadId: id }; } else { j.result = result; await rememberReading(j.reading, { savedId: result.id, savedAt: Date.now() }); } update(j, 'done', j.result.duplicate ? '此网页快照已在拾页中' : j.target === 'client' ? '已保存到拾页，可离线阅读' : '离线 HTML 已下载'); await release(j); } catch (e) { await fail(j, e); } }
async function capture(j, context) {
    try {
        if (j.target === 'client') { update(j, 'preparing', '正在检测并唤起拾页客户端…'); const info = await context.native({ action: 'hello' }); j.clientReadingVersion = info.readingAnnotationsVersion; if (info.webSnapshotLayoutVersion !== 2 || info.dualWebCaptureVersion !== 1) throw Error('同时保存原貌与正文需要拾页0.10.0或以上版本，请升级客户端'); if (j.reading && (j.reading.annotations.length || j.reading.deleted.length || j.reading.note.text) && info.readingAnnotationsVersion !== 1) throw Error('保存标注需要拾页0.8.0或以上版本，请先升级客户端'); if (info.offlineWebPagesVersion !== 1) throw Error('网页快照需要拾页0.7.0或以上版本，请先升级客户端'); }
        active(j); await validateTab(j); update(j, 'preparing', '正在加载延迟图片并冻结页面…'); let meta;
        try { meta = await chrome.tabs.sendMessage(j.tabId, { action: 'webpage-prepare', loadImages: j.loadImages, mode: j.mode }); if (meta?.error) throw Error(meta.error); if (!meta?.url || meta.url !== j.url) throw Error('未能准备当前网页，请从插件工具栏重新打开拾页'); active(j); update(j, 'capturing', '正在收集整页内容、图片、样式与字体…'); const blob = await chrome.pageCapture.saveAsMHTML({ tabId: j.tabId }); if (!blob) throw Error('浏览器未返回网页归档'); if (blob.size > 128 * 1024 * 1024) throw Error('网页归档超过128MiB'); j.bytes = new Uint8Array(await blob.arrayBuffer()); }
        finally { try { await chrome.tabs.sendMessage(j.tabId, { action: 'webpage-restore' }); } catch { } }
        active(j); await validateTab(j); await processor(); update(j, 'converting', '正在整理离线资源与嵌入内容…'); const result = await messageProcessor({ action: 'prepare', id: j.id, metadata: { ...meta, title: j.title || meta.title, capturedAt: new Date().toISOString(), reading: j.reading, mode: j.mode, customTitle: j.customTitle } }); j.bytes = null; active(j); reviewOrFinish(j, await supplement(j, result));
    } catch (e) { await fail(j, e); }
}
export async function handleWebPage(message, sender, context) {
    if (['webPermissionInfo', 'webPageRetry'].includes(message.action)) {
        if (!sender.url?.startsWith(chrome.runtime.getURL('capture-permissions.html'))) throw Error('请从网页保存面板授权'); const j = jobs.get(message.jobId); if (!j || j.state !== 'review') throw Error('快照已不在待确认状态'); if (message.action === 'webPermissionInfo') return { title: j.title, origins: j.missingOrigins || [] }; clearTimeout(j.reviewTimer); update(j, 'converting', '正在补齐离线资源…'); void (async () => { try { const r = await messageProcessor({ action: 'rebuild', id: j.id }); reviewOrFinish(j, await supplement(j, r)); } catch (e) { await fail(j, e); } })(); return { ok: true };
    }
    const processorSender = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(PROCESSOR) && !sender.tab;
    if (message.action === 'processorRead' || message.action === 'processorProgress') {
        if (!processorSender) throw Error('不允许访问网页转换数据'); const j = jobs.get(message.id); if (!j) throw Error('捕获任务已失效');
        if (message.action === 'processorProgress') { if (j.cancelled) throw Error('已取消保存'); update(j, message.committing ? 'committing' : 'saving', String(message.text || '正在处理…').slice(0, 150)); return { ok: true }; }
        active(j); const offset = message.offset; if (!Number.isSafeInteger(offset) || offset < 0 || offset > j.bytes?.length) throw Error('无效读取位置'); const part = j.bytes.subarray(offset, offset + 384 * 1024); let text = ''; for (let i = 0; i < part.length; i += 32768)text += String.fromCharCode(...part.subarray(i, i + 32768)); return { data: btoa(text), length: part.length, size: j.bytes.length };
    }
    if (message.action === 'openWebPage') {
        if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw Error('请从插件工具栏打开网页保存'); const tab = await chrome.tabs.get(message.tabId); const url = new URL(tab.url || ''); if (url.username || url.password) throw Error('请使用不包含账号密码的网页地址'); if (!['http:', 'https:'].includes(url.protocol) || ['chatgpt.com', 'chat.openai.com'].includes(url.hostname)) throw Error('当前页面不使用通用网页保存面板');
        try { const h = await chrome.tabs.sendMessage(tab.id, { action: 'webpage-health' }); if (h?.version === chrome.runtime.getManifest().version && h.alive) { await chrome.tabs.sendMessage(tab.id, { action: 'webpage-open' }); return { ok: true }; } } catch { }
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture-ui.js', 'webpage-prepare.js', 'webpage-ui.js', 'reading-model.js', 'reading-anchors.js', 'reading-editor.js', 'webpage-notes.js'] }); await chrome.tabs.sendMessage(tab.id, { action: 'webpage-open' }); return { ok: true };
    }
    if (message.action === 'webPageSettings') { await chrome.runtime.openOptionsPage(); return { ok: true }; }
    if (!sender.tab || sender.frameId !== 0) throw Error('只能从当前网页顶层保存快照'); const tab = await chrome.tabs.get(sender.tab.id); const url = new URL(tab.url || ''); if (!['http:', 'https:'].includes(url.protocol) || new URL(sender.url || 'about:blank').origin !== url.origin) throw Error('网页来源已变化，请重新打开保存面板');
    if (message.action === 'webPageSave') {
        if (running) throw Error('另一个网页正在保存，请稍后再试'); if (!['client', 'html'].includes(message.target) || message.expectedUrl !== tab.url) throw Error('无效的快照请求'); if (!await chrome.permissions.contains({ permissions: ['pageCapture', 'offscreen'] })) throw Error('请从浏览器工具栏打开拾页并启用网页快照权限'); const { preferences = {} } = await chrome.storage.local.get('preferences'); if (message.mode !== undefined && !['snapshot', 'article'].includes(message.mode)) throw Error('无效的采集模式'); const reading = await localReading(tab.url); const j = { reading, mode: 'snapshot', customTitle: message.customTitle === true, id: crypto.randomUUID(), tabId: tab.id, url: tab.url, documentId: sender.documentId, pageToken: message.pageToken, target: message.target, title: String(message.title || tab.title || url.hostname).slice(0, 300), loadImages: message.loadImages !== false, saveAs: preferences.saveAs === true, state: 'preparing', message: '正在准备网页快照…', cancelled: false }; jobs.set(j.id, j); running = j.id; for (const [id, old] of jobs) if (jobs.size > 20 && ['done', 'failed', 'cancelled'].includes(old.state)) jobs.delete(id); void capture(j, context); return publicJob(j);
    }
    const j = jobs.get(message.jobId); if (!j || j.tabId !== tab.id || j.documentId !== sender.documentId) throw Error('保存任务已失效，请重新保存');
    if (message.action === 'webPageStatus') return publicJob(j);
    if (message.action === 'webPageAuthorize') { if (j.state !== 'review' || !j.missingOrigins?.length) throw Error('没有需要授权的资源来源'); await chrome.tabs.create({ url: chrome.runtime.getURL('capture-permissions.html') + '?jobId=' + encodeURIComponent(j.id) }); return { ok: true }; }
    if (message.action === 'webPageContinue') { if (j.state !== 'review') throw Error('快照不在待确认状态'); clearTimeout(j.reviewTimer); void finish(j); return publicJob(j); }
    if (message.action === 'webPageCancel') { if (j.state === 'committing') throw Error('正在完成保存，暂不能取消'); if (['done', 'failed', 'cancelled'].includes(j.state)) return publicJob(j); j.cancelled = true; clearTimeout(j.reviewTimer); try { await chrome.tabs.sendMessage(j.tabId, { action: 'webpage-cancel' }); } catch { } try { await messageProcessor({ action: 'cancel', id: j.id }); } catch { } if (j.state === 'review') await fail(j, Error('已取消保存')); return publicJob(j); }
    throw Error('无效的网页保存操作');
}

chrome.tabs.onRemoved.addListener(tabId => { const j = jobs.get(running); if (j?.tabId === tabId) { j.cancelled = true; clearTimeout(j.reviewTimer); if (j.state === 'review') void fail(j, Error('来源网页已关闭')); else void messageProcessor({ action: 'cancel', id: j.id }).catch(() => { }); } });
