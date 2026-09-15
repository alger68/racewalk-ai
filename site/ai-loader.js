// UI initialization must not depend on a remote SDK import.
const SDK_VERSION='0.10.21';
let sdkAttempt=0;
const SDK_ROOT=new URL('./vendor/mediapipe/',import.meta.url);
const MODEL_URL=new URL('./models/pose_landmarker_full.task',import.meta.url);
function timeout(promise,milliseconds,label){return new Promise((resolve,reject)=>{let done=false;const timer=setTimeout(()=>{done=true;reject(new Error(`${label}逾時`));},milliseconds);Promise.resolve(promise).then(value=>{clearTimeout(timer);if(done){value?.close?.();return;}done=true;resolve(value);},error=>{clearTimeout(timer);if(!done){done=true;reject(error);}});});}
async function getModel(onStatus){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);
 try{
  const response=await fetch(MODEL_URL,{signal:controller.signal});
  if(!response.ok)throw new Error(`模型檔 HTTP ${response.status}`);
  const total=Number(response.headers.get('content-length'));
  if(!response.body?.getReader)return new Uint8Array(await response.arrayBuffer());
  const reader=response.body.getReader();const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;chunks.push(value);size+=value.length;onStatus(`AI 模型下載 ${(size/1048576).toFixed(1)} MB${total>0?` / ${(total/1048576).toFixed(1)} MB`:''}`);}
  if(size<1000000)throw new Error('模型檔不完整，請重新載入');
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
 }catch(error){if(error.name==='AbortError')throw new Error('模型下載逾時，請確認網路後重試');throw error;}finally{clearTimeout(timer);}
}
export async function createPoseEngine({onStatus=()=>{}}={}){
 if(typeof WebAssembly==='undefined')throw new Error('此瀏覽器不支援 WebAssembly');
 // Do not let the SDK choose OffscreenCanvas merely because its constructor
 // exists. Some WebKit versions cannot create a WebGL context on that canvas.
 // This canvas belongs ONLY to MediaPipe, never the 2D overlay/chart.
 const canvas=document.createElement('canvas');
 canvas.width=256;canvas.height=256;
 const gl=canvas.getContext('webgl2');
 if(!gl)throw new Error('無法建立 WebGL2 圖形環境；請使用支援 WebGL2 的瀏覽器並確認硬體加速可用');
 onStatus(`載入 AI 引擎 ${SDK_VERSION}…`);
 const sdkUrl=new URL('vision_bundle.mjs',SDK_ROOT);sdkUrl.searchParams.set('attempt',String(++sdkAttempt));
 const {FilesetResolver,PoseLandmarker}=await timeout(import(sdkUrl.href),20000,'AI 引擎載入');
 const modelAssetBuffer=await getModel(onStatus);onStatus('初始化 AI（首次載入請稍候）…');
 const vision=await timeout(FilesetResolver.forVisionTasks(new URL('wasm/',SDK_ROOT).href.replace(/\/$/,'')),20000,'WASM 載入');
 const engine=await timeout(PoseLandmarker.createFromOptions(vision,{canvas,baseOptions:{modelAssetBuffer,delegate:'CPU'},runningMode:'VIDEO',numPoses:6,minPoseDetectionConfidence:.35,minPosePresenceConfidence:.35,minTrackingConfidence:.35,outputSegmentationMasks:false}),60000,'AI 模型初始化');
 try{
  // Model construction alone does not establish inference readiness. Exercise
  // the real image-to-tensor path once before allowing the UI to say ready.
  onStatus('驗證 AI 圖形推論…');
  const probe=document.createElement('canvas');probe.width=256;probe.height=256;
  const ctx=probe.getContext('2d');ctx.fillStyle='#808080';ctx.fillRect(0,0,256,256);
  engine.detectForVideo(probe,0);
  return engine;
 }catch(error){engine.close();throw new Error(`AI 推論自檢失敗：${error.message||error}`);}
}
