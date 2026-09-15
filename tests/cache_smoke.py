"""Cold load, warm persistent cache and corrupt-cache recovery. No private videos."""
import http.server,threading,functools,os,json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
class Quiet(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(ROOT/'site')))
threading.Thread(target=server.serve_forever,daemon=True).start()
url=os.environ.get('TEST_BASE_URL',f'http://127.0.0.1:{server.server_port}/')
checks=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
  page=browser.new_page();requests=[]
  page.on('request',lambda r:requests.append(r.url) if 'pose_landmarker_full.task' in r.url else None)
  def ready():
   page.wait_for_function("document.querySelector('#engineBadge').textContent.includes('AI 已載入')",timeout=150000)
  page.goto(url,wait_until='domcontentloaded');ready();assert requests
  checks.append({'name':'cold_model_network','passed':True})
  requests.clear();page.reload(wait_until='domcontentloaded');ready();assert not requests,requests
  checks.append({'name':'warm_cache_no_model_request','passed':True})
  page.evaluate("async()=>{const c=await caches.open('racewalk-models-v1'),keys=await c.keys();for(const k of keys)await c.put(k,new Response('broken'));}")
  requests.clear();page.reload(wait_until='domcontentloaded');ready();assert requests
  checks.append({'name':'corrupt_cache_refetched','passed':True});browser.close()
finally:
 (ROOT/'test-results').mkdir(exist_ok=True)
 (ROOT/'test-results/cache-results.json').write_text(json.dumps({'checks':checks},indent=2));server.shutdown()
