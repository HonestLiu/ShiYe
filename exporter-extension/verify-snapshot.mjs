// Capture with the new extension, then run the actual existing service renderer.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {render} from '../local-pdf-server/render-webpage.mjs';
const root=path.dirname(new URL(import.meta.url).pathname);
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const executable=process.env.LOCAL_EXPORT_CHROMIUM_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output=await fs.mkdtemp(path.join(os.tmpdir(),'archive-pdf-regression-'));
const fallback='# 已排版的补全回答\n\nFALLBACK_RENDERED 正文与 **加粗**。\n\n行内公式 $x^2+1$。\n\n\\[\n\\int_0^1 x\\,dx=\\frac12\n\\]\n\n| 项目 | 数值 |\n|---|---|\n| 表格内容 | 42 |\n\n```js\nconst formula = "$x$";\n```\n\nFALLBACK_END';
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:executable});
try{
 const page=await browser.newPage({viewport:{width:1000,height:800}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{
  const url=route.request().url();
  if(url.endsWith('/api/auth/session'))return route.fulfill({json:{accessToken:'fixture-only'}});
  if(url.endsWith('/backend-api/conversation/fixture'))return route.fulfill({json:{title:'原貌与补全回归',current_node:'node-c',mapping:{'node-a':{id:'node-a',parent:null,message:{id:'msg-a',author:{role:'user'},content:{parts:['请说明原貌导出']}}},'node-b':{id:'node-b',parent:'node-a',message:{id:'msg-b',author:{role:'assistant'},content:{parts:['## API 中的回答\n\n网页应优先使用已渲染内容。']}}},'node-c':{id:'node-c',parent:'node-b',message:{id:'msg-c',author:{role:'assistant'},content:{parts:[fallback]}}}}}});
  if(url==='https://chatgpt.com/c/fixture')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;font:16px/1.7 system-ui;background:#fff;color:#222}.group\\/turn-messages,.message{width:700px;margin:20px auto}h2{font-size:26px;color:#146b59}p{margin:12px 0}svg{width:160px;height:70px}</style></head><body><section data-turn-id="node-a" data-turn="user"><div class="group/turn-messages"><p>请说明原貌导出</p></div></section><article class="message" data-chatgpt-search-unit-key="answer:assistant" data-chatgpt-search-message-ids="[&quot;msg-b&quot;]"><h2>网页中的已渲染回答</h2><p><strong>保留网页样式</strong> DOM_RENDERED</p><svg viewBox="0 0 160 70"><rect x="2" y="2" width="150" height="60" rx="8" fill="#18805d"/><text x="20" y="40" fill="#fff">SVG 图示</text></svg></article></body></html>'});
  return route.abort();
 });
 await page.goto('https://chatgpt.com/c/fixture');
 await page.evaluate(()=>{window.calls=[];window.supportsFallback=true;window.chrome={runtime:{sendMessage:async message=>{calls.push(message);if(message.path==='/health')return {data:{supportsMarkdownFallback:supportsFallback}};return {data:{jobId:'a'.repeat(32),server:'http://127.0.0.1:8765'}};}}};});
 for(const file of ['snapshot-adapter.js','capture.js','core.js','web-snapshot.js'])await page.addScriptTag({content:await fs.readFile(path.join(root,file),'utf8')});
 const conversation=await page.evaluate(()=>captureConversation());
 assert.equal(conversation.messages.length,3);assert(conversation.messages[0].messageIds.includes('node-a'));
 await page.evaluate(()=>{document.querySelector('article p').append(' FRESH_DOM');});
 const payload=await page.evaluate(async conversation=>{await ArchiveCore.createPdf(conversation,conversation.messages,{...ArchiveCore.defaults,engine:'chromium',contentTitle:'原貌回归'},{confirmFallback:()=>true});return calls.find(c=>c.path==='/api/pdf/v1').body.payload;},conversation);
 assert.equal(payload.webDocument.domCount,2);assert.equal(payload.webDocument.fallbackCount,1);
 assert(payload.webDocument.html.includes('FRESH_DOM'),'Must recapture the page at export time');
 assert(payload.webDocument.html.includes('data-local-pdf-markdown="true"'),'Missing server Markdown renderer marker');
 assert(payload.webDocument.html.includes('font-size:26px'),'DOM heading typography must remain frozen');
 assert(payload.webDocument.html.includes('<svg'));
 // An older service must never silently print the fallback source.
 await page.evaluate(()=>{supportsFallback=false;calls=[];});
 const oldService=await page.evaluate(async conversation=>{try{await ArchiveCore.createPdf(conversation,conversation.messages,{...ArchiveCore.defaults,engine:'chromium'});return '';}catch(error){return error.message;}},conversation);
 assert(oldService.includes('不支持'));assert.equal(await page.evaluate(()=>calls.filter(c=>c.path==='/api/pdf/v1').length),0);
 await page.evaluate(()=>{supportsFallback=true;calls=[];});
 const cancelled=await page.evaluate(async conversation=>{try{await ArchiveCore.createPdf(conversation,conversation.messages,{...ArchiveCore.defaults,engine:'chromium'},{confirmFallback:()=>false});return '';}catch(error){return error.message;}},conversation);
 assert(cancelled.includes('已取消'));assert.equal(await page.evaluate(()=>calls.filter(c=>c.path==='/api/pdf/v1').length),0);
 const bundle=path.join(output,'payload.json');await fs.writeFile(bundle,JSON.stringify(payload));
 const input=path.join(output,'document.html'),pdf=path.join(output,'document.pdf');
 // Exercise the same HTML sanitizer as the HTTP create handler.
 const prepared=JSON.parse(execFileSync('python3',['-c',"import sys,json;sys.path.insert(0,sys.argv[1]);import chromium_renderer;print(json.dumps(chromium_renderer.prepare_document(json.load(open(sys.argv[2])))))",path.resolve(root,'../local-pdf-server'),bundle],{encoding:'utf8',maxBuffer:16*1024*1024}));
 await fs.writeFile(input,prepared.html);
 const rendered=await render({input,output:pdf,width:prepared.width,theme:prepared.theme,options:{toc:false},executable},chromium);
 assert.equal(rendered.fallbackMessages,1);
 const html=await fs.readFile(input,'utf8');
 assert(/<table\b/.test(html));assert(html.includes('class="katex'));assert(html.includes('<h1')&&html.includes('已排版的补全回答'));
 assert(!html.includes('data-local-pdf-markdown="true"><pre>'));
 assert(html.includes('const formula = "$x$";'),'Code fences must remain code');
 // Inspect actual PDF text and render page one using macOS PDFKit.
 const swift=path.join(output,'inspect.swift'),preview=path.join(output,'page.png');
 await fs.writeFile(swift,'import Foundation\nimport PDFKit\nimport AppKit\nlet d=PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!\nlet image=d.page(at:0)!.thumbnail(of:NSSize(width:1000,height:1400),for:.mediaBox)\nlet bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!\ntry bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[2]))\nprint(String(data:try JSONSerialization.data(withJSONObject:["pages":d.pageCount,"text":d.string ?? ""]),encoding:.utf8)!)\n');
 const report=JSON.parse(execFileSync('/usr/bin/swift',['-module-cache-path','/tmp/archive-pdf-swift-cache',swift,pdf,preview],{encoding:'utf8',maxBuffer:8*1024*1024}));
 const compactText=report.text.replace(/\s+/g,'');assert(compactText.includes('FRESH_DOM'));assert(compactText.includes('FALLBACK_END'));assert(!report.text.includes('## '));assert(!report.text.includes('```'));assert(!report.text.includes('\\frac'));
 console.log(`PASS actual service PDF: DOM styling + SVG retained, Markdown headings/table/math rendered, code preserved; ${report.pages} pages. PDF: ${pdf}; preview: ${preview}`);
 // Recover messages from a recycled DOM window, restoring the original viewport.
 await page.setContent('<meta charset="utf-8"><style>body{margin:0}#scroll{height:300px;overflow:auto}.message{width:700px}</style><div id="scroll"><div id="window"></div><div style="height:2000px"></div></div>');
 await page.evaluate(()=>{const scroller=document.querySelector('#scroll');const update=()=>{const batch=Math.min(3,Math.floor(scroller.scrollTop/350));document.querySelector('#window').innerHTML=Array.from({length:2},(_,n)=>`<div class="message" data-message-id="virtual-${batch*2+n}" data-message-author-role="assistant"><h2>虚拟消息 ${batch*2+n}</h2></div>`).join('');};scroller.addEventListener('scroll',update);update();});
 const virtual=await page.evaluate(()=>ArchiveWebSnapshot.capture({messages:Array.from({length:8},(_,i)=>({turnId:'virtual-'+i,role:'assistant',markdown:'不应补全'})),options:{}}));
 assert.equal(virtual.domCount,8);assert.equal(virtual.fallbackCount,0);assert.equal(await page.locator('#scroll').evaluate(n=>n.scrollTop),0);
 assert.deepEqual(errors,[]);
 console.log('PASS current/grouped/ancestor IDs, fresh capture, virtual scroll recovery, original scroll restoration, old-server rejection and fallback cancellation. ChatGPT data is a fixture; PDF renderer is the actual server implementation.');
}finally{await browser.close();}
