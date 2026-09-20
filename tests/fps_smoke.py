"""量測影片幀率的瀏覽器煙霧測試。

取樣率被夾在影片幀率以內，而那個值現在是量出來的，不是手填的。
量錯的代價是「240fps 的影片被當成 60fps 分析」，而且沒有任何錯誤訊息，
所以這條路徑必須有真實瀏覽器的回歸守衛，不能只靠單元測試 snapFps。

影片用 canvas.captureStream + MediaRecorder 當場錄，是真的檔案、真的解碼路徑。
無頭環境錄不出 240fps，所以這裡只驗證低幀率這個真陽性案例與整條管線的行為；
高幀率的判定邏輯由 tests/diagnose.test.mjs 覆蓋。
"""
import http.server, socketserver, threading, os, sys, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'site')
OUT = os.environ.get('TEST_OUT', '/tmp')
RECORD = """
async (fps) => {
  const c=document.createElement('canvas');c.width=320;c.height=180;
  const g=c.getContext('2d');const stream=c.captureStream(fps);
  const rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
  const parts=[];rec.ondataavailable=e=>parts.push(e.data);
  let i=0;const draw=()=>{g.fillStyle=`hsl(${(i*7)%360} 80% 50%)`;g.fillRect(0,0,320,180);i++;};
  const timer=setInterval(draw,1000/fps);draw();rec.start();
  await new Promise(r=>setTimeout(r,2500));
  clearInterval(timer);
  await new Promise(r=>{rec.onstop=r;rec.stop();});
  return Array.from(new Uint8Array(await new Blob(parts,{type:'video/webm'}).arrayBuffer()));
}
"""

def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.abspath(ROOT))
    srv = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = os.environ.get('TEST_BASE_URL') or f'http://127.0.0.1:{srv.server_address[1]}/'
    errors, checks = [], 0

    def check(name, cond, detail=''):
        nonlocal checks
        assert cond, f'{name}: {detail}'
        checks += 1
        print('PASS', name)

    launch = {'args': ['--autoplay-policy=no-user-gesture-required']}
    if os.environ.get('CHROMIUM_PATH'):
        launch['executable_path'] = os.environ['CHROMIUM_PATH']

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch)
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(url + 'index.html')
        page.wait_for_selector('#fpsNote')

        check('requestVideoFrameCallback 可用',
              page.evaluate("'requestVideoFrameCallback' in HTMLVideoElement.prototype"),
              '沒有這個 API 就無法量測幀率，偵測會退回手填')

        before = {k: page.evaluate(f"document.querySelector('#video').{k}") for k in ('muted', 'currentTime')}

        clip = os.path.join(OUT, 'fps-smoke-30.webm')
        open(clip, 'wb').write(bytes(page.evaluate(RECORD, 30)))
        page.set_input_files('#videoInput', clip)
        page.wait_for_function(
            "/偵測到|失敗|無法/.test(document.querySelector('#fpsNote').textContent)", timeout=30000)

        # 量測期間主播放器不得被動到。先前的版本在主播放器上播放再還原，
        # 使用者會看到影片自己跑兩秒，而載入後立刻讀取播放位置的程式會讀到錯的值。
        moved = page.evaluate("document.querySelector('#video').currentTime")
        check('量測期間主播放器沒有被移動', moved <= 0.05, f'currentTime={moved}')
        check('量測期間主播放器沒有被播放', page.evaluate("document.querySelector('#video').paused"))

        note = page.inner_text('#fpsNote')
        check('量到了幀率而不是放棄', '偵測到' in note, note)
        measured = float(page.input_value('#fps'))

        # 對照基準用「要求錄製的節奏」，不是「平均送出的格數」。
        # MediaRecorder 產出的是變動幀率：無頭環境跟不上時會掉格，
        # totalVideoFrames/duration 因此低於實際節奏。取樣要對齊的是節奏——
        # 對齊平均值會讓每一格都取樣不足。這個差異抓出過一個真實缺陷：
        # 原本用「格數 ÷ 總時距」，開頭解碼暖機的幾格把結果拖到 19.8。
        delivered = page.evaluate("""async () => {
          const file=document.querySelector('#videoInput').files[0];
          const v=document.createElement('video');
          v.muted=true;v.src=URL.createObjectURL(file);
          await new Promise(r=>v.addEventListener('loadedmetadata',r,{once:true}));
          await v.play();
          await new Promise(r=>v.addEventListener('ended',r,{once:true}));
          const q=v.getVideoPlaybackQuality?.();
          URL.revokeObjectURL(v.src);
          return q&&v.duration>0 ? q.totalVideoFrames/v.duration : null;
        }""")
        check('量到的是錄製節奏（30 fps），不被掉格拖低',
              abs(measured - 30) / 30 <= 0.10,
              f'App {measured}；同檔平均送出 {delivered:.1f} fps（變動幀率，僅供對照）')
        print(f'     （參考：平均送出 {delivered:.1f} fps，低於節奏是因為無頭環境掉格）')

        check('低於篩查門檻時要講出後果', '低於 120' in note and '漏報' in note, note)
        check('量測結果覆蓋手填值並說明來由', '已更新' in note, note)

        after = {k: page.evaluate(f"document.querySelector('#video').{k}") for k in ('muted', 'currentTime')}
        check('量測後影片是暫停的', page.evaluate("document.querySelector('#video').paused"))
        check('量測後還原靜音狀態', after['muted'] == before['muted'], f"{before} -> {after}")
        check('量測後回到原本的時間點', after['currentTime'] <= 0.05, after['currentTime'])

        check('量測過程不丟未捕捉例外', not errors, '; '.join(errors))
        browser.close()
    srv.shutdown()
    print(f'{{"suite":"fps","checks":{checks},"passed":true,'
          f'"scope":"browser plumbing for frame-rate measurement on a recorded 30 fps clip; '
          f'headless cannot produce a true high-speed file"}}')

if __name__ == '__main__':
    sys.exit(main())
