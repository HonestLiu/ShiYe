const $ = selector => document.querySelector(selector);
let activeTab, currentOrigin, siteScriptId;

ArchiveCustomSelect.enhance(document);
async function save() { return ArchiveCore.savePreferences({ format: $('#format').value, selectType: $('#range').value, displayBtns: $('#display').checked }); }
$('#select').onclick = async () => { try { await save(); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) throw Error('请先打开 ChatGPT 对话页面。'); await ArchiveCore.request({ action: 'ensurePage', tabId: tab.id }); await chrome.tabs.sendMessage(tab.id, { action: 'open-selector', selectType: $('#range').value }); window.close(); } catch (error) { $('#status').textContent = error.message; } };
$('#settings').onclick = () => chrome.runtime.openOptionsPage();
$('#connection').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') + '#connection' });
for (const input of document.querySelectorAll('#chat-tools select,#chat-tools input')) input.onchange = save;
void ArchiveCore.preferences().then(prefs => { $('#range').value = prefs.selectType; $('#range').dispatchEvent(new Event('change')); $('#format').value = prefs.format; $('#format').dispatchEvent(new Event('change')); $('#display').checked = prefs.displayBtns; });

const siteFiles = ['capture-ui.js', 'webpage-prepare.js', 'webpage-ui.js', 'reading-model.js', 'reading-anchors.js', 'reading-editor.js', 'webpage-notes.js'];
async function registerSite() {
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [siteScriptId] });
    if (!scripts.length) await chrome.scripting.registerContentScripts([{ id: siteScriptId, matches: [new URL(currentOrigin).protocol + '//' + new URL(currentOrigin).hostname + '/*'], js: siteFiles, runAt: 'document_idle', persistAcrossSessions: true }]);
}
async function rememberSite(enabled) { const { siteEntryPreferences = {} } = await chrome.storage.local.get('siteEntryPreferences'); siteEntryPreferences[siteScriptId] = enabled; await chrome.storage.local.set({ siteEntryPreferences }); }
$('#open-page').onclick = async () => { try { const granted = await chrome.permissions.request({ permissions: ['pageCapture', 'offscreen'], origins: ['http://*/*', 'https://*/*'] }); if (!granted) throw Error('未开启网页快照权限'); if ($('#pin-site').checked) { await registerSite(); await rememberSite(true); } await ArchiveCore.request({ action: 'openWebPage', tabId: activeTab.id }); window.close(); } catch (e) { $('#status').textContent = e.message; } };
$('#pin-site').onchange = async () => { const enabled = $('#pin-site').checked; try { if (enabled) { if (!await chrome.permissions.request({ permissions: ['pageCapture', 'offscreen'], origins: [currentOrigin + '/*'] })) throw Error('未获得此网站的访问权限'); await registerSite(); await rememberSite(true); await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: siteFiles }); await chrome.tabs.sendMessage(activeTab.id, { action: 'webpage-show-entry' }); } else { const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [siteScriptId] }); if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: [siteScriptId] }); await rememberSite(false); await chrome.tabs.sendMessage(activeTab.id, { action: 'webpage-hide-entry' }).catch(() => { }); } $('#status').textContent = enabled ? '已启用此网站的页内入口' : '已关闭此网站的自动入口'; } catch (e) { $('#pin-site').checked = !enabled; $('#status').textContent = e.message; } };
(async () => { try { [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }); const url = new URL(activeTab?.url || ''); const chat = ['https://chatgpt.com', 'https://chat.openai.com'].includes(url.origin); $('#chat-tools').hidden = !chat; $('#web-page').hidden = chat; $('#page-notes').hidden = chat; $('#chat-link').hidden = !chat; if (!chat) { if (!['http:', 'https:'].includes(url.protocol)) { $('#open-page').disabled = $('#pin-site').disabled = true; $('#web-title').textContent = '此页面不能创建网页快照'; $('#web-origin').textContent = '请打开普通网站后再使用拾页。'; return; } currentOrigin = url.origin; siteScriptId = 'shiye-site-' + btoa(url.protocol + '//' + url.hostname).replace(/[^a-zA-Z0-9]/g, ''); $('#web-title').textContent = activeTab.title || url.hostname; $('#web-origin').textContent = url.hostname; $('#open-page').disabled = $('#pin-site').disabled = false; const { siteEntryPreferences = {} } = await chrome.storage.local.get('siteEntryPreferences'); $('#pin-site').checked = siteEntryPreferences[siteScriptId] !== false; } } catch (e) { $('#status').textContent = e.message; } })();

$('#reading-library').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('reading-library.html') });

$('#client-check').onclick = async () => { const b = $('#client-check'); b.disabled = true; $('#status').textContent = '正在连接拾页客户端…'; try { const info = await ArchiveCore.request({ action: 'clientHello' }); $('#status').textContent = '已连接 ' + (info.name || '拾页客户端'); } catch (e) { $('#status').textContent = '连接失败：' + e.message; } finally { b.disabled = false; } };

$('#page-notes').onclick = async () => { try { if (!activeTab?.id || !currentOrigin) throw Error('请先打开普通网页'); await ArchiveCore.request({ action: 'openWebPage', tabId: activeTab.id }); await chrome.tabs.sendMessage(activeTab.id, { action: 'reading-open' }); window.close(); } catch (e) { $('#status').textContent = e.message; } };

$('#translate-open').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('translate.html')});
