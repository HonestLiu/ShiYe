/* Small, local confirmation. Native modal owns focus, Escape and dismissal. */
(() => {
  const components=new WeakMap();
  const css=`
    dialog.local-export-success{width:min(360px,calc(100vw - 40px));max-width:none;margin:auto;padding:0;border:1px solid #e0e6e2;border-radius:18px;background:#fff;color:#202a24;box-shadow:0 18px 64px #0c211c26;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:left;overscroll-behavior:contain;overflow:visible;pointer-events:auto}
    dialog.local-export-success[open]{display:block}
    .local-export-success::backdrop{background:#0c171d45;backdrop-filter:blur(3px);overflow:hidden;overscroll-behavior:contain;pointer-events:auto}
    .local-export-success *{box-sizing:border-box}
    .local-export-success .les-body{padding:26px}
    .local-export-success .les-result{display:flex;gap:14px;align-items:center}
    .local-export-success .les-icon{display:grid;place-items:center;flex:none;width:42px;height:42px;border-radius:50%;background:#eaf6ef;color:#208253}
    .local-export-success h2{margin:0;font:650 18px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:-.25px;color:inherit}
    .local-export-success p{margin:5px 0 0;color:#69756e;font-size:13px;line-height:1.6;overflow-wrap:anywhere}
    .local-export-success form{margin:23px 0 0}
    .local-export-success .les-done{display:block;width:100%;min-height:42px;padding:9px 16px;border:1px solid transparent;border-radius:9px;background:#233c30;color:#fff;font:600 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;transition:background-color .12s}
    .local-export-success .les-done:hover{background:#31523f}
    .local-export-success .les-done:focus-visible{outline:3px solid #54a979;outline-offset:3px}
    .dark .local-export-success{background:#242a27;color:#f0f4f1;border-color:#414b45;box-shadow:0 18px 64px #0005;color-scheme:dark}
    .dark .local-export-success .les-icon{background:#31453a;color:#87d1a4}
    .dark .local-export-success p{color:#aab7ae}
    .dark .local-export-success .les-done{background:#dcebe0;color:#203629}
    .dark .local-export-success .les-done:hover{background:#cce0d2}
    @media(prefers-reduced-motion:reduce){.local-export-success .les-done{transition:none}}
  `;
  const formats={pdf:'PDF',md:'Markdown',txt:'TXT',csv:'CSV',json:'JSON'};
  function component(React){
    if(components.has(React))return components.get(React);
    function Success({open=true,info={},onClose}){
      const ref=React.useRef(null),outside=React.useRef(false),titleId=React.useId(),descriptionId=React.useId();
      React.useEffect(()=>{
        const dialog=ref.current;
        if(open && !dialog.open)dialog.showModal();
        else if(!open && dialog.open)dialog.close();
        return ()=>{if(dialog.open)dialog.close();};
      },[open]);
      const copied=!!info?.copyToClipboard;
      const format=formats[info?.exportType];
      const outsideBounds=event=>{const r=ref.current.getBoundingClientRect();return event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom;};
      return React.createElement('dialog',{ref,className:'local-export-success',closedby:'any','aria-labelledby':titleId,'aria-describedby':descriptionId,
        onClose:()=>onClose?.(),
        onPointerDown:event=>{if(!('closedBy' in ref.current))outside.current=event.button===0 && outsideBounds(event);},
        onPointerUp:event=>{if(!('closedBy' in ref.current) && outside.current && outsideBounds(event))ref.current.close();outside.current=false;}},
        React.createElement('style',null,css),
        React.createElement('div',{className:'les-body'},
          React.createElement('div',{className:'les-result'},
            React.createElement('span',{className:'les-icon','aria-hidden':'true'},
              React.createElement('svg',{width:23,height:23,viewBox:'0 0 24 24',fill:'none'},React.createElement('path',{d:'m5 12 4.5 4.5L19 7',stroke:'currentColor',strokeWidth:2.2,strokeLinecap:'round',strokeLinejoin:'round'}))),
            React.createElement('div',null,
              React.createElement('h2',{id:titleId},copied?'已复制到剪贴板':'导出完成'),
              React.createElement('p',{id:descriptionId},copied?'可以直接粘贴使用。':`${format?format+' 文件':'文件'}已交给浏览器下载。`))),
          React.createElement('form',{method:'dialog'},React.createElement('button',{type:'submit',className:'les-done',autoFocus:true},'完成'))));
    }
    components.set(React,Success);return Success;
  }
  globalThis.LocalSuccessDialog={component};
})();
