import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const server=await createServer({root,server:{host:'127.0.0.1',port:1421,strictPort:true}});await server.listen();
const {chromium}=createRequire(import.meta.url)(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-system-pdf-'));
try{
 execFileSync('swiftc',[path.join(root,'scripts/system-pdf-probe.swift'),'-o',path.join(dir,'probe')]);
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1421/');
 const fixtures={code:'<!doctype html><style>body{font:16px/1.7 sans-serif;margin:0}.pdf-document{width:760px}pre{white-space:pre}</style><main class="pdf-document"><section class="pdf-message"><h1>完整代码测试</h1><div style="display:inline-block;max-height:80px;overflow:auto"><pre>'+Array.from({length:120},(_,i)=>'CODE_'+i).join('\n')+'</pre></div><p>AFTER_CODE</p></section></main>',diagram:'<!doctype html><style>body{font:16px/1.7 sans-serif;margin:0}.pdf-document{width:760px}</style><main class="pdf-document"><section class="pdf-message">'+Array.from({length:22},(_,i)=>'<p>LEADING_'+i+'</p>').join('')+'<div data-d-component="box" data-d-has-border style="display:flex;flex-direction:column;border:1px solid #888;padding:12px;gap:8px"><p>FIGURE_BEGIN</p>'+Array.from({length:4},(_,i)=>'<div data-d-component="row" data-d-has-height style="display:flex;height:160px"><div style="flex:20;background:#dbeafe">TAG_'+i+'</div><div style="flex:6;background:#d1fae5">INDEX_'+i+'</div></div>').join('')+'<p>FIGURE_END</p></div><p>AFTER_FIGURE</p></section></main>'};
 fixtures.tail='<!doctype html><style>body{margin:0;font:16px/1.7 sans-serif}.pdf-document{width:760px}</style><main class="pdf-document"><section class="pdf-message"><p>END_OF_VISIBLE_CONTENT</p><span class="katex"><span aria-hidden="true">FORMULA_VISIBLE</span></span><svg width="150" height="40"><rect width="150" height="40" fill="green"/></svg><h4 class="sr-only" style="position:absolute;top:25000px;left:0;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"><span>HIDDEN_SPEAKER_LABEL</span></h4><div hidden style="position:absolute;top:35000px">HIDDEN_UI</div></section></main>';
 const noted=process.argv[3]?JSON.parse(await fs.readFile(process.argv[3],'utf8')):null;if(noted)fixtures.noted=noted.snapshot.html;
 const captured=process.argv[4]?JSON.parse(await fs.readFile(process.argv[4],'utf8')):null;if(captured)fixtures.captured=captured.snapshot.html;
 if(process.argv[2])fixtures.saved=await fs.readFile(process.argv[2],'utf8');
 for(const darkMode of [false,true]){
  const surfaces=await page.evaluate(async darkMode=>{
   const {printDocument}=await import('/src/reader.js');
   const html='<section class="pdf-message"><div data-code-block="true" style="background:#f3f3f3;background-image:linear-gradient(rgba(0,0,0,.05),rgba(0,0,0,.05))"><div data-markdown-copy="exclude" style="background:#f3f3f3;background-image:linear-gradient(rgba(0,0,0,.05),rgba(0,0,0,.05))">C</div><pre>CODE_END</pre></div><div id="diagram" style="background-image:linear-gradient(red,blue)">DIAGRAM</div></section>';
   const result=await printDocument({snapshot:{html}},{darkMode});
   const doc=new DOMParser().parseFromString(result.html,'text/html');
   return {surfaces:[...doc.querySelectorAll('[data-code-block],[data-markdown-copy=exclude]')].map(n=>({image:n.style.backgroundImage,color:n.style.backgroundColor})),diagram:doc.getElementById('diagram').style.backgroundImage};
  },darkMode);
  for(const surface of surfaces.surfaces){assert.equal(surface.image,'none');assert.equal(surface.color,darkMode?'rgb(30, 35, 34)':'rgb(242, 242, 242)');}
  assert(surfaces.diagram.includes('linear-gradient'));
 }
 console.log('PASS code toolbar flat overlays in light/dark; genuine diagram gradients preserved');
 for(const [name,html] of Object.entries(fixtures)){
  const document=await page.evaluate(async({html,noted})=>{const {printDocument}=await import('/src/reader.js');return printDocument(noted||{source:html.includes('data-shiye-offline')?'webpage':'chatgpt',snapshot:{html,width:760}});},{html,noted:name==='noted'?noted:name==='captured'?captured:null});
  const input=path.join(dir,name+'.html'),layout=path.join(dir,name+'.json'),continuous=path.join(dir,name+'-continuous.pdf'),pdf=path.join(dir,name+'.pdf');
  await fs.writeFile(input,document.html);await fs.writeFile(layout,JSON.stringify(document.layout));
  const parts=path.join(dir,name+'-parts');await fs.mkdir(parts);
  for(let i=0;i<document.layout.cuts.length-1;i++){
   const start=document.layout.cuts[i],size=document.layout.cuts[i+1]-start;
   const part=path.join(parts,i+'.pdf');
   execFileSync(path.join(dir,'probe'),[input,part,layout,String(start),String(size)],{encoding:'utf8',timeout:60000,maxBuffer:10*1024*1024});
  }
  execFileSync(path.join(root,'src-tauri/resources/pdf-split'),[parts,pdf,layout],{timeout:60000});
  const inspect=path.join(dir,'inspect.swift');await fs.writeFile(inspect,'import Foundation\nimport PDFKit\nlet d=PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!\nprint(String(data:try! JSONSerialization.data(withJSONObject:(0..<d.pageCount).map{d.page(at:$0)!.string ?? ""}),encoding:.utf8)!)');
  const pages=JSON.parse(execFileSync('swift',[inspect,pdf],{encoding:'utf8',timeout:60000})).map(t=>t.replace(/\s/g,''));
  if(['code','diagram'].includes(name))assert(pages.length>1);assert(pages.every(t=>t.length>0));
  if(name==='code'){for(let i=0;i<120;i++)assert(pages.join('').includes('CODE_'+i));assert(pages.join('').includes('AFTER_CODE'));assert.equal(pages.filter(p=>p.includes('CODE_119')).length,1);}
  else if(name==='diagram'){const index=pages.findIndex(p=>p.includes('FIGURE_BEGIN'));assert(index>0);assert(pages[index].includes('FIGURE_END'));assert(pages[index].includes('INDEX_3'));assert(pages.join('').includes('AFTER_FIGURE'));}
  else if(name==='tail'){assert.equal(pages.length,1);assert(pages[0].includes('END_OF_VISIBLE_CONTENT'));assert(pages[0].includes('FORMULA_VISIBLE'));assert(!pages.join('').includes('HIDDEN_SPEAKER_LABEL'));assert(!document.html.includes('HIDDEN_UI'));}
  else if(name==='captured'){assert(pages.join('').replace(/_/g,'').includes('ARTICLEENDPROOF'));assert(pages.join('').replace(/_/g,'').includes('KEEPCOMMENT'));}
  else if(name==='noted'){assert(pages.join('').replace(/_/g,'').includes('PAGENOTEPROOF'));assert(pages.join('').includes('跨段落批注'));assert(document.html.includes('data-shiye-highlight'));}
  else{assert(pages.join('').length>0);if(html.includes('data-shiye-offline'))for(const label of ['FRAME_OFFLINE_TEXT','SHADOW_OFFLINE_TEXT','END_OF_PAGE','FONT_OFFLINE_123'])assert(pages.join('').includes(label),'offline webpage PDF must retain '+label);}
  console.log('PASS WKWebView vector PDF + CoreGraphics A4 pagination:',name,pages.length,'pages');
 }
 console.log('Artifacts:',dir);
}finally{await browser.close();await server.close();}
