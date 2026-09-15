"""Real-model selection + tracking guard regression. Public repeated photo, NOT racewalk identity accuracy."""
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
def ff(args):subprocess.run(['ffmpeg','-y','-loglevel','error',*args],check=True)
ff(['-loop','1','-i',str(FIX/'pose.jpg'),'-vf','scale=1280:-2','-t','0.6','-r','30','-c:v','libx264','-pix_fmt','yuv420p',str(FIX/'pose.mp4')])
ff(['-i',str(FIX/'pose.mp4'),'-c','copy',str(FIX/'pose.mov')])
ff(['-f','lavfi','-i','color=gray:s=640x360:r=30','-t','0.6','-c:v','libx264','-pix_fmt','yuv420p',str(FIX/'blank.mp4')])
ff(['-loop','1','-i',str(FIX/'pose.jpg'),'-filter_complex','[0:v]scale=640:-2,split=4[a][b][c][d];[a][b]hstack[top];[c][d]hstack[bottom];[top][bottom]vstack[out]','-map','[out]','-t','0.6','-r','30','-c:v','libx264','-pix_fmt','yuv420p',str(FIX/'four.mp4')])
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT/'site')))
threading.Thread(target=server.serve_forever,daemon=True).start()
URL=os.environ.get('TEST_BASE_URL',f'http://127.0.0.1:{server.server_port}/')
origin=urlsplit(URL).netloc
results={'version':'3.0.4','sample':SAMPLE,'fixture':'Repeated public pose image, 4-tile collage, injected missing detections. NOT user video; NOT identity or gait accuracy validation.','checks':[]}
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
def phase(page):return page.evaluate('document.documentElement.dataset.analysisPhase')
def wait_phase(page,wanted,timeout=60000):
 page.wait_for_function('wanted=>wanted.includes(document.documentElement.dataset.analysisPhase)',arg=wanted,timeout=timeout)
def wait_ai(page):
 page.wait_for_function("/AI 已載入|AI 載入失敗/.test(document.querySelector('#engineBadge').textContent)",timeout=120000)
 assert 'AI 已載入' in page.inner_text('#engineBadge'),page.inner_text('#status')
def load(page,name):
 page.set_input_files('#videoInput',str(FIX/name));page.wait_for_function("document.querySelector('#video').readyState>=2")
 page.fill('#sampleFps','10')
def scan(page):
 page.click('#scanPeopleBtn');wait_phase(page,['select-target','no-person','no-selected-person','error']);assert page.locator('.person-choice').count()>0,page.inner_text('#status')
def choose(page,n=0):
 choice=page.locator('.person-choice').nth(n)
 original_index=int(choice.get_attribute('data-person-index'))
 anchor=(float(choice.get_attribute('data-center-x')),float(choice.get_attribute('data-center-y')))
 choice.click();assert phase(page)=='confirm-target'
 page.click('#startHereBtn');assert phase(page)=='confirm-target','Start must not bypass explicit confirmation'
 page.click('#confirmTargetBtn');assert phase(page)=='target-confirmed'
 return original_index,anchor
def run(page):
 page.click('#startHereBtn');wait_phase(page,['complete','error','target-paused','no-result'])
 assert phase(page)=='complete',page.inner_text('#status')
def report(page):
 page.click('[data-tab=report]')
 with page.expect_download() as d:page.click('#exportJson')
 data=json.loads(Path(d.value.path()).read_text());page.click('[data-tab=analyze]');return data
def verify_target(data,index,anchor):
 assert data['engine']=='rw-3.0.4-target-lock'
 assert data['targetSelection']['index']==index
 assert data['summary']['trackedFrames']>=5,data['summary']
 assert data['trackingStop'] is None,data['trackingStop']
 lm=data['frames'][0]['landmarks']
 center=(sum(lm[i]['x'] for i in [11,12,23,24])/4,sum(lm[i]['y'] for i in [11,12,23,24])/4)
 assert abs(center[0]-anchor[0])<.025 and abs(center[1]-anchor[1])<.025,(center,anchor)
 assert all(f['targetId']==data['targetSelection']['id'] for f in data['frames'])
 assert any((f.get('metrics',{}).get('leftKnee') or {}).get('value') is not None for f in data['frames'])
 return center
