/* Actual Chromium regression: background painting must not fill divider padding. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { render } from './render-webpage.mjs';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const module = process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.local/lib/node_modules/rea-agents/node_modules/playwright-core');
const { chromium } = require(module);
const executable = process.env.LOCAL_EXPORT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const source = await fs.readFile(path.join(here, 'web-snapshot.js'), 'utf8');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'divider-regression-'));
const browser = await chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: true });

async function paintedRows(page, locator, surface) {
  const png = await locator.screenshot();
  return page.evaluate(async ({base64,surface}) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + base64; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width=img.width;canvas.height=img.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
    const values=ctx.getImageData(Math.floor(img.width/2),0,1,img.height).data;
    let count=0;
    for(let index=0;index<values.length;index+=4) if(Math.abs(values[index]-surface)>5) count++;
    return count;
  }, {base64:png.toString('base64'),surface});
}

async function capture(theme, script) {
  const page=await browser.newPage({viewport:{width:900,height:700},colorScheme:theme});
  const surface=theme==='dark'?33:255;
  const ink=theme==='dark'?'rgba(255,255,255,.15)':'rgba(0,0,0,.1)';
  await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>
  body{margin:0;background:rgb(${surface},${surface},${surface});color:${theme==='dark'?'white':'black'};font:16px/26px sans-serif}
  #message{width:760px;margin:20px auto}.Divider-__JU1b{height:var(--divider-size);box-sizing:content-box;background-clip:content-box;background-color:var(--divider-color);padding-block:8px;align-self:stretch;margin:16px 0}
  hr{height:0;border:0;border-top:1px solid ${ink};padding:0;margin:16px 0}
  </style></head><body><div id="message" data-message-id="chosen"><p>分隔线之前</p><div class="Divider-__JU1b" data-d-component="divider" style="--divider-color:${ink};--divider-size:1px"></div><p>分隔线之后</p><hr><p>标准 HR 分隔线</p></div></body></html>`);
  const original=await paintedRows(page,page.locator('[data-d-component="divider"]'),surface);
  await page.evaluate(()=>globalThis.LocalExporter={messageRoots:()=>[document.querySelector('#message')]});
  await page.addScriptTag({content:script});
  const snapshot=await page.evaluate(()=>LocalWebSnapshot.capture({title:'分隔线验证',messages:[{turnId:'chosen',role:'Response'}],options:{}}));
  await page.setContent(snapshot.html);
  const divider=page.locator('[data-d-component="divider"]');
  const geometry=await divider.evaluate(node=>({height:node.getBoundingClientRect().height,clip:getComputedStyle(node).backgroundClip,padding:getComputedStyle(node).paddingTop}));
  const actual=await paintedRows(page,divider,surface);
  const hr=await paintedRows(page,page.locator('hr'),surface);
  await page.close();
  return {original,actual,geometry,hr,snapshot};
}

try {
  const broken=await capture('light',source.replace('background-clip background-origin',''));
  assert.equal(broken.original,1);assert.equal(broken.actual,17,'Must reproduce the reported grey rectangle');
  for(const theme of ['light','dark']) {
    const fixed=await capture(theme,source);
    assert.equal(fixed.actual,1,theme+' divider should paint exactly one pixel row');
    assert.equal(fixed.geometry.height,17,'Keep spacing geometry unchanged');
    assert.equal(fixed.geometry.padding,'8px');assert.equal(fixed.geometry.clip,'content-box');
    assert.equal(fixed.hr,1,'Native HR must remain a thin rule');
    const input=path.join(temporary,theme+'.html');await fs.writeFile(input,fixed.snapshot.html);
    const output=path.join(temporary,theme+'.pdf');
    const result=await render({input,output,width:760,theme,options:{margin:'narrow',removePageNumber:true},executable},chromium);
    assert.equal(result.engine,'chromium');assert((await fs.readFile(output)).subarray(0,5).toString()==='%PDF-');
    console.log(`PASS ${theme}: broken paint 17px -> fixed paint 1px; 17px layout/8px padding retained; native HR 1px; real sandboxed Chromium PDF generated`);
  }
} finally {await browser.close();await fs.rm(temporary,{recursive:true,force:true});}
