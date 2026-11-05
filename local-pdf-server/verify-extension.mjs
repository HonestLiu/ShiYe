import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../local-extension/', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
assert.deepEqual(manifest.optional_host_permissions,['http://*/*','https://*/*']);
assert.equal(manifest.externally_connectable, undefined);
assert.deepEqual(manifest.content_scripts[0].js, ['bridge.js', 'web-snapshot.js', 'success-dialog.js','content.js']);
assert.equal(manifest.content_scripts.length, 1);
for (const name of ['content.js', 'popup.js', 'options.js']) {
  const source = read(name);
  assert(!source.includes('backend:"https://apir.chatgptexporter.com/api"'));
  assert(!source.includes('e.t0.init.call(e.t0,e.t1,e.t6)'));
  assert(source.includes('http://127.0.0.1:8765/api'));
  new vm.Script(source, { filename: name });
}
assert(read('content.js').includes('LocalExporter.createPdf('));
assert(read('content.js').includes('type:"exppdf"')); // settings dialog restored
assert(read('content.js').includes('!e.isComposing'));
assert(!read('background.js').includes('chatgptexporter.com'));
new vm.Script(read('web-snapshot.js'));
new vm.Script(read('success-dialog.js'));
assert(read('content.js').includes('LocalSuccessDialog.component(s)'));
assert(!read('content.js').includes('Export Success'));

