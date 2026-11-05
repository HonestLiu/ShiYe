/* Browser regression: nested scroller, initially absent selections, tall answers. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE || path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.LOCAL_EXPORT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:900,height:700}});
 await page.setContent('<style>body{margin:0}#scroll{height:400px;overflow:auto;scroll-behavior:smooth}#space{height:12000px}#window{position:sticky;top:0}article{color:rgb(20,60,120)}</style><main id="scroll"><div id="window"></div><div id="space"></div></main>');
 await page.evaluate(()=>{
  const scroller=document.querySelector('#scroll');
  const update=()=>{
   const index=scroller.scrollTop<3000?0:scroller.scrollTop<9000?1:2;
   document.querySelector('#window').innerHTML=`<article data-message-id="m${index}"><h2>Original ${index}</h2><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></article>`;
  };
  scroller.addEventListener('scroll',update);update();
  window.LocalExporter={messageRoots:()=>[...document.querySelectorAll('[data-message-id]')]};
 });
 await page.addScriptTag({content:await fs.readFile(new URL('web-snapshot.js',import.meta.url),'utf8')});
 const capture=async ids=>page.evaluate(ids=>LocalWebSnapshot.capture({messages:ids.map(id=>({turnId:id,role:'Response',markdown:'FALLBACK'})),options:{}}),ids);
 // m2 is absent initially, with >6 screens containing no selected message.
 let result=await capture(['m2']);
 assert.equal(result.fallbackCount,0);assert.equal(result.domCount,1);assert(result.html.includes('<svg'));assert(result.html.includes('rgb(20, 60, 120)'));
 assert.equal(await page.locator('#scroll').evaluate(n=>n.scrollTop),0);
 assert.equal(await page.locator('#scroll').evaluate(n=>n.style.scrollBehavior),'');
 console.log('PASS absent selection: found nested transcript scroller, crossed 30 screens, retained SVG and original color, restored scroll and styles');
 result=await capture(['m0','m1','m2']);assert.equal(result.domCount,3);assert.equal(result.fallbackCount,0);
 for(let i=0;i<3;i++)assert(result.html.includes(`Original ${i}`));
 console.log('PASS recycled DOM: captured all messages across very tall answers without stagnant-message cutoff');
 // Delayed append after first reaching the bottom, past the previous 100ms wait.
 await page.evaluate(()=>{
  const scroller=document.querySelector('#scroll');let scheduled=false;
  scroller.addEventListener('scroll',()=>{
   if(!scheduled && scroller.scrollTop>=scroller.scrollHeight-scroller.clientHeight-2){
    scheduled=true;setTimeout(()=>{const node=document.createElement('article');node.dataset.messageId='late';node.textContent='Late original';scroller.append(node);},650);
   }
  });
 });
 result=await capture(['late']);assert.equal(result.fallbackCount,0);assert(result.html.includes('Late original'));
 console.log('PASS delayed mount at bottom: waited for original DOM instead of reformatting');
}finally{await browser.close();}
