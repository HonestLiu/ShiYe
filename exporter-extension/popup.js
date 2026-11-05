const $=selector=>document.querySelector(selector);
ArchiveCustomSelect.enhance(document);
async function save(){return ArchiveCore.savePreferences({format:$('#format').value,selectType:$('#range').value,displayBtns:$('#display').checked});}
$('#select').onclick=async()=>{try{await save();const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id||!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url||''))throw Error('请先打开 ChatGPT 对话页面。');try{await chrome.tabs.sendMessage(tab.id,{action:'open-selector',selectType:$('#range').value});}catch{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['snapshot-adapter.js','capture.js','core.js','web-snapshot.js','role-icons.js','custom-select.js','content-ui.js']});await chrome.tabs.sendMessage(tab.id,{action:'open-selector',selectType:$('#range').value});}window.close();}catch(error){$('#status').textContent=error.message;}};
$('#settings').onclick=()=>chrome.runtime.openOptionsPage();
$('#connection').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('settings.html')+'#connection'});
for(const input of document.querySelectorAll('select,input'))input.onchange=save;
void ArchiveCore.preferences().then(prefs=>{$('#range').value=prefs.selectType;$('#range').dispatchEvent(new Event('change'));$('#format').value=prefs.format;$('#format').dispatchEvent(new Event('change'));$('#display').checked=prefs.displayBtns;});
