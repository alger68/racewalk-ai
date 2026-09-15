"""Read-only timing audit of published app. No private footage or production writes.
Live timing is from GitHub Actions, not the user's Mac/network.
Bandwidth emulation is explicitly labeled and runs through real downloads.
"""
from pathlib import Path
from urllib.request import urlopen,Request
from urllib.parse import urlsplit
import json,time,hashlib,traceback
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'audit-results';OUT.mkdir(exist_ok=True)
URL='https://alger68.github.io/racewalk-ai/'
SUBJECT='f2791d61a1f4c289a4d41fb27a9281b7026ede57'
R={'subject_commit':SUBJECT,'url':URL,'environment':'Ubuntu GitHub Actions; Playwright 1.57.0; software-rendered Chromium/WebKit; NOT physical Mac/iPhone','runs':[],'failures':[],'integrity':{}}
def save(): (OUT/'runtime-results.json').write_text(json.dumps(R,ensure_ascii=False,indent=2))
def get(path):
 with urlopen(Request(URL+path,headers={'User-Agent':'RaceWalk-readonly-audit'}),timeout=30) as r:return r.read(),dict(r.headers)
# Wait only for the pinned release to become visible; never deploy from this workflow.
expected=hashlib.sha256((ROOT/'site/app.js').read_bytes()).hexdigest()
for attempt in range(18):
 try:
  raw,headers=get('app.js');actual=hashlib.sha256(raw).hexdigest()
  if actual==expected:break
 except Exception as e:actual=str(e)
 time.sleep(5)
R['integrity']['app']={'expected_sha256':expected,'live_sha256':actual,'match':actual==expected}
for path in ['index.html','core.js','continuity.js','target-lock.js','ai-loader.js','asset-manifest.json']:
 try:
  raw,h=get(path);local=ROOT/'site'/path
  R['integrity'][path]={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'matches_build':hashlib.sha256(raw).digest()==hashlib.sha256(local.read_bytes()).digest() if local.exists() else None,'cache_control':h.get('Cache-Control',h.get('cache-control'))}
  if path=='asset-manifest.json':R['manifest']=json.loads(raw)
 except Exception as e:R['integrity'][path]={'error':str(e)}
save()
INIT="""(()=>{window.__auditEvents=[];window.__auditLongTasks=[];
try{new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__auditLongTasks.push({start:e.startTime,duration:e.duration}))).observe({type:'longtask',buffered:true});}catch{}
window.addEventListener('DOMContentLoaded',()=>{for(const id of ['engineBadge','status']){const el=document.getElementById(id);if(!el)continue;const snap=()=>{window.__auditEvents.push({id,t:performance.now(),text:el.textContent});};new MutationObserver(snap).observe(el,{childList:true,subtree:true,characterData:true});snap();}});})();"""
def take(page,label,network=None):
 events=[];errors=[];failed=[];requests=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('requestfailed',lambda r:failed.append({'url':r.url,'failure':r.failure}))
 page.on('request',lambda r:requests.append({'url':r.url,'method':r.method}))
 started=time.monotonic();page.goto(URL,wait_until='domcontentloaded',timeout=60000)
 page.wait_for_function("(()=>{let e=document.getElementById('engineBadge');return e&&/AI 已載入|AI 載入失敗|程式啟動失敗|AI 推論失敗/.test(e.textContent)})()",timeout=240000)
 wall=time.monotonic()-started;page.wait_for_timeout(150)
 data=page.evaluate("({events:window.__auditEvents||[],longTasks:window.__auditLongTasks||[],resources:performance.getEntriesByType('resource').map(e=>({name:e.name,start:e.startTime,end:e.responseEnd,duration:e.duration,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,decodedBodySize:e.decodedBodySize})),badge:document.querySelector('#engineBadge').textContent,status:document.querySelector('#status').textContent,title:document.title,ua:navigator.userAgent})")
 entry={'name':label,'network':network or 'Runner network, uncontrolled; do not extrapolate to user','wall_seconds':round(wall,3),'passed':'AI 已載入' in data['badge'],'errors':errors,'request_failures':failed,'requests':requests,**data}
 R['runs'].append(entry);save();print('AUDIT_START',label,round(wall,3),data['badge'],flush=True)
 return entry
try:
 with sync_playwright() as p:
  for name in ['chromium','webkit']:
   opts={'headless':True}
   if name=='chromium':opts['args']=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
   browser=getattr(p,name).launch(**opts)
   for repetition in range(2):
    context=browser.new_context(viewport={'width':1280,'height':800} if name=='chromium' else {'width':390,'height':844})
    context.add_init_script(INIT)
    page=context.new_page();take(page,f'{name}_cold_{repetition+1}');page.close()
    page=context.new_page();warm=take(page,f'{name}_warm_{repetition+1}')
    warm['model_network_requests']=sum('pose_landmarker_full.task' in r['url'] for r in warm['requests']);save()
    if repetition==0:page.screenshot(path=str(OUT/f'{name}-ready.png'),full_page=True)
    context.close()
   # One run per browser explicitly denies cache persistence. Correct behavior is to
   # continue initialization, not misreport a cache hit or stop the application.
   ctx=browser.new_context();ctx.add_init_script(INIT)
   ctx.add_init_script("try{Object.defineProperty(window,'caches',{get(){throw new DOMException('Injected denial','SecurityError')}})}catch{}")
   pg=ctx.new_page();take(pg,f'{name}_cache_storage_denied');ctx.close()
   # Real SDK load failure must expose actionable failure; then retry unchanged UI.
   ctx=browser.new_context();ctx.add_init_script(INIT);pg=ctx.new_page()
   pattern='**/vendor/mediapipe/vision_bundle.mjs*'
   def reject(route):route.fulfill(status=503,content_type='text/plain',body='deliberate test failure')
   pg.route(pattern,reject);err=take(pg,f'{name}_sdk_failure_injection');err['expected_failure']=True
   pg.unroute(pattern,reject);t=time.monotonic();pg.click('#initAi');pg.wait_for_function("document.querySelector('#engineBadge').textContent.includes('AI 已載入')",timeout=120000)
   R['runs'].append({'name':f'{name}_retry_after_sdk_failure','passed':True,'wall_seconds':round(time.monotonic()-t,3)});save();ctx.close()
   if name=='chromium':
    # A cold client capped at 2 Mbps / 80 ms RTT. This is a simulated link, not measured user bandwidth.
    ctx=browser.new_context();ctx.add_init_script(INIT);pg=ctx.new_page();cdp=ctx.new_cdp_session(pg)
    cdp.send('Network.enable');cdp.send('Network.emulateNetworkConditions',{'offline':False,'latency':80,'downloadThroughput':250000,'uploadThroughput':250000,'connectionType':'cellular3g'})
    take(pg,'chromium_cold_2Mbps','CDP controlled 2 Mbps (250,000 B/s), latency 80 ms');ctx.close()
   browser.close()
except Exception as e:
 R['failures'].append({'error':str(e),'traceback':traceback.format_exc()});save();raise
finally:save()
