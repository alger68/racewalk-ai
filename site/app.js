import { JOINTS, bboxFromLandmarks, chooseTarget, estimateGroundY, flightIntervals, computeFrameMetrics, runMonkeyCore } from './core.js?v=3.0.3';
import { createPoseEngine } from './ai-loader.js?v=3.0.3';

const $ = (id) => document.getElementById(id);
const state = { landmarker:null, aiPromise:null, videoUrl:null, clickPoint:null, clickTime:0, frames:[], maxPeople:0, analyzing:false, stop:false, manual:false, report:null, selectedIndex:-1, timestampBase:0, lastTimestamp:0, model:'MediaPipe PoseLandmarker Full', version:'rw-3.0.3-analysis-flow', phase:'idle', lastError:null, phaseLog:[], previewPeople:[], previewTime:0 };
const video=$('video'), overlay=$('overlay'), chart=$('chart'), octx=overlay.getContext('2d'), cctx=chart.getContext('2d');
const LINKS=[[11,12],[11,23],[12,24],[23,24],[23,25],[25,27],[27,29],[29,31],[24,26],[26,28],[28,30],[30,32],[27,31],[28,32]];
const localDate = new Date();
$('date').value = `${localDate.getFullYear()}-${String(localDate.getMonth()+1).padStart(2,'0')}-${String(localDate.getDate()).padStart(2,'0')}`;
let mediaTimer = null;

