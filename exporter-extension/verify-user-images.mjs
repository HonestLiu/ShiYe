import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const dir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-user-images-'));
try{
 const page=await browser.newPage({viewport:{width:1000,height:900}});
 await page.goto('about:blank');
 const images=await page.evaluate(()=>[[900,300],[300,900]].map(([w,h])=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');for(let i=0;i<3;i++){x.fillStyle=['#ef4444','#22c55e','#3b82f6'][i];x.fillRect(w>h?i*w/3:0,w>h?0:i*h/3,w>h?w/3:w,w>h?h:h/3);}x.fillStyle='white';x.font='30px sans-serif';x.fillText('FULL IMAGE',20,50);return c.toDataURL();}));
 const html='<style>body{font:16px/1.7 system-ui;margin:0;background:white;color:#222}.turn{width:700px;margin:20px auto}.clip,button{width:80px;height:80px;overflow:hidden;border-radius:12px;padding:0}.clip img{width:80px;height:80px;object-fit:cover}</style><div data-message-id="pure" data-message-author-role="user" class="turn"><div class="clip"><button><img alt="Uploaded image" src="'+images[0]+'"></button></div></div><div data-message-id="answer" data-message-author-role="assistant" class="turn"><p>ANSWER_TEXT</p></div><div data-message-id="mixed" data-message-author-role="user" class="turn"><div class="clip"><button><img alt="Uploaded image" src="'+images[1]+'"></button></div><div class="markdown"><p>QUESTION_TEXT</p></div></div>';
 const mapping={};for(const [key,parent,id,role,parts]of [
 ['pure-node',null,'pure','user',[{content_type:'image_asset_pointer',asset_pointer:'sediment://file-1'}]],
 ['answer-node','pure-node','answer','assistant',['ANSWER_TEXT']],
 ['mixed-node','answer-node','mixed','user',[{content_type:'image_asset_pointer',asset_pointer:'sediment://file-2'},'QUESTION_TEXT']]
 ])mapping[key]={parent,message:{id,author:{role},content:{parts}}};
 await page.route('**/*',r=>{const u=r.request().url();if(u.endsWith('/api/auth/session'))return r.fulfill({json:{accessToken:'test'}});if(u.includes('/backend-api/conversation/'))return r.fulfill({json:{title:'用户图片',current_node:'mixed-node',mapping}});if(u==='https://chatgpt.com/c/images')return r.fulfill({contentType:'text/html',body:html});return r.abort();});
 await page.goto('https://chatgpt.com/c/images');for(const file of ['snapshot-adapter.js','capture.js','web-snapshot.js'])await page.addScriptTag({content:await fs.readFile(new URL(file,import.meta.url),'utf8')});
 const conversation=await page.evaluate(()=>captureConversation());assert.equal(conversation.messages.length,3);assert.equal(conversation.messages[0].role,'user');assert.match(conversation.messages[0].text,/图片 × 1/);assert.equal(conversation.messages[0].images.length,1);assert(conversation.messages[0].markdown.includes('!['));assert(conversation.messages[2].markdown.includes('QUESTION_TEXT'));assert(conversation.messages[2].markdown.includes('!['));
 const snapshot=await page.evaluate(async c=>ArchiveWebSnapshot.capture({title:'用户图片',messages:c.messages.map(m=>({...m,turnId:m.id})),options:{}}),conversation);
 assert.equal(snapshot.domCount,3);assert.equal(snapshot.warnings.length,0);await fs.writeFile(path.join(dir,'snapshot.html'),snapshot.html);
 const exported=await browser.newPage({viewport:{width:1000,height:1400}});await exported.setContent(snapshot.html);
 const report=await exported.locator('[data-local-pdf-user-image]').evaluateAll(nodes=>nodes.map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight,fit:getComputedStyle(n).objectFit})));assert.equal(report.length,2);assert(Math.abs(report[0].width/report[0].height-3)<.01);assert(Math.abs(report[1].width/report[1].height-1/3)<.01);assert(report.every(i=>i.fit==='contain'));assert.equal(await exported.locator('button').count(),0);assert.equal(await exported.locator('.clip').count(),0);assert(await exported.getByText('QUESTION_TEXT').isVisible());await exported.screenshot({path:path.join(dir,'expanded.png'),fullPage:true});
 // The API retains image-only messages even while their DOM is unmounted.
 await page.evaluate(()=>document.querySelector('[data-message-id=pure]').remove());
 const unmounted=await page.evaluate(()=>captureConversation());assert.equal(unmounted.messages.length,3);assert.equal(unmounted.messages[0].imageCount,1);assert.match(unmounted.messages[0].text,/图片/);
 await page.reload();for(const file of ['snapshot-adapter.js','capture.js','web-snapshot.js'])await page.addScriptTag({content:await fs.readFile(new URL(file,import.meta.url),'utf8')});
 // DOM-only mode remains available and retains image-only questions.
 await page.evaluate(()=>{window.fetch=async()=>{throw Error('offline');};});const dom=await page.evaluate(()=>captureConversation());assert.equal(dom.messages.length,3);assert.match(dom.messages[0].text,/图片/);
 await page.evaluate(src=>{const image=document.createElement('img');image.src=src;document.querySelector('[data-message-id=pure] button').append(image);},images[1]);
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-message-id=pure] img')].every(n=>n.complete));
 const multi=await page.evaluate(async()=>{const c=await captureConversation();const m=c.messages.find(m=>m.id==='pure');const snapshot=await ArchiveWebSnapshot.capture({messages:[m],options:{}});return {preview:m.text,count:new DOMParser().parseFromString(snapshot.html,'text/html').querySelectorAll('[data-local-pdf-user-image]').length};});assert.match(multi.preview,/图片 × 2/);assert.equal(multi.count,2);
 console.log('PASS API + DOM pure-image and mixed questions; button thumbnails retained as full-aspect figures; captions and message text preserved. Artifacts:',dir);
}finally{await browser.close();}
