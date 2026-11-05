/* Real browser: mixed identities, nested IDs, virtualized windows, API fallback. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {render} from './render-webpage.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),require=createRequire(import.meta.url);
const {chromium}=require(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE || path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const executable=process.env.LOCAL_EXPORT_CHROMIUM_EXECUTABLE || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'long-conversation-'));
const count=Number(process.env.LOCAL_TEST_MESSAGE_COUNT || 1000);
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:executable});
try{
  const page=await browser.newPage({viewport:{width:900,height:900}});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<style>body{margin:0;font:16px/1.8 system-ui;background:white;color:#171717}.message{width:760px;margin:24px auto}h2{font-size:22px}p{margin:10px 0}</style><main id="transcript"></main>');
  await page.evaluate(count=>{
    const root=document.querySelector('#transcript');
    for(let index=0;index<count;index++){
      if(index%10===0)continue; // API-only messages do not exist in the DOM.
      const marker='OUT_MSG_'+String(index).padStart(5,'0');
      const content=`<h2>${marker}</h2><p>长对话测试。保留消息顺序、中文段落和全部内容。${'可靠导出需要逐条核对，不能只保留当前窗口。'.repeat(4)}</p><p>正文结尾 ${marker}_END</p>`;
      const wrapper=document.createElement('article');
      if(index%3===0){wrapper.dataset.turnId='msg-'+index;wrapper.innerHTML='<div class="group/turn-messages message">'+content+'</div>';wrapper.outerHTML;const section=document.createElement('section');section.dataset.turnId='msg-'+index;section.append(...wrapper.childNodes);root.append(section);}
      else if(index%3===1){wrapper.dataset.chatgptSearchUnitKey='group-'+index+':assistant';wrapper.dataset.chatgptSearchMessageIds='msg-'+index;wrapper.className='message';wrapper.innerHTML=index%4===0?'<div class="group/turn-messages message">'+content+'</div>':content;root.append(wrapper);}
      else{wrapper.innerHTML=`<div class="group/turn-messages message"><div data-chatgpt-search-message-ids="msg-${index}">${content}</div></div>`;root.append(wrapper);}
    }
    window.chrome={runtime:{sendMessage:async message=>message.cmd==='local_ready'?{errcode:0}:{}},storage:{local:{get:async()=>({pdfOptions:{localTocOptInVersion:1}}),set:async()=>{}},onChanged:{addListener(){}}}};
  },count);
  await page.addScriptTag({content:await fs.readFile(path.join(here,'extension-bridge.js'),'utf8')});
  await page.evaluate(()=>LocalExporter.ready);
  await page.addScriptTag({content:await fs.readFile(path.join(here,'web-snapshot.js'),'utf8')});
  const snapshot=await page.evaluate(async count=>{
    const messages=Array.from({length:count},(_,index)=>{
      const marker='OUT_MSG_'+String(index).padStart(5,'0');
      return {turnId:'msg-'+index,role:'Response',markdown:'## '+marker+'\n\n会话补全正文，支持公式 $x^2+1$。\n\n'+marker+'_END'};
    });
    return LocalWebSnapshot.capture({title:'长对话完整性回归',messages,options:{toc:false}});
  },count);
  assert.equal(snapshot.messageCount,count);assert.equal(snapshot.fallbackCount,Math.ceil(count/10));
  if(process.env.LOCAL_TEST_LONG_BUNDLE)await fs.writeFile(process.env.LOCAL_TEST_LONG_BUNDLE,JSON.stringify({engine:'chromium',webDocument:snapshot,messages:Array.from({length:count},(_,index)=>({turnId:'msg-'+index,role:'Response'})),options:{toc:false}}));
  console.log(`Captured ${snapshot.messageCount} messages (${snapshot.domCount} DOM, ${snapshot.fallbackCount} API), ${(Buffer.byteLength(snapshot.html)/1048576).toFixed(2)} MiB snapshot`);
  for(let index=0;index<count;index++){
    const marker='OUT_MSG_'+String(index).padStart(5,'0');assert(snapshot.html.includes(marker+'_END'),marker+' missing');
    if(index)assert(snapshot.html.indexOf('OUT_MSG_'+String(index-1).padStart(5,'0'))<snapshot.html.indexOf(marker),'Message order changed');
  }
  const input=path.join(temporary,'snapshot.html'),output=process.env.LOCAL_TEST_LONG_PDF || path.join(temporary,'long.pdf');
  await fs.writeFile(input,snapshot.html);
  const result=await render({input,output,width:snapshot.width,theme:'light',options:{toc:false},executable,timeoutMs:600000},chromium);
  assert.equal(result.fallbackMessages,snapshot.fallbackCount);assert.equal(result.headings,count);
  let report;
  if(process.platform==='darwin'){
    report=JSON.parse(execFileSync('/usr/bin/swift',['-module-cache-path','/tmp/local-pdf-swift-cache',path.join(here,'tests/inspect-long-pdf.swift'),output],{encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,CLANG_MODULE_CACHE_PATH:'/tmp/local-pdf-clang-cache'}}));
    assert.equal(report.bookmarks,count);
  }else{
    report={text:execFileSync('pdftotext',[output,'-'],{encoding:'utf8',maxBuffer:64*1024*1024}),pages:Number(execFileSync('pdfinfo',[output],{encoding:'utf8'}).match(/Pages:\s+(\d+)/)[1])};
  }
  for(let index=0;index<count;index++)assert(report.text.includes('OUT_MSG_'+String(index).padStart(5,'0')+'_END'),'PDF body truncated at message '+index);
  assert(!report.text.startsWith('目录'));
  console.log(`PASS real ${count}-message PDF: ${report.pages} pages, ${result.headings} headings/bookmarks, ${snapshot.domCount} DOM + ${snapshot.fallbackCount} API messages; every final marker verified; default TOC pages off`);
  // Recycle the same small DOM window at different scroll positions.
  await page.setContent('<style>body{margin:0}.message{width:760px}#scroll{height:350px;overflow:auto}#spacer{height:2200px}</style><div id="scroll"><div id="window"></div><div id="spacer"></div></div>');
  await page.evaluate(()=>{
    const scroller=document.querySelector('#scroll');
    const update=()=>{const batch=Math.min(3,Math.floor(scroller.scrollTop/400));document.querySelector('#window').innerHTML=Array.from({length:3},(_,n)=>`<div class="message" data-message-id="virtual-${batch*3+n}" data-message-author-role="assistant"><h2>虚拟消息 ${batch*3+n}</h2></div>`).join('');};
    scroller.addEventListener('scroll',update);update();
    window.LocalExporter={messageRoots:()=>[...document.querySelectorAll('[data-message-id]')]};
  });
  await page.addScriptTag({content:await fs.readFile(path.join(here,'web-snapshot.js'),'utf8')});
  const virtual=await page.evaluate(()=>LocalWebSnapshot.capture({messages:Array.from({length:12},(_,index)=>({turnId:'virtual-'+index,role:'Response',markdown:'本条不应走补全'})),options:{}}));
  assert.equal(virtual.domCount,12);assert.equal(virtual.fallbackCount,0);
  assert.equal(await page.locator('#scroll').evaluate(node=>node.scrollTop),0,'Original scroll position must be restored');
  console.log('PASS virtualized transcript: 12 messages captured from a recycled 3-node window, no API fallback; original scroll position restored');
  await page.evaluate(()=>{const hidden=document.createElement('div');hidden.setAttribute('data-message-id','hidden-message');hidden.style.display='none';hidden.textContent='隐藏占位';document.body.append(hidden);});
  const hidden=await page.evaluate(()=>LocalWebSnapshot.capture({messages:[{turnId:'hidden-message',role:'Response',markdown:'## 隐藏节点的完整会话正文'}],options:{}}));
  assert.equal(hidden.fallbackCount,1,'Hidden stale DOM must not produce an invisible PDF message');
}finally{await browser.close();await fs.rm(temporary,{recursive:true,force:true});}