const messages = [], actualFetch = [], beacons = [], xhrCalls = [];
const svgDecodes = [], canvasDraws = [];
let bridgePrefs = { renderer: 'pandoc', toc: true };
const bridgePreferenceWrites = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
class TestDOMParser {
  parseFromString(source) {
    const attributes = new Map([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    return { source, attributes, querySelector: () => null, documentElement: { localName: 'svg', getAttribute: key => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value) } };
  }
}
class TestXMLSerializer {
  serializeToString(doc) {
    let text = doc.source;
    for (const key of ['width', 'height']) {
      if (!doc.attributes.has(key)) continue;
      const value = `${key}="${doc.attributes.get(key)}"`;
      text = new RegExp(`${key}="[^"]*"`).test(text) ? text.replace(new RegExp(`${key}="[^"]*"`), value) : text.replace('<svg ', `<svg ${value} `);
    }
    return text;
  }
}
class TestImage {
  async decode() { svgDecodes.push(await (await fetch(this.src)).text()); }
}
class FakeXHR extends EventTarget {
  open(...args) { xhrCalls.push(args); }
  send() {}
  setRequestHeader() {}
}
const context = vm.createContext({
  console, URL, Request, Response, Blob, FormData, Uint8Array, TextEncoder,Event, EventTarget,
  atob, btoa, queueMicrotask, setTimeout, clearTimeout,
  DOMParser: TestDOMParser, XMLSerializer: TestXMLSerializer, Image: TestImage,
  document: { createElement: type => {
    assert.equal(type, 'canvas');
    return { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => canvasDraws.push(args.slice(1)) }), toBlob: callback => callback(new Blob([png], { type: 'image/png' })) };
  } },
  location: { href: 'https://chatgpt.com/c/example' },
  navigator: { sendBeacon: (...args) => { beacons.push(args); return true; } },
  XMLHttpRequest: FakeXHR,
  fetch: async (url) => { if(String(url).startsWith('https://external.example/'))throw new TypeError('CORS'); actualFetch.push(String(url)); return String(url).startsWith('data:') ? fetch(url) : new Response(new Blob(['png'], { type: 'image/png' })); },
  chrome: { storage: { local: { get: async () => ({pdfOptions:bridgePrefs}), set: async value => { bridgePrefs=value.pdfOptions;bridgePreferenceWrites.push(value); } } }, runtime: { sendMessage: async message => {
    messages.push(message);
    if (message.cmd === 'snapshot_resource') return {base64:png.toString('base64'),mime:'image/png'};
    if (message.cmd === 'local_ready') return { errcode: 0 };
    if (message.cmd === 'pdf') return { errcode: 0, jobId: 'local-test' };
    return { status: 200, mime: 'application/json', text: JSON.stringify(message.payload.upload ? { errcode: 0, url: 'http://127.0.0.1:8765/api/file/test.png' } : message.payload.path === '/health' ? { engines:{chromium:{available:true}}, supportsMarkdownFallback:true } : { selectors: {} }) };
  } } }
});
vm.runInContext(read('bridge.js'), context);
await context.LocalExporter.ready;
assert.match(await context.LocalExporter.prepareFallback('![external](https://external.example/image.png)'), /api\/file\/test.png/);
assert.equal(bridgePrefs.toc,false,'Upgrade must turn off the previously enabled TOC default once');
assert.equal(bridgePrefs.renderer,'pandoc');
assert.equal(bridgePrefs.localTocOptInVersion,1);
bridgePrefs.toc=true;
vm.runInContext(read('bridge.js'), context);
await context.LocalExporter.ready;
assert.equal(bridgePrefs.toc,true,'A later explicit opt-in must survive reload');
assert.equal(bridgePreferenceWrites.length,1,'Migration must run only once');
assert(read('content.js').includes('D=p((0,s.useState)(!1),2),j=D[0],F=D[1]'));
await context.fetch('http://127.0.0.1:8765/api/config/v3');
assert.equal(actualFetch.length, 0); // local traffic relayed, no mixed-content fetch
assert.equal(messages.at(-1).payload.path, '/api/config/v3');
await context.fetch('https://phus.chatgptexporter.com/e/');
await context.fetch('https://us.i.posthog.com/i/v0/e/');
assert.equal(actualFetch.length, 0);
context.navigator.sendBeacon('https://phus.chatgptexporter.com/e/', 'secret');
assert.equal(beacons.length, 0);
await vm.runInContext(`new Promise(resolve => {const xhr=new XMLHttpRequest();xhr.addEventListener('load',resolve);xhr.open('POST','https://phus.chatgptexporter.com/e/');xhr.setRequestHeader('Content-Type','text/plain');xhr.send('secret');})`, context);
assert.equal(xhrCalls.length, 0);
const pdf = await context.LocalExporter.createPdf({ title: '图片与公式', messages: [{ role: 'Prompt', heading: '问题', markdown: '![图](https://chatgpt.com/image.png)\n\n$x^2$' }], options: { toc: true } });
assert.equal(pdf.jobId, 'local-test');
assert.deepEqual(actualFetch, ['https://chatgpt.com/image.png']);
assert(messages.find(item => item.payload?.upload)?.payload.upload.base64);
const pdfPayload = messages.at(-1).payload.payload;
assert(pdfPayload.messages[0].markdown.includes('127.0.0.1:8765/api/file/'));
assert(pdfPayload.messages[0].markdown.includes('$x^2$'));
assert.equal(pdfPayload.options.toc, true);
await context.LocalExporter.createPdf({ title: '拦截图片', messages: [{ role: 'Prompt', markdown: '![图](https://apir.chatgptexporter.com/private.png)' }], options: {} });
assert.equal(actualFetch.length, 1); // even image localization cannot bypass the fence
assert(messages.at(-1).payload.payload.messages[0].markdown.includes('图片无法读取'));
// Exact reported shape: percent-encoded SVG, UTF-8 Chinese, width=100%, viewBox.
const svgFixture = fs.readFileSync(new URL('fixtures/inline-diagram.svg', import.meta.url), 'utf8');
for (const svgUrl of [
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFixture),
  'data:image/svg+xml;base64,' + Buffer.from(svgFixture).toString('base64')
]) {
  const before = messages.length;
  await context.LocalExporter.createPdf({ title: 'SVG 回归', messages: [{ role: 'Response', markdown: `![积分图](${svgUrl})` }], options: {} });
  const uploaded = messages.slice(before).find(message => message.payload?.upload);
  assert(uploaded, 'SVG data URL was skipped instead of uploaded');
  assert.equal(uploaded.payload.upload.mime, 'image/png');
  assert.deepEqual(Buffer.from(uploaded.payload.upload.base64, 'base64'), png);
  assert(messages.at(-1).payload.payload.messages[0].markdown.includes('http://127.0.0.1:8765/api/file/'));
  assert(!messages.at(-1).payload.payload.messages[0].markdown.includes('data:image/svg'));
}
assert.equal(svgDecodes.length, 2);
assert(svgDecodes.every(xml => xml.includes('width="340"') && xml.includes('height="160"') && xml.includes('负半轴区域也计正面积')));
assert.deepEqual(canvasDraws, [[0, 0, 680, 320], [0, 0, 680, 320]]);
let inlineResult;
const diagramNode = {
  closest: () => null,
  getAttribute: key => ({ viewBox: '0 0 340 160', 'data-d-component': 'svg', 'aria-label': '积分图' })[key],
  cloneNode: () => ({ source: svgFixture, attributes: new Map([['width', '100%']]), setAttribute(key, value) { this.attributes.set(key, value); } }),
  ownerDocument: { createElement: () => ({ attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }) },
  replaceWith: value => inlineResult = value
};
const mathNode = { closest: () => ({}) };
const iconNode = { closest: () => null, getAttribute: key => key === 'viewBox' ? '0 0 24 24' : null };
context.LocalExporter.inlineSvgImages({ querySelectorAll: () => [diagramNode, mathNode, iconNode] });
assert(inlineResult.attributes.src.startsWith('data:image/svg+xml;charset=utf-8,'));
assert.equal(inlineResult.attributes.alt, '积分图');
assert(read('content.js').includes('LocalExporter.inlineSvgImages(o.body)'));
const ordered = context.LocalExporter.insertDiagram('**先说明半径为什么要平方。**\n\n### 第二步：代入公式\n\n继续计算。', { address: 'local-test-image', before: ['先说明半径为什么要平方。'], after: ['第二步：代入公式'] });
assert(ordered.indexOf('![') > ordered.indexOf('为什么要平方'));
assert(ordered.indexOf('![') < ordered.indexOf('第二步'));
assert.equal(context.LocalExporter.insertDiagram(ordered, { address: 'local-test-image', before: [], after: [] }), ordered);
const repeated = context.LocalExporter.insertDiagram('因此需要先审题。\n\n函数的正负由正弦函数决定。\n\n因此：\n\n开始列式。', { address: 'repeated-caption-image', before: ['函数的正负由正弦函数决定。'], after: ['因此：'] });
assert(repeated.indexOf('![') > repeated.indexOf('函数的正负'));
assert(repeated.indexOf('![') < repeated.indexOf('因此：'));
let capturedWebPayload;
context.LocalWebSnapshot = { capture: async payload => { capturedWebPayload = payload; return {html:'<p>original webpage</p>',css:'',width:760,theme:'light'}; } };
await context.LocalExporter.createPdf({title:'网页原貌',messages:[{turnId:'chosen',role:'Response',markdown:'fallback body'}],options:{renderer:'chromium'}});
assert.equal(capturedWebPayload.title,'网页原貌');
assert.equal(messages.at(-1).payload.payload.engine,'chromium');
assert.equal(messages.at(-1).payload.payload.webDocument.html,'<p>original webpage</p>');

