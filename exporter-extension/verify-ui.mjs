// Real Chromium exercises the shipped overlay; ChatGPT and service responses are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const root=path.dirname(new URL(import.meta.url).pathname);
const {chromium}=createRequire(import.meta.url)(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.LOCAL_EXPORT_CHROMIUM_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const css=await fs.readFile(path.join(root,'content.css'),'utf8');
 await page.route('**/*',async route=>{
  const url=route.request().url();
  if(url.endsWith('/content.css'))return route.fulfill({contentType:'text/css',body:css});
  if(url.endsWith('/api/auth/session'))return route.fulfill({json:{}});
  if(url==='https://chatgpt.com/c/fixture')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><title>测试对话 - ChatGPT</title><style>body{font:16px/1.7 system-ui;margin:0;background:#fff;color:#222}main{max-width:680px;margin:40px auto;padding-bottom:220px}.composer{position:fixed;bottom:30px;left:calc(50% - 340px);width:680px;transform:translateZ(0);overflow:hidden}form{padding:20px;background:#eee;border-radius:20px}textarea{width:100%;height:48px}</style><main><h1>测试对话</h1>${Array.from({length:6},(_,i)=>`<article data-message-author-role="${i%2?'assistant':'user'}" data-message-id="m${i}"><h6 class="sr-only">${i%2?'ChatGPT说:':'你说:'}</h6><div class="${i===1?'content-body':'markdown'}"><p>消息 ${i+1}：${i%2?'回答内容，包含推导和解释。':'请解释这个问题。'}</p></div></article>`).join('')}</main><div class="composer"><form><textarea id="prompt-textarea"></textarea></form></div>`});
  return route.abort();
 });
 await page.goto('https://chatgpt.com/c/fixture');
 await page.evaluate(()=>{
  window.calls=[];window.stored={preferences:{pdfTarget:'server'}};window.changeListeners=[];window.failPdf=false;window.clipboardText='';window.pendingPdf=false;
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.clipboardText=text;}}});
  window.chrome={runtime:{id:'fixture',getURL:file=>'https://extension.fixture/'+file,getManifest:()=>({version:'1.9.2'}),onMessage:{addListener(){}},sendMessage:async message=>{
   calls.push(message);
   if(message.action==='clientHello')return {data:{nativePdfJobs:true,pdfOptionsVersion:1,pdfOnly:true,name:'拾页'}};
   if(message.action==='clientRequest'){
    const request=message.request;
    if(request.action==='begin'){window.nativeChunks=[];return {data:{upload:'fixture-upload'}};}
    if(request.action==='chunk'){nativeChunks.push(request.data);return {data:{ok:true}};}
    if(request.action==='commit'){const binary=nativeChunks.map(s=>atob(s)).join('');window.clientArchive=JSON.parse(new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));return {data:{id:'saved-item',jobId:'client-job'}};}
    if(request.action==='export_status')return {data:{status:window.clientStatus||'done',delivery:window.clientDelivery||'client',error:'模拟客户端生成失败'}};
   }
   if(message.path==='/api/pdf/v1'){if(failPdf)return {error:'模拟服务离线'};return {data:{jobId:'a'.repeat(32),server:'http://127.0.0.1:8765'}};}
   if(message.path?.match(/\/api\/pdf\/v1\/[a-f0-9]{32}$/))return {data:{status:pendingPdf?'processing':'done'}};
   return {data:{ok:true}};
  }},storage:{local:{get:async key=>{if(typeof key==='string')return {[key]:stored[key]};return stored;},set:async patch=>{Object.assign(stored,patch);for(const [key,newValue] of Object.entries(patch))for(const fn of changeListeners)fn({[key]:{newValue}},'local');}},onChanged:{addListener:fn=>changeListeners.push(fn)}}};
 });
 for(const file of ['bootstrap.js','snapshot-adapter.js','capture.js','core.js','web-snapshot.js','role-icons.js','custom-select.js','content-ui.js'])await page.addScriptTag({content:await fs.readFile(path.join(root,file),'utf8')});
 const bar=page.locator('#conversation-archive .button-bar');
 const panel=page.locator('#conversation-archive .selector');
 await bar.getByRole('button',{name:'SELECT',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#conversation-archive').shadowRoot.querySelector('.count').textContent==='6/6');
 assert.equal(await panel.locator('.row').count(),6);
 assert.equal(await panel.locator('.row.assistant svg.role-icon use[href="#archive-role-assistant"]').count(),3);
 assert.equal(await panel.locator('.row.user svg.role-icon use[href="#archive-role-user"]').count(),3);
 assert.equal(await panel.locator('svg.role-icon[aria-hidden="true"]').count(),6);
 const previews=await panel.locator('.preview').allTextContents();assert(previews.every(text=>!text.includes('ChatGPT说:')&&!text.includes('你说:')));assert(previews.every(text=>text.startsWith('消息 ')));
 const body=await page.evaluate(()=>captureConversation());assert(body.messages.every(m=>!m.markdown.includes('ChatGPT说:')&&!m.markdown.includes('你说:')));

 assert.equal((await panel.boundingBox()).height,900,'Sidebar must escape transformed composer');
 await panel.getByRole('button',{name:'清空',exact:true}).click();
 const checks=panel.locator('[data-message]');await checks.nth(1).click();await checks.nth(4).click({modifiers:['Shift']});
 assert.equal(await panel.locator('[data-message]:checked').count(),4);
 await panel.getByRole('button',{name:'反选',exact:true}).click();assert.equal(await panel.locator('[data-message]:checked').count(),2);
 await panel.getByRole('button',{name:'提问',exact:true}).click();assert.equal(await panel.locator('[data-message]:checked').count(),3);
 await panel.getByRole('button',{name:'回答',exact:true}).click();assert.equal(await panel.locator('[data-message]:checked').count(),3);
 await panel.getByRole('button',{name:'展开',exact:true}).click();assert.equal(await panel.locator('.preview.expanded').count(),6);
 await panel.getByRole('button',{name:'折叠',exact:true}).click();await panel.locator('.preview').first().click();assert.equal(await panel.locator('.preview.expanded').count(),1);
 await panel.getByRole('button',{name:'最新消息在前',exact:true}).click();assert.equal(await panel.locator('[data-message]').first().getAttribute('data-message'),'m5');
 await panel.getByRole('button',{name:'清空',exact:true}).click();await panel.locator('[data-message="m4"]').click();await panel.locator('[data-message="m1"]').click({modifiers:['Shift']});assert.equal(await panel.locator('[data-message]:checked').count(),4);
 await panel.getByRole('button',{name:'停靠到左侧',exact:true}).click();assert.equal((await panel.boundingBox()).x,0);
 const resize=panel.getByRole('separator');let r=await resize.boundingBox();await page.mouse.move(r.x+2,300);await page.mouse.down();await page.mouse.move(440,300);await page.mouse.up();assert(Math.abs((await panel.boundingBox()).width-440)<5);
 await panel.getByRole('button',{name:'停靠到右侧',exact:true}).click();
 const format=panel.locator('[data-action=format]');
 await format.click();await page.getByRole('menuitem',{name:'TEXT',exact:true}).click();assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='downloadText').length),0,'Changing footer format must not export');
 await panel.locator('.actions [data-action=export]').click();await page.getByRole('dialog').waitFor();assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='downloadText').at(-1).format),'txt');await page.getByRole('button',{name:'完成',exact:true}).click();
 await format.click();await page.getByRole('menuitem',{name:'PDF',exact:true}).click();await panel.locator('.actions [data-action=export]').click();
 let dialog=page.getByRole('dialog');await dialog.waitFor();assert(await dialog.evaluate(n=>n.matches(':modal')));
 assert(await dialog.getByLabel('目录',{exact:true}).isChecked(),'PDF outline defaults on');assert(!await dialog.getByLabel('目录页',{exact:true}).isChecked(),'Printed TOC defaults off');
 await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>calls.filter(c=>c.path==='/api/pdf/v1').length),0,'Esc must cancel before submission');assert(await panel.isVisible(),'Closing PDF modal must keep selector');
 await panel.locator('.actions [data-action=export]').click();dialog=page.getByRole('dialog');await dialog.getByLabel('内容标题',{exact:true}).fill('导出标题');await dialog.getByLabel('目录',{exact:true}).uncheck();await dialog.getByLabel('目录页',{exact:true}).check();
 await page.screenshot({path:'/tmp/archive-pdf-dialog.png'});
 await dialog.getByRole('button',{name:'导出 PDF',exact:true}).click();await page.getByRole('heading',{name:'导出成功',exact:true}).waitFor();
 const pdf=await page.evaluate(()=>calls.find(c=>c.path==='/api/pdf/v1'));assert.equal(pdf.body.payload.title,'导出标题');assert.equal(pdf.body.payload.options.toc,true);assert.equal(pdf.body.payload.options.outline,false);assert.equal(pdf.body.payload.messages.length,4);assert(await page.evaluate(()=>calls.some(c=>c.download&&c.path.endsWith('/download'))));
 await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.evaluate(async()=>{await ArchiveCore.savePreferences({format:'md',copyToClipboard:true,muteExport:true,autoCloseSelector:true,selectType:'answers'});});
 await panel.locator('.actions [data-action=export]').click();await panel.waitFor({state:'hidden'});assert((await page.evaluate(()=>clipboardText)).includes('消息 2'),JSON.stringify(await page.evaluate(()=>({clipboardText,prefs:stored.preferences,calls:calls.slice(-4)}))));
 await bar.getByRole('button',{name:'SELECT',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#conversation-archive').shadowRoot.querySelector('.count').textContent==='3/6');
 await page.screenshot({path:'/tmp/archive-selector-light.png'});
 await page.evaluate(()=>document.documentElement.classList.add('dark'));await page.screenshot({path:'/tmp/archive-selector-dark.png'});
 await page.setViewportSize({width:360,height:740});assert((await panel.boundingBox()).width<=360);await page.screenshot({path:'/tmp/archive-selector-mobile.png'});
 await page.evaluate(()=>{history.pushState({},'','/c/other');document.querySelector('main h1').textContent='另一条对话';});await panel.waitFor({state:'hidden'});
 await page.setViewportSize({width:1200,height:900});
 await page.evaluate(async()=>{
  const answer=document.querySelector('[data-message-id="m1"]');
  answer.querySelector('.content-body').innerHTML='<h3>较小标题</h3><div role="heading" aria-level="1">单个回答的最大标题</div><h1>同级第二个标题</h1><pre><code># 代码中的标题</code></pre><h1 hidden>隐藏标题</h1><p>正文内容</p>';
  await ArchiveCore.savePreferences({format:'pdf',selectType:'none',copyToClipboard:false,autoCloseSelector:false,muteExport:false});
  await __archiveOverlay.open('none');
 });
 await panel.locator('[data-message="m1"]').check();await panel.locator('.actions [data-action=export]').click();
 dialog=page.getByRole('dialog');
 assert.match(await dialog.getByLabel('文件名',{exact:true}).inputValue(),/^单个回答的最大标题_\d{8}-\d{6}\.pdf$/);
 assert.equal(await dialog.getByLabel('内容标题',{exact:true}).inputValue(),'测试对话','Only filename prefill changes');
 await page.keyboard.press('Escape');
 await panel.locator('[data-message="m3"]').check();await panel.locator('.actions [data-action=export]').click();
 dialog=page.getByRole('dialog');assert.match(await dialog.getByLabel('文件名',{exact:true}).inputValue(),/^测试对话_\d{8}-\d{6}\.pdf$/);await page.keyboard.press('Escape');
 await panel.getByRole('button',{name:'清空',exact:true}).click();await panel.locator('[data-message="m0"]').check();await panel.locator('.actions [data-action=export]').click();
 dialog=page.getByRole('dialog');assert.match(await dialog.getByLabel('文件名',{exact:true}).inputValue(),/^测试对话_\d{8}-\d{6}\.pdf$/);await page.keyboard.press('Escape');
 await page.evaluate(async()=>ArchiveCore.savePreferences({pdfTarget:'client'}));
 await panel.locator('.actions [data-action=export]').click();dialog=page.getByRole('dialog');
 assert(await dialog.getByRole('radio',{name:'拾页客户端',exact:true}).isChecked());
 assert(await dialog.getByLabel('同时保存到拾页',{exact:true}).isChecked());assert(await dialog.locator('[data-pdf-options]').isVisible());assert(await dialog.locator('[data-server-engine]').isHidden());
 await dialog.getByLabel('文件名',{exact:true}).fill('客户端文档.pdf');
 const serverCreates=await page.evaluate(()=>calls.filter(c=>c.path==='/api/pdf/v1').length);
 await dialog.getByRole('button',{name:'导出 PDF',exact:true}).click();
 await page.getByRole('heading',{name:'导出成功',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.path==='/api/pdf/v1').length),serverCreates,'Client PDF must not fetch the old HTTP backend');
 assert.equal(await page.evaluate(()=>clientArchive.exportRequest.filename),'客户端文档.pdf');
 assert.equal(typeof await page.evaluate(()=>clientArchive.exportRequest.options.outline),'boolean');
 assert.equal(await page.evaluate(()=>clientArchive.exportRequest.options.pageSize),'a4');
 assert.equal(await page.evaluate(()=>clientArchive.messages.length),1);
 assert(await page.getByText('PDF 已保存至客户端选择的位置。',{exact:true}).isVisible());
 await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.evaluate(()=>{window.clientDelivery='browser';});
 await panel.locator('.actions [data-action=export]').click();dialog=page.getByRole('dialog');
 await dialog.getByLabel('同时保存到拾页',{exact:true}).uncheck();
 await dialog.getByRole('button',{name:'导出 PDF',exact:true}).click();await page.getByText('PDF 已交给浏览器下载。',{exact:true}).waitFor();
 assert(await page.evaluate(()=>calls.some(c=>c.action==='clientDownload'&&c.jobId==='client-job')));
 assert.equal(await page.evaluate(()=>clientArchive.exportRequest.browserDownload),true);assert.equal(await page.evaluate(()=>clientArchive.exportRequest.saveToLibrary),false);assert.equal(await page.evaluate(()=>stored.preferences.saveToClient),false);
 await page.getByRole('button',{name:'完成',exact:true}).click();
 for(const [clientStatus,expected] of [['cancelled','已在客户端取消 PDF 保存'],['failed','模拟客户端生成失败']]){
  await page.evaluate(value=>{window.clientStatus=value;},clientStatus);
  await panel.locator('.actions [data-action=export]').click();dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'导出 PDF',exact:true}).click();
  await dialog.locator('.pdf-status').filter({hasText:expected}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'导出成功',exact:true}).count(),0);
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
 }
 // Simulate a reload on an already-open page. Retain exactly the selected IDs.
 const selectedBefore=await panel.locator('[data-message]:checked').evaluateAll(nodes=>nodes.map(n=>n.dataset.message));
 await page.evaluate(()=>{window.oldDisposed=false;const old=__archiveOverlay.dispose;__archiveOverlay.dispose=()=>{oldDisposed=true;old();};__archiveOverlay.version='1.2.3';});
 for(const file of ['bootstrap.js','snapshot-adapter.js','capture.js','core.js','web-snapshot.js','role-icons.js','custom-select.js','content-ui.js'])await page.addScriptTag({content:await fs.readFile(path.join(root,file),'utf8')});
 await page.waitForFunction(()=>document.querySelector('#conversation-archive')?.shadowRoot.querySelector('.status').textContent.includes('连接已恢复'));
 assert(await page.evaluate(()=>oldDisposed));assert.equal(await page.locator('#conversation-archive').count(),1);
 assert.deepEqual(await panel.locator('[data-message]:checked').evaluateAll(nodes=>nodes.map(n=>n.dataset.message)),selectedBefore);
 // Earlier releases have no dispose hook: retire their visible host safely.
 await page.evaluate(()=>{delete __archiveOverlay.dispose;__archiveOverlay.version='1.2.3';});
 for(const file of ['bootstrap.js','snapshot-adapter.js','capture.js','core.js','web-snapshot.js','role-icons.js','custom-select.js','content-ui.js'])await page.addScriptTag({content:await fs.readFile(path.join(root,file),'utf8')});
 await page.waitForFunction(()=>document.querySelector('#conversation-archive')?.shadowRoot.querySelector('.status').textContent.includes('连接已恢复'));
 assert.equal(await page.locator('#conversation-archive').count(),1);
 assert.equal(await page.locator('[id^="conversation-archive-retired-"]:visible').count(),0);
 assert.deepEqual(await panel.locator('[data-message]:checked').evaluateAll(nodes=>nodes.map(n=>n.dataset.message)),selectedBefore);
 assert.deepEqual(errors,[]);
 console.log('PASS real Chromium fixture: page selector, range/invert/filter selection, expansion, reverse order, dock/resize, format menu, text/clipboard, native PDF modal + Esc, create/poll/auto-download, auto-close, dark/mobile, SPA reset, single-answer highest-heading filename and multi-message/user fallbacks. Service and ChatGPT data are mocked.');
}finally{await browser.close();}
