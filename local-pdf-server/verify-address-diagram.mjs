// Regression based on the user's saved ChatGPT page, with all page scripts disabled.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {render} from './render-webpage.mjs';
import {preparePagination} from './pdf-pagination.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const source=path.resolve(process.argv[2]||path.join(os.homedir(),'Downloads/408计组大题模板手册.html'));
const assets=path.join(path.dirname(source),path.basename(source,'.html')+'_files');
const output=await fs.mkdtemp(path.join(os.tmpdir(),'address-diagram-'));
const {chromium}=createRequire(import.meta.url)(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const executable=process.env.LOCAL_EXPORT_CHROMIUM_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:executable});
try{
 const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:1200,height:900}});
 await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith('file:')){const file=fileURLToPath(url);if(file===source||file.startsWith(assets+path.sep))return route.continue();}return route.abort();});
 const page=await context.newPage();await page.goto(pathToFileURL(source).href,{waitUntil:'load'});
 await page.evaluate(async()=>{await document.fonts.ready;});
 const sourceMetrics=await page.evaluate(()=>{
  const title=[...document.querySelectorAll('[data-d-component="text"]')].find(node=>node.textContent.trim()==='32位地址划分');
  if(!title)throw Error('未找到32位地址划分');
  const diagram=title.parentElement;diagram.id='address-diagram-regression';diagram.setAttribute('data-message-id','address-diagram');
  const row=diagram.querySelector('[data-d-component="row"][data-d-has-height]');
  const measure=node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {x:r.x,y:r.y,width:r.width,height:r.height,grow:s.flexGrow,basis:s.flexBasis,justify:s.justifyContent,background:s.backgroundColor};};
  return {row:measure(row),cells:[...row.children].map(measure)};
 });
 assert(sourceMetrics.cells[0].width>100,'Saved CSS assets must be available');
 await page.locator('#address-diagram-regression').screenshot({path:path.join(output,'source.png')});
 await page.evaluate(()=>{window.ArchiveSnapshotAdapter={messageRoots:()=>[document.querySelector('#address-diagram-regression')]};});
 await page.evaluate(await fs.readFile(path.join(root,'../exporter-extension/web-snapshot.js'),'utf8'));
 const snapshot=await page.evaluate(()=>ArchiveWebSnapshot.capture({messages:[{turnId:'address-diagram',role:'assistant',markdown:''}],options:{}}));
 await page.setContent(snapshot.html);await page.evaluate(async()=>document.fonts.ready);
 const measure=()=>{const row=document.querySelector('[data-d-component="row"][data-d-has-height]'),r=row.getBoundingClientRect();return {width:r.width,height:r.height,cells:[...row.children].map(n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n);return {x:b.x-r.x,y:b.y-r.y,width:b.width,height:b.height,grow:s.flexGrow,justify:s.justifyContent,background:s.backgroundColor};})};};
 const captured=await page.evaluate(measure);
 await page.evaluate(preparePagination,{pageHeight:1100});
 const printed=await page.evaluate(measure);
 console.log(JSON.stringify({source:sourceMetrics,captured,printed}));
 await page.locator('.pdf-message').screenshot({path:path.join(output,'printed.png')});
 for(let i=0;i<3;i++){
  assert(Math.abs(printed.cells[i].width-captured.cells[i].width)<2,'Segment width changed at index '+i);
  assert(Math.abs(printed.cells[i].height-captured.cells[i].height)<2,'Segment height changed at index '+i);
  assert.equal(printed.cells[i].justify,captured.cells[i].justify,'Vertical centering changed');
  assert.equal(printed.cells[i].background,captured.cells[i].background);
 }
 assert(Math.abs(printed.cells[0].width/printed.cells[1].width-20/6)<.1,'Tag/组号 proportion must remain 20:6');
 const input=path.join(output,'snapshot.html'),pdf=path.join(output,'diagram.pdf');await fs.writeFile(input,snapshot.html);
 await render({input,output:pdf,width:snapshot.width,theme:snapshot.theme,options:{outline:true,toc:false},executable},chromium);
 const swift=path.join(output,'preview.swift');
 await fs.writeFile(swift,'import Foundation\nimport PDFKit\nimport AppKit\nlet d=PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!\nlet image=d.page(at:0)!.thumbnail(of:NSSize(width:1100,height:1550),for:.mediaBox)\nlet bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!\ntry bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[2]))\nprint(d.string ?? "")\n');
 const pdfText=execFileSync('/usr/bin/swift',['-module-cache-path','/tmp/address-diagram-swift-cache',swift,pdf,path.join(output,'pdf.png')],{encoding:'utf8'}).replace(/\s+/g,'');
 for(const word of ['Tag','20位','组号','块内'])assert(pdfText.includes(word),'PDF lost label '+word);
 console.log('PASS saved ChatGPT address diagram: 20:6:6 segment widths, 58px height, centered labels and colors preserved through snapshot and pagination. Artifacts: '+output);
}finally{await browser.close();}
