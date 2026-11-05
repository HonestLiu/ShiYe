/* Exercise the actual generated component with its bundled React and CSS. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const here=path.dirname(new URL(import.meta.url).pathname);
const extension=path.resolve(here,'../local-extension');
const {chromium}=createRequire(import.meta.url)(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE || path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.LOCAL_EXPORT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
  const page=await browser.newPage({viewport:{width:960,height:720}});
  const errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  await page.setContent('<!doctype html><html><body style="margin:0;background:#f7f8f7"><main style="max-width:680px;margin:70px auto;font:16px/2 system-ui;color:#67736e"><h1 style="color:#202a24;font-size:25px">对话笔记</h1><p>整理知识，保留思路。</p><p>导出完成后，继续当前对话。</p></main><div id="success-test-host"></div></body></html>');
  await page.evaluate(()=>{
    window.LocalExporter={ready:Promise.resolve()};
    window.chrome={runtime:{getURL:path=>'chrome-extension://fixture/'+path,sendMessage:async()=>({}),onMessage:{addListener(){}}},i18n:{getMessage:key=>key},storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:{addListener(){}}}};
  });
  await page.addScriptTag({content:await fs.readFile(path.join(extension,'success-dialog.js'),'utf8')});
  let bundle=await fs.readFile(path.join(extension,'content.js'),'utf8');
  const marker='window.onload=r(i().mark';assert.equal(bundle.split(marker).length,2);
  bundle=bundle.replace(marker,'globalThis.__SuccessHarness={React:s,createRoot:c.H,Success:ME,css:WE};return;'+marker);
  new vm.Script(bundle);
  await page.addScriptTag({content:bundle});
  await page.waitForFunction(()=>!!globalThis.__SuccessHarness);
  await page.evaluate(()=>{
    const {React,createRoot,Success,css}=__SuccessHarness;
    const shadow=document.querySelector('#success-test-host').attachShadow({mode:'open'});
    document.querySelector('#success-test-host').style.cssText='position:fixed;inset:0;z-index:99999;pointer-events:none';
    const style=document.createElement('style');style.textContent=css;shadow.append(style);
    const theme=document.createElement('div');theme.id='theme';shadow.append(theme);
    function Fixture(){
      const [open,setOpen]=React.useState(false),[info,setInfo]=React.useState({exportType:'pdf'});
      window.chooseInfo=value=>setInfo(value);
      return React.createElement(React.Fragment,null,React.createElement('button',{id:'trigger',style:{pointerEvents:'auto'},onClick:()=>setOpen(true)},'导出样例'),open && React.createElement(Success,{open:true,info,onClose:()=>setOpen(false)}));
    }
    createRoot(theme).render(React.createElement(Fixture));
  });
  const trigger=page.getByRole('button',{name:'导出样例'});
  const dialog=page.getByRole('dialog');
  for(const format of ['pdf','md','txt','csv','json']){
    await page.evaluate(format=>chooseInfo({exportType:format}),format);
    await trigger.click();await dialog.waitFor();
    assert.equal(await dialog.getByRole('button').count(),1);
    assert.equal(await dialog.locator('a,img').count(),0,'Success must not request promotional resources');
    assert((await dialog.textContent()).includes('已交给浏览器下载'));
    assert(await dialog.getByRole('button',{name:'完成'}).evaluate(node=>node.getRootNode().activeElement===node));
    if(format==='pdf')await page.screenshot({path:'/tmp/export-success-light.png'});
    await dialog.getByRole('button',{name:'完成'}).click();await dialog.waitFor({state:'detached'});
    assert(await trigger.evaluate(node=>node.getRootNode().activeElement===node),'Focus should return to the original trigger');
  }
  await page.evaluate(()=>chooseInfo({copyToClipboard:true,exportType:'md'}));
  await trigger.click();await dialog.waitFor();
  assert.equal(await dialog.getByRole('heading').textContent(),'已复制到剪贴板');
  await page.keyboard.press('Tab');assert(await trigger.evaluate(node=>node.getRootNode().activeElement!==node),'Background controls must not receive focus while modal');
  assert(await dialog.evaluate(node=>node.matches(':modal')));
  await page.keyboard.press('Shift+Tab');assert(await dialog.getByRole('button').evaluate(node=>node.getRootNode().activeElement===node));
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await page.evaluate(()=>{chooseInfo({exportType:'pdf'});document.querySelector('#success-test-host').shadowRoot.querySelector('#theme').className='dark';document.body.style.background='#212523';});
  await trigger.click();await dialog.waitFor();
  await page.screenshot({path:'/tmp/export-success-dark.png'});
  await page.mouse.click(5,5);await dialog.waitFor({state:'detached'});
  await page.setViewportSize({width:360,height:720});await trigger.click();await dialog.waitFor();
  const bounds=await dialog.boundingBox();assert(bounds.x>=18 && bounds.x+bounds.width<=342);
  await page.screenshot({path:'/tmp/export-success-mobile.png'});
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  // Exercise the old-browser pointer fallback independently of native closedby.
  await page.evaluate(()=>{window.savedClosedBy=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'closedBy');delete HTMLDialogElement.prototype.closedBy;});
  await trigger.click();await dialog.waitFor();
  await dialog.evaluate(node=>node.removeAttribute('closedby'));
  const fallbackBounds=await dialog.boundingBox();
  await page.mouse.click(fallbackBounds.x+8,fallbackBounds.y+8);
  assert(await dialog.isVisible(),'Dialog padding is not the backdrop');
  await page.mouse.move(fallbackBounds.x+80,fallbackBounds.y+45);await page.mouse.down();await page.mouse.move(5,5);await page.mouse.up();
  assert(await dialog.isVisible(),'Dragging from content onto the backdrop must not dismiss');
  await page.mouse.click(5,5);await dialog.waitFor({state:'detached'});
  await page.evaluate(()=>Object.defineProperty(HTMLDialogElement.prototype,'closedBy',window.savedClosedBy));
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log('PASS actual generated success UI: PDF/MD/TXT/CSV/JSON, clipboard, one action, no remote resources, keyboard focus/Tab/Escape/return, light dismiss, shadow-root dark theme and 360px layout');
}finally{await browser.close();}
