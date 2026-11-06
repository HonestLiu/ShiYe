// Frontend integration in real Chromium, with the native command transport mocked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {chromium}=createRequire(import.meta.url)(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:1320,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!=='https://reader.test')return route.abort();const file=path.join(root,'dist',u.pathname==='/'?'index.html':u.pathname);return route.fulfill({body:await fs.readFile(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});});
 await page.addInitScript(()=>{
  window.testItems=[{id:'fixture-1',title:'计组复习手册',url:'https://chatgpt.com/c/fixture',savedAt:1780000000,summary:'中文正文与地址划分',starred:false,read:false,trashed:false,folder:'',tags:'',notes:'',progress:0}];window.calls=[];window.testJobs=[];window.cancelSave=false;window.failPrint=false;
  window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback(){},invoke:async(command,args)=>{
   calls.push({command,args});if(command==='plugin:event|listen')return 1;
   if(command==='plugin:dialog|save')return cancelSave?null:'/tmp/browser-export.pdf';
   if(command==='print_pdf'){if(failPrint)throw Error('native rendering failed');return {ok:true};}
   if(command==='command'){const r=args.request;if(r.action==='pending_exports')return structuredClone(testJobs.filter(j=>j.status==='queued'));
    if(r.action==='claim_export'){const j=testJobs.find(j=>j.jobId===r.jobId);if(j?.status==='queued'){j.status='processing';return {claimed:true};}return {claimed:false};}
    if(r.action==='finish_export'){Object.assign(testJobs.find(j=>j.jobId===r.jobId),r);return r;}
    if(r.action==='info')return {dataDir:'/tmp/reader-test',nativePdf:true};if(r.action==='list')return structuredClone(testItems);if(r.action==='search')return testItems.filter(i=>(i.title+i.summary+i.notes+i.tags).includes(r.query)).map(i=>i.id);
    if(r.action==='load')return {version:1,title:'计组复习手册',source:'chatgpt',url:'https://chatgpt.com/c/fixture',snapshot:{width:760,html:'<!doctype html><html><head><style>body{font:16px/1.8 sans-serif;background:white}#chart{display:flex;width:500px;height:80px}#chart span:first-child{flex:20;background:#dbeafe}#chart span:last-child{flex:6;background:#d1fae5}</style></head><body><h1>计组地址划分</h1><p>中文正文与地址划分</p><div id="chart"><span>Tag 20 位</span><span>组号 6 位</span></div><h2>代码</h2><pre><code>first line\nlast line</code></pre><script>parent.window.snapshotExecuted=true<\/script><a href="javascript:alert(1)" onclick="alert(1)">unsafe</a><img src="https://external.test/pixel"></body></html>'},messages:[{role:'assistant',text:'中文正文与地址划分',markdown:'# 计组地址划分'}]};
    if(r.action==='update'){Object.assign(testItems.find(i=>i.id===r.id),r.patch);return {ok:true};}
   }return {};
  }};
 });
 await page.goto('https://reader.test/');await page.getByRole('heading',{name:'计组复习手册',exact:true}).click();
 await page.frameLocator('#frame').getByRole('heading',{name:'计组地址划分',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.snapshotExecuted),undefined);
 const secure=await page.locator('#frame').evaluate(frame=>({scripts:frame.contentDocument.scripts.length,src:frame.contentDocument.querySelector('img').getAttribute('src'),href:frame.contentDocument.querySelector('a').getAttribute('href'),ratio:frame.contentDocument.querySelector('#chart span:first-child').getBoundingClientRect().width/frame.contentDocument.querySelector('#chart span:last-child').getBoundingClientRect().width}));
 assert.equal(secure.scripts,0);assert.equal(secure.src,null);assert.equal(secure.href,null);assert(Math.abs(secure.ratio-20/6)<.05);
 assert.equal(await page.locator('#toc button').count(),2);
 await page.getByRole('button',{name:'切换星标'}).click();await page.waitForFunction(()=>testItems[0].starred);
 await page.getByRole('button',{name:'整理',exact:true}).click();await page.locator('#edit-folder').fill('408');await page.locator('#edit-tags').fill('计组,地址');await page.locator('#edit-notes').fill('考前复习');await page.locator('#edit-form').getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>testItems[0].folder),'408');
 await page.locator('#search').fill('考前复习');await page.waitForFunction(()=>document.querySelector('#list-count').textContent==='1 条收藏');
 await page.locator('#search').fill('不匹配内容');await page.getByText('没有找到匹配内容').waitFor();await page.locator('#search').fill('');await page.locator('.item').waitFor();
 await page.getByRole('button',{name:'标为已读',exact:true}).click();await page.getByRole('button',{name:'标为未读',exact:true}).waitFor();
 await page.screenshot({path:path.join(root,'preview.png')});
 await page.getByRole('button',{name:'移到回收站'}).click();await page.getByRole('button',{name:'恢复收藏'}).waitFor();await page.getByRole('button',{name:'回收站',exact:true}).click();assert.equal(await page.locator('.item').count(),1);await page.getByRole('button',{name:'恢复收藏'}).click();
 await page.getByRole('button',{name:'设置',exact:false}).click();
 await page.waitForFunction(()=>calls.some(c=>c.args?.request?.action==='open_settings'));
 assert.deepEqual(errors,[]);console.log('PASS reading UI: snapshot CSS/diagram and headings, blocked scripts/network, Chinese search, tags/folder/notes, read/star/trash/restore. Native transport is mocked.');
}finally{await browser.close();}