try:
 with sync_playwright() as p:
  for name in ('chromium','webkit'):
   opts={'headless':True}
   if name=='chromium':opts['args']=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
   browser=getattr(p,name).launch(**opts)
   viewport={'width':1440,'height':1000} if name=='chromium' else {'width':390,'height':844}
   page,errors,external=open_page(browser,viewport)
   page.goto(URL,wait_until='domcontentloaded');page.wait_for_function("document.documentElement.dataset.appReady==='true'");wait_ai(page)
   page.click('#startHereBtn');assert '[NO_VIDEO]' in page.inner_text('#status')
   load(page,'pose.mp4');scan(page)
   assert phase(page)=='select-target','One detected person must not automatically become the target'
   idx,anchor=choose(page);run(page);data=report(page);verify_target(data,idx,anchor)
   record(name+'_real_single_pose_requires_confirmation',passed=True,frames=data['summary']['frames'])
   page.click('#manualToggle');box=page.locator('#overlay').bounding_box();page.locator('#overlay').click(position={'x':box['width']*.5,'y':box['height']*.55})
   corrected=report(page);assert corrected['summary']['manualCorrections']==1 and corrected['frames']!=data['frames']
   page.click('#manualToggle');load(page,'pose.mov');scan(page);idx,anchor=choose(page);run(page);verify_target(report(page),idx,anchor)
   record(name+'_mov_manual_edit_and_repeat',passed=True)
   # Force selection of a NON-FIRST detection and verify the actual reported coordinates.
   load(page,'four.mp4');scan(page);count=page.locator('.person-choice').count();assert count>=4,count
   idx,anchor=choose(page,count-1);page.screenshot(path=str(OUT/f'{name}-target-confirmed.png'),full_page=True)
   run(page);data=report(page);center=verify_target(data,idx,anchor);assert idx!=0
   record(name+'_real_four_people_nonfirst_locked',passed=True,chosen_index=idx,confirmed_center=anchor,reported_center=center,frames=data['summary']['frames'])
   # Reselect a different person at a new frame. Older report provenance must not be relabeled.
   page.click('#clearTargetBtn');old=report(page);assert old['targetSelection']==data['targetSelection']
   page.evaluate("document.querySelector('#video').currentTime=0")
   page.wait_for_function("!document.querySelector('#video').seeking")
   scan(page);idx2,anchor2=choose(page,0);run(page);new=report(page);verify_target(new,idx2,anchor2)
   assert new['targetSelection']['id']!=data['targetSelection']['id'] and idx2!=idx
   record(name+'_reselection_new_segment_no_relabel',passed=True)
   # Drag an explicit quadrant ROI using pointer events, including the portrait WebKit layout.
   load(page,'four.mp4');page.click('#selectBoxBtn');box=page.locator('#overlay').bounding_box()
   page.mouse.move(box['x']+box['width']*.01,box['y']+box['height']*.01);page.mouse.down()
   page.mouse.move(box['x']+box['width']*.49,box['y']+box['height']*.49,steps=12);page.mouse.up()
   wait_phase(page,['select-target','no-person','no-selected-person','error']);assert page.locator('.person-choice').count()>=1,page.inner_text('#status')
   idx3,anchor3=choose(page);assert anchor3[0]<.5 and anchor3[1]<.5
   run(page);roi=report(page);verify_target(roi,idx3,anchor3);assert roi['targetSelection']['method']=='box'
   record(name+'_explicit_roi_reprojected_and_locked',passed=True)
   # Changed time invalidates the confirmed snapshot rather than associating it at the wrong instant.
   load(page,'pose.mp4');scan(page);choose(page)
   page.evaluate("document.querySelector('#video').currentTime=.3")
   page.wait_for_function("document.documentElement.dataset.analysisPhase==='select-target'")
   with page.expect_download() as d:page.click('#diagnosticBtn')
   diagnostic=json.loads(Path(d.value.path()).read_text());assert not diagnostic['analysis']['targetSelected']
   record(name+'_seek_requires_new_confirmation',passed=True)
   load(page,'blank.mp4');page.click('#startHereBtn');wait_phase(page,['no-person','error']);assert phase(page)=='no-person'
   record(name+'_no_person_is_not_success',passed=True)
   assert not errors,errors;assert not external,external;page.close()
   # Fault injection: real AI finds the seed, then all detections disappear.
   page,errors,external=open_page(browser,viewport)
   def inject_loss(route):
    response=route.fetch();text=response.text();needle='    const full=inferFull(input);'
    assert needle in text
    route.fulfill(response=response,body=text.replace(needle,"    if(globalThis.__dropPose)return {landmarks:[]};\n"+needle))
   page.route('**/ai-loader.js*',inject_loss);page.goto(URL,wait_until='domcontentloaded');wait_ai(page)
   load(page,'pose.mp4');scan(page);choose(page);page.evaluate('globalThis.__dropPose=true')
   page.click('#startHereBtn');wait_phase(page,['target-paused','complete','error']);assert phase(page)=='target-paused',page.inner_text('#status')
   stopped=report(page);assert stopped['summary']['trackedFrames']==1 and stopped['summary']['frames']==2
   rejected=stopped['frames'][-1];assert rejected['landmarks'] is None and rejected['targetId'] is None
   assert rejected['metrics']['leftKnee'] is None and stopped['trackingStop']
   page.screenshot(path=str(OUT/f'{name}-loss-paused.png'),full_page=True)
   record(name+'_injected_loss_halts_without_bystander_values',passed=True);assert not errors,errors;page.close()
   # SDK failure must not block media handling; retry remains usable.
   page,errors,external=open_page(browser,viewport)
   pattern='**/vendor/mediapipe/vision_bundle.mjs*'
   def reject_sdk(route):route.fulfill(status=503,content_type='text/plain',body='injected SDK failure')
   page.route(pattern,reject_sdk);page.goto(URL,wait_until='domcontentloaded')
   page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('AI 載入失敗')")
   load(page,'pose.mp4');page.unroute(pattern,reject_sdk);page.click('#initAi');wait_ai(page)
   page.set_input_files('#videoInput',{'name':'broken.mov','mimeType':'video/quicktime','buffer':b'not a video'})
   page.wait_for_function("document.querySelector('#mediaStatus').dataset.error==='true'")
   record(name+'_sdk_retry_and_bad_media_error',passed=True)
   assert not errors,errors;page.close();browser.close()
except Exception as error:
 results['failure']=str(error);results['traceback']=traceback.format_exc()
 try:page.screenshot(path=str(OUT/'failure.png'),full_page=True)
 except Exception:pass
 raise
finally:
 (OUT/'browser-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n');server.shutdown()
