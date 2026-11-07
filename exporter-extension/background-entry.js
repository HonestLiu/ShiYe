import { handleWebPage } from './webpage-background.js';
import { handleReading } from './reading-background.js';
import './background.js';
// Static dependencies: dynamic import is unavailable in an extension service worker.
globalThis.ShiyeWebPageBackground = { handleWebPage };
globalThis.ShiyeReadingBackground = { handleReading };
const readingFiles = [
  'capture-ui.js','webpage-prepare.js',
  'webpage-ui.js',
  'reading-model.js',
  'reading-anchors.js',
  'reading-editor.js',
  'webpage-notes.js'
];
const menus = [
  ['shiye-save', '打开网页收藏面板', ['page']],
  ['shiye-highlight', '高亮选中文字', ['selection']],
  ['shiye-note', '为选中文字添加批注', ['selection']],
  ['shiye-clip', '收藏选中文字到拾页', ['selection']],
  ['shiye-link', '收藏链接到拾页', ['link']],
  ['shiye-image', '收藏图片到拾页', ['image']]
];
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    for (const s of scripts.filter((s) => s.id.startsWith('shiye-site-')))
      await chrome.scripting.updateContentScripts([{ id: s.id, js: readingFiles }]);
    await chrome.contextMenus.removeAll();
    for (const [id, title, contexts] of menus)
      chrome.contextMenus.create({ id, title, contexts, documentUrlPatterns: ['http://*/*', 'https://*/*'] });
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await menuVisibility(tab);
  } catch (e) {
    console.warn('拾页入口更新失败', e);
  }
});
async function contextual(info, tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return;
  if (['chatgpt.com', 'chat.openai.com'].includes(new URL(tab.url).hostname)) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: readingFiles });
  if (info.menuItemId === 'shiye-highlight' || info.menuItemId === 'shiye-note') {
    await chrome.tabs.sendMessage(tab.id, {
      action: 'reading-context-highlight',
      note: info.menuItemId === 'shiye-note'
    });
  } else if (['shiye-clip', 'shiye-link', 'shiye-image'].includes(info.menuItemId)) {
    await chrome.tabs.sendMessage(tab.id, {
      action: 'reading-context-save',
      text: info.selectionText,
      image: info.menuItemId === 'shiye-image' ? info.srcUrl : undefined,
      link: info.menuItemId === 'shiye-link' ? info.linkUrl : undefined
    });
  } else await chrome.tabs.sendMessage(tab.id, { action: 'webpage-open' });
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void contextual(info, tab).catch((e) => console.warn('拾页右键操作失败', e));
});
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'highlight-selection') return;
  void (async () => {
    if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await contextual({ menuItemId: 'shiye-highlight' }, tab);
  })().catch((e) => console.warn('拾页快捷键操作失败', e));
});
// ChatGPT retains its existing message-export UI; generic page menus stay out of that flow.
async function menuVisibility(tab) {
  const isChat = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//.test(tab?.url || '');
  for (const [id] of menus)
    await new Promise((resolve) =>
      chrome.contextMenus.update(id, { visible: !isChat }, () => {
        void chrome.runtime.lastError;
        resolve();
      })
    );
}
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then(menuVisibility)
    .catch(() => {});
});
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.status === 'complete')) void menuVisibility(tab).catch(() => {});
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId < 0) return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    await menuVisibility(tab);
  })().catch(() => {});
});

async function ensureEdge(tab){
 if(!tab?.id||!/^https?:\/\//.test(tab.url||''))return;
 const url=new URL(tab.url);if(['chatgpt.com','chat.openai.com'].includes(url.hostname))return;
 const {edgeLauncher={},edgeHiddenSites=[],siteEntryPreferences={}}=await chrome.storage.local.get(['edgeLauncher','edgeHiddenSites','siteEntryPreferences']);
 const site='shiye-site-'+btoa(url.protocol+'//'+url.hostname).replace(/[^a-zA-Z0-9]/g,'');
 if(edgeLauncher.disabled||edgeHiddenSites.includes(url.origin)||siteEntryPreferences[site]===false)return;
 await chrome.scripting.executeScript({target:{tabId:tab.id},files:readingFiles});
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message.action!=='edgeEnsure'||sender.id!==chrome.runtime.id||!sender.tab||sender.frameId!==0)return;
 void ensureEdge(sender.tab).then(()=>reply({ok:true}),()=>reply({ok:false}));return true;
});
async function restoreEdges(){for(const tab of await chrome.tabs.query({}))void ensureEdge(tab).catch(()=>{});}
chrome.runtime.onInstalled.addListener(()=>void restoreEdges().catch(()=>{}));
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&((changes.edgeLauncher&&changes.edgeLauncher.newValue?.disabled!==changes.edgeLauncher.oldValue?.disabled)||changes.edgeHiddenSites||changes.siteEntryPreferences))void restoreEdges().catch(()=>{});});
