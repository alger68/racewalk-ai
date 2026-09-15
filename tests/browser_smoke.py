"""Real inference and analysis-entry regression tests; no private user footage.
Fixtures repeat one public image, so these tests do not measure gait or identity accuracy.
"""
from pathlib import Path
from functools import partial
from urllib.parse import urlsplit
import http.server, threading, subprocess, urllib.request, json, os, traceback
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results';OUT.mkdir(exist_ok=True)
FIX=OUT/'fixture';FIX.mkdir(exist_ok=True)
SAMPLE='https://storage.googleapis.com/mediapipe-assets/pose.jpg'
with urllib.request.urlopen(SAMPLE,timeout=60) as response:(FIX/'pose.jpg').write_bytes(response.read())
def ff(args):subprocess.run(['ffmpeg','-y','-loglevel','error',*args],check=True)
ff(['-loop','1','-i',str(FIX/'pose.jpg'),'-vf','scale=1280:-2','-t','0.6','-r','30','-c:v','libx264','-pix_fmt','yuv420p',str(FIX/'pose.mp4')])
ff(['-i',str(FIX/'pose.mp4'),'-c','copy',str(FIX/'pose.mov')])
ff(['-f','lavfi','-i','color=gray:s=640x360:r=30','-t','0.6','-c:v','libx264','-pix_fmt','yuv420p',str(FIX/'blank.mp4')])
# Four tiled copies of a public photo exercise the multi-person UI, not race walking.
ff(['-loop','1','-i',str(FIX/'pose.jpg'),'-filter_complex','[0:v]scale=640:-2,split=4[a][b][c][d];[a][b]hstack[top];[c][d]hstack[bottom];[top][bottom]vstack[out]','-map','[out]','-t','0.6','-r','30','-c:v','libx264','-pix_fmt','yuv420p',str(FIX/'four.mp4')])
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT/'site')))
threading.Thread(target=server.serve_forever,daemon=True).start()
URL=os.environ.get('TEST_BASE_URL',f'http://127.0.0.1:{server.server_port}/')
origin=urlsplit(URL).netloc
results={'version':'3.0.3','sample':SAMPLE,'fixture':'Repeated public pose image in MP4/MOV and four-tile collage; NOT user video or gait accuracy validation','checks':[]}
def record(name,**values):
 results['checks'].append({'name':name,**values});print('BROWSER_CHECK',name,json.dumps(values,ensure_ascii=False),flush=True)
def open_page(browser,viewport):
 page=browser.new_page(viewport=viewport);page.set_default_timeout(20000);errors=[];external=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('request',lambda req:external.append(req.url) if urlsplit(req.url).scheme in ('http','https') and urlsplit(req.url).netloc!=origin else None)
 page.expose_function('rwTestSnapshot',lambda v:results.update(last_ui=v))
 page.add_init_script("""window.addEventListener('DOMContentLoaded',()=>{
 const snapshot=()=>window.rwTestSnapshot({status:document.querySelector('#status')?.textContent,media:document.querySelector('#mediaStatus')?.textContent,badge:document.querySelector('#engineBadge')?.textContent,phase:document.documentElement.dataset.analysisPhase}).catch(()=>{});
 for(const id of ['status','mediaStatus','engineBadge']){const e=document.getElementById(id);if(e)new MutationObserver(snapshot).observe(e,{childList:true,subtree:true});}snapshot();});""")
 return page,errors,external
def wait_ai(page):
 page.wait_for_function("/AI 已載入|AI 載入失敗/.test(document.querySelector('#engineBadge').textContent)",timeout=120000)
 assert 'AI 已載入' in page.inner_text('#engineBadge'),page.inner_text('#status')
def load(page,name):
 page.set_input_files('#videoInput',str(FIX/name));page.wait_for_function("document.querySelector('#video').readyState>=2")
 page.fill('#sampleFps','10')
def select_target(page):
 box=page.locator('#overlay').bounding_box();assert box
 page.locator('#overlay').click(position={'x':box['width']/2,'y':box['height']/2})
def wait_finish(page):
 page.wait_for_function("['complete','error','no-result','no-person','select-target'].includes(document.documentElement.dataset.analysisPhase)",timeout=60000)
 assert page.evaluate('document.documentElement.dataset.analysisPhase')=='complete',page.inner_text('#status')
def report(page):
 page.click('[data-tab=report]')
 with page.expect_download() as d:page.click('#exportJson')
 data=json.loads(Path(d.value.path()).read_text());page.click('[data-tab=analyze]');return data
