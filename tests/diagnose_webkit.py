"""Diagnose real WebKit/Chromium inference with a public fixture; no mocked model."""
from pathlib import Path
from functools import partial
import http.server,threading,json,traceback
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results';OUT.mkdir(exist_ok=True)
class Server(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def translate_path(self,path):
  if path.split('?')[0].startswith('/__fixtures__/'):
   return str(OUT/'fixture'/Path(path.split('?')[0]).name)
  return super().translate_path(path)
 def do_GET(self):
  if self.path.startswith('/__probe__'):
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(b'<!doctype html><body>Inference diagnostics</body>');return
  super().do_GET()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),partial(Server,directory=str(ROOT/'site')))
threading.Thread(target=server.serve_forever,daemon=True).start()
URL=f'http://127.0.0.1:{server.server_port}'
results=[]
js=r'''async ({delegate,nosimd})=>{
 const out={delegate,nosimd};let engine;
 try{
  const {FilesetResolver,PoseLandmarker}=await import('/vendor/mediapipe/vision_bundle.mjs');
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
  const gl=canvas.getContext('webgl2');out.webgl2=!!gl;
  if(gl){const ext=gl.getExtension('WEBGL_debug_renderer_info');out.renderer=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}
  out.offscreen=typeof OffscreenCanvas!=='undefined';
  if(out.offscreen)out.offscreenWebgl2=!!new OffscreenCanvas(16,16).getContext('webgl2');
  const vision=nosimd?{wasmLoaderPath:'/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js',wasmBinaryPath:'/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm'}:await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  const bytes=new Uint8Array(await (await fetch('/models/pose_landmarker_full.task')).arrayBuffer());
  engine=await PoseLandmarker.createFromOptions(vision,{canvas,baseOptions:{modelAssetBuffer:bytes,delegate},runningMode:'IMAGE',numPoses:6,minPoseDetectionConfidence:.35,minPosePresenceConfidence:.35,minTrackingConfidence:.35});
  const image=new Image();image.src='/__fixtures__/pose.jpg';await image.decode();
  const copy=document.createElement('canvas');const ctx=copy.getContext('2d',{willReadFrequently:true});
  function pixels(source,w,h){copy.width=w;copy.height=h;ctx.drawImage(source,0,0,w,h);return ctx.getImageData(0,0,w,h);}
  function stats(data){let sum=0,sq=0,n=0;for(let i=0;i<data.data.length;i+=64){const v=data.data[i];sum+=v;sq+=v*v;n++;}return {width:data.width,height:data.height,mean:sum/n,variance:sq/n-(sum/n)**2};}
  const id=pixels(image,image.naturalWidth,image.naturalHeight);out.imagePixels=stats(id);
  out.imageElementPoses=engine.detect(image).landmarks.length;
  out.imageDataPoses=engine.detect(id).landmarks.length;
  const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';document.body.append(video);video.src='/__fixtures__/pose.mp4';
  await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('video decode'));setTimeout(()=>reject(Error('video decode timeout')),10000);video.load();});
  const vd=pixels(video,video.videoWidth,video.videoHeight);out.videoPixels=stats(vd);
  out.videoImageDataPoses=engine.detect(vd).landmarks.length;
  out.videoElementPoses=engine.detect(video).landmarks.length;
  return out;
 }catch(e){out.error=String(e);out.stack=e.stack;return out;}
 finally{try{engine?.close();}catch{}}
}'''
try:
 with sync_playwright() as p:
  for browser_name in ('chromium','webkit'):
   opts={'headless':True}
   if browser_name=='chromium':opts['args']=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
   browser=getattr(p,browser_name).launch(**opts)
   for delegate,nosimd in [('CPU',False),('CPU',True),('GPU',False)]:
    page=browser.new_page();errors=[]
    page.on('console',lambda m:errors.append(m.text[:1500]) if m.type=='error' else None)
    try:
     page.goto(URL+'/__probe__');r=page.evaluate(js,{'delegate':delegate,'nosimd':nosimd});r['browser']=browser_name;r['errors']=errors
     results.append(r);print('INFERENCE_DIAG',json.dumps(r),flush=True)
    except Exception as e:results.append({'browser':browser_name,'delegate':delegate,'nosimd':nosimd,'error':str(e)})
    finally:page.close();(OUT/'webkit-diagnostics.json').write_text(json.dumps(results,indent=2))
   browser.close()
finally:
 (OUT/'webkit-diagnostics.json').write_text(json.dumps(results,indent=2));server.shutdown()
