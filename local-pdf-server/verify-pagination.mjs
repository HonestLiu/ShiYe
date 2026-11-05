import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {render,pdfOptions} from './render-webpage.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LOCAL_EXPORT_PLAYWRIGHT_MODULE||path.join(os.homedir(),'.local/lib/node_modules/rea-agents/node_modules/playwright-core'));
const executable=process.env.LOCAL_EXPORT_CHROMIUM_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pdf-pagination-'));
const swift=path.join(directory,'inspect.swift');
await fs.writeFile(swift,'import Foundation\nimport PDFKit\nimport AppKit\nlet d=PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!\nvar texts=[String]()\nfor i in 0..<d.pageCount{texts.append(d.page(at:i)!.string ?? "")}\nif CommandLine.arguments.count>2{let image=d.page(at:0)!.thumbnail(of:NSSize(width:850,height:1200),for:.mediaBox);let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!;try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[2]))}\nprint(String(data:try JSONSerialization.data(withJSONObject:["pages":d.pageCount,"texts":texts]),encoding:.utf8)!)\n');
function inspect(pdf,preview){const report=JSON.parse(execFileSync('/usr/bin/swift',['-module-cache-path','/tmp/pdf-pagination-swift-cache',swift,pdf,...(preview?[preview]:[])],{encoding:'utf8',maxBuffer:8*1024*1024}));report.texts=report.texts.map(text=>text.replace(/\s+/g,''));return report;}
const wrapper=body=>'<!doctype html><meta charset="utf-8"><style>body{margin:0;font:16px/1.6 system-ui;color:#222;background:#fff}.pdf-document{width:760px}.pdf-message pre,.pdf-message table{break-inside:avoid}td{padding:4px}</style><main class="pdf-document">'+body+'</main>';
const frozen=wrapper('<section class="pdf-message" data-role="assistant"><div style="height:16000px;min-height:16000px;overflow:hidden"><h2>冻结高度回归</h2><p>BEGIN_CONTENT 正文应只有一页。</p><div style="display:grid;grid-template-rows:6000px"><p>GRID_CONTENT</p></div><div style="height:4000px;min-height:4000px"></div><p>END_CONTENT</p></div></section>');
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:executable});
try{
 const page=await browser.newPage();await page.emulateMedia({media:'screen'});await page.setContent(frozen);
 const before=path.join(directory,'before.pdf');await page.pdf({...pdfOptions({removePageNumber:true},760),path:before});
 const original=inspect(before);assert(original.pages>5,'Fixture must reproduce unnecessary pages');
 console.log('Reproduced frozen-size bug:',original.pages,'pages,',original.texts.filter(text=>!text.trim()).length,'blank pages');
}finally{await browser.close();}
async function check(name,html,options={}){const input=path.join(directory,name+'.html'),output=path.join(directory,name+'.pdf');await fs.writeFile(input,html);const result=await render({input,output,width:760,theme:'light',options:{removePageNumber:true,...options},executable},chromium);return {result,report:inspect(output,path.join(directory,name+'.png')),input,output};}
const fixed=await check('fixed',frozen);assert.equal(fixed.report.pages,1);assert(fixed.report.texts[0].includes('END_CONTENT'));assert(fixed.report.texts[0].includes('GRID_CONTENT'));
const long=await check('long',wrapper('<section class="pdf-message"><div style="height:25000px;overflow:auto"><pre style="height:22000px;overflow:auto"><code>'+Array.from({length:160},(_,i)=>'CODE_LINE_'+String(i).padStart(3,'0')).join('\n')+'</code></pre><table style="height:12000px"><tbody style="height:12000px">'+Array.from({length:90},(_,i)=>'<tr><td>TABLE_ROW_'+String(i).padStart(3,'0')+'</td></tr>').join('')+'</tbody></table></div></section>'));
assert(long.report.pages>2&&long.report.pages<15);assert(long.report.texts.every(text=>text.trim()),'Code/table must not leave blank pages');
const text=long.report.texts.join('').replace(/\s+/g,'');for(let i=0;i<160;i++)assert(text.includes('CODE_LINE_'+String(i).padStart(3,'0')));for(let i=0;i<90;i++)assert(text.includes('TABLE_ROW_'+String(i).padStart(3,'0')));
const deliberate=await check('deliberate',wrapper('<section class="pdf-message" data-role="user"><p>PROMPT_ONE</p></section><section class="pdf-message" data-role="user" style="break-before:page"><p>PROMPT_TWO</p></section>'));
assert.equal(deliberate.report.pages,2);assert(deliberate.report.texts[0].includes('PROMPT_ONE'));assert(deliberate.report.texts[1].includes('PROMPT_TWO'));
// A raster-only page legitimately has no extractable text and must not be deleted.
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#18805d"/><circle cx="200" cy="150" r="80" fill="#d9edb3"/></svg>';
const image=await check('image-only',wrapper('<section class="pdf-message"><p>TEXT_PAGE</p></section><section class="pdf-message" style="break-before:page"><img width="400" height="300" src="data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')+'"></section>'));
assert.equal(image.report.pages,2);assert.equal(image.result.images,1);assert(image.report.texts[0].includes('TEXT_PAGE'));
// Do not collapse absolute geometry inside a diagram or a KaTeX inline stack.
const geometry=await check('geometry',wrapper('<section class="pdf-message"><div style="position:relative;width:400px;height:240px"><svg style="position:absolute;inset:0" width="400" height="240"><rect width="400" height="240" fill="#18805d"/></svg></div><p>AFTER_CHART</p><span class="katex"><span style="display:inline-block;height:40px;position:relative">MATH_GEOMETRY</span></span></section>'));
const normalized=await fs.readFile(geometry.input,'utf8');assert(normalized.includes('height:240px'));assert(geometry.report.texts.join('').includes('AFTER_CHART'));
console.log(`PASS pagination: frozen sizes → 1 page; all 160 code lines and 90 table rows retained across ${long.report.pages} pages with zero blank pages; explicit page breaks, image-only page, absolute chart and math geometry preserved. Fixtures: ${directory}`);