try:
 with sync_playwright() as p:
  for name in ('chromium','webkit'):
   opts={'headless':True}
   if name=='chromium':opts['args']=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
   browser=getattr(p,name).launch(**opts)
   viewport={'width':1440,'height':1000} if name=='chromium' else {'width':390,'height':844}
   page,errors,external=open_page(browser,viewport)
   page.goto(URL,wait_until='domcontentloaded');page.wait_for_function("document.documentElement.dataset.appReady==='true'");wait_ai(page)
   assert page.input_value('#date')
   page.click('#startHereBtn');assert '[NO_VIDEO]' in page.inner_text('#status')
   record(name+'_missing_video_explained',passed=True)
   # The old version silently disabled analysis here. No coordinate click is used.
   load(page,'pose.mp4');expect(page.locator('#analyzeBtn')).to_be_enabled()
   page.click('#startHereBtn');wait_finish(page);data=report(page)
   assert data['engine']=='rw-3.0.3-analysis-flow'
   assert data['summary']['frames']>=5 and data['summary']['trackedFrames']>=1
   assert any((f.get('metrics',{}).get('leftKnee') or {}).get('value') is not None for f in data['frames'])
   record(name+'_no_preselected_target_real_inference',passed=True,frames=data['summary']['frames'],tracked=data['summary']['trackedFrames'])
   page.click('#manualToggle');box=page.locator('#overlay').bounding_box();page.locator('#overlay').click(position={'x':box['width']*.5,'y':box['height']*.55})
   corrected=report(page);assert corrected['summary']['manualCorrections']==1 and corrected['frames']!=data['frames']
   page.click('#manualToggle');load(page,'pose.mov');select_target(page);page.click('#analyzeBtn');wait_finish(page)
   record(name+'_mov_repeat_manual_and_export',passed=True)
   load(page,'four.mp4');page.click('#scanPeopleBtn')
   page.wait_for_function("document.documentElement.dataset.analysisPhase==='select-target'",timeout=60000)
   candidates=page.locator('.person-choice').count();assert candidates>=2,{'candidates':candidates,'status':page.inner_text('#status')}
   page.screenshot(path=str(OUT/f'{name}-people-selection.png'),full_page=True)
   page.locator('.person-choice').nth(1).click();wait_finish(page);multi=report(page)
   assert multi['summary']['trackedFrames']>=1
   record(name+'_multi_person_explicit_choice',passed=True,detected=candidates,tracked=multi['summary']['trackedFrames'])
   page.screenshot(path=str(OUT/f'{name}-inference.png'),full_page=True)
   load(page,'blank.mp4');page.click('#startHereBtn')
   page.wait_for_function("document.documentElement.dataset.analysisPhase==='no-person'",timeout=60000)
   assert '分析完成' not in page.inner_text('#status');record(name+'_no_person_not_reported_as_success',passed=True)
   with page.expect_download() as d:page.click('#diagnosticBtn')
   diag=json.loads(Path(d.value.path()).read_text());assert diag['engine']=='rw-3.0.3-analysis-flow';assert 'frames' in diag['analysis']
   assert not any(k in diag for k in ['landmarks','athlete','video','image'])
   record(name+'_diagnostic_export_without_video',passed=True)
   page.set_input_files('#videoInput',{'name':'broken.mov','mimeType':'video/quicktime','buffer':b'not a video'})
   page.wait_for_function("document.querySelector('#mediaStatus').dataset.error==='true'")
   page.click('#startHereBtn');page.wait_for_function("document.documentElement.dataset.analysisPhase==='error'")
   assert '[MEDIA]' in page.inner_text('#status');record(name+'_bad_video_is_actionable',passed=True)
   assert not errors,errors;assert not external,external;record(name+'_no_external_runtime_requests',passed=True);page.close()
   # Failure injection is separate from the real-inference assertions above.
   page,errors,external=open_page(browser,viewport);pattern='**/vendor/mediapipe/vision_bundle.mjs*'
   def reject_sdk(route):route.fulfill(status=503,content_type='text/plain',body='injected SDK failure')
   page.route(pattern,reject_sdk);page.goto(URL,wait_until='domcontentloaded')
   page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('AI 載入失敗')")
   load(page,'pose.mp4');page.click('[data-tab=guide]');expect(page.locator('#guide')).to_be_visible();page.click('[data-tab=analyze]')
   page.unroute(pattern,reject_sdk);page.click('#initAi');wait_ai(page);record(name+'_failed_sdk_video_and_retry',passed=True);page.close()
   page,errors,external=open_page(browser,viewport)
   loader=(ROOT/'site/ai-loader.js').read_text();assert 'return engine.detect(input);' in loader
   fail_loader=loader.replace('return engine.detect(input);',"throw new Error('TEST_INJECTED_INFERENCE_FAILURE');")
   page.route('**/ai-loader.js*',lambda route:route.fulfill(status=200,content_type='application/javascript',body=fail_loader))
   page.goto(URL,wait_until='domcontentloaded');wait_ai(page);load(page,'pose.mp4');page.click('#startHereBtn')
   page.wait_for_function("document.documentElement.dataset.analysisPhase==='error'")
   assert 'AI 推論失敗' in page.inner_text('#engineBadge');assert 'TEST_INJECTED' in page.inner_text('#status')
   expect(page.locator('#initAi')).to_be_enabled();expect(page.locator('#startHereBtn')).to_be_enabled()
   record(name+'_inference_error_clears_ready_and_unlocks',passed=True)
   assert not errors,errors;page.close();browser.close()
except Exception as e:
 results['failure']=str(e);results['traceback']=traceback.format_exc();raise
finally:
 (OUT/'browser-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n');server.shutdown()
