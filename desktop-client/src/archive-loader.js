// Tauri's raw byte response avoids embedding multi-megabyte HTML into JS callbacks.
export async function loadArchiveBytes(invoke,id){
 const data=await invoke('load_archive_bytes',{id});
 if(!(data instanceof ArrayBuffer)&&!ArrayBuffer.isView(data)&&!Array.isArray(data))throw Error('归档读取返回了无效数据');
 const archive=JSON.parse(new TextDecoder().decode(Array.isArray(data)?new Uint8Array(data):data));
 if(archive.version!==1||typeof archive.snapshot?.html!=='string')throw Error('归档内容无效');
 return archive;
}