// An incomplete original-appearance capture must never be submitted silently.
context.LocalWebSnapshot.capture=async()=>({html:'<p>mixed</p>',messageCount:2,domCount:1,fallbackCount:1});
let asked=0;
context.confirm=text=>{asked++;assert(text.includes('1/2'));return false;};
let submittedBefore=messages.filter(m=>m.cmd==='pdf').length;
await assert.rejects(context.LocalExporter.createPdf({messages:[{markdown:'body'}],options:{renderer:'chromium'}}),/已取消导出/);
assert.equal(asked,1);
assert.equal(messages.filter(m=>m.cmd==='pdf').length,submittedBefore);
context.confirm=()=>true;
await context.LocalExporter.createPdf({messages:[{markdown:'body'}],options:{renderer:'chromium'}});
assert.equal(messages.filter(m=>m.cmd==='pdf').length,submittedBefore+1);
assert.equal(messages.at(-1).payload.payload.engine,'chromium');
console.log('PASS incomplete original capture: explicit consent required, cancellation submits no PDF, acceptance preserves Chromium');

// Exercise the actual service worker with local HTTP responses and storage.
const stored = { commonOptions: { removeBrand: true } };
const requests = [];
let offline = false;
let webRevision = 0;
let remotePdfOptions = { pageSize: 'a5' };
let permissionGranted=true;
let messageListener;
let switchConnectionDuringRead=false;
const background = vm.createContext({
  console, URL, Response, Request, Blob, FormData, Uint8Array, atob, btoa,
  AbortSignal, setTimeout, clearTimeout,
  fetch: async (url, options) => {
    if (offline) throw new Error('test service offline');
    assert(['http://127.0.0.1:8765/','https://export.example.test/','https://cdn.openai.com/','https://example.org/'].some(origin=>String(url).startsWith(origin)));
    requests.push([url, options]);
    if (String(url).endsWith('/api/account')) return Response.json({ errcode: 0, local: true, isPro: true, name: '本地用户', email: '' });
    if (String(url).endsWith('/api/settings')) {
      if(switchConnectionDuringRead && options.method==='GET'){
        switchConnectionDuringRead=false;stored.serverConnection={url:'http://127.0.0.1:8765',token:''};
      }
      return Response.json({ errcode: 0, webRevision, settings: { pdfOptions: remotePdfOptions, commonOptions: { removeBrand: false } } });
    }
    if (String(url).includes('/api/pdf/v1')) return Response.json({ errcode: 0, jobId: 'new-job', status: 'queued' });
    if (String(url).endsWith('/api/usage')) return Response.json({ errcode: 0, hasExceed: false });
    return Response.json({ errcode: 0 });
  },
  chrome: {
    permissions:{contains:async()=>permissionGranted},
    runtime: { id: 'test-extension',getURL:path=>'chrome-extension://test-extension/'+path, onMessage: { addListener(callback) {messageListener=callback;} }, onInstalled: { addListener() {} }, setUninstallURL: async () => {}, openOptionsPage: async () => {} },
    storage: {
      local: { get: async keys => keys === null ? { ...stored } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in stored).map(key => [key, stored[key]])), set: async data => Object.assign(stored, data) },
      session: { setAccessLevel: async () => {} }, onChanged: { addListener() {} }
    }
  }
});
vm.runInContext(read('background.js'), background);
await vm.runInContext('dispatch({cmd:"local_ready"})', background);
assert.equal(stored.session.user.cusId, 'local');
assert.equal(stored.pdfOptions.pageSize, 'a5');
assert.equal(stored.commonOptions.removeBrand, true); // do not overwrite existing prefs
assert.equal((await vm.runInContext('dispatch({cmd:"account",payload:{cmd:"getinfo"}})', background)).rslt.local, true);
assert.equal((await vm.runInContext('dispatch({cmd:"usage",payload:{cmd:"get"}})', background)).rslt.hasExceed, false);
await vm.runInContext('dispatch({cmd:"pdf",payload:{cmd:"create",payload:{markdown:"test"}}})', background);
await assert.rejects(vm.runInContext('dispatch({cmd:"local_request",payload:{path:"//example.com",method:"GET"}})', background));
await assert.rejects(vm.runInContext('dispatch({cmd:"local_request",payload:{path:"/api/../secret",method:"GET"}})', background));
await vm.runInContext('dispatch({cmd:"snapshot_resource",url:"https://example.org/image.png"})', background);
assert.equal(requests.findLast(([url])=>url==='https://example.org/image.png')[1].credentials,'omit');
assert.equal(requests.findLast(([url])=>url==='https://example.org/image.png')[1].referrerPolicy,'no-referrer');
assert.equal(requests.findLast(([url])=>url==='https://example.org/image.png')[1].redirect,'follow');
for (const url of ['file:///etc/passwd','data:text/plain,test','https://user:secret@example.org/image.png']) {
  await assert.rejects(vm.runInContext('dispatch('+JSON.stringify({cmd:'snapshot_resource',url})+')',background));
}
assert(requests.length > 3);
offline = true;
stored.localSettingsDirty = true;
stored.commonOptions.removeBrand = false;
delete stored.pdfOptions;
await vm.runInContext('dispatch({cmd:"local_ready"})', background);
assert.equal(stored.localSettingsDirty, true);
assert.equal(stored.pdfOptions, undefined);
offline = false;
await vm.runInContext('dispatch({cmd:"local_ready"})', background);
assert.equal(stored.pdfOptions.pageSize, 'a5');
assert.equal(stored.localSettingsDirty, false);
assert.equal(JSON.parse(requests.filter(([url, options]) => url.endsWith('/api/settings') && options.method === 'POST').at(-1)[1].body).settings.commonOptions.removeBrand, false);
webRevision=1;remotePdfOptions={pageSize:'a4',toc:false,renderer:'chromium',localTocOptInVersion:1};
await vm.runInContext('dispatch({cmd:"local_ready"})', background);
assert.equal(stored.pdfOptions.pageSize,'a4','Clean browser settings must receive newer web preferences');
assert.equal(stored.pdfOptions.toc,false);
assert.equal(stored.localWebSettingsRevision,1);
stored.localSettingsDirty=true;stored.pdfOptions={...stored.pdfOptions,toc:true};webRevision=2;
await vm.runInContext('dispatch({cmd:"local_ready"})', background);
assert.equal(stored.pdfOptions.toc,true,'Unsynced local choices must win a web/local conflict');
assert.equal(stored.localWebSettingsRevision,2);
await assert.rejects(vm.runInContext('dispatch({cmd:"server_config_set",payload:{url:"https://export.example.test/api",token:"test"}})',background));
permissionGranted=false;
await assert.rejects(vm.runInContext('dispatch({cmd:"server_config_set",payload:{url:"https://export.example.test",token:"test"}})',background));
permissionGranted=true;
await vm.runInContext('dispatch({cmd:"server_config_set",payload:{url:"https://export.example.test/",token:"test-private-service-token"}})',background);
assert.equal(stored.serverConnection.url,'https://export.example.test');
await vm.runInContext('dispatch({cmd:"local_request",payload:{path:"/health",method:"GET"}})',background);
const remoteHealth=requests.findLast(([url])=>url==='https://export.example.test/health');
assert(remoteHealth);
assert.equal(remoteHealth[1].headers.Authorization,'Bearer test-private-service-token');
assert.equal(remoteHealth[1].redirect,'error');
assert(requests.filter(([url,options])=>url.endsWith('/api/settings') && options.method==='POST').every(([,options])=>!options.body.includes('test-private-service-token')),'Connection credentials must never enter preference backups');
await vm.runInContext('dispatch({cmd:"snapshot_resource",url:"https://cdn.openai.com/test.woff2"})',background);
assert.equal(requests.at(-1)[1].headers?.Authorization,undefined,'Never attach the service token to OpenAI resource downloads');
assert.equal(messageListener({cmd:'server_config_get'},{id:'test-extension',url:'https://chatgpt.com/'},()=>{throw new Error('Credentials leaked to a content script');}),false);
const writesBeforeSwitch=requests.filter(([url,options])=>url.endsWith('/api/settings') && options.method==='POST').length;
switchConnectionDuringRead=true;
await assert.rejects(vm.runInContext('reconcile()',background),/服务器连接已更改/);
assert.equal(requests.filter(([url,options])=>url.endsWith('/api/settings') && options.method==='POST').length,writesBeforeSwitch,'Changing servers during a read must not post the old server state into the new server');

