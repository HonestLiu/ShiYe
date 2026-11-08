// Build with the existing signing key, preserving the installed extension's identity.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),stage=await fs.mkdtemp(path.join(os.tmpdir(),'shiye-extension-package-'));
try {
 const source=path.join(root,'exporter-extension'),key=path.join(root,'exporter-extension.pem'),copy=path.join(stage,'exporter-extension');
 await fs.access(key);await fs.cp(source,copy,{recursive:true});
 const chrome=process.env.CHROME_PACK_EXECUTABLE||path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
 execFileSync(chrome,['--user-data-dir='+path.join(stage,'profile'),'--no-first-run','--pack-extension='+copy,'--pack-extension-key='+key],{stdio:'pipe',timeout:30000});
 const output=path.join(root,'exporter-extension.crx');await fs.copyFile(copy+'.crx',output);
 const manifest=JSON.parse(await fs.readFile(path.join(source,'manifest.json'),'utf8'));console.log('Packaged extension '+manifest.version+': '+output);
}finally{await fs.rm(stage,{recursive:true,force:true});}
