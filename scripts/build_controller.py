"""Build 3.0.5 from audited controller and test templates.
All required replacements must match. No private user media is read or published.
Generated frontend files are build outputs, not editable source-of-truth files.
"""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
site=ROOT/'site';site.mkdir(exist_ok=True)
p=site/'app.js';s=(ROOT/'src/controller.template.js').read_text()
def sub(old,new):
 global s
 assert old in s,old[:90]
 s=s.replace(old,new)
sub("import { createPoseEngine }", "import {ContinuousTarget, dedupePoses, gapIntervals} from './continuity.js?v=3.0.5';\nimport { createPoseEngine }")
sub("new LockedTarget({id:selected.id", "new ContinuousTarget({id:selected.id")
sub("const people=(engine.detectForVideo(video,state.lastTimestamp,options).landmarks||[]).filter(lm=>describePose(lm,video.videoWidth/video.videoHeight));", "const people=dedupePoses((engine.detectForVideo(video,state.lastTimestamp,options).landmarks||[]),video.videoWidth/video.videoHeight).filter(lm=>describePose(lm,video.videoWidth/video.videoHeight));")
sub("const people=index===0?selected.people.map(clonePose):(engine.detectForVideo(video,state.lastTimestamp).landmarks||[]);", "const people=index===0?selected.people.map(clonePose):dedupePoses((engine.detectForVideo(video,state.lastTimestamp,{region:tracker.regionAt(t),regionSource:'tracker'}).landmarks||[]),video.videoWidth/video.videoHeight);")
old="if(!landmarks){frame.metrics={leftKnee:null,rightKnee:null};state.frames.push(frame);state.trackingStop={time:t,state:match.state,reason:match.reason,targetId:selected.id};state.targetSelection=null;state.clickPoint=null;state.pendingTarget=null;$('targetConfirm').hidden=true;drawFrame(frame);break;}"
new="""if(!landmarks){
    frame.metrics={leftKnee:null,rightKnee:null};state.frames.push(frame);
    if(!state.trackingStop)state.trackingStop={time:t,state:match.state,reason:match.reason,targetId:selected.id};
    $('personCount').textContent=`${people.length} / ${state.maxPeople}`;
    $('progressBar').style.width=`${((index+1)/count)*100}%`;
    $('status').textContent=`掃描 ${index+1}/${count} 格 · ${formatTime(t)} · ${match.state==='reacquiring'?'核對原指定選手':match.state==='needs-review'?'待人工重新指定':'暫時搜尋指定選手'} · 此格角度留白（不停止整段、不補值）`;
    drawFrame(frame);if(index%3===0)drawChart();await new Promise(r=>setTimeout(r,0));continue;
   }"""
sub(old,new)
sub("if(state.trackingStop)setPhase('target-paused',`指定 ${state.trackingStop.targetId} 於 ${formatTime(state.trackingStop.time)} 暫停：${state.trackingStop.reason}。已保留 ${valid} 格可靠配對結果，請匯出報告或重新指定；沒有改追旁人。`);else if(state.stop)","if(state.stop)")
sub("else setPhase('complete',`分析完成：${state.frames.length} 格，可用骨架 ${valid} 格，最多同框 ${state.maxPeople} 人。`);", "else if(state.trackingStop)setPhase('complete-gaps',`全段掃描完成：${state.frames.length} 格，配對通過 ${valid} 格，未可靠配對 ${state.frames.length-valid} 格（角度留白）。短暫失聯需連續 3 格核對才恢復；長時間失聯請移至清楚影格重新指定。`);else setPhase('complete',`分析完成：${state.frames.length} 格，可用骨架 ${valid} 格，最多同框 ${state.maxPeople} 人。`);")
sub("trackingStop:state.trackingStop,settings:", "trackingStop:state.trackingStop,gaps:gapIntervals(state.frames),scan:{processedFrames:state.frames.length,recoveredFrames:state.frames.filter(f=>f.trackState==='recovered').length,missingValues:state.frames.filter(f=>!f.landmarks).length,stoppedByUser:state.stop},settings:")
sub("halt-on-loss-or-ambiguity", "continue-scan;null-on-uncertainty;three-frame-bounded-recovery")
sub("追蹤不確定，已暫停；不是完整分析", "含追蹤缺值；掃描完成不代表每格均可判讀")
sub("只追蹤已確認的選手；失聯、重疊或配對不明確時暫停，不自動換人。", "短暫失聯時繼續掃描、角度留白；連續 3 格核對同一目標才恢復。長時間失聯需重新指定，不拿旁人補值。")
sub("若失聯不會用旁人取代", "若失聯會留下缺值，不會無條件改追最近的人")
s=s.replace('3.0.4','3.0.5')
start=s.index('function drawBand(');end=s.index('\nfunction buildReport',start)
s=s[:start]+"""function drawBand(key,color,w,h){
 let segment=[];
 const paint=()=>{if(segment.length>=2){cctx.fillStyle=color;cctx.beginPath();segment.forEach((p,i)=>{const x=36+p.t/(video.duration||1)*(w-44),y=mapY(p.m.high,h);i?cctx.lineTo(x,y):cctx.moveTo(x,y);});[...segment].reverse().forEach(p=>cctx.lineTo(36+p.t/(video.duration||1)*(w-44),mapY(p.m.low,h)));cctx.closePath();cctx.fill();}segment=[];};
 for(const f of state.frames){const m=f.metrics?.[key];if(m?.low==null)paint();else segment.push({t:f.t,m});}paint();
}
"""+s[end:]
p.write_text(s)
s=(ROOT/'src/ai-loader.template.js').read_text();a=s.index('async function getModel');b=s.index('\nfunction bounds',a)
s=s[:a]+(ROOT/'src/model-cache.js').read_text()+s[b:]
s=s.replace("onStatus('初始化 AI（首次載入請稍候）…');", "onStatus('模型已讀取，正在初始化 WASM／AI（這一步不是模型下載）…');")
(site/'ai-loader.js').write_text(s)
s=(ROOT/'src/index.template.html').read_text().replace('3.0.4','3.0.5').replace('不確定時暫停','不確定留白／繼續掃描')
(site/'index.html').write_text(s)
# Preserve all former UI regressions, adapting only the intentionally changed
# missing-detection behavior. Real inference, ROI and target-coordinate assertions remain.
s=(ROOT/'src/browser_smoke.template.py').read_text().replace('3.0.4','3.0.5')
s=s.replace("'target-paused'","'complete-gaps'")
s=s.replace("stopped['summary']['frames']==2","stopped['summary']['frames']==6")
s=s.replace("needle='    const full=inferFull(input);'",'needle="    if(closed)throw new Error(\'AI 引擎已關閉，請重新載入\');"')
s=s.replace('injected_loss_halts_without_bystander_values','injected_loss_continues_with_null_values')
(ROOT/'tests/browser_smoke.py').write_text(s)
print('Built 3.0.5 controller, model-cache loader, entry page and UI regression tests')