// Keep prerequisites, candidate selection, progress and diagnostics next to the video.
// UI state comes from the controller, never inferred from an "AI ready" label.
const flow=document.createElement('section');
flow.id='analysisFlow';flow.className='analysis-flow';
flow.innerHTML='<strong>AI 分析操作</strong><p id="flowChecklist"></p><div class="actions compact"><button id="startHereBtn" class="primary">開始 AI 分析</button><button id="scanPeopleBtn">辨識目前畫面人物</button><button id="clearTargetBtn">重新選人</button><button id="diagnosticBtn">下載診斷</button></div><label class="clip-label">本次分析長度 <input id="clipSeconds" type="number" min="1" max="60" step="1" value="15"> 秒（從選取位置開始，最長 60 秒）</label><p id="flowStatus" role="status" aria-live="polite">匯入影片後直接按「開始 AI 分析」，未選人時先辨識人物。</p><div id="candidateList"></div>';
$('stage').before(flow);
const liveProgress=document.createElement('div');liveProgress.id='liveProgress';liveProgress.hidden=true;document.body.append(liveProgress);
new MutationObserver(()=>{$('flowStatus').textContent=$('status').textContent;liveProgress.textContent=$('status').textContent;}).observe($('status'),{childList:true,subtree:true,characterData:true});
function setPhase(phase,message){
 state.phase=phase;document.documentElement.dataset.analysisPhase=phase;
 if(message)$('status').textContent=message;
 state.phaseLog.push({phase,time:new Date().toISOString()});
 if(state.phaseLog.length>40)state.phaseLog.shift();
}
function noteError(code,error){
 state.lastError={code,message:String(error?.message||error)};
 setPhase('error',`分析未完成 [${code}]：${state.lastError.message}。可按「下載診斷」保存目前狀態。`);
}
function clearPreview(){state.previewPeople=[];$('candidateList').replaceChildren();}
function showPeople(people,t){
 state.previewPeople=people;state.previewTime=t;
 $('candidateList').replaceChildren();
 people.forEach((lm,i)=>{
  const box=bboxFromLandmarks(lm);if(!box)return;
  const button=document.createElement('button');button.type='button';button.className='person-choice';
  const thumb=document.createElement('canvas');thumb.width=96;thumb.height=112;
  const sx=Math.max(0,box.x1)*video.videoWidth,sy=Math.max(0,box.y1)*video.videoHeight;
  const sw=Math.min(video.videoWidth-sx,(box.x2-box.x1)*video.videoWidth),sh=Math.min(video.videoHeight-sy,(box.y2-box.y1)*video.videoHeight);
  if(sw>0&&sh>0)thumb.getContext('2d').drawImage(video,sx,sy,sw,sh,0,0,96,112);
  const label=document.createElement('span');label.textContent=`分析人物 ${i+1}`;
  button.append(thumb,label);button.onclick=()=>{
   if(state.analyzing)return;
   if(Math.abs(video.currentTime-state.previewTime)>.05){clearPreview();noteError('TARGET_EXPIRED','影片時間已改變，請重新辨識人物');return;}
   state.manual=false;$('manualToggle').textContent='人工修點：關';$('stage').classList.remove('manual-active');
   state.clickPoint={x:(box.x1+box.x2)/2,y:(box.y1+box.y2)/2};state.clickTime=t;
   $('clickHint').style.display='none';clearPreview();updateControls();analyze();
  };
  $('candidateList').append(button);
 });
 drawCurrent();
}
function drawPeoplePreview(){
 if(!state.previewPeople.length||Math.abs(video.currentTime-state.previewTime)>.05)return;
 const rect=video.getBoundingClientRect(),w=rect.width,h=rect.height;
 octx.clearRect(0,0,w,h);
 state.previewPeople.forEach((lm,i)=>{
  drawPose(lm,w,h,.9,2);const box=bboxFromLandmarks(lm);if(!box)return;
  const x=Math.max(0,box.x1*w),y=Math.max(24,box.y1*h);
  octx.fillStyle='#0f172a';octx.fillRect(x,y-24,75,24);octx.fillStyle='white';octx.font='bold 14px system-ui';octx.fillText(`人物 ${i+1}`,x+6,y-7);
 });
}
function diagnostic(){return {
 schema:1,engine:state.version,created:new Date().toISOString(),phase:state.phase,lastError:state.lastError,
 ai:{loaded:!!state.landmarker,loading:!!state.aiPromise,badge:$('engineBadge').textContent},
 browser:{userAgent:navigator.userAgent,hidden:document.hidden,secureContext:isSecureContext,viewport:[innerWidth,innerHeight]},
 media:{selected:!!state.videoUrl,mime:$('videoInput').files?.[0]?.type||'',readyState:video.readyState,networkState:video.networkState,errorCode:video.error?.code??null,width:video.videoWidth,height:video.videoHeight,duration:Number.isFinite(video.duration)?video.duration:null,currentTime:video.currentTime,seeking:video.seeking,paused:video.paused},
 analysis:{targetSelected:!!state.clickPoint,targetTime:state.clickTime,detectedPeople:state.previewPeople.length,frames:state.frames.length,maxPeople:state.maxPeople,busy:state.analyzing,clipSeconds:Number($('clipSeconds').value)},
 phaseLog:state.phaseLog,privacy:'No video, image, name, athlete fields, landmarks or local records included.'
};}
$('diagnosticBtn').onclick=()=>download('RaceWalk-3.0.3-diagnostic.json',JSON.stringify(diagnostic(),null,2),'application/json');
$('startHereBtn').onclick=()=>analyze();
$('scanPeopleBtn').onclick=()=>analyze(true);
$('clearTargetBtn').onclick=()=>{if(state.analyzing)return;state.clickPoint=null;clearPreview();$('clickHint').style.display='block';setPhase('idle','已清除選取。按「開始 AI 分析」重新辨識，或直接點影片中的目標。');updateControls();drawCurrent();};
async function waitForMedia(){
 if(video.error)throw new Error(`影片解碼錯誤 ${video.error.code}；請先確認此瀏覽器能播放原片`);
 if(video.readyState>=2&&video.videoWidth&&Number.isFinite(video.duration)&&video.duration>0)return;
 video.scrollIntoView({block:'center',behavior:'instant'});
 setPhase('media','正在讀取影片影格…');
 await new Promise((resolve,reject)=>{
  let done=false;const clean=()=>{clearTimeout(timer);video.removeEventListener('loadeddata',check);video.removeEventListener('canplay',check);video.removeEventListener('error',fail);};
  const finish=e=>{if(done)return;done=true;clean();video.pause();e?reject(e):resolve();};
  const check=()=>{if(video.readyState>=2&&video.videoWidth&&Number.isFinite(video.duration)&&video.duration>0)finish();};
  const fail=()=>finish(new Error(`影片解碼失敗（${video.error?.code??'?'}）`));
  const timer=setTimeout(()=>finish(new Error('影片未提供可分析影格，請按播放確認；支援與否取決於影片編碼，不能只改副檔名')),10000);
  video.addEventListener('loadeddata',check);video.addEventListener('canplay',check);video.addEventListener('error',fail);
  video.play().then(check).catch(()=>{});check();
 });
}

