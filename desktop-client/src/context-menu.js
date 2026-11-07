import {uiIcon} from './ui.js';

// Menus live in the trusted app, including when the hit is inside an inert snapshot.
export function mountContextMenus({cmd,run,status,resolve=()=>[]}) {
 const layer=document.createElement('dialog');layer.id='context-menu-layer';layer.setAttribute('aria-label','收藏操作');
 const panel=document.createElement('div');panel.id='context-menu';panel.className='context-menu';panel.hidden=true;
 const group=document.createElement('div');group.setAttribute('aria-label','右键菜单');
 // Current Chromium exposes focusGroup with incomplete menu semantics/navigation;
 // use a single, complete ARIA keyboard fallback rather than two competing systems.
 group.setAttribute('role','menu');panel.append(group);layer.append(panel);document.body.append(layer);
 let origin=null,highlight=null;
 function close(restore=false){if(panel.hidden)return;panel.hidden=true;if(layer.open)layer.close();highlight?.classList.remove('context-target');highlight=null;if(restore&&origin?.isConnected)origin.focus({preventScroll:true});}
 function active(button){if(panel.querySelector('[data-active]')===button)return;for(const old of panel.querySelectorAll('[data-active]'))old.removeAttribute('data-active');if(button){button.setAttribute('data-active','');if(document.activeElement!==button)button.focus({preventScroll:true,focusVisible:false});}}

 function hit(doc,x,y,depth=0){const target=doc.elementFromPoint(x,y);if(target?.tagName==='IFRAME'&&depth<12){try{const rect=target.getBoundingClientRect(),inside=target.contentDocument;if(inside?.body)return hit(inside,(x-rect.left)*target.clientWidth/rect.width,(y-rect.top)*target.clientHeight/rect.height,depth+1);}catch{}}return {doc,target};}
 function rootPoint(doc,x,y){for(let win=doc.defaultView;win&&win!==window;win=win.parent){const frame=win.frameElement;if(!frame)break;const rect=frame.getBoundingClientRect();x=rect.left+x*rect.width/frame.clientWidth;y=rect.top+y*rect.height/frame.clientHeight;}return {x,y};}
 function show({doc,target},point){
  if(!target||target.closest('#context-menu'))return;close();origin=document.activeElement;
  const input=target.closest('input:not([type=checkbox]):not([type=radio]):not([type=button]),textarea'),editable=input||target.closest('[contenteditable=true]');
  const selection=doc.getSelection(),range=selection?.rangeCount?selection.getRangeAt(0).cloneRange():null;
  const start=input?.selectionStart,end=input?.selectionEnd,text=input?input.value.slice(start??0,end??0):selection?.toString()||'';
  const restore=()=>{if(input){input.focus();try{input.setSelectionRange(start,end);}catch{}}else if(range&&range.startContainer.isConnected){editable?.focus();const s=doc.getSelection();s.removeAllRanges();s.addRange(range);}};
  const copy=async()=>{if(text)await cmd({action:'copy_text',text});};
  function key(key,shift=false){restore();editable.dispatchEvent(new KeyboardEvent('keydown',{key,code:'Key'+key.toUpperCase(),metaKey:navigator.platform.includes('Mac'),ctrlKey:!navigator.platform.includes('Mac'),shiftKey:shift,bubbles:true,cancelable:true}));}
  function insert(value){restore();if(input){input.setRangeText(value,start??input.value.length,end??input.value.length,'end');input.dispatchEvent(new Event('input',{bubbles:true}));}else if(!doc.execCommand('insertText',false,value))throw Error('无法在此处插入文本，请使用键盘粘贴');}
  const canEdit=!!editable&&!input?.readOnly&&!input?.disabled&&!['password','number','date','time','color','file','range'].includes(input?.type);
  const actions=[];
  if(editable){if(canEdit)actions.push({label:'撤销',icon:'refresh',action:()=>input?doc.execCommand('undo'):key('z')},{label:'重做',action:()=>input?doc.execCommand('redo'):key('z',true)},null);
   if(canEdit)actions.push({label:'剪切',disabled:!text,action:async()=>{await copy();insert('');}});
   actions.push({label:'复制',icon:'note',disabled:!text,action:copy});
   if(canEdit)actions.push({label:'粘贴文本',action:async()=>{const value=await cmd({action:'read_text'});insert(value.text||'');}});
   actions.push({label:'全选',action:()=>{if(input){input.focus();input.select();}else{editable.focus();const r=doc.createRange();r.selectNodeContents(editable);const s=doc.getSelection();s.removeAllRanges();s.addRange(r);}}});
  }else{
   if(text)actions.push({label:'复制',icon:'note',action:copy});
   const link=target.closest('a[href]');let address='';try{if(link){const url=new URL(link.getAttribute('href'),doc.baseURI);if(/^https?:$/.test(url.protocol))address=url.href;}}catch{}
   if(address)actions.push({label:'打开链接',icon:'external',action:()=>cmd({action:'open_source',url:address})},{label:'复制链接',action:()=>cmd({action:'copy_text',text:address})});
   const extra=resolve({target,doc,text,restore});if(actions.length&&extra.length)actions.push(null);actions.push(...extra);
   if(!actions.length)actions.push({label:'全选',action:()=>{const r=doc.createRange();r.selectNodeContents(doc.body);const s=doc.getSelection();s.removeAllRanges();s.addRange(r);}});
  }
  group.replaceChildren();for(const action of actions){if(!action){if(group.lastElementChild?.tagName!=='HR')group.append(document.createElement('hr'));continue;}const b=document.createElement('button');b.type='button';b.tabIndex=-1;b.setAttribute('role','menuitem');b.disabled=!!action.disabled;b.classList.toggle('danger',!!action.danger);b.innerHTML=uiIcon(action.icon||'');const label=document.createElement('span');label.textContent=action.label;b.append(label);if(!action.icon)b.querySelector('svg').style.visibility='hidden';b.onclick=()=>{close(true);restore();run(async()=>{await action.action();});};group.append(b);}
  while(group.lastElementChild?.tagName==='HR')group.lastElementChild.remove();
  highlight=target.closest('.item');highlight?.classList.add('context-target');
  if('showPopover'in panel)for(const other of document.querySelectorAll('[popover]:popover-open'))other.hidePopover();panel.hidden=false;layer.showModal();const w=panel.offsetWidth,h=panel.offsetHeight;
  panel.style.left=Math.max(6,Math.min(point.x,innerWidth-w-6))+'px';panel.style.top=Math.max(6,Math.min(point.y,innerHeight-h-6))+'px';
  active(group.querySelector('button:not(:disabled)'));
 }
 const bound=new WeakSet();function attach(doc){if(bound.has(doc))return;bound.add(doc);doc.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();const point=rootPoint(doc,e.clientX,e.clientY);if(layer.contains(e.target)){if(panel.contains(e.target))return;close(true);show(hit(document,point.x,point.y),point);}else show({doc,target:e.target},point);},true);for(const f of doc.querySelectorAll('iframe')){try{if(f.contentDocument)attach(f.contentDocument);}catch{}}}
 attach(document);document.addEventListener('load',e=>{if(e.target.tagName==='IFRAME'){try{attach(e.target.contentDocument);}catch{}}},true);
 window.addEventListener('shiye-context-request',e=>{const {x,y}=e.detail||{};if(Number.isFinite(x)&&Number.isFinite(y)){const r=panel.getBoundingClientRect();if(!panel.hidden&&x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom)return;close(true);show(hit(document,x,y),{x,y});}});
 document.addEventListener('keydown',e=>{if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();const target=document.activeElement,r=target.getBoundingClientRect();show({doc:document,target},{x:r.left+12,y:r.bottom});}});
 group.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);}else if(e.key==='Tab'){e.preventDefault();close(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const buttons=[...group.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);active(buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]);}});
 group.addEventListener('pointermove',e=>active(e.target.closest('button:not(:disabled)')));
 group.addEventListener('pointerleave',()=>active(null));
 // Retain selection/caret and consume the entire outside click before hiding the layer.
 layer.addEventListener('pointerdown',e=>{if(e.button===0&&!panel.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();}});
 layer.addEventListener('click',e=>{if(!panel.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();close(true);}},true);
 layer.addEventListener('wheel',e=>{if(!panel.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();close(true);}},{passive:false});
 layer.addEventListener('cancel',e=>{e.preventDefault();close(true);});
 window.addEventListener('blur',()=>close());window.addEventListener('resize',()=>close());

 return {close};
}
