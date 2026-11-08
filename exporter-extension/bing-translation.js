// Bing's public translator webpage protocol; independently implemented, no embedded keys.
const languages=new Set(['zh-Hans','zh-Hant','en','ja','ko','fr','de','es','ru']);
let queue=Promise.resolve();
export function parseBingPage(html){
 const raw=html.match(/params_AbusePreventionHelper\s*=\s*(\[[^\]]+\])/),ig=html.match(/IG:\s*"([a-fA-F0-9]+)"/);
 if(!raw||!ig)throw Error('必应翻译暂不可用，请稍后重试');
 let values;try{values=JSON.parse(raw[1]);}catch{throw Error('必应翻译页面格式已变化');}
 if(!Number.isSafeInteger(values[0])||typeof values[1]!=='string'||!values[1]||values[1].length>4000)throw Error('必应翻译参数无效');
 return {key:String(values[0]),token:values[1],ig:ig[1],expires:Date.now()+Math.min(1200000,Math.max(1000,Number(values[2])||600000))};
}
async function bounded(url,options={},limit=2*1024*1024){
 const response=await fetch(url,{...options,credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error(response.status===429?'必应请求过于频繁，请稍后重试':'必应翻译请求失败（'+response.status+'）');
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit)throw Error('翻译服务响应过大');chunks.push(value);}}finally{await reader.cancel();}
 const output=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}return new TextDecoder().decode(output);
}
async function translate(text,to){
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(to+'\n'+text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const {translationCache=[]}=await chrome.storage.local.get('translationCache'),now=Date.now(),cached=translationCache.find(v=>v.hash===hash&&now-v.at<30*86400000);
 if(cached)return {...cached.result,cached:true};
 let {bingTranslationToken}=await chrome.storage.session.get('bingTranslationToken');
 if(!bingTranslationToken||bingTranslationToken.expires<Date.now()){bingTranslationToken=parseBingPage(await bounded('https://www.bing.com/translator'));await chrome.storage.session.set({bingTranslationToken});}
 const body=new URLSearchParams({fromLang:'auto-detect',to,text,key:bingTranslationToken.key,token:bingTranslationToken.token});
 let result;try{const data=JSON.parse(await bounded('https://www.bing.com/ttranslatev3?isVertical=1&IG='+bingTranslationToken.ig+'&IID=translator.5024.1',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()},200000));
 if(data?.statusCode||typeof data?.[0]?.translations?.[0]?.text!=='string'||!data[0].translations[0].text){await chrome.storage.session.remove('bingTranslationToken');throw Error('必应未返回译文，请稍后重试');}
 result={text:data[0].translations[0].text,to:data[0].translations[0].to,from:data[0].detectedLanguage?.language||'auto',provider:'bing-web'};
 if(result.text.length>20000)throw Error('译文过长');
 }catch(error){await chrome.storage.session.remove('bingTranslationToken');if(error instanceof SyntaxError)throw Error('必应翻译响应异常，请稍后重试');throw error;}
 await chrome.storage.local.set({translationCache:[{hash,at:now,result},...translationCache.filter(v=>v.hash!==hash&&now-v.at<30*86400000)].slice(0,80)});
 return result;
}
export function translateBing(text,to='zh-Hans'){
 if(typeof text!=='string'||!text.trim()||text.length>1000)return Promise.reject(Error('请选中 1 至 1000 个字符再翻译'));
 if(!languages.has(to))return Promise.reject(Error('不支持的目标语言'));
 const job=queue.then(()=>translate(text,to));queue=job.catch(()=>{}).then(()=>new Promise(r=>setTimeout(r,700)));return job;
}
