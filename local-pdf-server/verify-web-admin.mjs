/* Real HTTP + browser regression; uses isolated data and an ephemeral port. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const {chromium}=createRequire(import.meta.url)(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE || path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'web-admin-test-'));
const reservation=net.createServer();
await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const external=process.env.LOCAL_TEST_ADMIN_URL;
const base=external || `http://127.0.0.1:${port}`;
const authToken=process.env.LOCAL_TEST_ADMIN_TOKEN || '';
const serviceFetch=(url,options={})=>fetch(url,{...options,headers:{...(authToken ? {Authorization:'Bearer '+authToken} : {}),...options.headers}});
let processLog='';
let service, browser;
async function start() {
  if(external)return;
  service=spawn(process.env.LOCAL_TEST_PYTHON || 'python3',['-u',path.join(here,'server.py'),'--port',String(port)],{
    cwd:here,env:{...process.env,LOCAL_EXPORT_DATA_DIR:temporary,LOCAL_EXPORT_API_TOKEN:authToken,PATH:`${process.env.PATH}:/Library/TeX/texbin`},stdio:['ignore','pipe','pipe']});
  service.stdout.on('data',data=>processLog+=data);service.stderr.on('data',data=>processLog+=data);
  for(let attempt=0;attempt<80;attempt++) {
    if(service.exitCode!==null)throw new Error(processLog);
    try{if((await serviceFetch(base+'/health')).ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Test service did not start: '+processLog);
}
async function stop() {
  if(!service || service.exitCode!==null)return;
  const stopped=new Promise(resolve=>service.once('exit',resolve));service.kill('SIGINT');await stopped;
}
try {
  await start();
  const root=await serviceFetch(base+'/');assert.equal(root.status,200);
  assert(root.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const html=await root.text();const token=html.match(/name="local-csrf" content="([^"]+)"/)[1];
  for(const resource of ['/local.js','/local.css'])assert.equal((await serviceFetch(base+resource)).status,200);
  for(const privatePath of ['/server.py','/data/local.sqlite3','/%2e%2e/server.py'])assert.equal((await serviceFetch(base+privatePath)).status,404);
  assert.equal((await serviceFetch(base+'/api/settings',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{"settings":{}}'})).status,403);
  assert.equal((await serviceFetch(base+'/api/settings',{method:'POST',headers:{Origin:'https://example.org','X-Local-CSRF':token,'Content-Type':'application/json'},body:'{"settings":{}}'})).status,403);
  const post=async (route,body)=>{
    const response=await serviceFetch(base+route,{method:'POST',headers:{Origin:base,'X-Local-CSRF':token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  };
  const saved=await post('/api/settings',{source:'web',settings:{pdfOptions:{toc:false,localTocOptInVersion:1,renderer:'chromium'}}});
  assert.equal(saved.webRevision,1);
  assert.equal((await (await serviceFetch(base+'/api/jobs')).json()).total,0);
  browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.LOCAL_EXPORT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/');
  if(authToken){await page.locator('#login-section').waitFor();await page.locator('#login-token').fill(authToken);await page.locator('#login-form button').click();}
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已连接'));
  if(process.env.LOCAL_TEST_ADMIN_SCREENSHOT)await page.screenshot({path:process.env.LOCAL_TEST_ADMIN_SCREENSHOT.replace(/\.png$/,'.desktop.png'),fullPage:true});
  assert.equal(await page.locator('#options').isVisible(),false);
  assert.equal(await page.locator('#default-toc').isChecked(),false);
  await page.locator('#name').fill('Web 后台验证');await page.locator('#email').fill('web@localhost');
  await page.locator('#profile button').click();await page.waitForFunction(()=>document.querySelector('#profile-result').textContent.includes('已保存'));
  assert.equal((await (await serviceFetch(base+'/api/account')).json()).name,'Web 后台验证');
  await page.locator('#default-toc').check();await page.locator('#renderer-form button').click();
  await page.waitForFunction(()=>document.querySelector('#renderer-result').textContent.includes('已保存'));
  assert.equal((await (await serviceFetch(base+'/api/settings')).json()).settings.pdfOptions.toc,true);
  await page.locator('#message').fill('<img src=x onerror=alert(1)> 测试反馈');await page.locator('#feedback-form button').click();
  await page.waitForFunction(()=>document.querySelector('#feedback-result').textContent.includes('已保存'));
  assert.equal(await page.locator('#feedback-list img').count(),0);
  assert((await page.locator('#feedback-list').textContent()).includes('<img'));
  await page.locator('#document-title').fill('Web 中文公式验证');
  await page.locator('#markdown-file').setInputFiles({name:'Web 中文公式验证.md',mimeType:'text/markdown',buffer:Buffer.from('# 一级标题\n\n中文正文与公式 $x^2+1$。\n\n## 二级标题\n\n- 列表内容\n')});
  assert((await page.locator('#markdown').inputValue()).includes('一级标题'));
  await page.locator('#create-form button').click();
  await page.waitForFunction(()=>document.querySelector('#create-result').textContent.includes('PDF 已生成'),{},{timeout:90000});
  const pdfDownload=page.waitForEvent('download');await page.getByRole('link',{name:'下载 PDF',exact:true}).first().click();
  const download=await pdfDownload;assert.equal(download.suggestedFilename(),'Web 中文公式验证.pdf');
  assert.equal((await fs.readFile(await download.path())).subarray(0,5).toString(),'%PDF-');
  const webJob=await post('/api/pdf/v1',{engine:'chromium',title:'网页测试',webDocument:{html:'<main class="pdf-document"><h1>网页标题</h1><p>快照正文</p></main>',css:'body{font:16px sans-serif}',width:760,theme:'light'},options:{toc:false}});
  await page.locator('#refresh').click();
  await page.getByRole('link',{name:'下载快照',exact:true}).first().waitFor();
  const snapshot=page.waitForEvent('download');await page.getByRole('link',{name:'下载快照',exact:true}).first().click();
  assert((await fs.readFile(await (await snapshot).path(),'utf8')).includes('快照正文'));
  for(let attempt=0;attempt<100;attempt++) {
    const job=await (await serviceFetch(base+'/api/pdf/v1/'+webJob.jobId)).json();
    if(job.status==='done')break;
    assert.notEqual(job.status,'failed',job.errmsg);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const history=await (await serviceFetch(base+'/api/jobs')).json();assert.equal(history.total,2);
  assert(history.items.every(job=>job.status==='done'));
  assert(history.items.every(job=>!('directory' in job)));
  await page.setViewportSize({width:390,height:844});await page.goto(base+'/');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已连接'));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile page must not overflow');
  await page.screenshot({path:path.join(temporary,'mobile.png'),fullPage:true});
  if(process.env.LOCAL_TEST_ADMIN_SCREENSHOT)await fs.copyFile(path.join(temporary,'mobile.png'),process.env.LOCAL_TEST_ADMIN_SCREENSHOT);
  if(authToken){await page.locator('#logout').click();await page.locator('#login-section').waitFor();assert.equal((await page.request.get(base+'/api/jobs')).status(),401);}
  await stop();await start();
  assert.equal((await (await serviceFetch(base+'/api/jobs')).json()).total,2,'History must survive server restart');
  assert.deepEqual(errors,[]);
  console.log('PASS real Web admin: HTTP assets/CSRF/origin/path checks; browser profile/preferences/feedback; Markdown upload -> real PDF download; Chromium snapshot download; mobile layout; '+(external?'external server history':'durable history after restart'));
}finally{
  if(browser)await browser.close();await stop();await fs.rm(temporary,{recursive:true,force:true});
}
