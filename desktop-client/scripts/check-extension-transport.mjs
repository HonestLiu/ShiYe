import fs from 'node:fs/promises';
import vm from 'node:vm';
const repo=new URL('../../',import.meta.url);

import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
let listener,expected,offset=0;const assembled=[];
const snapshot={html:'代码与图表'.repeat(150000),fallbackCount:0};
const context={URL,TextEncoder,Uint8Array,crypto:webcrypto,AbortSignal,btoa,location:{href:'https://chatgpt.com/c/fixture'},ArchiveSnapshotAdapter:{},ArchiveWebSnapshot:{capture:async()=>snapshot},chrome:{runtime:{id:'test-extension',onMessage:{addListener(fn){listener=fn;}},sendMessage(message){assert(JSON.stringify(message).length<1024*1024);return new Promise(resolve=>listener(message,{id:'test-extension'},resolve));},async sendNativeMessage(host,req){assert.equal(host,'io.local.archive_reader');let data;
 if(req.action==='hello')data={version:1,nativePdfJobs:true,pdfOptionsVersion:1};if(req.action==='begin'){expected=req;data={upload:'test-upload'};}
 if(req.action==='chunk'){assert.equal(req.offset,offset);const bytes=Buffer.from(req.data,'base64');assert(bytes.length<=384*1024);assembled.push(bytes);offset+=bytes.length;data={offset};}
 if(req.action==='commit')data={id:'saved-item'};return {data};}}}};
vm.runInNewContext(await fs.readFile(new URL('exporter-extension/background.js',repo),'utf8'),context);
vm.runInNewContext(await fs.readFile(new URL('exporter-extension/core.js',repo),'utf8'),context);
const message={id:'selected-answer',role:'assistant',markdown:'# 中文收藏',text:'正文'};
const result=await context.ArchiveCore.saveClient({title:'会话标题',url:context.location.href},[message],{});
assert.equal(result.id,'saved-item');const bytes=Buffer.concat(assembled),archive=JSON.parse(bytes.toString());assert.equal(bytes.length,expected.size);assert.equal(archive.title,'中文收藏');assert.deepEqual(archive.messages,[message]);assert.equal(archive.snapshot.html,snapshot.html);assert.equal(Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex'),expected.sha256);assert(assembled.length>1);console.log('PASS core + background: selected-message scope, title, multi-chunk Unicode archive before extension messaging, SHA-256 and commit acknowledgment. Native API is mocked.');

assembled.length=0;offset=0;
await context.ArchiveCore.saveClient({title:'会话标题',url:context.location.href},[message],{exportRequest:{id:'job-id',filename:'网页.pdf'}});
assert.equal(JSON.parse(Buffer.concat(assembled).toString()).exportRequest.filename,'网页.pdf');
console.log('PASS browser PDF intent is carried in the chunked archive, without an HTTP PDF request.');

const native=context.chrome.runtime.sendNativeMessage;
context.chrome.runtime.sendNativeMessage=async(host,req)=>req.action==='hello'?{data:{version:1}}:native(host,req);
await assert.rejects(context.ArchiveCore.saveClient({title:'会话标题',url:context.location.href},[message],{exportRequest:{id:'job-id',filename:'网页.pdf'}}),/升级至0.2.0/);
console.log('PASS old clients are rejected with an upgrade instruction before snapshot transfer.');