function updateControls() {
  const ready = !!state.videoUrl && video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0;
  // A clickable button must explain missing prerequisites instead of silently disabling.
  $('analyzeBtn').disabled = state.analyzing;
  $('startHereBtn').disabled=state.analyzing;$('scanPeopleBtn').disabled=state.analyzing;$('clearTargetBtn').disabled=state.analyzing;
  $('flowChecklist').textContent=`AI：${state.landmarker?'已就緒':state.aiPromise?'載入中':'待載入'} ｜ 影片：${video.error?'解碼錯誤':ready?'已解碼':state.videoUrl?'等待影格':'未匯入'} ｜ 目標：${state.clickPoint?'已選取':'尚未選取（按分析會協助選人）'}`;
  $('stopBtn').disabled = !state.analyzing;liveProgress.hidden=!state.analyzing;
  $('stopBtn').style.cssText = state.analyzing ? 'position:fixed;right:16px;bottom:16px;z-index:999;background:#991b1b;color:white;padding:14px 24px;box-shadow:0 4px 18px #0004' : '';
  $('initAi').disabled = !!state.aiPromise || state.analyzing;
  for (const id of ['videoInput','timeSlider','prevFrame','nextFrame','manualToggle','manualJoint','fps','sampleFps','groundSlider','sigmaPx','uncertaintyEnabled','playPause','clipSeconds']) {
    if ($(id)) $(id).disabled = state.analyzing;
  }
}
function mediaMessage(text, error=false) {
  $('mediaStatus').textContent = text;
  $('mediaStatus').dataset.error = error ? 'true' : 'false';
}
async function ensureAi() {
  if (state.landmarker) return state.landmarker;
  if (state.aiPromise) return state.aiPromise;
  $('initAi').textContent='AI 載入中…';
  $('engineBadge').textContent='AI 載入中';
  state.aiPromise = createPoseEngine({onStatus(text) {
    $('engineBadge').textContent=text;
    if (!state.analyzing) $('status').textContent=text;
  }}).then(engine => {
    state.landmarker=engine;
    $('engineBadge').textContent='AI 已載入 · 最多 6 人';
    if(!state.analyzing)$('status').textContent='AI 已就緒。匯入影片後直接按「開始 AI 分析」；多人畫面會先列出人物供選取。';
    $('initAi').textContent='AI 已就緒';
    return engine;
  }).catch(error => {
    $('engineBadge').textContent='AI 載入失敗 · 可重試';
    $('status').textContent=`AI 載入失敗：${error.message}。影片播放與介面仍可使用，請按「重試 AI」。`;
    $('initAi').textContent='重試 AI';
    throw error;
  }).finally(()=>{state.aiPromise=null;updateControls();});
  updateControls();
  return state.aiPromise;
}
$('initAi').addEventListener('click',()=>{ensureAi().catch(()=>{});});

document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{
  if(state.analyzing){$('status').textContent='分析中，請先按「停止」後再切換頁籤。';return;}
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$(btn.dataset.tab).classList.add('active'); if(btn.dataset.tab==='report') renderReport(); if(btn.dataset.tab==='records') renderRecords(); if(btn.dataset.tab==='analyze') drawCurrent();
}));

function syncCanvas(){const r=video.getBoundingClientRect();const dpr=devicePixelRatio||1;overlay.style.width=`${r.width}px`;overlay.style.height=`${r.height}px`;overlay.width=Math.max(1,Math.round(r.width*dpr));overlay.height=Math.max(1,Math.round(r.height*dpr));octx.setTransform(dpr,0,0,dpr,0,0);}
window.addEventListener('resize',()=>{syncCanvas();drawCurrent();});

$('videoInput').addEventListener('change',e=>{
  const f=e.target.files?.[0];if(!f||state.analyzing)return;
  video.pause();clearTimeout(mediaTimer);
  if(state.videoUrl)URL.revokeObjectURL(state.videoUrl);
  state.videoUrl=URL.createObjectURL(f);state.frames=[];state.clickPoint=null;state.clickTime=0;state.report=null;state.maxPeople=0;state.lastError=null;clearPreview();setPhase('media','正在匯入影片…');
  $('clickHint').style.display='block';$('clickHint').textContent='等待影片解碼…';
  $('personCount').textContent='0 / 0';$('quickStats').replaceChildren();$('events').replaceChildren();$('angleNow').textContent='L — / R —';$('progressBar').style.width='0%';
  $('timeSlider').value=0;$('timeSlider').max=0;
  mediaMessage(`正在讀取 ${f.name}…`);
  video.src=state.videoUrl;video.load();updateControls();renderReport();drawCurrent();
  const expectedUrl=state.videoUrl;
  mediaTimer=setTimeout(()=>{if(state.videoUrl===expectedUrl&&video.readyState<2) mediaMessage('影片尚未完成解碼。請先按播放；若一直黑畫面，改用此瀏覽器可播放的 H.264 MP4（不是直接修改副檔名）。',true);},15000);
});
video.addEventListener('loadedmetadata',()=>{
  syncCanvas();$('timeSlider').max=Number.isFinite(video.duration)?video.duration:0;
  mediaMessage(`影片資訊已讀取：${video.videoWidth} × ${video.videoHeight}，${formatTime(video.duration)}；等待畫面解碼。`);
  updateControls();drawCurrent();
});
video.addEventListener('loadeddata',()=>{
  clearTimeout(mediaTimer);mediaMessage(`影片已就緒：${video.videoWidth} × ${video.videoHeight}，${formatTime(video.duration)}。`);
  $('clickHint').textContent='點一下要追蹤的選手';updateControls();drawCurrent();
});
video.addEventListener('canplay',updateControls);
video.addEventListener('error',()=>{
  clearTimeout(mediaTimer);state.stop=true;
  const code=video.error?.code??'?';
  mediaMessage(`影片解碼失敗（${code}）。MOV/MP4 是容器；請確認影片能在此瀏覽器播放，必要時轉成 H.264 MP4，勿只改副檔名。`,true);
  updateControls();
});
video.addEventListener('timeupdate',()=>{$('timeSlider').value=video.currentTime;$('timeText').textContent=formatTime(video.currentTime);if(!state.analyzing)drawCurrent();});
video.addEventListener('pause',()=>{$('playPause').textContent='播放 / 暫停';});
$('playPause').onclick=async()=>{if(state.analyzing||!state.videoUrl)return;try{if(video.paused){await video.play();$('playPause').textContent='暫停';}else video.pause();}catch(e){mediaMessage(`無法播放：${e.message}`,true);}};
$('timeSlider').addEventListener('input',()=>{if(!state.analyzing&&video.readyState>=1)video.currentTime=+$('timeSlider').value;});
$('prevFrame').addEventListener('click',()=>{if(video.readyState>=1)video.currentTime=Math.max(0,video.currentTime-1/(+$('fps').value||60));});
$('nextFrame').addEventListener('click',()=>{if(video.readyState>=1)video.currentTime=Math.min(Math.max(0,video.duration-.001),video.currentTime+1/(+$('fps').value||60));});

