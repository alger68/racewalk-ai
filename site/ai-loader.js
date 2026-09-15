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
 // The WebGL canvas is owned only by MediaPipe, never by our 2D overlay.
 // Explicit HTMLCanvasElement avoids partially supported OffscreenCanvas.
 const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
 const gl=canvas.getContext('webgl2');
 if(!gl)throw new Error('無法建立 WebGL2 圖形環境；請使用支援 WebGL2 的瀏覽器並確認硬體加速可用');
 let engine=null;
 const frameCanvas=document.createElement('canvas');
 const frameContext=frameCanvas.getContext('2d',{willReadFrequently:true});
 try{
  onStatus(`載入 AI 引擎 ${SDK_VERSION}…`);
  const sdkUrl=new URL('vision_bundle.mjs',SDK_ROOT);sdkUrl.searchParams.set('attempt',String(++sdkAttempt));
  const {FilesetResolver,PoseLandmarker}=await timeout(import(sdkUrl.href),20000,'AI 引擎載入');
  const modelAssetBuffer=await getModel(onStatus);onStatus('初始化 AI（首次載入請稍候）…');
  const vision=await timeout(FilesetResolver.forVisionTasks(new URL('wasm/',SDK_ROOT).href.replace(/\/$/,'')),20000,'WASM 載入');
  engine=await timeout(PoseLandmarker.createFromOptions(vision,{canvas,baseOptions:{modelAssetBuffer,delegate:'CPU'},runningMode:'VIDEO',numPoses:6,minPoseDetectionConfidence:.35,minPosePresenceConfidence:.35,minTrackingConfidence:.35,outputSegmentationMasks:false}),60000,'AI 模型初始化');
  // Exercise real image-to-tensor processing before the UI reports ready.
  onStatus('驗證 AI 圖形推論…');
  frameCanvas.width=256;frameCanvas.height=256;
  frameContext.fillStyle='#808080';frameContext.fillRect(0,0,256,256);
  engine.detectForVideo(frameContext.getImageData(0,0,256,256),0);
  let closed=false;
  return {
   detectForVideo(source,timestamp){
    if(closed)throw new Error('AI 引擎已關閉，請重新載入');
    let input=source;
    if(source instanceof HTMLVideoElement){
     const width=source.videoWidth,height=source.videoHeight;
     if(source.readyState<2||source.seeking||!width||!height)throw new Error('影片影格尚未解碼，無法送入 AI');
     if(frameCanvas.width!==width)frameCanvas.width=width;
     if(frameCanvas.height!==height)frameCanvas.height=height;
     // WebKit can expose a stale/empty direct-video WebGL texture. Copy the
     // decoded pixels explicitly. Keep native dimensions and point coordinates.
     frameContext.drawImage(source,0,0,width,height);
     input=frameContext.getImageData(0,0,width,height);
    }
    return engine.detectForVideo(input,timestamp);
   },
   close(){if(closed)return;closed=true;try{engine.close();}finally{gl.getExtension('WEBGL_lose_context')?.loseContext();frameCanvas.width=0;frameCanvas.height=0;}}
  };
 }catch(error){
  try{engine?.close();}catch{}
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  throw error;
 }
}
