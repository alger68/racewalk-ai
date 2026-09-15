const MODEL_SHA256='5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1';
async function validModel(bytes){
 if(bytes.byteLength!==9398198)return false;
 if(!globalThis.crypto?.subtle)return true;
 const hash=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('')===MODEL_SHA256;
}
async function getModel(onStatus){
 let cache=null;
 try{
  if(globalThis.isSecureContext&&globalThis.caches&&['http:','https:'].includes(MODEL_URL.protocol)){
   cache=await caches.open('racewalk-models-v1');const hit=await cache.match(MODEL_URL.href);
   if(hit){const bytes=new Uint8Array(await hit.arrayBuffer());if(await validModel(bytes)){onStatus('AI 模型：已從本機快取讀取（免重新下載）');return bytes;}await cache.delete(MODEL_URL.href);}
  }
 }catch{cache=null;}
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),180000);
 try{
  onStatus('下載 AI 模型（首次需約 9 MB；成功後嘗試保存本機快取）…');
  const response=await fetch(MODEL_URL,{signal:controller.signal});
  if(!response.ok)throw new Error(`模型檔 HTTP ${response.status}`);
  const total=Number(response.headers.get('content-length'))||9398198;let bytes;
  if(!response.body?.getReader)bytes=new Uint8Array(await response.arrayBuffer());
  else{
   const reader=response.body.getReader(),chunks=[];let size=0,lastUpdate=0;
   for(;;){const {done,value}=await reader.read();if(done)break;chunks.push(value);size+=value.length;
    if(performance.now()-lastUpdate>100||size>=total){onStatus(`AI 模型下載 ${(size/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`);lastUpdate=performance.now();}
   }
   bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  }
  if(!await validModel(bytes))throw new Error('模型檔不完整或雜湊不符；不使用損壞快取，請重試');
  try{if(cache)await cache.put(MODEL_URL.href,new Response(bytes,{headers:{'Content-Type':'application/octet-stream'}}));}catch{}
  return bytes;
 }catch(error){if(error.name==='AbortError')throw new Error('模型下載逾時，請確認網路後重試');throw error;}finally{clearTimeout(timer);}
}