// Invalid imports must not touch existing browser preferences.
const elements = new Map();
const element = key => {
  if (!elements.has(key)) elements.set(key, { value: '', textContent: '', disabled: false, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; }, replaceChildren() {}, append() {}, querySelector() { return { disabled: false }; } });
  return elements.get(key);
};
const writes = [];
const connectionMessages=[],permissionRequests=[];
let allowConnectionPermission=false;
const dashboard = vm.createContext({
  console, URL, Blob, setTimeout,
  document: { querySelector: element, createElement: () => ({}) },
  chrome: {
    permissions:{request:async options=>{permissionRequests.push(options);return allowConnectionPermission;}},
    runtime: { openOptionsPage() {}, sendMessage: async message => {
      connectionMessages.push(message);
      if(message.cmd==='server_config_get')return {errcode:0,url:'http://127.0.0.1:8765',token:''};
      if(message.cmd==='server_config_set')return {errcode:0};
      return { status: 200, text: JSON.stringify(message.payload?.path === '/health' ? { ok: true } : { errcode: 0, items: [] }) };
    } }, storage: { local: { get:async()=>({}),set: async value => writes.push(value) } }
  }
});
await vm.runInContext(read('local.js'), dashboard);
await element('#import').handlers.change({ target: { files: [{ size: 20, text: async () => '{"settings":{"pdfOptions":"bad"}}' }] } });
assert.equal(writes.length, 0);
assert(element('#settings-result').textContent.includes('必须是对象'));
element('#server-url').value='https://export.example.test';element('#server-token').value='test-service-token';
const denied=element('#connection-form').handlers.submit({preventDefault(){},currentTarget:element('#connection-form')});
assert.equal(permissionRequests.length,1,'Host permission must be requested synchronously during the submit gesture');
await denied;
assert.equal(connectionMessages.filter(message=>message.cmd==='server_config_set').length,0);
assert(element('#connection-result').textContent.includes('未授予'));
allowConnectionPermission=true;
element('#server-url').value='https://export.example.test';element('#server-token').value='test-service-token';
await element('#connection-form').handlers.submit({preventDefault(){},currentTarget:element('#connection-form')});
const connectionSave=connectionMessages.findLast(message=>message.cmd==='server_config_set');
assert.equal(connectionSave.payload.url,'https://export.example.test');
assert.equal(connectionSave.payload.token,'test-service-token');
const transferChunks=[];
let transferSize=0;
context.chrome.runtime.sendMessage=async message=>{
  const {path,body,expectedBaseUrl}=message.payload;
  assert.equal(expectedBaseUrl,'http://127.0.0.1:8765');
  assert(JSON.stringify(message).length<900000,'Every IPC packet must stay below 1 MiB');
  let data;
  if(path==='/api/pdf/uploads'){transferSize=body.size;data={uploadId:'f'.repeat(32)};}
  else if(path.endsWith('/chunk')){assert.equal(body.index,transferChunks.length);transferChunks.push(Buffer.from(body.data,'base64'));data={};}
  else {assert(path.endsWith('/commit'));data={errcode:0,jobId:'chunked-job'};}
  return {status:200,text:JSON.stringify(data)};
};
const largePayload={engine:'chromium',text:'汉字📚'.repeat(600000)};
assert.equal((await context.LocalExporter.submitPdf(largePayload)).jobId,'chunked-job');
const restored=Buffer.concat(transferChunks);
assert.equal(restored.length,transferSize);
assert.equal(JSON.parse(restored.toString()).text,largePayload.text,'UTF-8 and surrogate boundaries must survive chunking');
console.log('PASS: package syntax, restored PDF dialog, local relay/images, UTF-8 and base64 SVG data URLs rasterized/uploaded with viewBox dimensions, selected Markdown, telemetry fence, identity/preferences, offline recovery and dirty sync, invalid import preserves settings, API commands and path rejection.');
