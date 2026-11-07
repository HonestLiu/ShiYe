// A small navigation hook; capture and Native Messaging only run after an explicit action.
(() => {
 if(window.top!==window||!/^https?:$/.test(location.protocol)||['chatgpt.com','chat.openai.com'].includes(location.hostname))return;
 void chrome.runtime.sendMessage({action:'edgeEnsure'}).catch(()=>{});
})();
