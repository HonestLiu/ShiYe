// Snapshot documents forbid scripts. Chrome can still deliver parent listeners;
// WKWebView needs a cheap, shared fallback. Never scan text or layout on a timer.
const watchers=new WeakMap(),activeWatchers=new Set();let windowActive=true;
export function setReadingWindowActive(value){windowActive=value;for(const watcher of activeWatchers)watcher.resume();}
export function observeReadingDocument(doc,callbacks){
 let watcher=watchers.get(doc);if(!watcher){
  const win=doc.defaultView,owner=document,subscribers=new Set();let timer=null,lastY=win.scrollY,lastSelection=null,closed=false;
  const emit=kind=>{for(const callback of subscribers)callback[kind]?.();};
  function selection(){const s=win.getSelection();const next=s?.rangeCount&&!s.isCollapsed?[s.anchorNode,s.anchorOffset,s.focusNode,s.focusOffset]:null;if(next?.every((v,i)=>v===lastSelection?.[i])||(!next&&!lastSelection))return;lastSelection=next;emit('selection');}
  function scroll(){const y=win.scrollY;if(y===lastY)return;lastY=y;emit('scroll');}
  let events=false;const probe=doc.createElement('span');doc.body.append(probe);probe.addEventListener('reader-events-probe',()=>{events=true;},{once:true});probe.dispatchEvent(new win.Event('reader-events-probe'));probe.remove();
  function stop(){clearTimeout(timer);timer=null;}
  function resume(){stop();if(closed||events||!windowActive||owner.hidden||!owner.hasFocus())return;timer=setTimeout(tick,250);}
  function tick(){timer=null;if(closed||!windowActive||owner.hidden||!owner.hasFocus())return;scroll();selection();resume();}
  win.addEventListener('scroll',scroll,{passive:true});doc.addEventListener('selectionchange',selection);
  owner.addEventListener('visibilitychange',resume);window.addEventListener('focus',resume);window.addEventListener('blur',resume);
  resume();watcher={subscribers,resume,close(){closed=true;stop();win.removeEventListener('scroll',scroll);doc.removeEventListener('selectionchange',selection);owner.removeEventListener('visibilitychange',resume);window.removeEventListener('focus',resume);window.removeEventListener('blur',resume);watchers.delete(doc);activeWatchers.delete(watcher);}};watchers.set(doc,watcher);activeWatchers.add(watcher);
 }
 watcher.subscribers.add(callbacks);return ()=>{watcher.subscribers.delete(callbacks);if(!watcher.subscribers.size)watcher.close();};
}
