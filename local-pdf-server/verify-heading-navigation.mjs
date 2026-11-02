import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { render } from './render-webpage.mjs';
import { addHeadingNavigation } from './web-heading-navigation.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE || path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const here=path.dirname(fileURLToPath(import.meta.url));
const executable=process.env.LOCAL_EXPORT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'pdf-heading-nav-'));
const input=path.join(temporary,'fixture.html');
await fs.writeFile(input,`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
body{font:16px/1.7 system-ui,sans-serif;color:#202b34;margin:0}.pdf-document{width:760px}h1{font-size:28px}h2{font-size:22px}h3{font-size:18px}.chapter{break-before:page}.sr-only{position:absolute;width:1px;height:1px;clip:rect(0,0,0,0);overflow:hidden}
</style></head><body><main class="pdf-document"><section class="pdf-message" data-role="Prompt"><h1>用户标题不进入目录</h1></section><section class="pdf-message" data-role="Response">
<h4 class="sr-only">隐藏的角色标签</h4><h1 id="overview">总览</h1><p>本例验证一级、二级、三级标题，以及重复标题的独立跳转。</p><h2 id="duplicate">准备</h2><p>第一处准备内容。</p><h2 class="chapter">步骤</h2><p>新的章节在另一页。</p><h3>细节</h3><p>步骤下面的三级标题。</p><h2 id="duplicate" class="chapter">准备</h2><p>同名标题，属于另一处内容。</p><div role="heading" aria-level="3">扩展</div><p><strong>加粗正文不视为标题</strong></p><pre><h2>代码内容不进入目录</h2></pre><h2 style="display:none">隐藏标题</h2>
</section></main></body></html>`);
const titles=['总览','准备','步骤','细节','准备','扩展'];
const browser=await chromium.launch({executablePath:executable,headless:true,chromiumSandbox:true});
try {
  const page=await browser.newPage();await page.setContent(await fs.readFile(input,'utf8'));
  const nav=await page.evaluate(addHeadingNavigation,{toc:true});assert.equal(nav.headings,6);assert.equal(nav.tocEntries,6);
  const ids=await page.locator('[data-pdf-toc] a').evaluateAll(nodes=>nodes.map(node=>decodeURIComponent(node.getAttribute('href').slice(1))));
  assert.equal(new Set(ids).size,6);assert.equal(ids[0],'overview');
  assert.deepEqual(await page.locator('[data-pdf-toc] a').allTextContents(),titles);
  assert.equal(await page.locator('[data-pdf-toc] ol ol ol').count(),2);
  await page.evaluate(addHeadingNavigation,{toc:true});assert.equal(await page.locator('[data-pdf-toc]').count(),1);
  const defaults=await page.evaluate(addHeadingNavigation);
  assert.equal(defaults.headings,6);assert.equal(defaults.tocEntries,0);
  assert.equal(await page.locator('[data-pdf-toc]').count(),0,'Default must not insert a catalogue page');
}finally{await browser.close()}
try {
  for(const toc of [undefined,true,false]) {
    const output=path.join(temporary,toc?'with-toc.pdf':'bookmarks-only.pdf');
    const result=await render({input,output,width:760,theme:'light',options:{toc,margin:'normal',removePageNumber:false},executable},chromium);
    assert.equal(result.headings,6);assert.equal(result.tocEntries,toc?6:0);
    const report=JSON.parse(execFileSync('/usr/bin/swift',['-module-cache-path','/tmp/local-pdf-swift-cache',path.join(here,'tests/inspect-navigation.swift'),output],{encoding:'utf8',env:{...process.env,CLANG_MODULE_CACHE_PATH:'/tmp/local-pdf-clang-cache'}}));
    if(process.env.DEBUG_PDF_NAV) console.log(JSON.stringify(report));
    assert.deepEqual(report.outline.map(item=>item.title),titles,'PDF bookmark titles must match visible response headings');
    assert(report.outline[3].depth>report.outline[2].depth,'Third-level heading must nest below second-level heading');
    assert.equal(report.links.length,toc?6:0,'The printed catalogue must contain actual PDF links');
    if(toc) {
      for(let index=0;index<titles.length;index++) {
        assert(report.links[index].target>0,'Link must jump into body pages, not open a URL or point back to the catalogue');
        assert(report.links[index].text.includes(titles[index]));
        assert.equal(report.links[index].url,'');
      }
      assert.notEqual(report.links[1].target,report.links[4].target,'Duplicate heading names need distinct destinations');
    }
    console.log(`PASS real PDF toc=${toc}: 6 hierarchical bookmarks; ${report.links.length} internal links with valid body destinations; hidden/user/code headings excluded; duplicate titles isolated`);
  }
}finally{await fs.rm(temporary,{recursive:true,force:true})}
