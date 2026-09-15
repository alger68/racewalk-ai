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
function bounds(pose){
 const points=[11,12,23,24,25,26,27,28].map(i=>pose[i]).filter(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&(p.visibility??1)>=.35);
 if(points.length<3)return null;
 const x1=Math.min(...points.map(p=>p.x)),y1=Math.min(...points.map(p=>p.y)),x2=Math.max(...points.map(p=>p.x)),y2=Math.max(...points.map(p=>p.y));
 return {x1,y1,x2,y2,cx:(x1+x2)/2,cy:(y1+y2)/2,area:Math.max(0,(x2-x1)*(y2-y1)),score:points.reduce((s,p)=>s+(p.visibility??1),0)/points.length};
}
function duplicate(a,b){
 const intersection=Math.max(0,Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1))*Math.max(0,Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1));
 return intersection/Math.max(1e-9,a.area+b.area-intersection)>.55&&Math.hypot(a.cx-b.cx,a.cy-b.cy)<.08;
}
export async function createPoseEngine({onStatus=()=>{}}={}){
 if(typeof WebAssembly==='undefined')throw new Error('此瀏覽器不支援 WebAssembly');
 const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
 const gl=canvas.getContext('webgl2');
 if(!gl)throw new Error('無法建立 WebGL2 圖形環境；請確認瀏覽器的硬體加速可用');
 let engine=null;
 const frameCanvas=document.createElement('canvas');
 const frameContext=frameCanvas.getContext('2d',{willReadFrequently:true});
 try{
  onStatus(`載入 AI 引擎 ${SDK_VERSION}…`);
  const sdkUrl=new URL('vision_bundle.mjs',SDK_ROOT);sdkUrl.searchParams.set('attempt',String(++sdkAttempt));
  const {FilesetResolver,PoseLandmarker}=await timeout(import(sdkUrl.href),20000,'AI 引擎載入');
  const modelAssetBuffer=await getModel(onStatus);onStatus('初始化 AI（首次載入請稍候）…');
  const vision=await timeout(FilesetResolver.forVisionTasks(new URL('wasm/',SDK_ROOT).href.replace(/\/$/,'')),20000,'WASM 載入');
  engine=await timeout(PoseLandmarker.createFromOptions(vision,{canvas,baseOptions:{modelAssetBuffer,delegate:'CPU'},runningMode:'IMAGE',numPoses:6,minPoseDetectionConfidence:.35,minPosePresenceConfidence:.35,minTrackingConfidence:.35,outputSegmentationMasks:false}),60000,'AI 模型初始化');
  onStatus('驗證 AI 圖形推論…');frameCanvas.width=256;frameCanvas.height=256;frameContext.fillStyle='#808080';frameContext.fillRect(0,0,256,256);engine.detect(frameContext.getImageData(0,0,256,256));
  let closed=false,expectedPeople=0,currentSource=null,explicitRoiMode=false;
  function inferFull(input){return engine.detect(input);}
  return {
   inferenceMode:'IMAGE-per-frame',
   detectForVideo(source,timestamp,options={}){
    if(closed)throw new Error('AI 引擎已關閉，請重新載入');
    if(!Number.isFinite(timestamp)||timestamp<0)throw new Error('無效的影格時間');
    let input=source;const isVideo=source instanceof HTMLVideoElement;
    if(isVideo){
     if(source.currentSrc!==currentSource){currentSource=source.currentSrc;expectedPeople=0;explicitRoiMode=false;}
     const width=source.videoWidth,height=source.videoHeight;
     if(source.readyState<2||source.seeking||!width||!height)throw new Error('影片影格尚未解碼，無法送入 AI');
     if(frameCanvas.width!==width)frameCanvas.width=width;if(frameCanvas.height!==height)frameCanvas.height=height;
     frameContext.drawImage(source,0,0,width,height);input=frameContext.getImageData(0,0,width,height);
    }
    if(isVideo&&options.region){
     explicitRoiMode=true;
     const b=options.region,width=input.width,height=input.height;
     const x=Math.max(0,Math.floor(b.x1*width)),y=Math.max(0,Math.floor(b.y1*height));
     const w=Math.min(width-x,Math.ceil((b.x2-b.x1)*width)),h=Math.min(height-y,Math.ceil((b.y2-b.y1)*height));
     if(!(w>=12&&h>=20))throw new Error('指定框太小或超出影片範圍，請重新框住整位選手');
     const result=engine.detect(frameContext.getImageData(x,y,w,h));
     const landmarks=(result.landmarks||[]).map(pose=>pose.map(p=>({...p,x:(x+p.x*w)/width,y:(y+p.y*h)/height,z:(p.z??0)*w/width,visibility:p.x<0||p.x>1||p.y<0||p.y>1?0:(p.visibility??1)})));
     return {landmarks,worldLandmarks:[],segmentationMasks:[],scanMode:'explicit-user-region'};
    }
    const full=inferFull(input);
    const number=full.landmarks?.length||0;
    // A nonempty result is not proof that the selected person was detected.
    // Recheck a partial candidate list; explicit ROI selection enables the slower
    // multi-scale path for this video. No identity is inferred from the count.
    const rescan=explicitRoiMode||number===0||number<expectedPeople;
    expectedPeople=Math.max(expectedPeople,number);
    if(!isVideo||!rescan||input.width<720||input.height<480)return full;
    const width=input.width,height=input.height,candidates=[];
    for(const pose of full.landmarks||[]){const box=bounds(pose);if(box)candidates.push({pose,box});}
    for(const [fx,fy] of [[0,0],[.38,0],[0,.38],[.38,.38]]){
     const x=Math.floor(fx*width),y=Math.floor(fy*height),w=Math.min(width-x,Math.ceil(width*.62)),h=Math.min(height-y,Math.ceil(height*.62));
     const result=engine.detect(frameContext.getImageData(x,y,w,h));
     for(const pose of result.landmarks||[]){const mapped=pose.map(p=>({...p,x:(x+p.x*w)/width,y:(y+p.y*h)/height,z:(p.z??0)*w/width,visibility:p.x<0||p.x>1||p.y<0||p.y>1?0:(p.visibility??1)}));const box=bounds(mapped);if(box&&box.area>0)candidates.push({pose:mapped,box});}
    }
    candidates.sort((a,b)=>b.box.score-a.box.score);const selected=[];
    for(const candidate of candidates){if(!selected.some(other=>duplicate(candidate.box,other.box)))selected.push(candidate);if(selected.length===6)break;}
    expectedPeople=Math.max(expectedPeople,selected.length);
    return {landmarks:selected.map(c=>c.pose),worldLandmarks:[],segmentationMasks:[],scanMode:'tiled-candidate-recovery'};
   },
   close(){if(closed)return;closed=true;try{engine.close();}finally{gl.getExtension('WEBGL_lose_context')?.loseContext();frameCanvas.width=0;frameCanvas.height=0;}}
  };
 }catch(error){try{engine?.close();}catch{}gl.getExtension('WEBGL_lose_context')?.loseContext();throw error;}
}
