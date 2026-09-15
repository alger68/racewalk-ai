import { bboxFromLandmarks, estimateGroundY, flightIntervals, supportKnee, computeFrameMetrics, runMonkeyCore } from './core.js?v=3.0.4';
import { LockedTarget, describePose, selectionCandidates, sampleAppearance, contentRect } from './target-lock.js?v=3.0.4';
import { createPoseEngine } from './ai-loader.js?v=3.0.4';
const $=id=>document.getElementById(id);
const state={landmarker:null,aiPromise:null,videoUrl:null,clickPoint:null,clickTime:0,frames:[],maxPeople:0,analyzing:false,stop:false,manual:false,report:null,lastTimestamp:0,version:'rw-3.0.4-target-lock',phase:'idle',lastError:null,phaseLog:[],previewPeople:[],previewTime:0,pendingTarget:null,targetSelection:null,runSelection:null,trackingStop:null,selectionIntent:null,selectionSerial:0,boxSelecting:false,draftBox:null,ignoreNextClick:false};
const video=$('video'),overlay=$('overlay'),chart=$('chart'),octx=overlay.getContext('2d'),cctx=chart.getContext('2d');
const LINKS=[[11,12],[11,23],[12,24],[23,24],[23,25],[25,27],[27,29],[29,31],[24,26],[26,28],[28,30],[30,32],[27,31],[28,32]];
const today=new Date();$('date').value=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
const appearanceCanvas=document.createElement('canvas'),previewCanvas=document.createElement('canvas');
let previewAppearances=[],mediaTimer=null,dragStart=null;
const clonePose=lm=>lm.map(p=>p?{...p}:p);
const timeTolerance=()=>Math.min(.025,.5/(+$('fps').value||60));
const flow=document.createElement('section');flow.id='analysisFlow';flow.className='analysis-flow';
flow.innerHTML='<strong>指定選手 → 確認縮圖 → 開始鎖定分析</strong><p id="flowChecklist"></p><div class="actions compact"><button id="startHereBtn" class="primary">開始 AI 分析</button><button id="scanPeopleBtn">辨識目前畫面人物</button><button id="selectBoxBtn" aria-pressed="false">框選指定選手</button><button id="clearTargetBtn">重新選人</button><button id="diagnosticBtn">下載診斷</button></div><label class="clip-label">本次分析長度 <input id="clipSeconds" type="number" min="1" max="60" step="1" value="15"> 秒（從確認的影格開始）</label><p id="flowStatus" role="status" aria-live="polite"></p><div id="candidateList"></div><div id="targetConfirm" hidden><canvas id="targetThumbnail" width="112" height="132" aria-label="待確認的指定選手縮圖"></canvas><strong id="targetConfirmText"></strong><button id="confirmTargetBtn" class="primary">確認這位選手</button></div><p id="targetPolicy">只追蹤已確認的選手；失聯、重疊或配對不明確時暫停，不自動換人。</p>';
$('stage').before(flow);
const liveProgress=document.createElement('div');liveProgress.id='liveProgress';liveProgress.hidden=true;document.body.append(liveProgress);
new MutationObserver(()=>{$('flowStatus').textContent=$('status').textContent;liveProgress.textContent=$('status').textContent;}).observe($('status'),{childList:true,subtree:true,characterData:true});
function setPhase(phase,message){state.phase=phase;document.documentElement.dataset.analysisPhase=phase;if(message)$('status').textContent=message;state.phaseLog.push({phase,time:new Date().toISOString()});if(state.phaseLog.length>40)state.phaseLog.shift();}
function noteError(code,error){state.lastError={code,message:String(error?.message||error)};setPhase('error',`分析未完成 [${code}]：${state.lastError.message}。可按「下載診斷」保存目前狀態。`);}
function clearPreview(){state.previewPeople=[];$('candidateList').replaceChildren();}
function resetTarget(){state.pendingTarget=null;state.targetSelection=null;state.clickPoint=null;state.selectionIntent=null;state.draftBox=null;$('targetConfirm').hidden=true;clearPreview();}
function selectionStillCurrent(t){return !video.seeking&&Math.abs(video.currentTime-t)<=timeTolerance();}
function pickCandidate(index){
 if(state.analyzing)return;
 if(!selectionStillCurrent(state.previewTime)){resetTarget();noteError('TARGET_EXPIRED','影片時間已改變，請在新起點重新指定');updateControls();return;}
 const pose=state.previewPeople[index];if(!pose)return;
 if(!describePose(pose,video.videoWidth/video.videoHeight)){noteError('TARGET_QUALITY','此人肩髖點不足，請改選清楚影格或框選整位選手');return;}
 state.manual=false;$('manualToggle').textContent='人工修點：關';$('stage').classList.remove('manual-active');
 // Capture the exact pose and complete candidate array, not merely its center.
 state.pendingTarget={landmarks:clonePose(pose),people:state.previewPeople.map(clonePose),index,time:state.previewTime,appearance:previewAppearances[index]??null,method:state.selectionIntent?.kind||'thumbnail'};
 state.targetSelection=null;state.clickPoint=null;
 const sourceThumb=$('candidateList').querySelector(`[data-person-index="${index}"] canvas`),tc=$('targetThumbnail').getContext('2d');tc.clearRect(0,0,112,132);if(sourceThumb)tc.drawImage(sourceThumb,0,0,112,132);
 $('targetConfirm').hidden=false;$('targetConfirmText').textContent=`候選人物 ${index+1}（${formatTime(state.previewTime)}）：請核對影片中的金色框，再按「確認這位選手」。`;$('confirmTargetBtn').hidden=false;
 setPhase('confirm-target','尚未開始分析。請确认金色框內是不是你指定的人；不對可改點其他縮圖或重新框選。');updateControls();drawCurrent();
}
$('confirmTargetBtn').onclick=()=>{
 if(state.analyzing||!state.pendingTarget)return;
 if(!selectionStillCurrent(state.pendingTarget.time)){resetTarget();noteError('TARGET_EXPIRED','影片起點已改變，請重新指定');updateControls();return;}
 const target=state.pendingTarget;state.targetSelection={...target,id:`T${String(++state.selectionSerial).padStart(3,'0')}`};state.pendingTarget=null;state.clickTime=target.time;
 const box=bboxFromLandmarks(target.landmarks);state.clickPoint={x:box.cx,y:box.cy};
 $('targetConfirmText').textContent=`已確認 ${state.targetSelection.id}，起點 ${formatTime(target.time)}。按「開始鎖定分析」。`;$('confirmTargetBtn').hidden=true;$('clickHint').style.display='none';clearPreview();
 setPhase('target-confirmed',`已指定 ${state.targetSelection.id}。從你確認的骨架開始；若失聯不會用旁人取代。`);updateControls();drawCurrent();
};
function showPeople(people,t,refreshPixels=true){
 // Capture pixels while video is presented; thumbnail clicks may scroll it offscreen on WebKit.
 if(refreshPixels){previewCanvas.width=video.videoWidth;previewCanvas.height=video.videoHeight;previewCanvas.getContext('2d').drawImage(video,0,0);previewAppearances=people.map(lm=>sampleAppearance(video,lm,appearanceCanvas));}
 state.previewPeople=people.map(clonePose);state.previewTime=t;state.pendingTarget=null;state.targetSelection=null;$('targetConfirm').hidden=true;$('candidateList').replaceChildren();
 const eligible=selectionCandidates(state.previewPeople,state.selectionIntent,video.videoWidth/video.videoHeight);
 if(!eligible.length){setPhase('no-selected-person','你指定的位置／框內沒有可靠的選手骨架；未改選旁邊的人。請移到清楚影格，按「框選指定選手」框住整位選手。');drawCurrent();return;}
 for(const i of eligible){
  const lm=state.previewPeople[i],box=bboxFromLandmarks(lm),torso=describePose(lm,video.videoWidth/video.videoHeight);
  const button=document.createElement('button');button.type='button';button.className='person-choice';button.dataset.personIndex=i;button.dataset.centerX=torso.x;button.dataset.centerY=torso.y;
  const thumb=document.createElement('canvas');thumb.width=112;thumb.height=132;
  const sx=Math.max(0,box.x1)*video.videoWidth,sy=Math.max(0,box.y1)*video.videoHeight,sw=Math.min(video.videoWidth-sx,(box.x2-box.x1)*video.videoWidth),sh=Math.min(video.videoHeight-sy,(box.y2-box.y1)*video.videoHeight);
  if(sw>0&&sh>0){const ctx=thumb.getContext('2d'),k=Math.min(112/sw,132/sh);ctx.fillStyle='#0f172a';ctx.fillRect(0,0,112,132);ctx.drawImage(previewCanvas,sx,sy,sw,sh,(112-sw*k)/2,(132-sh*k)/2,sw*k,sh*k);}
  const label=document.createElement('span');label.textContent=`選取人物 ${i+1}`;button.append(thumb,label);button.onclick=()=>pickCandidate(i);$('candidateList').append(button);
 }
 setPhase('select-target',`有 ${eligible.length} 位候選，請點縮圖再確認。編號只對應目前影格，不是永久人物 ID；即使只偵測到 1 人也不會自動選取。`);drawCurrent();
}
function drawPeoplePreview(){
 const rect=overlay.getBoundingClientRect(),w=rect.width,h=rect.height,livePreview=state.previewPeople.length&&selectionStillCurrent(state.previewTime);
 if(livePreview){octx.clearRect(0,0,w,h);state.previewPeople.forEach((lm,i)=>{drawPose(lm,w,h,.25,1);const b=bboxFromLandmarks(lm);if(!b)return;const x=Math.max(0,b.x1*w),y=Math.max(24,b.y1*h);octx.fillStyle='#334155';octx.fillRect(x,y-24,75,24);octx.fillStyle='white';octx.font='bold 14px system-ui';octx.fillText(`人物 ${i+1}`,x+6,y-7);});}
 const target=state.pendingTarget||state.targetSelection;
 if(target&&selectionStillCurrent(target.time)&&!state.analyzing){if(!livePreview)octx.clearRect(0,0,w,h);drawPose(target.landmarks,w,h,1,3);drawSelectedBox(target.landmarks,w,h,state.targetSelection?.id||'待確認');}
 const roi=state.draftBox||state.selectionIntent?.box;
 if(roi&&!state.analyzing){octx.save();octx.strokeStyle='#06b6d4';octx.lineWidth=3;octx.setLineDash([6,4]);octx.strokeRect(roi.x1*w,roi.y1*h,(roi.x2-roi.x1)*w,(roi.y2-roi.y1)*h);octx.restore();}
}
function drawSelectedBox(lm,w,h,label){const b=bboxFromLandmarks(lm);if(!b)return;octx.save();octx.strokeStyle='#f59e0b';octx.lineWidth=4;octx.strokeRect(b.x1*w,b.y1*h,(b.x2-b.x1)*w,(b.y2-b.y1)*h);octx.fillStyle='#78350f';const x=Math.max(0,b.x1*w),y=Math.max(24,b.y1*h);octx.fillRect(x,y-24,120,24);octx.fillStyle='white';octx.font='bold 14px system-ui';octx.fillText(`指定 ${label}`,x+5,y-7);octx.restore();}
function diagnostic(){return {schema:1,engine:state.version,created:new Date().toISOString(),phase:state.phase,lastError:state.lastError,ai:{loaded:!!state.landmarker,loading:!!state.aiPromise,badge:$('engineBadge').textContent},browser:{userAgent:navigator.userAgent,hidden:document.hidden,secureContext:isSecureContext,viewport:[innerWidth,innerHeight]},media:{selected:!!state.videoUrl,mime:$('videoInput').files?.[0]?.type||'',readyState:video.readyState,networkState:video.networkState,errorCode:video.error?.code??null,width:video.videoWidth,height:video.videoHeight,duration:Number.isFinite(video.duration)?video.duration:null,currentTime:video.currentTime,seeking:video.seeking,paused:video.paused},analysis:{targetSelected:!!state.targetSelection,targetId:state.targetSelection?.id??null,confirmationPending:!!state.pendingTarget,trackingStop:state.trackingStop,targetTime:state.clickTime,detectedPeople:state.previewPeople.length,frames:state.frames.length,maxPeople:state.maxPeople,busy:state.analyzing,clipSeconds:Number($('clipSeconds').value)},phaseLog:state.phaseLog,privacy:'No video, image, name, athlete fields, landmarks, appearance histograms or local records included.'};}
$('diagnosticBtn').onclick=()=>download('RaceWalk-3.0.4-diagnostic.json',JSON.stringify(diagnostic(),null,2),'application/json');
$('startHereBtn').onclick=()=>analyze();
$('scanPeopleBtn').onclick=()=>{if(state.analyzing)return;resetTarget();analyze(true);};
$('clearTargetBtn').onclick=()=>{if(state.analyzing)return;resetTarget();$('clickHint').style.display='block';setPhase('idle','已解除指定；先前報告仍保留。請框選或辨識人物，再確認新目標。');updateControls();drawCurrent();};
async function waitForMedia(){
 if(video.error)throw new Error(`影片解碼錯誤 ${video.error.code}；請先確認此瀏覽器能播放原片`);
 if(video.readyState>=2&&video.videoWidth&&Number.isFinite(video.duration)&&video.duration>0)return;
 video.scrollIntoView({block:'center',behavior:'instant'});setPhase('media','正在讀取影片影格…');
 await new Promise((resolve,reject)=>{let done=false;const clean=()=>{clearTimeout(timer);video.removeEventListener('loadeddata',check);video.removeEventListener('canplay',check);video.removeEventListener('error',fail);};const finish=e=>{if(done)return;done=true;clean();video.pause();e?reject(e):resolve();};const check=()=>{if(video.readyState>=2&&video.videoWidth&&Number.isFinite(video.duration)&&video.duration>0)finish();};const fail=()=>finish(new Error(`影片解碼失敗（${video.error?.code??'?'}）`));const timer=setTimeout(()=>finish(new Error('影片未提供可分析影格，請按播放確認；支援與否取決於影片編碼，不能只改副檔名')),10000);video.addEventListener('loadeddata',check);video.addEventListener('canplay',check);video.addEventListener('error',fail);video.play().then(check).catch(()=>{});check();});
}
function updateControls(){
 const ready=!!state.videoUrl&&video.readyState>=2&&Number.isFinite(video.duration)&&video.duration>0;
 for(const id of ['analyzeBtn','startHereBtn','scanPeopleBtn','clearTargetBtn','selectBoxBtn','confirmTargetBtn'])$(id).disabled=state.analyzing;
 const label=state.targetSelection?'開始鎖定分析':state.pendingTarget?'請先確認這位選手':'開始 AI 分析';$('analyzeBtn').textContent=label;$('startHereBtn').textContent=label;
 $('flowChecklist').textContent=`AI：${state.landmarker?'已就緒':state.aiPromise?'載入中':'待載入'} ｜ 影片：${video.error?'解碼錯誤':ready?'已解碼':state.videoUrl?'等待影格':'未匯入'} ｜ 目標：${state.targetSelection?state.targetSelection.id+' 已確認':state.pendingTarget?'待確認縮圖':'尚未指定'}`;
 $('stopBtn').disabled=!state.analyzing;liveProgress.hidden=!state.analyzing;$('stopBtn').style.cssText=state.analyzing?'position:fixed;right:16px;bottom:16px;z-index:999;background:#991b1b;color:white;padding:14px 24px;box-shadow:0 4px 18px #0004':'';
 $('initAi').disabled=!!state.aiPromise||state.analyzing;
 for(const id of ['videoInput','timeSlider','prevFrame','nextFrame','manualToggle','manualJoint','fps','sampleFps','groundSlider','sigmaPx','uncertaintyEnabled','playPause','clipSeconds'])if($(id))$(id).disabled=state.analyzing;
}
function mediaMessage(text,error=false){$('mediaStatus').textContent=text;$('mediaStatus').dataset.error=error?'true':'false';}
async function ensureAi(){
 if(state.landmarker)return state.landmarker;if(state.aiPromise)return state.aiPromise;
 $('initAi').textContent='AI 載入中…';$('engineBadge').textContent='AI 載入中';
 state.aiPromise=createPoseEngine({onStatus(text){$('engineBadge').textContent=text;if(!state.analyzing)$('status').textContent=text;}}).then(engine=>{state.landmarker=engine;$('engineBadge').textContent='AI 已載入 · 最多 6 人';if(!state.analyzing)$('status').textContent='AI 已就緒。請框選指定選手，或辨識人物後確認縮圖；模型就緒不代表已鎖定目標。';$('initAi').textContent='AI 已就緒';return engine;}).catch(error=>{$('engineBadge').textContent='AI 載入失敗 · 可重試';$('status').textContent=`AI 載入失敗：${error.message}。影片播放與介面仍可使用，請按「重試 AI」。`;$('initAi').textContent='重試 AI';throw error;}).finally(()=>{state.aiPromise=null;updateControls();});updateControls();return state.aiPromise;
}
$('initAi').addEventListener('click',()=>{ensureAi().catch(()=>{});});
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{if(state.analyzing){$('status').textContent='分析中，請先按「停止」後再切換頁籤。';return;}document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$(btn.dataset.tab).classList.add('active');if(btn.dataset.tab==='report')renderReport();if(btn.dataset.tab==='records')renderRecords();if(btn.dataset.tab==='analyze')drawCurrent();}));
function syncCanvas(){const r=video.getBoundingClientRect(),stage=$('stage').getBoundingClientRect(),fit=contentRect(r.width,r.height,video.videoWidth,video.videoHeight),dpr=devicePixelRatio||1;overlay.style.left=`${r.left-stage.left+fit.x}px`;overlay.style.top=`${r.top-stage.top+fit.y}px`;overlay.style.right='auto';overlay.style.bottom='auto';overlay.style.width=`${fit.width}px`;overlay.style.height=`${fit.height}px`;overlay.width=Math.max(1,Math.round(fit.width*dpr));overlay.height=Math.max(1,Math.round(fit.height*dpr));octx.setTransform(dpr,0,0,dpr,0,0);}
window.addEventListener('resize',()=>{syncCanvas();drawCurrent();});
$('videoInput').addEventListener('change',e=>{
 const f=e.target.files?.[0];if(!f||state.analyzing)return;video.pause();clearTimeout(mediaTimer);if(state.videoUrl)URL.revokeObjectURL(state.videoUrl);
 state.videoUrl=URL.createObjectURL(f);state.frames=[];state.clickTime=0;state.report=null;state.maxPeople=0;state.lastError=null;state.runSelection=null;state.trackingStop=null;resetTarget();boxMode(false);setPhase('media','正在匯入影片…');
 $('clickHint').style.display='block';$('clickHint').textContent='等待影片解碼…';$('personCount').textContent='0 / 0';$('quickStats').replaceChildren();$('events').replaceChildren();$('angleNow').textContent='L — / R —';$('progressBar').style.width='0%';$('timeSlider').value=0;$('timeSlider').max=0;
 mediaMessage(`正在讀取 ${f.name}…`);video.src=state.videoUrl;video.load();updateControls();renderReport();drawCurrent();const expectedUrl=state.videoUrl;
 mediaTimer=setTimeout(()=>{if(state.videoUrl===expectedUrl&&video.readyState<2)mediaMessage('影片尚未完成解碼。請先按播放；若一直黑畫面，改用此瀏覽器可播放的 H.264 MP4（不是直接修改副檔名）。',true);},15000);
});
video.addEventListener('loadedmetadata',()=>{syncCanvas();$('timeSlider').max=Number.isFinite(video.duration)?video.duration:0;mediaMessage(`影片資訊已讀取：${video.videoWidth} × ${video.videoHeight}，${formatTime(video.duration)}；等待畫面解碼。`);updateControls();drawCurrent();});
video.addEventListener('loadeddata',()=>{clearTimeout(mediaTimer);mediaMessage(`影片已就緒：${video.videoWidth} × ${video.videoHeight}，${formatTime(video.duration)}。`);$('clickHint').textContent='框選或點選目標，再確認縮圖';updateControls();drawCurrent();});
video.addEventListener('canplay',updateControls);
video.addEventListener('error',()=>{clearTimeout(mediaTimer);state.stop=true;mediaMessage(`影片解碼失敗（${video.error?.code??'?'}）。MOV/MP4 是容器；請確認影片能在此瀏覽器播放，必要時轉成 H.264 MP4，勿只改副檔名。`,true);updateControls();});
video.addEventListener('timeupdate',()=>{$('timeSlider').value=video.currentTime;$('timeText').textContent=formatTime(video.currentTime);if(!state.analyzing)drawCurrent();});
video.addEventListener('seeked',()=>{if(state.analyzing||state.manual)return;const target=state.pendingTarget||state.targetSelection;if(target&&!selectionStillCurrent(target.time)){resetTarget();setPhase('select-target','影片時間已變更，請在新的起點重新指定選手；舊報告仍可匯出。');updateControls();drawCurrent();}});
video.addEventListener('pause',()=>{$('playPause').textContent='播放 / 暫停';});
$('playPause').onclick=async()=>{if(state.analyzing||!state.videoUrl)return;try{if(video.paused){await video.play();$('playPause').textContent='暫停';}else video.pause();}catch(e){mediaMessage(`無法播放：${e.message}`,true);}};
$('timeSlider').addEventListener('input',()=>{if(!state.analyzing&&video.readyState>=1)video.currentTime=+$('timeSlider').value;});
$('prevFrame').addEventListener('click',()=>{if(video.readyState>=1)video.currentTime=Math.max(0,video.currentTime-1/(+$('fps').value||60));});
$('nextFrame').addEventListener('click',()=>{if(video.readyState>=1)video.currentTime=Math.min(Math.max(0,video.duration-.001),video.currentTime+1/(+$('fps').value||60));});
function pointOnVideo(e){const r=overlay.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
function requestSelection(intent){resetTarget();state.manual=false;$('manualToggle').textContent='人工修點：關';$('stage').classList.remove('manual-active');state.selectionIntent=intent;state.clickTime=video.currentTime;$('clickHint').style.display='none';setPhase('select-target','正在辨識你指定的位置；不會改選位置以外的人。');updateControls();drawCurrent();analyze(true);}
overlay.addEventListener('click',e=>{
 if(state.ignoreNextClick){state.ignoreNextClick=false;return;}if(state.analyzing||video.readyState<2||state.boxSelecting)return;video.pause();const p=pointOnVideo(e);
 if(state.manual&&state.frames.length){const f=nearestFrame(video.currentTime);if(f?.landmarks){const idx=+$('manualJoint').value;f.landmarks[idx]={...(f.landmarks[idx]||{}),x:p.x,y:p.y,visibility:1,presence:1,manual:true};f.metrics=metricsFor(f);drawCurrent();buildReport();$('status').textContent=`人工修正 ${$('manualJoint').selectedOptions[0].text} @ ${formatTime(f.t)}`;}else $('status').textContent='此格沒有指定選手的可靠骨架，不會拿旁人的骨架供修正。';return;}
 if(state.previewPeople.length&&selectionStillCurrent(state.previewTime)){const eligible=selectionCandidates(state.previewPeople,{kind:'point',point:p},video.videoWidth/video.videoHeight);if(eligible.length===1){pickCandidate(eligible[0]);return;}state.selectionIntent={kind:'point',point:p};showPeople(state.previewPeople,video.currentTime,false);updateControls();return;}
 requestSelection({kind:'point',point:p});
});
function boxMode(active){state.boxSelecting=active;overlay.style.touchAction=active?'none':'manipulation';$('selectBoxBtn').textContent=active?'取消框選':'框選指定選手';$('selectBoxBtn').setAttribute('aria-pressed',String(active));$('stage').classList.toggle('roi-selecting',active);}
$('selectBoxBtn').onclick=()=>{if(state.analyzing)return;if(!state.videoUrl||video.readyState<2){noteError('NO_FRAME','請先匯入可播放的影片');return;}video.pause();boxMode(!state.boxSelecting);state.manual=false;$('manualToggle').textContent='人工修點：關';if(state.boxSelecting){resetTarget();setPhase('select-target','請拖曳框住整位指定選手；框內有多人時仍需選縮圖確認。');video.scrollIntoView({block:'center',behavior:'instant'});}drawCurrent();updateControls();};
overlay.addEventListener('pointerdown',e=>{if(!state.boxSelecting||state.analyzing||e.button!==0)return;e.preventDefault();video.pause();dragStart={p:pointOnVideo(e),id:e.pointerId};overlay.setPointerCapture(e.pointerId);});
overlay.addEventListener('pointermove',e=>{if(!dragStart||e.pointerId!==dragStart.id)return;e.preventDefault();const p=pointOnVideo(e),a=dragStart.p;state.draftBox={x1:Math.min(a.x,p.x),y1:Math.min(a.y,p.y),x2:Math.max(a.x,p.x),y2:Math.max(a.y,p.y)};drawCurrent();});
overlay.addEventListener('pointerup',e=>{if(!dragStart||e.pointerId!==dragStart.id)return;e.preventDefault();const p=pointOnVideo(e),a=dragStart.p,r=overlay.getBoundingClientRect(),box={x1:Math.min(a.x,p.x),y1:Math.min(a.y,p.y),x2:Math.max(a.x,p.x),y2:Math.max(a.y,p.y)};dragStart=null;state.draftBox=null;if(overlay.hasPointerCapture(e.pointerId))overlay.releasePointerCapture(e.pointerId);state.ignoreNextClick=true;setTimeout(()=>{state.ignoreNextClick=false;},500);if((box.x2-box.x1)*r.width<12||(box.y2-box.y1)*r.height<20){setPhase('select-target','框太小，請框住整位選手；沒有自動改選人物。');drawCurrent();return;}boxMode(false);requestSelection({kind:'box',box});});
overlay.addEventListener('pointercancel',()=>{dragStart=null;state.draftBox=null;drawCurrent();});
$('manualToggle').addEventListener('click',()=>{state.manual=!state.manual;$('manualToggle').textContent=`人工修點：${state.manual?'開':'關'}`;$('stage').classList.toggle('manual-active',state.manual);});
$('showSkeleton').onchange=drawCurrent;$('showRefs').onchange=drawCurrent;$('showAllPeople').onchange=drawCurrent;$('groundSlider').oninput=()=>{drawCurrent();buildReport();};$('uncertaintyEnabled').onchange=recomputeAll;$('sigmaPx').onchange=recomputeAll;
function seek(t){return new Promise((resolve,reject)=>{let timer;const clean=()=>{clearTimeout(timer);video.removeEventListener('seeked',check);video.removeEventListener('loadeddata',check);video.removeEventListener('canplay',check);video.removeEventListener('error',fail);};const fail=()=>{clean();reject(new Error('影片解碼失敗，無法讀取影格'));};const check=()=>{if(state.stop){clean();resolve();return;}if(!video.seeking&&Math.abs(video.currentTime-t)<.05&&video.readyState>=2){clean();resolve();}};video.addEventListener('seeked',check);video.addEventListener('loadeddata',check);video.addEventListener('canplay',check);video.addEventListener('error',fail);timer=setTimeout(()=>{clean();reject(new Error(`讀取 ${formatTime(t)} 影格逾時，請確認影片可播放`));},10000);try{if(Math.abs(video.currentTime-t)>.0005)video.currentTime=t;check();}catch(e){clean();reject(e);}});}
async function presentFrame(){
 if(document.hidden)throw new Error('網頁已進入背景，請回到前景後重新分析');
 const visible=()=>{const r=video.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;};if(!visible())video.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
 // WebKit may expose decoded metadata before presenting offscreen video pixels.
 await new Promise((resolve,reject)=>{let first=0,second=0,done=false;const finish=error=>{if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(first);cancelAnimationFrame(second);error?reject(error):resolve();};const timer=setTimeout(()=>finish(new Error('影片畫面未能呈現，請保持分析頁面在前景')),2000);first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>finish());});});
 if(document.hidden||!visible())throw new Error('影片不在可見範圍，請保持分析工作台開啟後重試');
}
function metricsFor(f){return computeFrameMetrics(f,{uncertaintyEnabled:$('uncertaintyEnabled').checked,sigmaPx:+$('sigmaPx').value||0,width:video.videoWidth||1920,height:video.videoHeight||1080});}
function recomputeAll(){state.frames.forEach(f=>f.metrics=metricsFor(f));buildReport();drawChart();drawCurrent();}
$('analyzeBtn').addEventListener('click',()=>analyze());
$('stopBtn').addEventListener('click',()=>{state.stop=true;$('status').textContent='正在停止，等待目前影格結束…';});
async function analyze(previewOnly=false){
 if(state.analyzing)return;state.lastError=null;
 if(!previewOnly&&state.pendingTarget){setPhase('confirm-target','請先核對金色框，按「確認這位選手」；尚未開始分析。');$('targetConfirm').scrollIntoView({block:'center'});return;}
 if(state.targetSelection&&!selectionStillCurrent(state.targetSelection.time)){resetTarget();setPhase('select-target','影片時間已改變，需重新指定選手。');}
 if(!state.videoUrl){noteError('NO_VIDEO','尚未匯入影片，請先選擇影片檔案');$('videoInput').scrollIntoView({block:'center'});return;}
 state.analyzing=true;state.stop=false;updateControls();video.pause();setPhase('preflight','開始檢查：影片解碼 → 指定確認 → 鎖定追蹤…');
 let error=null,started=false,stage='MEDIA';
 try{
  await waitForMedia();if(state.stop)return;stage='AI';setPhase('ai','確認 AI 模型…');const engine=await ensureAi();if(state.stop)return;stage='FRAME';await presentFrame();if(state.stop)return;
  if(!state.targetSelection||previewOnly){
   stage='DETECTION';setPhase('detecting','正在辨識目前畫面的人物…');await presentFrame();state.lastTimestamp+=1000;
   const options=state.selectionIntent?.kind==='box'?{region:state.selectionIntent.box}:{};
   const people=(engine.detectForVideo(video,state.lastTimestamp,options).landmarks||[]).filter(lm=>describePose(lm,video.videoWidth/video.videoHeight));if(state.stop)return;
   $('personCount').textContent=`${people.length} / ${Math.max(state.maxPeople,people.length)}`;
   if(!people.length){clearPreview();setPhase('no-person','指定畫面或框內未取得可靠人物骨架，尚未開始分析；不會改追其他人。請移到全身清楚的影格再指定。');return;}
   showPeople(people,video.currentTime);$('analysisFlow').scrollIntoView({block:'start',behavior:'instant'});return;
  }
  const selected=state.targetSelection;if(!selected)throw new Error('尚未確認指定選手');
  const tracker=new LockedTarget({id:selected.id,landmarks:selected.landmarks,time:selected.time,appearance:selected.appearance,aspect:video.videoWidth/video.videoHeight});
  state.runSelection={id:selected.id,time:selected.time,method:selected.method,index:selected.index,policy:'explicit-confirmation; immutable-seed; halt-on-loss-or-ambiguity'};
  clearPreview();started=true;state.frames=[];state.report=null;state.maxPeople=0;state.trackingStop=null;
  const sampleFps=Math.max(5,Math.min(60,+$('sampleFps').value||30));$('sampleFps').value=sampleFps;
  const clipSeconds=Math.max(1,Math.min(60,+$('clipSeconds').value||15));$('clipSeconds').value=clipSeconds;
  const start=Math.min(selected.time,Math.max(0,video.duration-.001)),end=Math.min(video.duration,start+clipSeconds),dt=1/sampleFps,count=Math.max(1,Math.ceil((end-start)*sampleFps)),base=state.lastTimestamp+1000;
  setPhase('analyzing',`準備分析 ${formatTime(start)}–${formatTime(end)}，共 ${count} 格…`);
  for(let index=0;index<count;index++){
   if(state.stop)break;stage='FRAME';const t=Math.min(start+index*dt,Math.max(0,end-.001));$('status').textContent=`讀取第 ${index+1}/${count} 格（${formatTime(t)}）…`;
   await seek(t);if(state.stop)break;await presentFrame();if(state.stop)break;stage='INFERENCE';state.lastTimestamp=base+Math.round((t-start)*1000);
   // The first sample is EXACTLY the user's confirmed snapshot. No center-based rematch.
   const people=index===0?selected.people.map(clonePose):(engine.detectForVideo(video,state.lastTimestamp).landmarks||[]);state.maxPeople=Math.max(state.maxPeople,people.length);
   const match=index===0?{index:selected.index,state:'locked',reason:'使用者確認的起始骨架',targetId:selected.id}:tracker.match(people,t,people.map(lm=>sampleAppearance(video,lm,appearanceCanvas)));
   const pick=match.index,landmarks=pick>=0?clonePose(people[pick]):null,box=landmarks?bboxFromLandmarks(landmarks):null;
   const frame={index,t,people,peopleCount:people.length,targetIndex:pick,targetId:landmarks?selected.id:null,landmarks,box,trackState:match.state,trackReason:match.reason};
   if(!landmarks){frame.metrics={leftKnee:null,rightKnee:null};state.frames.push(frame);state.trackingStop={time:t,state:match.state,reason:match.reason,targetId:selected.id};state.targetSelection=null;state.clickPoint=null;state.pendingTarget=null;$('targetConfirm').hidden=true;drawFrame(frame);break;}
   stage='METRICS';frame.metrics=metricsFor(frame);state.frames.push(frame);$('personCount').textContent=`${people.length} / ${state.maxPeople}`;$('progressBar').style.width=`${((index+1)/count)*100}%`;$('status').textContent=`分析 ${formatTime(t)} / ${formatTime(end)} · ${index+1}/${count} 格 · ${people.length} 人 · 指定 ${selected.id} 已鎖定`;
   drawFrame(frame);if(index%3===0)drawChart();await new Promise(r=>setTimeout(r,0));
  }
  stage='REPORT';const autoGround=estimateGroundY(state.frames);if(autoGround!=null)$('groundSlider').value=Math.max(.45,Math.min(.98,autoGround));$('groundText').textContent=autoGround==null?'無法估計':`自動 ${(+ $('groundSlider').value).toFixed(3)}`;buildReport();saveRecord();
 }catch(e){error=e;if(stage==='INFERENCE'||stage==='DETECTION'){try{state.landmarker?.close();}catch{}state.landmarker=null;$('engineBadge').textContent='AI 推論失敗 · 需重試';$('initAi').textContent='重試 AI';}if(started&&state.frames.length){try{buildReport();}catch{}}noteError(stage,e);
 }finally{
  state.analyzing=false;updateControls();drawCurrent();
  if(!error&&started){const valid=state.frames.filter(f=>f.landmarks).length;if(state.trackingStop)setPhase('target-paused',`指定 ${state.trackingStop.targetId} 於 ${formatTime(state.trackingStop.time)} 暫停：${state.trackingStop.reason}。已保留 ${valid} 格可靠配對結果，請匯出報告或重新指定；沒有改追旁人。`);else if(state.stop)setPhase('stopped',`已停止（部分結果）：${state.frames.length} 格。`);else if(!valid)setPhase('no-result',`分析已結束但沒有可用骨架（${state.frames.length} 格）；這不是成功的動作分析。`);else setPhase('complete',`分析完成：${state.frames.length} 格，可用骨架 ${valid} 格，最多同框 ${state.maxPeople} 人。`);}else if(!error&&state.stop)setPhase('stopped','已停止，尚未產生新的分析結果。');
 }
}
function nearestFrame(t){if(!state.frames.length)return null;let best=state.frames[0],d=Math.abs(best.t-t);for(const f of state.frames){const nd=Math.abs(f.t-t);if(nd<d){best=f;d=nd;}}return best;}
function drawCurrent(){syncCanvas();drawFrame(nearestFrame(video.currentTime));drawPeoplePreview();drawChart();}
function drawFrame(frame){
 const r=overlay.getBoundingClientRect(),w=r.width,h=r.height;octx.clearRect(0,0,w,h);if(!frame)return;
 if($('showSkeleton').checked){if($('showAllPeople').checked)frame.people?.forEach((lm,i)=>drawPose(i===frame.targetIndex&&frame.landmarks?frame.landmarks:lm,w,h,i===frame.targetIndex?1:.22,i===frame.targetIndex?3:1));else if(frame.landmarks)drawPose(frame.landmarks,w,h,1,3);}
 const gy=+$('groundSlider').value;octx.strokeStyle='#22c55e';octx.lineWidth=2;octx.setLineDash([8,6]);octx.beginPath();octx.moveTo(0,gy*h);octx.lineTo(w,gy*h);octx.stroke();octx.setLineDash([]);
 if(frame.landmarks){drawSelectedBox(frame.landmarks,w,h,frame.targetId||'舊資料');if($('showRefs').checked)drawRefs(frame.landmarks,w,h);const m=frame.metrics;$('angleNow').textContent=`L ${fmtAngle(m?.leftKnee?.value,m?.leftKnee)} / R ${fmtAngle(m?.rightKnee?.value,m?.rightKnee)}`;}else $('angleNow').textContent='指定選手未可靠配對 · 不取值';
}
function drawPose(lm,w,h,alpha,lineWidth){octx.save();octx.globalAlpha=alpha;octx.strokeStyle='#38bdf8';octx.fillStyle='#f8fafc';octx.lineWidth=lineWidth;for(const [a,b] of LINKS){const p=lm[a],q=lm[b];if(!p||!q||(p.visibility??1)<.2||(q.visibility??1)<.2)continue;octx.beginPath();octx.moveTo(p.x*w,p.y*h);octx.lineTo(q.x*w,q.y*h);octx.stroke();}for(const i of [11,12,23,24,25,26,27,28,29,30,31,32]){const p=lm[i];if(!p||(p.visibility??1)<.2)continue;octx.beginPath();octx.arc(p.x*w,p.y*h,p.manual?6:3.5,0,Math.PI*2);octx.fill();}const b=bboxFromLandmarks(lm);if(b){octx.strokeStyle=alpha<1?'#94a3b8':'#f59e0b';octx.strokeRect(b.x1*w,b.y1*h,(b.x2-b.x1)*w,(b.y2-b.y1)*h);}octx.restore();}
function drawRefs(lm,w,h){octx.save();octx.strokeStyle='#f43f5e';octx.lineWidth=2;for(const [a,b] of [[11,12],[23,24]])if(lm[a]&&lm[b]){octx.beginPath();octx.moveTo(lm[a].x*w,lm[a].y*h);octx.lineTo(lm[b].x*w,lm[b].y*h);octx.stroke();}if(lm[11]&&lm[12]&&lm[23]&&lm[24]){octx.beginPath();octx.moveTo((lm[11].x+lm[12].x)/2*w,(lm[11].y+lm[12].y)/2*h);octx.lineTo((lm[23].x+lm[24].x)/2*w,(lm[23].y+lm[24].y)/2*h);octx.stroke();}octx.restore();}
function drawChart(){const dpr=devicePixelRatio||1,w=chart.clientWidth||600,h=260;chart.width=Math.round(w*dpr);chart.height=Math.round(h*dpr);cctx.setTransform(dpr,0,0,dpr,0,0);cctx.clearRect(0,0,w,h);cctx.fillStyle='#fbfdff';cctx.fillRect(0,0,w,h);cctx.strokeStyle='#e2e8f0';cctx.lineWidth=1;for(const a of [120,140,160,180]){const y=mapY(a,h);cctx.beginPath();cctx.moveTo(36,y);cctx.lineTo(w-8,y);cctx.stroke();cctx.fillStyle='#64748b';cctx.font='11px system-ui';cctx.fillText(String(a),4,y+4);}if(state.frames.length<2)return;drawBand('leftKnee','#0f766e33',w,h);drawBand('rightKnee','#7c3aed22',w,h);drawLine('leftKnee','#0f766e',w,h);drawLine('rightKnee','#7c3aed',w,h);const x=36+video.currentTime/(video.duration||1)*(w-44);cctx.strokeStyle='#ef4444';cctx.beginPath();cctx.moveTo(x,8);cctx.lineTo(x,h-20);cctx.stroke();}
function mapY(a,h){return 8+(180-(a??180))/70*(h-36);}
function drawLine(key,color,w,h){cctx.strokeStyle=color;cctx.lineWidth=2;cctx.beginPath();let started=false;for(const f of state.frames){const v=f.metrics?.[key]?.value;if(v==null){started=false;continue;}const x=36+f.t/(video.duration||1)*(w-44),y=mapY(v,h);if(!started){cctx.moveTo(x,y);started=true;}else cctx.lineTo(x,y);}cctx.stroke();}
function drawBand(key,color,w,h){const pts=state.frames.map(f=>({t:f.t,m:f.metrics?.[key]})).filter(x=>x.m?.low!=null);if(pts.length<2)return;cctx.fillStyle=color;cctx.beginPath();pts.forEach((p,i)=>{const x=36+p.t/(video.duration||1)*(w-44),y=mapY(p.m.high,h);i?cctx.lineTo(x,y):cctx.moveTo(x,y);});[...pts].reverse().forEach(p=>cctx.lineTo(36+p.t/(video.duration||1)*(w-44),mapY(p.m.low,h)));cctx.closePath();cctx.fill();}
function buildReport(){
 if(!state.frames.length){state.report=null;return;}
 const gy=+$('groundSlider').value,fps=+$('sampleFps').value||30,flights=flightIntervals(state.frames,gy,fps),knee=supportKnee(state.frames,gy,fps),valid=state.frames.filter(f=>f.landmarks).length,l=state.frames.map(f=>f.metrics?.leftKnee?.value).filter(Number.isFinite),r=state.frames.map(f=>f.metrics?.rightKnee?.value).filter(Number.isFinite);
 state.report={schema:4,engine:state.version,created:new Date().toISOString(),targetSelection:state.runSelection,trackingStop:state.trackingStop,settings:{athlete:$('athlete').value,date:$('date').value,view:$('view').value,direction:$('direction').value,fps:+$('fps').value,sampleFps:fps,uncertaintyEnabled:$('uncertaintyEnabled').checked,pointSigmaPx:+$('sigmaPx').value,groundY:gy,clipSeconds:+$('clipSeconds').value},summary:{frames:state.frames.length,trackedFrames:valid,continuity:valid/state.frames.length,maxPeople:state.maxPeople,minLeftKneeSupport:knee.minLeft,minRightKneeSupport:knee.minRight,minLeftKneeWholeClip:l.length?Math.min(...l):null,minRightKneeWholeClip:r.length?Math.min(...r):null,supportPhases:knee.left.length+knee.right.length,partialSupportPhases:[...knee.left,...knee.right].filter(c=>c.partial).length,flightIntervals:flights.length,manualCorrections:state.frames.reduce((n,f)=>n+(f.landmarks?.filter?.(p=>p?.manual).length||0),0)},flights,supportKnee:{left:knee.left,right:knee.right},frames:state.frames.map(f=>({t:f.t,peopleCount:f.peopleCount,trackState:f.trackState,targetId:f.targetId??null,trackReason:f.trackReason??null,landmarks:f.landmarks,metrics:f.metrics}))};renderQuick();renderReport();
}
function renderQuick(){if(!state.report)return;const s=state.report.summary;$('quickStats').innerHTML=`${stat('指定選手',state.report.targetSelection?.id||'—')}${stat('追蹤連續率',(s.continuity*100).toFixed(1)+'%')}${stat('左膝支撐期最小角',s.minLeftKneeSupport==null?'—':s.minLeftKneeSupport.toFixed(1)+'°')}${stat('右膝支撐期最小角',s.minRightKneeSupport==null?'—':s.minRightKneeSupport.toFixed(1)+'°')}`;$('events').innerHTML=state.report.flights.length?state.report.flights.map((e,i)=>`<div class="event"><span>疑似雙腳離地 #${i+1} · ${formatTime(e.startTime)}–${formatTime(e.endTime)} · ${e.lowerMs.toFixed(0)}–${e.upperMs.toFixed(0)} ms</span><button data-seek="${e.startTime}">複查</button></div>`).join(''):'<p class="muted">未標記疑似雙腳離地；不代表已通過正式競走判定。</p>';document.querySelectorAll('[data-seek]').forEach(b=>b.onclick=()=>{if(!state.analyzing)video.currentTime=+b.dataset.seek;});}
function stat(k,v){return `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`;}
function renderReport(){if(!state.report){$('reportBody').innerHTML='<p>完成分析後會產生本次報告。</p>';return;}const r=state.report,s=r.summary;$('reportBody').innerHTML=`<h3>${escapeHtml(r.settings.athlete)} · ${r.settings.date}</h3><p><strong>指定選手：${escapeHtml(r.targetSelection?.id||'未記錄')}</strong> ｜ 起始影格 ${formatTime(r.targetSelection?.time)} ｜ ${r.trackingStop?'追蹤不確定，已暫停；不是完整分析':'使用者已確認目標'}。追蹤標籤不是身分保證，請核對原片。</p><p>引擎：${r.engine} ｜ 取樣 ${r.settings.sampleFps} fps ｜ 誤差模擬 ${r.settings.uncertaintyEnabled?`開啟（σ=${r.settings.pointSigmaPx}px）`:'關閉'}</p><table><tr><th>指標</th><th>結果</th></tr><tr><td>追蹤連續率</td><td>${(s.continuity*100).toFixed(1)}%</td></tr><tr><td>最多同框人物</td><td>${s.maxPeople}</td></tr><tr><td>左膝支撐期最小角</td><td>${num(s.minLeftKneeSupport)}°</td></tr><tr><td>右膝支撐期最小角</td><td>${num(s.minRightKneeSupport)}°</td></tr><tr><td>支撐期數（其中未涵蓋垂直位置）</td><td>${s.supportPhases}（${s.partialSupportPhases}）</td></tr><tr><td>整段最小膝角（含擺動期，非 TR54 判準）</td><td>${num(s.minLeftKneeWholeClip)}° / ${num(s.minRightKneeWholeClip)}°</td></tr><tr><td>疑似雙腳離地區間</td><td>${s.flightIntervals}</td></tr><tr><td>人工修正點數</td><td>${s.manualCorrections}</td></tr></table><p class="muted">支撐期最小角只取「觸地到通過垂直位置」這段，也就是 TR54 彎膝規則規範的範圍；擺動期彎膝屬正常動作，不列入。若該次觸地期間髖未通過踝的正上方（選手提前出框），該次退回用整段觸地期並計入括號內的數量，涵蓋範圍比規則規定的大。非矢狀面拍攝會讓量到的角度偏小。AI 僅提供篩查與複查證據，不輸出正式犯規判決。</p>`;}
$('monkeyBtn').onclick=()=>{try{const r=runMonkeyCore(1000);$('monkeyResult').textContent=`PASS\n${r.passed}/${r.iterations} invariants passed\nangle range / uncertainty containment OK\n此為核心隨機測試，不是影片準確度驗證。`;}catch(e){$('monkeyResult').textContent='FAIL\n'+e.stack;}};
$('exportJson').onclick=()=>state.report&&download(`racewalk-${$('date').value}.json`,JSON.stringify(state.report,null,2),'application/json');
$('exportCsv').onclick=()=>{if(!state.report)return;const rows=[['t','people','track','targetId','leftKnee','leftLow','leftHigh','rightKnee','rightLow','rightHigh']];for(const f of state.frames)rows.push([f.t,f.peopleCount,f.trackState,f.targetId??'',f.metrics?.leftKnee?.value??'',f.metrics?.leftKnee?.low??'',f.metrics?.leftKnee?.high??'',f.metrics?.rightKnee?.value??'',f.metrics?.rightKnee?.low??'',f.metrics?.rightKnee?.high??'']);download(`racewalk-${$('date').value}.csv`,rows.map(r=>r.join(',')).join('\n'),'text/csv');};
$('exportHtml').onclick=()=>{if(!state.report)return;download(`racewalk-${$('date').value}.html`,`<!doctype html><meta charset="utf-8"><title>RaceWalk Report</title><style>body{font-family:system-ui;padding:32px;max-width:900px;margin:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}</style><h1>RaceWalk Lab 報告</h1>${$('reportBody').innerHTML}`,'text/html');};
function download(name,text,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function readRecords(){try{const v=JSON.parse(localStorage.getItem('racewalk-v3-records')||'[]');return Array.isArray(v)?v:[];}catch{return [];}}
function saveRecord(){if(!state.report)return;try{const list=readRecords();list.unshift({created:state.report.created,settings:state.report.settings,summary:state.report.summary,targetSelection:state.report.targetSelection,trackingStop:state.report.trackingStop});localStorage.setItem('racewalk-v3-records',JSON.stringify(list.slice(0,50)));}catch{$('recordList').textContent='此瀏覽器無法保存本機紀錄；請匯出 JSON 保存分析結果。';}}
function renderRecords(){const list=readRecords();$('recordList').innerHTML=list.length?list.map(x=>`<div class="record"><strong>${escapeHtml(x.settings?.athlete||'')}</strong> · ${escapeHtml(x.settings?.date||'')} · ${escapeHtml(x.targetSelection?.id||'舊紀錄')}</div>`).join(''):'<p class="muted">尚無本機紀錄。</p>';}
$('clearRecords').onclick=()=>{if(confirm('確定清除本機訓練紀錄？')){try{localStorage.removeItem('racewalk-v3-records');renderRecords();}catch{$('recordList').textContent='本機儲存不可用。';}}};
function formatTime(s){if(!Number.isFinite(s))return '00:00.000';const m=Math.floor(s/60),sec=s-m*60;return `${String(m).padStart(2,'0')}:${sec.toFixed(3).padStart(6,'0')}`;}
function fmtAngle(v,b){if(v==null)return '—';return `${v.toFixed(1)}°${b&&b.low!=null?` [${b.low.toFixed(1)}–${b.high.toFixed(1)}]`:''}`;}
function num(v){return Number.isFinite(v)?v.toFixed(1):'—';}
function escapeHtml(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
updateControls();document.documentElement.dataset.appReady='true';ensureAi().catch(()=>{});
