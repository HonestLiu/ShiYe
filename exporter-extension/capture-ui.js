// Shared by the live-page preparer and the offline converter. Do not match all
// fixed/sticky elements or immersive-translate-* classes: those include prose.
(() => {
 const selector=[
  '#shiye-webpage','[data-shiye-reading-ui]','[data-shiye-exclude-ui]',
  '#immersive-translate-browser-popup','.immersive-translate-browser-popup',
  'immersive-translate-browser-popup','#immersive-translate-browser-popup-container',
  '#immersive-translate-global-popup','#immersive-translate-input-popup',
  'grammarly-desktop-integration','grammarly-extension','#gtx-trans'
 ].join(',');
 const extensionUrl=url=>/^(?:chrome-extension|moz-extension|safari-web-extension):\/\//i.test(url||'');
 const extensionFrame=n=>n.matches?.('iframe')&&extensionUrl(n.getAttribute('src'));
 const matches=n=>!!n.matches?.(selector)||extensionFrame(n);
 const within=n=>!!n.closest?.(selector)||extensionFrame(n);
 function remove(root){for(const n of root.querySelectorAll(selector+',iframe'))if(matches(n))n.remove();}
 globalThis.ShiyeCaptureUI={selector,matches,within,remove,extensionUrl};
})();