overlay.addEventListener('click',e=>{
  if(state.analyzing||video.readyState<2)return;
  video.pause();const rect=overlay.getBoundingClientRect();
  const p={x:Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height))};
  if(state.manual&&state.frames.length){const f=nearestFrame(video.currentTime);if(f?.landmarks){const idx=+$('manualJoint').value;f.landmarks[idx]={...(f.landmarks[idx]||{}),x:p.x,y:p.y,visibility:1,presence:1,manual:true};f.metrics=metricsFor(f);drawCurrent();buildReport();$('status').textContent=`人工修正 ${$('manualJoint').selectedOptions[0].text} @ ${formatTime(f.t)}`;}else $('status').textContent='此格沒有可修正的骨架，請先選擇有追蹤結果的影格。';return;}
  state.clickPoint=p;state.clickTime=video.currentTime;clearPreview();$('clickHint').style.display='none';
  $('status').textContent=`已設定目標，將從 ${formatTime(state.clickTime)} 開始分析；多人遮擋仍需人工核對。`;
  updateControls();drawCurrent();
});
$('manualToggle').addEventListener('click',()=>{state.manual=!state.manual;$('manualToggle').textContent=`人工修點：${state.manual?'開':'關'}`;$('stage').classList.toggle('manual-active',state.manual);});
$('showSkeleton').onchange=drawCurrent;$('showRefs').onchange=drawCurrent;$('showAllPeople').onchange=drawCurrent;$('groundSlider').oninput=()=>{drawCurrent();buildReport();};$('uncertaintyEnabled').onchange=recomputeAll;$('sigmaPx').onchange=recomputeAll;

function seek(t){
  return new Promise((resolve,reject)=>{
    let timer;
    const clean=()=>{clearTimeout(timer);video.removeEventListener('seeked',check);video.removeEventListener('loadeddata',check);video.removeEventListener('canplay',check);video.removeEventListener('error',fail);};
    const fail=()=>{clean();reject(new Error('影片解碼失敗，無法讀取影格'));};
    const check=()=>{if(state.stop){clean();resolve();return;}if(!video.seeking&&Math.abs(video.currentTime-t)<.05&&video.readyState>=2){clean();resolve();}};
    video.addEventListener('seeked',check);video.addEventListener('loadeddata',check);video.addEventListener('canplay',check);video.addEventListener('error',fail);
    timer=setTimeout(()=>{clean();reject(new Error(`讀取 ${formatTime(t)} 影格逾時，請確認影片可播放`));},10000);
    try{if(Math.abs(video.currentTime-t)>.0005)video.currentTime=t;check();}catch(e){clean();reject(e);}
  });
}
async function presentFrame(){
  if(document.hidden)throw new Error('網頁已進入背景，請回到前景後重新分析');
  const visible=()=>{const r=video.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;};
  if(!visible()) video.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  // WebKit can report readyState=4 but return black pixels for an offscreen paused video.
  await new Promise((resolve,reject)=>{
    let first=0,second=0,done=false;
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(first);cancelAnimationFrame(second);error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error('影片畫面未能呈現，請保持分析頁面在前景')),2000);
    first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>finish());});
  });
  if(document.hidden||!visible())throw new Error('影片不在可見範圍，請保持分析工作台開啟後重試');
}
function metricsFor(f){return computeFrameMetrics(f,{uncertaintyEnabled:$('uncertaintyEnabled').checked,sigmaPx:+$('sigmaPx').value||0,width:video.videoWidth||1920,height:video.videoHeight||1080});}
function recomputeAll(){state.frames.forEach(f=>f.metrics=metricsFor(f));buildReport();drawChart();drawCurrent();}

