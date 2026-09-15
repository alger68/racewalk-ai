"""Real model inference and failure recovery; public repeated-image fixture, not gait accuracy."""
from pathlib import Path
from functools import partial
from urllib.parse import urlsplit
import http.server,threading,subprocess,urllib.request,json,os,traceback
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results';OUT.mkdir(exist_ok=True)
FIX=OUT/'fixture';FIX.mkdir(exist_ok=True)
SAMPLE='https://storage.googleapis.com/mediapipe-assets/pose.jpg'
with urllib.request.urlopen(SAMPLE,timeout=60) as response:(FIX/'pose.jpg').write_bytes(response.read())
subprocess.run(['ffmpeg','-y','-loglevel','error','-loop','1','-i',str(FIX/'pose.jpg'),'-vf','scale=640:-2','-t','0.6','-r','30','-c:v','libx264','-pix_fmt','yuv420p',str(FIX/'pose.mp4')],check=True)
subprocess.run(['ffmpeg','-y','-loglevel','error','-i',str(FIX/'pose.mp4'),'-c','copy',str(FIX/'pose.mov')],check=True)
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT/'site')))
threading.Thread(target=server.serve_forever,daemon=True).start()
URL=os.environ.get('TEST_BASE_URL',f'http://127.0.0.1:{server.server_port}/')
origin=urlsplit(URL).netloc
results={'sample':SAMPLE,'fixture':'0.6-second repeated image; H.264 MP4 and MOV, not the user video','checks':[],'console_errors':[]}
def record(name,**values):
 results['checks'].append({'name':name,**values});print('BROWSER_CHECK',name,json.dumps(values,ensure_ascii=False),flush=True)
def open_page(browser,**kwargs):
 page=browser.new_page(**kwargs);page.set_default_timeout(20000);errors=[];external=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('console',lambda m:results['console_errors'].append(m.text[:800]) if m.type=='error' else None)
 page.on('request',lambda req:external.append(req.url) if urlsplit(req.url).scheme in ('http','https') and urlsplit(req.url).netloc!=origin else None)
 page.expose_function('rwTestSnapshot',lambda value:results.update(last_ui=value))
 page.add_init_script("""window.addEventListener('DOMContentLoaded',()=>{
 const snapshot=()=>window.rwTestSnapshot({status:document.querySelector('#status')?.textContent,media:document.querySelector('#mediaStatus')?.textContent,badge:document.querySelector('#engineBadge')?.textContent}).catch(()=>{});
 for(const id of ['status','mediaStatus','engineBadge']){const e=document.getElementById(id);if(e)new MutationObserver(snapshot).observe(e,{childList:true,subtree:true,characterData:true});}snapshot();
 });""")
 return page,errors,external
def wait_ai(page):
 page.wait_for_function("/AI 已載入|AI 載入失敗/.test(document.querySelector('#engineBadge').textContent)",timeout=120000)
 assert 'AI 已載入' in page.inner_text('#engineBadge'),page.inner_text('#status')
def select_target(page):
 box=page.locator('#overlay').bounding_box();assert box
 page.locator('#overlay').click(position={'x':box['width']/2,'y':box['height']/2})
def analyze(page):
 expect(page.locator('#analyzeBtn')).to_be_enabled();page.click('#analyzeBtn')
 page.wait_for_function("/^(分析完成|分析未完成)/.test(document.querySelector('#status').textContent)",timeout=45000)
 assert page.inner_text('#status').startswith('分析完成'),page.inner_text('#status')
def report(page):
 page.click('[data-tab=report]')
 with page.expect_download() as d:page.click('#exportJson')
 return json.loads(Path(d.value.path()).read_text())
try:
 with sync_playwright() as p:
  for name in ('chromium','webkit'):
   options={'headless':True}
   if name=='chromium':options['args']=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
   browser=getattr(p,name).launch(**options)
   viewport={'width':1440,'height':1000} if name=='chromium' else {'width':390,'height':844}
   page,errors,external=open_page(browser,viewport=viewport)
   page.goto(URL,wait_until='domcontentloaded');page.wait_for_function("document.documentElement.dataset.appReady==='true'")
   assert page.input_value('#date')
   page.set_input_files('#videoInput',str(FIX/'pose.mp4'));page.wait_for_function("document.querySelector('#video').readyState>=2")
   wait_ai(page);page.fill('#sampleFps','10');select_target(page);analyze(page)
   data=report(page)
   assert data['engine']=='rw-3.0.2-bootstrap-fix'
   assert data['summary']['frames']>=5
   assert data['summary']['maxPeople']>=1 and data['summary']['trackedFrames']>=1
   assert any((f.get('metrics',{}).get('leftKnee') or {}).get('value') is not None for f in data['frames'])
   record(name+'_real_inference',passed=True,frames=data['summary']['frames'],people=data['summary']['maxPeople'],tracked=data['summary']['trackedFrames'])
   page.click('[data-tab=analyze]');page.click('#manualToggle')
   box=page.locator('#overlay').bounding_box();page.locator('#overlay').click(position={'x':box['width']*.5,'y':box['height']*.55})
   corrected=report(page);assert corrected['summary']['manualCorrections']==1 and corrected['frames']!=data['frames']
   page.click('[data-tab=analyze]');page.click('#manualToggle')
   page.set_input_files('#videoInput',str(FIX/'pose.mov'));page.wait_for_function("document.querySelector('#video').readyState>=2")
   select_target(page);analyze(page);record(name+'_mov_repeat_and_manual_edit',passed=True)
   page.screenshot(path=str(OUT/f'{name}-inference.png'),full_page=True)
   assert not errors,errors;assert not external,external
   record(name+'_no_external_runtime_requests',passed=True);page.close()
   page,errors,external=open_page(browser,viewport=viewport)
   pattern='**/vendor/mediapipe/vision_bundle.mjs*'
   def reject_sdk(route):route.fulfill(status=503,content_type='text/plain',body='injected SDK failure')
   page.route(pattern,reject_sdk);page.goto(URL,wait_until='domcontentloaded')
   page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('AI 載入失敗')")
   assert page.input_value('#date')
   page.set_input_files('#videoInput',str(FIX/'pose.mp4'));page.wait_for_function("document.querySelector('#video').readyState>=2")
   page.click('[data-tab=guide]');expect(page.locator('#guide')).to_be_visible();page.click('[data-tab=analyze]')
   expect(page.locator('#initAi')).to_be_enabled();page.unroute(pattern,reject_sdk);page.click('#initAi');wait_ai(page)
   assert not errors,errors;record(name+'_failed_sdk_video_and_retry',passed=True)
   page.set_input_files('#videoInput',{'name':'broken.mov','mimeType':'video/quicktime','buffer':b'not a video'})
   page.wait_for_function("document.querySelector('#mediaStatus').dataset.error==='true'");expect(page.locator('#analyzeBtn')).to_be_disabled()
   record(name+'_bad_video_error',passed=True);page.close();browser.close()
except Exception as e:
 results['failure']=str(e);results['traceback']=traceback.format_exc();raise
finally:
 (OUT/'browser-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n');server.shutdown()
