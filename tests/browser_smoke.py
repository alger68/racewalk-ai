"""Real inference plus failure injection. Repeated public sample image, not gait-accuracy validation."""
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
results={'sample':SAMPLE,'fixture':'0.6-second repeated image, H.264 MP4 and MOV; not the user video','checks':[]}
def record(name,**values):
    results['checks'].append({'name':name,**values});print('BROWSER_CHECK',name,json.dumps(values,ensure_ascii=False),flush=True)
def open_page(browser,**kwargs):
    page=browser.new_page(**kwargs);page.set_default_timeout(20000);errors=[];external=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.on('request',lambda req:external.append(req.url) if urlsplit(req.url).scheme in ('http','https') and urlsplit(req.url).netloc!=origin else None)
    return page,errors,external
try:
 with sync_playwright() as p:
  for browser_name in ('chromium','webkit'):
    options={'headless':True}
    if browser_name=='chromium':options['args']=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
    browser=getattr(p,browser_name).launch(**options)
    viewport={'width':1440,'height':1000} if browser_name=='chromium' else {'width':390,'height':844}
    page,errors,external=open_page(browser,viewport=viewport)
    page.goto(URL,wait_until='domcontentloaded')
    page.wait_for_function("document.documentElement.dataset.appReady==='true'")
    assert page.input_value('#date')
    page.set_input_files('#videoInput',str(FIX/'pose.mp4'))
    page.wait_for_function("document.querySelector('#video').readyState>=2")
    page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('AI 已載入')",timeout=120000)
    page.fill('#sampleFps','10')
    box=page.locator('#overlay').bounding_box();assert box
    page.locator('#overlay').click(position={'x':box['width']/2,'y':box['height']/2})
    expect(page.locator('#analyzeBtn')).to_be_enabled();page.click('#analyzeBtn')
    page.wait_for_function("document.querySelector('#status').textContent.startsWith('分析完成')",timeout=120000)
    page.click('[data-tab=report]')
    with page.expect_download() as download:page.click('#exportJson')
    data=json.loads(Path(download.value.path()).read_text())
    assert data['engine']=='rw-3.0.2-bootstrap-fix'
    assert data['summary']['frames']>=5
    assert data['summary']['maxPeople']>=1
    assert data['summary']['trackedFrames']>=1
    assert any(f.get('metrics',{}).get('leftKnee',{}).get('value') is not None for f in data['frames'])
    record(browser_name+'_real_inference',passed=True,frames=data['summary']['frames'],people=data['summary']['maxPeople'],tracked=data['summary']['trackedFrames'])
    page.click('[data-tab=analyze]');page.click('#manualToggle')
    box=page.locator('#overlay').bounding_box()
    page.locator('#overlay').click(position={'x':box['width']*.5,'y':box['height']*.55})
    page.click('[data-tab=report]')
    with page.expect_download() as download:page.click('#exportJson')
    corrected=json.loads(Path(download.value.path()).read_text())
    assert corrected['summary']['manualCorrections']==1
    assert corrected['frames']!=data['frames']
    page.click('[data-tab=analyze]');page.click('#manualToggle')
    page.set_input_files('#videoInput',str(FIX/'pose.mov'))
    page.wait_for_function("document.querySelector('#video').readyState>=2")
    box=page.locator('#overlay').bounding_box()
    page.locator('#overlay').click(position={'x':box['width']/2,'y':box['height']/2})
    page.click('#analyzeBtn')
    page.wait_for_function("document.querySelector('#status').textContent.startsWith('分析完成')",timeout=120000)
    record(browser_name+'_mov_repeat_and_manual_edit',passed=True)
    page.screenshot(path=str(OUT/f'{browser_name}-inference.png'),full_page=True)
    assert not errors,errors;assert not external,external
    record(browser_name+'_no_external_runtime_requests',passed=True);page.close()
    page,errors,external=open_page(browser,viewport=viewport)
    pattern='**/vendor/mediapipe/vision_bundle.mjs*'
    def reject_sdk(route):route.fulfill(status=503,content_type='text/plain',body='injected SDK failure')
    page.route(pattern,reject_sdk);page.goto(URL,wait_until='domcontentloaded')
    page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('AI 載入失敗')")
    assert page.input_value('#date')
    page.set_input_files('#videoInput',str(FIX/'pose.mp4'))
    page.wait_for_function("document.querySelector('#video').readyState>=2")
    page.click('[data-tab=guide]');expect(page.locator('#guide')).to_be_visible();page.click('[data-tab=analyze]')
    expect(page.locator('#initAi')).to_be_enabled()
    page.unroute(pattern,reject_sdk);page.click('#initAi')
    page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('AI 已載入')",timeout=120000)
    assert not errors,errors
    record(browser_name+'_failed_sdk_video_and_retry',passed=True)
    page.set_input_files('#videoInput',{'name':'broken.mov','mimeType':'video/quicktime','buffer':b'not a video'})
    page.wait_for_function("document.querySelector('#mediaStatus').dataset.error==='true'")
    expect(page.locator('#analyzeBtn')).to_be_disabled()
    record(browser_name+'_bad_video_error',passed=True)
    page.close();browser.close()
except Exception as error:
 results['failure']=str(error);results['traceback']=traceback.format_exc()
 try:
    results['last_ui']=page.evaluate("({status:document.querySelector('#status')?.textContent,media:document.querySelector('#mediaStatus')?.textContent,badge:document.querySelector('#engineBadge')?.textContent})")
    results['last_page_errors']=errors
    page.screenshot(path=str(OUT/'failure.png'),full_page=True)
 except Exception:pass
 raise
finally:
 (OUT/'browser-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n');server.shutdown()