$('analyzeBtn').addEventListener('click',()=>analyze());
$('stopBtn').addEventListener('click',()=>{state.stop=true;$('status').textContent='正在停止，等待目前影格結束…';});
async function analyze(previewOnly=false){
  if(state.analyzing)return;
  state.lastError=null;
  if(!state.videoUrl){noteError('NO_VIDEO','尚未匯入影片，請先選擇影片檔案');$('videoInput').scrollIntoView({block:'center'});return;}
  state.analyzing=true;state.stop=false;updateControls();video.pause();
  setPhase('preflight','開始檢查：影片解碼 → 人物選取 → 逐格分析…');
  let error=null,started=false,stage='MEDIA';
  try{
    await waitForMedia();if(state.stop)return;
    stage='AI';setPhase('ai','確認 AI 模型…');const engine=await ensureAi();if(state.stop)return;
    stage='FRAME';await presentFrame();if(state.stop)return;
    if(!state.clickPoint||previewOnly){
      stage='DETECTION';setPhase('detecting','正在辨識目前畫面的人物…');await presentFrame();
      state.lastTimestamp+=1000;
      const people=(engine.detectForVideo(video,state.lastTimestamp).landmarks||[]).filter(lm=>bboxFromLandmarks(lm));
      if(state.stop)return;
      $('personCount').textContent=`${people.length} / ${Math.max(state.maxPeople,people.length)}`;
      if(people.length===0){clearPreview();setPhase('no-person','目前這一格沒有辨識到人物，尚未開始分析。請播放到人物全身清楚的畫面，再按「辨識目前畫面人物」。');return;}
      if(previewOnly||people.length>1){
        showPeople(people,video.currentTime);$('analysisFlow').scrollIntoView({block:'start',behavior:'instant'});
        setPhase('select-target',`偵測到 ${people.length} 人。請點下方「分析人物 1、2…」的縮圖，或點選影片中的目標後再按分析；不會任意替你選人。`);
        return;
      }
      const box=bboxFromLandmarks(people[0]);state.clickPoint={x:(box.x1+box.x2)/2,y:(box.y1+box.y2)/2};state.clickTime=video.currentTime;
      $('clickHint').style.display='none';setPhase('target','本格只偵測到 1 人，已選取。請核對是否為目標選手。');
    }
    clearPreview();started=true;state.frames=[];state.report=null;state.maxPeople=0;
    const sampleFps=Math.max(5,Math.min(60,+$('sampleFps').value||30));
    $('sampleFps').value=sampleFps;
    const clipSeconds=Math.max(1,Math.min(60,+$('clipSeconds').value||15));$('clipSeconds').value=clipSeconds;
    const start=Math.min(state.clickTime,Math.max(0,video.duration-.001));
    const end=Math.min(video.duration,start+clipSeconds),dt=1/sampleFps;
    const count=Math.max(1,Math.ceil((end-start)*sampleFps));let previous=null;
    const base=state.lastTimestamp+1000;setPhase('analyzing',`準備分析 ${formatTime(start)}–${formatTime(end)}，共 ${count} 格…`);
    for(let index=0;index<count;index++){
      if(state.stop)break;
      stage='FRAME';const t=Math.min(start+index*dt,Math.max(0,end-.001));
      $('status').textContent=`讀取第 ${index+1}/${count} 格（${formatTime(t)}）…`;
      await seek(t);if(state.stop)break;await presentFrame();if(state.stop)break;
      stage='INFERENCE';state.lastTimestamp=base+Math.round((t-start)*1000);
      const result=engine.detectForVideo(video,state.lastTimestamp);
      const people=result.landmarks||[];state.maxPeople=Math.max(state.maxPeople,people.length);
      const pick=chooseTarget(people,previous,previous?null:state.clickPoint);
      const landmarks=pick>=0?people[pick].map(p=>({...p})):null;
      const box=landmarks?bboxFromLandmarks(landmarks):null;if(box)previous=box;
      const frame={index,t,people,peopleCount:people.length,targetIndex:pick,landmarks,box,trackState:landmarks?'tracked':'lost'};
      stage='METRICS';frame.metrics=metricsFor(frame);state.frames.push(frame);
      $('personCount').textContent=`${people.length} / ${state.maxPeople}`;
      $('progressBar').style.width=`${((index+1)/count)*100}%`;
      $('status').textContent=`分析 ${formatTime(t)} / ${formatTime(end)} · ${index+1}/${count} 格 · ${people.length} 人 · 目標 ${landmarks?'已鎖定':'搜尋中'}`;
      drawFrame(frame);if(index%3===0)drawChart();await new Promise(r=>setTimeout(r,0));
    }
    stage='REPORT';const autoGround=estimateGroundY(state.frames);
    if(autoGround!=null)$('groundSlider').value=Math.max(.45,Math.min(.98,autoGround));
    $('groundText').textContent=autoGround==null?'無法估計':`自動 ${(+ $('groundSlider').value).toFixed(3)}`;
    buildReport();saveRecord();
  }catch(e){
    error=e;
    // A failed inference must not leave a misleading "AI ready" state behind.
    if(stage==='INFERENCE'||stage==='DETECTION'){
      try{state.landmarker?.close();}catch{}state.landmarker=null;
      $('engineBadge').textContent='AI 推論失敗 · 需重試';$('initAi').textContent='重試 AI';
    }
    if(started&&state.frames.length){try{buildReport();}catch{}}
    noteError(stage,e);
  }finally{
    state.analyzing=false;updateControls();drawCurrent();
    if(!error&&started){
      const valid=state.frames.filter(f=>f.landmarks).length;
      if(state.stop)setPhase('stopped',`已停止（部分結果）：${state.frames.length} 格。`);
      else if(!valid)setPhase('no-result',`分析已結束但沒有可用骨架（${state.frames.length} 格）。請重新選人或更換清楚的畫面；這不是成功的動作分析。`);
      else setPhase('complete',`分析完成：${state.frames.length} 格，可用骨架 ${valid} 格，最多同框 ${state.maxPeople} 人。`);
    }else if(!error&&state.stop)setPhase('stopped','已停止，尚未產生新的分析結果。');
  }
}

