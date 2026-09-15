"""Diagnose the actual app with a public video fixture, without mocking inference."""
from pathlib import Path
from functools import partial
import http.server,threading,json,traceback
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results';OUT.mkdir(exist_ok=True)
class Server(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),partial(Server,directory=str(ROOT/'site')))
threading.Thread(target=server.serve_forever,daemon=True).start()
URL=f'http://127.0.0.1:{server.server_port}/'
results=[]
pixels=r'''()=>{const v=document.querySelector('#video'),c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;const x=c.getContext('2d');x.drawImage(v,0,0);const data=x.getImageData(0,0,c.width,c.height);let s=0,ss=0,n=0;for(let i=0;i<data.data.length;i+=64){s+=data.data[i];ss+=data.data[i]**2;n++;}const r=v.getBoundingClientRect();return {width:c.width,height:c.height,mean:s/n,variance:ss/n-(s/n)**2,time:v.currentTime,ready:v.readyState,seeking:v.seeking,paused:v.paused,rect:{top:r.top,bottom:r.bottom},viewport:innerHeight,source:v.currentSrc.slice(0,20),status:document.querySelector('#status').textContent};}'''
try:
 with sync_playwright() as p:
  for width,height in [(390,844),(1440,1000)]:
   browser=p.webkit.launch(headless=True);page=browser.new_page(viewport={'width':width,'height':height});row={'viewport':[width,height],'errors':[]};results.append(row)
   page.on('console',lambda m:row['errors'].append(m.text[:1000]) if m.type=='error' else None)
   try:
    page.goto(URL);page.wait_for_function("document.documentElement.dataset.appReady==='true'")
    page.set_input_files('#videoInput',str(OUT/'fixture/pose.mp4'));page.wait_for_function("document.querySelector('#video').readyState>=2")
    page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('AI 已載入')",timeout=120000)
    page.fill('#sampleFps','10');box=page.locator('#overlay').bounding_box();page.locator('#overlay').click(position={'x':box['width']/2,'y':box['height']/2})
    page.click('#analyzeBtn');page.wait_for_function("/^(分析完成|分析未完成)/.test(document.querySelector('#status').textContent)",timeout=60000)
    row['after_app']=page.evaluate(pixels)
    page.screenshot(path=str(OUT/f'webkit-app-{width}.png'),full_page=True)
    page.locator('#video').scroll_into_view_if_needed();page.wait_for_timeout(300)
    row['after_scroll']=page.evaluate(pixels)
    row['fresh_engine']=page.evaluate("""async()=>{const m=await import('./ai-loader.js?v=3.0.2');window._probeEngine=await m.createPoseEngine();return _probeEngine.detectForVideo(document.querySelector('#video'),10000).landmarks.length;}""")
    await_prime="""async()=>{const v=document.querySelector('#video');v.muted=true;v.currentTime=0;await v.play();await new Promise(r=>setTimeout(r,150));v.pause();} """
    page.evaluate(await_prime);row['after_play']=page.evaluate(pixels)
    row['after_play_poses']=page.evaluate("()=>_probeEngine.detectForVideo(document.querySelector('#video'),20000).landmarks.length")
    page.evaluate('()=>_probeEngine.close()')
    page.click('#analyzeBtn');page.wait_for_function("/^(分析完成|分析未完成)/.test(document.querySelector('#status').textContent)",timeout=60000)
    row['repeat_app']=page.evaluate(pixels)
   except Exception as e:row['failure']=str(e);row['traceback']=traceback.format_exc()
   finally:
    print('APP_DIAG',json.dumps(row),flush=True);page.close();browser.close();(OUT/'webkit-app-diagnostics.json').write_text(json.dumps(results,indent=2))
finally:
 (OUT/'webkit-app-diagnostics.json').write_text(json.dumps(results,indent=2));server.shutdown()
