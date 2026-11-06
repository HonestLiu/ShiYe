import assert from 'node:assert/strict';import {loadArchiveBytes} from '../src/archive-loader.js';
const archive={version:1,title:'中文归档',snapshot:{html:'<h1>数学 ∑</h1>'}},bytes=new TextEncoder().encode(JSON.stringify(archive));
for(const data of [bytes,bytes.buffer,Array.from(bytes)])assert.deepEqual(await loadArchiveBytes(async(command,args)=>{assert.equal(command,'load_archive_bytes');assert.equal(args.id,'one');return data;},'one'),archive);
await assert.rejects(loadArchiveBytes(async()=>({}),'one'),/无效数据/);await assert.rejects(loadArchiveBytes(async()=>new TextEncoder().encode('{}'),'one'),/内容无效/);await assert.rejects(loadArchiveBytes(async()=>{throw Error('读取失败');},'one'),/读取失败/);
console.log('PASS raw archive IPC: Unicode ArrayBuffer/typed-array decoding, validation and read-error propagation');