function nearestFrame(t){if(!state.frames.length)return null;let best=state.frames[0],d=Math.abs(best.t-t);for(const f of state.frames){const nd=Math.abs(f.t-t);if(nd<d){best=f;d=nd}}return best}
function drawCurrent(){syncCanvas();const f=nearestFrame(video.currentTime);drawFrame(f);drawPeoplePreview();drawChart();}
function drawFrame(frame){const rect=video.getBoundingClientRect(),w=rect.width,h=rect.height;octx.clearRect(0,0,w,h);if(!frame){if(state.clickPoint){octx.fillStyle='#f59e0b';octx.beginPath();octx.arc(state.clickPoint.x*w,state.clickPoint.y*h,7,0,Math.PI*2);octx.fill()}return}if($('showSkeleton').checked){if($('showAllPeople').checked){frame.people?.forEach((lm,i)=>drawPose(i===frame.targetIndex&&frame.landmarks?frame.landmarks:lm,w,h,i===frame.targetIndex?1:.22,i===frame.targetIndex?3:1));}else if(frame.landmarks)drawPose(frame.landmarks,w,h,1,3);}const gy=+$('groundSlider').value;octx.strokeStyle='#22c55e';octx.lineWidth=2;octx.setLineDash([8,6]);octx.beginPath();octx.moveTo(0,gy*h);octx.lineTo(w,gy*h);octx.stroke();octx.setLineDash([]);if(frame.landmarks&&$('showRefs').checked)drawRefs(frame.landmarks,w,h);const m=frame.metrics;if(m){const l=m.leftKnee?.value,r=m.rightKnee?.value;$('angleNow').textContent=`L ${fmtAngle(l,m.leftKnee)} / R ${fmtAngle(r,m.rightKnee)}`}}
function drawPose(lm,w,h,alpha,lineWidth){octx.save();octx.globalAlpha=alpha;octx.strokeStyle='#38bdf8';octx.fillStyle='#f8fafc';octx.lineWidth=lineWidth;for(const [a,b] of LINKS){const p=lm[a],q=lm[b];if(!p||!q||(p.visibility??1)<.2||(q.visibility??1)<.2)continue;octx.beginPath();octx.moveTo(p.x*w,p.y*h);octx.lineTo(q.x*w,q.y*h);octx.stroke()}for(const i of [11,12,23,24,25,26,27,28,29,30,31,32]){const p=lm[i];if(!p||(p.visibility??1)<.2)continue;octx.beginPath();octx.arc(p.x*w,p.y*h,p.manual?6:3.5,0,Math.PI*2);octx.fill()}const b=bboxFromLandmarks(lm);if(b){octx.strokeStyle='#f59e0b';octx.strokeRect(b.x1*w,b.y1*h,(b.x2-b.x1)*w,(b.y2-b.y1)*h)}octx.restore()}
function drawRefs(lm,w,h){const pairs=[[11,12],[23,24]];octx.save();octx.strokeStyle='#f43f5e';octx.lineWidth=2;for(const [a,b] of pairs){if(lm[a]&&lm[b]){octx.beginPath();octx.moveTo(lm[a].x*w,lm[a].y*h);octx.lineTo(lm[b].x*w,lm[b].y*h);octx.stroke()}}if(lm[11]&&lm[12]&&lm[23]&&lm[24]){const sx=(lm[11].x+lm[12].x)/2,sy=(lm[11].y+lm[12].y)/2,hx=(lm[23].x+lm[24].x)/2,hy=(lm[23].y+lm[24].y)/2;octx.beginPath();octx.moveTo(sx*w,sy*h);octx.lineTo(hx*w,hy*h);octx.stroke()}octx.restore()}

