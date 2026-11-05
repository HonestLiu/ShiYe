// Real packaged executable in Native Messaging mode, against an isolated IPC fixture.
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'reader-bridge-'));
const origin='chrome-extension://'+'a'.repeat(32)+'/';await fs.writeFile(path.join(root,'origins.json'),JSON.stringify([origin]));
const received=[];
const server=net.createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('data',data=>{buffer=Buffer.concat([buffer,data]);if(buffer.length<4||buffer.length<buffer.readUInt32LE()+4)return;const req=JSON.parse(buffer.subarray(4));received.push(req);const body=Buffer.from(JSON.stringify({data:{version:1,echo:req.action}})),head=Buffer.alloc(4);head.writeUInt32LE(body.length);socket.end(Buffer.concat([head,body]));});});
await new Promise(resolve=>server.listen(path.join(root,'reader.sock'),resolve));
async function run(origin,message){return new Promise((resolve,reject)=>{const exe=path.resolve('desktop-client/src-tauri/target/release/archive-reader');const p=spawn(exe,['--native-host',origin],{env:{...process.env,ARCHIVE_READER_DATA_DIR:root}});const chunks=[];p.stdout.on('data',d=>chunks.push(d));p.on('error',reject);p.on('close',code=>{try{assert.equal(code,0);const bytes=Buffer.concat(chunks);assert.equal(bytes.readUInt32LE(),bytes.length-4);resolve(JSON.parse(bytes.subarray(4)));}catch(e){reject(e);}});if(message){const b=Buffer.from(JSON.stringify(message)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);p.stdin.end(Buffer.concat([h,b]));}else p.stdin.end();});}
try{assert.equal((await run(origin,{action:'hello'})).data.echo,'hello');const before=received.length;assert.match((await run('chrome-extension://'+'b'.repeat(32)+'/',{action:'hello'})).error,/未配对/);assert.equal(received.length,before);console.log('PASS packaged native-host framing, IPC forwarding and unpaired extension rejection. Application cold start is not exercised.');}finally{server.close();await fs.rm(root,{recursive:true,force:true});}
