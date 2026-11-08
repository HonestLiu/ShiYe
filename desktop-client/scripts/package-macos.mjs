import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
execFileSync('npm',['run','bundle'],{cwd:root,stdio:'inherit'});
const application=path.join(root,'src-tauri/target/release/bundle/macos/拾页.app');
// Keep proc-macro dylibs loadable during compilation; use Apple strip only on the finished app.
execFileSync('/usr/bin/strip',['-x',path.join(application,'Contents/MacOS/archive-reader')],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--force','--sign','-',path.join(application,'Contents/Resources/resources/pdf-split')],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--force','--sign','-',application],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',application],{stdio:'inherit'});
const stage=await fs.mkdtemp(path.join(os.tmpdir(),'reader-package-'));
const release=path.join(root,'releases');await fs.mkdir(release,{recursive:true});
try{
 execFileSync('/usr/bin/ditto',[path.join(root,'src-tauri/target/release/bundle/macos/拾页.app'),path.join(stage,'拾页.app')]);
 await fs.symlink('/Applications',path.join(stage,'Applications'));
 const output=path.join(release,`拾页_0.16.9_${process.arch}.dmg`);
 execFileSync('/usr/bin/hdiutil',['create','-volname','拾页','-srcfolder',stage,'-ov','-format','UDZO',output],{stdio:'inherit'});
 console.log('Installer:',output);
}finally{await fs.rm(stage,{recursive:true,force:true});}