function drawChart(){const dpr=devicePixelRatio||1;const cssW=chart.clientWidth||600,cssH=260;chart.width=Math.round(cssW*dpr);chart.height=Math.round(cssH*dpr);cctx.setTransform(dpr,0,0,dpr,0,0);cctx.clearRect(0,0,cssW,cssH);cctx.fillStyle='#fbfdff';cctx.fillRect(0,0,cssW,cssH);cctx.strokeStyle='#e2e8f0';cctx.lineWidth=1;for(const a of [120,140,160,180]){const y=mapY(a,cssH);cctx.beginPath();cctx.moveTo(36,y);cctx.lineTo(cssW-8,y);cctx.stroke();cctx.fillStyle='#64748b';cctx.font='11px system-ui';cctx.fillText(String(a),4,y+4)}if(state.frames.length<2)return;drawBand('leftKnee','#0f766e33',cssW,cssH);drawBand('rightKnee','#7c3aed22',cssW,cssH);drawLine('leftKnee','#0f766e',cssW,cssH);drawLine('rightKnee','#7c3aed',cssW,cssH);const x=36+(video.currentTime/(video.duration||1))*(cssW-44);cctx.strokeStyle='#ef4444';cctx.beginPath();cctx.moveTo(x,8);cctx.lineTo(x,cssH-20);cctx.stroke()}
function mapY(a,h){return 8+(180-(a??180))/70*(h-36)}
function drawLine(key,color,w,h){cctx.strokeStyle=color;cctx.lineWidth=2;cctx.beginPath();let started=false;for(const f of state.frames){const v=f.metrics?.[key]?.value;if(v==null)continue;const x=36+f.t/(video.duration||1)*(w-44),y=mapY(v,h);if(!started){cctx.moveTo(x,y);started=true}else cctx.lineTo(x,y)}cctx.stroke()}
function drawBand(key,color,w,h){const pts=state.frames.map(f=>({t:f.t,m:f.metrics?.[key]})).filter(x=>x.m?.low!=null);if(pts.length<2)return;cctx.fillStyle=color;cctx.beginPath();pts.forEach((p,i)=>{const x=36+p.t/(video.duration||1)*(w-44),y=mapY(p.m.high,h);i?cctx.lineTo(x,y):cctx.moveTo(x,y)});[...pts].reverse().forEach(p=>{const x=36+p.t/(video.duration||1)*(w-44),y=mapY(p.m.low,h);cctx.lineTo(x,y)});cctx.closePath();cctx.fill()}

function buildReport(){if(!state.frames.length){state.report=null;return}const gy=+$('groundSlider').value;const fps=+$('sampleFps').value||30;const flights=flightIntervals(state.frames,gy,fps);const valid=state.frames.filter(f=>f.landmarks).length;const l=state.frames.map(f=>f.metrics?.leftKnee?.value).filter(Number.isFinite),r=state.frames.map(f=>f.metrics?.rightKnee?.value).filter(Number.isFinite);const minL=l.length?Math.min(...l):null,minR=r.length?Math.min(...r):null;state.report={schema:3,engine:state.version,created:new Date().toISOString(),settings:{athlete:$('athlete').value,date:$('date').value,view:$('view').value,direction:$('direction').value,fps:+$('fps').value,sampleFps:fps,uncertaintyEnabled:$('uncertaintyEnabled').checked,pointSigmaPx:+$('sigmaPx').value,groundY:gy,clipSeconds:+$('clipSeconds').value},summary:{frames:state.frames.length,trackedFrames:valid,continuity:valid/state.frames.length,maxPeople:state.maxPeople,minLeftKnee:minL,minRightKnee:minR,flightIntervals:flights.length,manualCorrections:state.frames.reduce((n,f)=>n+(f.landmarks?.filter?.(p=>p?.manual).length||0),0)},flights,frames:state.frames.map(f=>({t:f.t,peopleCount:f.peopleCount,trackState:f.trackState,landmarks:f.landmarks,metrics:f.metrics}))};renderQuick();renderReport()}
function renderQuick(){if(!state.report)return;const s=state.report.summary;$('quickStats').innerHTML=`${stat('追蹤連續率',(s.continuity*100).toFixed(1)+'%')}${stat('最多同框',s.maxPeople+' 人')}${stat('左膝最小角',s.minLeftKnee==null?'—':s.minLeftKnee.toFixed(1)+'°')}${stat('右膝最小角',s.minRightKnee==null?'—':s.minRightKnee.toFixed(1)+'°')}`;$('events').innerHTML=state.report.flights.length?state.report.flights.map((e,i)=>`<div class="event"><span>疑似雙腳離地 #${i+1} · ${formatTime(e.startTime)}–${formatTime(e.endTime)} · ${e.lowerMs.toFixed(0)}–${e.upperMs.toFixed(0)} ms</span><button data-seek="${e.startTime}">複查</button></div>`).join(''):'<p class="muted">未標記疑似雙腳離地；不代表已通過正式競走判定。</p>';document.querySelectorAll('[data-seek]').forEach(b=>b.onclick=()=>{if(!state.analyzing)video.currentTime=+b.dataset.seek;});}
function stat(k,v){return `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`}
function renderReport(){if(!state.report){$('reportBody').innerHTML='<p>完成分析後會產生本次報告。</p>';return}const r=state.report,s=r.summary;$('reportBody').innerHTML=`<h3>${escapeHtml(r.settings.athlete)} · ${r.settings.date}</h3><p>引擎：${r.engine} ｜ 取樣 ${r.settings.sampleFps} fps ｜ 誤差模擬 ${r.settings.uncertaintyEnabled?`開啟（σ=${r.settings.pointSigmaPx}px）`:'關閉'}</p><table><tr><th>指標</th><th>結果</th></tr><tr><td>追蹤連續率</td><td>${(s.continuity*100).toFixed(1)}%</td></tr><tr><td>最多同框人物</td><td>${s.maxPeople}</td></tr><tr><td>左膝最小角</td><td>${num(s.minLeftKnee)}°</td></tr><tr><td>右膝最小角</td><td>${num(s.minRightKnee)}°</td></tr><tr><td>疑似雙腳離地區間</td><td>${s.flightIntervals}</td></tr><tr><td>人工修正點數</td><td>${s.manualCorrections}</td></tr></table><p class="muted">AI 僅提供篩查與複查證據，不輸出正式犯規判決。</p>`}

