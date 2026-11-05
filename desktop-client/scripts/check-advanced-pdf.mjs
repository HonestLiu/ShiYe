import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';import {createServer} from 'vite';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'reader-advanced-'));
const server=await createServer({root,server:{host:'127.0.0.1',port:1422,strictPort:true}});await server.listen();
const {chromium}=createRequire(import.meta.url)(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const probe=path.join(dir,'probe');execFileSync('swiftc',[path.join(root,'scripts/system-pdf-probe.swift'),'-o',probe]);
 const inspect=path.join(dir,'inspect.swift');await fs.writeFile(inspect,`import Foundation
import PDFKit
import AppKit
let d=PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!
var outline=[[String:Any]](),links=[[String:Any]]()
func walk(_ n:PDFOutline){if let t=n.label,let dest=n.destination,let p=dest.page{outline.append(["title":t,"page":d.index(for:p)])};for i in 0..<n.numberOfChildren{walk(n.child(at:i)!)}}
if let r=d.outlineRoot{walk(r)}
for i in 0..<d.pageCount{for a in d.page(at:i)!.annotations where a.type=="Link"{let dest=a.destination ?? (a.action as? PDFActionGoTo)?.destination;links.append(["from":i,"target":dest?.page.map{d.index(for:$0)} ?? -1,"url":a.url?.absoluteString ?? (a.action as? PDFActionURL)?.url?.absoluteString ?? ""])}}
let pages=(0..<d.pageCount).map{d.page(at:$0)!.string ?? ""}
let b=d.page(at:0)!.bounds(for:.mediaBox)
if CommandLine.arguments.count>2{let image=d.page(at:0)!.thumbnail(of:NSSize(width:1000,height:1300),for:.mediaBox);let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!;try! bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[2]))}
print(String(data:try! JSONSerialization.data(withJSONObject:["pages":pages,"outline":outline,"links":links,"width":b.width,"height":b.height,"title":d.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String ?? ""]),encoding:.utf8)!)`);
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1422/');
 const archive={version:1,title:'TITLE_DEFAULT',url:'https://chatgpt.com/c/source',snapshot:{width:760,html:'<!doctype html><style>body{margin:0;background:white;color:#222;font:16px/1.6 sans-serif}.pdf-document{width:760px}section{margin-bottom:24px}</style><main class="pdf-document"><section class="pdf-message" data-role="user"><h1>USER_ONE</h1><p>第一条提问</p></section><section class="pdf-message" data-role="assistant"><h2>ANSWER</h2><p>回答正文</p><pre>'+Array.from({length:24},(_,i)=>'CODE_'+i).join('\n')+'</pre></section><section class="pdf-message" data-role="user"><h1>USER_TWO</h1><p>第二条提问</p></section></main>'},messages:[{role:'user',createTime:1700000000},{role:'assistant',model:'MODELNAME',createTime:1700000000},{role:'user'}]};
 const short=await page.evaluate(async()=>{const {printDocument}=await import('/src/reader.js');return printDocument({title:'Short',snapshot:{html:'<p>Short answer</p>'}},{pageSize:'a5',pageOrient:'landscape',margin:'wide'});});
 assert.equal(short.layout.cuts.length,2,'short landscape answer must not acquire a blank viewport page');
 for(const outline of [false,true])for(const toc of [false,true]){
  const advanced=outline&&toc;
  const options={outline,toc,removePageNumber:!advanced,includeConvoLink:advanced,includeModelName:advanced,includePerMsgTime:advanced,pageBreakPerPrompt:advanced,...(advanced?{pageSize:'a5',pageOrient:'landscape',margin:'narrow',fontFamily:'serif',fontSize:125,darkMode:true,contentTitle:'CUSTOM_TITLE'}:{})};
  const document=await page.evaluate(async({archive,options})=>{const {printDocument}=await import('/src/reader.js');return printDocument(archive,options);},{archive,options});
  const name=`outline-${outline}-toc-${toc}`,input=path.join(dir,name+'.html'),layout=path.join(dir,name+'.json'),parts=path.join(dir,name),pdf=path.join(dir,name+'.pdf');await fs.mkdir(parts);await fs.writeFile(input,document.html);await fs.writeFile(layout,JSON.stringify(document.layout));
  for(let i=0;i<document.layout.cuts.length-1;i++)execFileSync(probe,[input,path.join(parts,i+'.pdf'),layout,String(document.layout.cuts[i]),String(document.layout.cuts[i+1]-document.layout.cuts[i])],{timeout:60000,maxBuffer:10*1024*1024});
  execFileSync(path.join(root,'src-tauri/resources/pdf-split'),[parts,pdf,layout],{timeout:60000});
  const report=JSON.parse(execFileSync('swift',[inspect,pdf,pdf+'.png'],{encoding:'utf8',timeout:60000}));
  report.pages=report.pages.map(text=>text.normalize('NFKC'));
  assert.equal(report.outline.length>0,outline);assert.equal(report.pages[0].includes('目录'),toc);
  assert.equal(report.links.some(l=>l.url===archive.url),advanced);
  if(toc){const targets=report.links.filter(l=>l.target>=0);assert(targets.length>=3);assert(targets.every(l=>l.target>l.from));for(const heading of document.layout.headings){const expected=document.layout.cuts.findIndex((y,i)=>i<document.layout.cuts.length-1&&heading.y<document.layout.cuts[i+1]-.1);if(outline)assert.equal(report.outline.find(h=>h.title===heading.text).page,expected);}}
  const all=report.pages.join('');for(let i=0;i<24;i++)assert(all.includes('CODE_'+i));
  assert.equal(all.includes('MODELNAME'),advanced);
  if(advanced){assert(Math.abs(report.width-595.28)<.1);assert(Math.abs(report.height-419.53)<.1);assert.equal(report.title,'CUSTOM_TITLE');assert(report.pages.some(p=>p.split('\n').some(line=>/^\d+$/.test(line.trim()))));const userOne=report.pages.findIndex(p=>p.includes('USER_ONE')&&!p.includes('目录')),userTwo=report.pages.findIndex(p=>p.includes('USER_TWO')&&!p.includes('目录'));assert(userTwo>userOne);}
  else assert(!report.pages.some(p=>p.split('\n').some(line=>/^\d+$/.test(line.trim()))));
  console.log('PASS native advanced PDF',name,report.pages.length,'pages',report.outline.length,'bookmarks',report.links.length,'links');
 }
 console.log('Artifacts:',dir);
}finally{await browser.close();await server.close();}
