import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {save} from '@tauri-apps/plugin-dialog';
import {printDocument,cleanSnapshot} from './reader.js';
const cmd=request=>invoke('command',{request});
let busy=false;
async function drain(){
 if(busy)return;busy=true;
 try{for(;;){
  const jobs=await cmd({action:'pending_exports'});
  if(!jobs.length){const result=await cmd({action:'service_idle'});if(result.idle)return;continue;}
  const job=jobs[0];if(!(await cmd({action:'claim_export',jobId:job.jobId})).claimed)continue;
  try{
   const target=await cmd({action:'prepare_export',jobId:job.jobId});
   const path=target.path||await save({defaultPath:job.filename,filters:[{name:'PDF',extensions:['pdf']}]});
   if(!path){await cmd({action:'finish_export',jobId:job.jobId,status:'cancelled'});continue;}
   const archive=await cmd({action:'load_export',jobId:job.jobId});
   if((job.format||'pdf')==='pdf'){
    const document=await printDocument(archive,job.options||{});await invoke('print_pdf',{...document,path,jobId:job.jobId});
   }else{
    const html=cleanSnapshot(ShiyeAnchors.html(archive.snapshot.html,archive.reading));const doc=new DOMParser().parseFromString(html,'text/html');doc.querySelectorAll('style,script').forEach(n=>n.remove());doc.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,pre,blockquote,tr').forEach(n=>n.append('\n'));
    await cmd({action:'write_export',jobId:job.jobId,html,text:doc.body.textContent});
   }
   await cmd({action:'finish_export',jobId:job.jobId,status:'done',path});
  }catch(error){await cmd({action:'finish_export',jobId:job.jobId,status:'failed',error:String(error)});}
 }}finally{busy=false;}
}
await listen('library-changed',drain);
await drain();