$('monkeyBtn').onclick=()=>{try{const r=runMonkeyCore(1000);$('monkeyResult').textContent=`PASS\n${r.passed}/${r.iterations} invariants passed\nangle range / uncertainty containment OK\n此為核心隨機測試，不是影片準確度驗證。`;}catch(e){$('monkeyResult').textContent='FAIL\n'+e.stack}};
$('exportJson').onclick=()=>state.report&&download(`racewalk-${$('date').value}.json`,JSON.stringify(state.report,null,2),'application/json');
$('exportCsv').onclick=()=>{if(!state.report)return;const rows=[['t','people','track','leftKnee','leftLow','leftHigh','rightKnee','rightLow','rightHigh']];for(const f of state.frames){rows.push([f.t,f.peopleCount,f.trackState,f.metrics?.leftKnee?.value??'',f.metrics?.leftKnee?.low??'',f.metrics?.leftKnee?.high??'',f.metrics?.rightKnee?.value??'',f.metrics?.rightKnee?.low??'',f.metrics?.rightKnee?.high??''])}download(`racewalk-${$('date').value}.csv`,rows.map(r=>r.join(',')).join('\n'),'text/csv')};
$('exportHtml').onclick=()=>{if(!state.report)return;const html=`<!doctype html><meta charset="utf-8"><title>RaceWalk Report</title><style>body{font-family:system-ui;padding:32px;max-width:900px;margin:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}</style><h1>RaceWalk Lab 報告</h1>${$('reportBody').innerHTML}`;download(`racewalk-${$('date').value}.html`,html,'text/html')};
function download(name,text,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

function readRecords(){try{const value=JSON.parse(localStorage.getItem('racewalk-v3-records')||'[]');return Array.isArray(value)?value:[];}catch{return [];}}
function saveRecord(){if(!state.report)return;try{const list=readRecords();list.unshift({created:state.report.created,settings:state.report.settings,summary:state.report.summary});localStorage.setItem('racewalk-v3-records',JSON.stringify(list.slice(0,50)));}catch{$('recordList').textContent='此瀏覽器無法保存本機紀錄；請匯出 JSON 保存分析結果。';}}
function renderRecords(){const list=readRecords();$('recordList').innerHTML=list.length?list.map(x=>`<div class="record"><strong>${escapeHtml(x.settings?.athlete||'')}</strong> · ${escapeHtml(x.settings?.date||'')}</div>`).join(''):'<p class="muted">尚無本機紀錄。</p>';}
$('clearRecords').onclick=()=>{if(confirm('確定清除本機訓練紀錄？')){try{localStorage.removeItem('racewalk-v3-records');renderRecords();}catch{$('recordList').textContent='本機儲存不可用。';}}};

function formatTime(s){if(!Number.isFinite(s))return'00:00.000';const m=Math.floor(s/60),sec=s-m*60;return `${String(m).padStart(2,'0')}:${sec.toFixed(3).padStart(6,'0')}`}
function fmtAngle(v,b){if(v==null)return'—';return `${v.toFixed(1)}°${b&&b.low!=null?` [${b.low.toFixed(1)}–${b.high.toFixed(1)}]`:''}`}
function num(v){return Number.isFinite(v)?v.toFixed(1):'—'}
function escapeHtml(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

setPhase('idle');updateControls();
document.documentElement.dataset.appReady='true';
ensureAi().catch(()=>{});
