// Asset requests that never settle must not trap a completed 1/1 DOM capture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage();await page.route('**/*',route=>route.abort());
 await page.setContent('<style>@font-face{font-family:Unused;src:url(https://assets.test/unused.woff2)}'+Array.from({length:8},(_,i)=>`@font-face{font-family:Slow${i};src:url(https://assets.test/slow-${i}.woff2)}`).join('')+'</style><div data-message-id="answer"><h2>完整回答</h2>'+Array.from({length:8},(_,i)=>`<span style="font-family:Slow${i},sans-serif">正文${i}</span>`).join('')+'</div>',{waitUntil:'domcontentloaded'});
 await page.evaluate(()=>{
  window.progress=[];window.fetched=[];
  window.ArchiveSnapshotAdapter={messageRoots:()=>[document.querySelector('[data-message-id]')],exportProgress:text=>progress.push(text)};
  window.ArchiveCore={request:()=>new Promise(()=>{})};
  window.fetch=async url=>{fetched.push(String(url));if(String(url).includes('slow-0'))return {ok:true,blob:()=>new Promise(()=>{})};return new Promise(()=>{});};
  // Exercise the real 20s deadline in accelerated wall time, including queued assets.
  const timer=window.setTimeout.bind(window),now=Date.now.bind(Date),base=now();
  window.setTimeout=(fn,ms,...args)=>timer(fn,Math.max(1,ms/1000),...args);
  Date.now=()=>base+(now()-base)*1000;
 });
 await page.addScriptTag({content:await fs.readFile(new URL('./web-snapshot.js',import.meta.url),'utf8')});
 const started=Date.now();const result=await page.evaluate(()=>ArchiveWebSnapshot.capture({messages:[{turnId:'answer',role:'assistant',markdown:'完整回答'}],options:{}}));
 assert(Date.now()-started<2500,'A nonsettling asset escaped the global deadline');
 assert.equal(result.domCount,1);assert(result.html.includes('正文7'));assert(result.warnings.length>0);
 const fetched=await page.evaluate(()=>fetched);assert(fetched.length>0);assert(!fetched.some(url=>url.includes('unused.woff2')),'Unselected fonts must not be fetched');
 const progress=await page.evaluate(()=>progress);assert(progress.some(p=>p.includes('1/1')));assert(progress.some(p=>p.includes('字体')));assert(progress.at(-1).includes('捕获完成'));
 const fast=await browser.newPage();await fast.route('**/*',r=>r.abort());
 await fast.setContent('<style>@font-face{font-family:KeptFont;src:url(https://assets.test/kept.woff2)}@font-face{font-family:Unused;src:url(https://assets.test/unneeded.woff2)}</style><div data-message-id="fast" style="font-family:KeptFont,sans-serif">可用字体仍应保留</div>',{waitUntil:'domcontentloaded'});
 const fontBytes=await fs.readFile(new URL('../local-pdf-server/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2',import.meta.url));
 await fast.evaluate(bytes=>{window.fetched=[];window.ArchiveSnapshotAdapter={messageRoots:()=>[document.querySelector('[data-message-id]')]};window.ArchiveCore={request:async()=>{throw Error('unexpected background fallback');}};window.fetch=async url=>{fetched.push(String(url));return new Response(Uint8Array.from(bytes),{headers:{'Content-Type':'font/woff2'}});};},[...fontBytes]);
 await fast.addScriptTag({content:await fs.readFile(new URL('./web-snapshot.js',import.meta.url),'utf8')});
 const embedded=await fast.evaluate(()=>ArchiveWebSnapshot.capture({messages:[{turnId:'fast',role:'assistant',markdown:'正文'}],options:{}}));
 assert(embedded.html.includes('data:font/woff2;base64,'));assert.equal((await fast.evaluate(()=>fetched)).length,1);
 console.log('PASS hanging font headers, hanging bodies and queued requests reach a bounded finish; unrelated fonts skipped; all selected text and phase progress retained. Timers accelerated 1000x.');
}finally{await browser.close();}
