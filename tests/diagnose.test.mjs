import assert from 'node:assert/strict';
import {diagnoseCapture,kneeChangeRate,affectedMetrics,MIN_SCREENING_FPS,LOW_CONTINUITY,IMPLAUSIBLE_SUPPORT_KNEE,
        MAX_PLAUSIBLE_KNEE_RATE,MAX_PLAUSIBLE_FLIGHT_MS} from '../site/core.js';

let cases=0;const check=(name,fn)=>{fn();cases++;console.log('PASS',name);};
// 一份「一切正常」的報告，各測試只改自己關心的那一欄。
const ok=(over={})=>({
  settings:{sampleFps:240,...(over.settings||{})},
  trackingStop:over.trackingStop??null,
  summary:{frames:200,trackedFrames:200,continuity:1,minLeftKneeSupport:176,minRightKneeSupport:178,
           supportPhases:6,partialSupportPhases:0,flightIntervals:2,...(over.summary||{})},
});
const titles=r=>diagnoseCapture(r).map(f=>f.title);
const levels=r=>diagnoseCapture(r).map(f=>f.level);
const has=(r,frag)=>diagnoseCapture(r).some(f=>f.title.includes(frag));

check('沒有報告就不發表意見',()=>{
  assert.deepEqual(diagnoseCapture(null),[]);
  assert.deepEqual(diagnoseCapture({}),[]);
});

check('低於篩查幀率是 blocker，且算得出取樣點數',()=>{
  const f=diagnoseCapture(ok({settings:{sampleFps:30}}))[0];
  assert.equal(f.level,'blocker');
  assert.ok(f.title.includes('30 fps'));
  assert.ok(f.cause.includes('1 個取樣點'),f.cause);   // 40ms / 33.3ms
  assert.ok(diagnoseCapture(ok({settings:{sampleFps:MIN_SCREENING_FPS}})).every(x=>!x.title.includes('不足以篩查')));
});

check('連續率分兩級，措辭不同',()=>{
  assert.equal(diagnoseCapture(ok({summary:{continuity:.283}}))[0].level,'blocker');
  const warn=diagnoseCapture(ok({summary:{continuity:.6}}));
  assert.ok(warn.some(f=>f.level==='warn'&&f.title.includes('60.0%')));
  assert.ok(!has(ok({summary:{continuity:LOW_CONTINUITY}}),'追蹤連續率'));
});

check('膝角偏小被歸因於投影誤差，不是宣稱選手彎膝',()=>{
  const f=diagnoseCapture(ok({summary:{minLeftKneeSupport:135.7,minRightKneeSupport:133.3}}))
    .find(x=>x.title.includes('支撐期最小角'));
  assert.ok(f,'應該要有這一條');
  assert.ok(f.title.includes('左 135.7°')&&f.title.includes('右 133.3°'));
  assert.ok(f.cause.includes('機位')&&f.cause.includes('偏小'));
  assert.ok(!/彎膝|犯規/.test(f.action.replace('不要拿這個數字判讀選手','')),'不可暗示已判定犯規');
  assert.ok(!has(ok({summary:{minLeftKneeSupport:IMPLAUSIBLE_SUPPORT_KNEE}}),'支撐期最小角'));
});

check('沒有支撐期就沒有彎膝可判',()=>{
  assert.ok(diagnoseCapture(ok({summary:{supportPhases:0}})).some(f=>f.level==='blocker'&&f.title.includes('支撐期')));
});

check('未標記騰空講的是「沒有證明」，不是「沒有騰空」',()=>{
  const f=diagnoseCapture(ok({summary:{flightIntervals:0}})).find(x=>x.title.includes('未標記'));
  assert.ok(f.cause.includes('沒有證明')&&f.cause.includes('漏報'));
  assert.equal(f.level,'info');
});

check('早期失聯只在連續率也低時才歸因於種子骨架',()=>{
  assert.ok(has(ok({summary:{continuity:.3},trackingStop:{time:.1667}}),'0.17 秒'));
  // 連續率正常時，早期一次失聯不構成問題，不該亂指控起始骨架
  assert.ok(!has(ok({summary:{continuity:.95},trackingStop:{time:.1667}}),'失去配對'));
});

check('一切正常時不虛報，但也不保證準確度',()=>{
  const f=diagnoseCapture(ok());
  assert.equal(f.length,1);
  assert.equal(f[0].level,'info');
  assert.ok(f[0].cause.includes('不是量測準確度的保證'));
});

check('嚴重的排在前面',()=>{
  const r=ok({settings:{sampleFps:30},summary:{continuity:.283,minLeftKneeSupport:135,supportPhases:0,flightIntervals:0}});
  const l=levels(r);
  assert.deepEqual([...l].sort((a,b)=>({blocker:0,warn:1,info:2})[a]-({blocker:0,warn:1,info:2})[b]),l);
  assert.equal(l[0],'blocker');
});

check('每一條都給得出原因與做法',()=>{
  for(const r of [ok(),ok({settings:{sampleFps:30}}),ok({summary:{continuity:.2,supportPhases:0,flightIntervals:0}})])
    for(const f of diagnoseCapture(r)){
      assert.ok(f.title&&f.cause&&f.action,`缺欄位：${JSON.stringify(f)}`);
      assert.ok(['blocker','warn','info'].includes(f.level));
    }
});

// 逐格膝角序列。step 是每格的變化量（度）。
const kneeFrames=(step,n=60,key='leftKnee')=>Array.from({length:n},(_,i)=>({metrics:{[key]:{value:150+(i%2?step:0)}}}));

check('角速度用中位數，不被少數幾格帶走',()=>{
  // 平穩序列裡插入一格大跳動：中位數應該不動
  const f=Array.from({length:40},(_,i)=>({metrics:{leftKnee:{value:150+i*2}}}));
  f[20].metrics.leftKnee.value=10;
  const r=kneeChangeRate(f,'leftKnee',30);
  assert.ok(r<MAX_PLAUSIBLE_KNEE_RATE,`中位數不該被單一離群值推高，得到 ${r}`);
  assert.equal(kneeChangeRate([],'leftKnee',30),null);
  assert.equal(kneeChangeRate(kneeFrames(5,4),'leftKnee',30),null,'樣本太少不下結論');
  assert.equal(kneeChangeRate(kneeFrames(5),'leftKnee',0),null);
});

check('逐格來回跳動被抓成 blocker，不是被當成動作',()=>{
  // 150↔180 每格來回：30°/格 × 30fps = 900°/秒，生理上不可能
  const r=ok({summary:{},settings:{sampleFps:30}});r.frames=kneeFrames(30);
  const f=diagnoseCapture(r).find(x=>x.title.includes('逐格跳動'));
  assert.ok(f,'應該要抓到');
  assert.equal(f.level,'blocker');
  assert.ok(f.title.includes('900°/秒'),f.title);
  assert.ok(f.cause.includes('左右腳')&&f.cause.includes('一步只擺盪一次'));
  assert.ok(f.action.includes('不能拿來判讀'));
});

check('正常擺幅不誤報，且門檻隨取樣率縮放',()=>{
  const slow=ok({settings:{sampleFps:30}});slow.frames=kneeFrames(6);   // 6°/格 × 30fps = 180°/秒
  assert.ok(!diagnoseCapture(slow).some(x=>x.title.includes('逐格跳動')));
  // 同樣的 6°/格，在 240fps 取樣下就是 1440°/秒——那才是不可能的動作
  const fast=ok({settings:{sampleFps:240}});fast.frames=kneeFrames(6);
  assert.ok(diagnoseCapture(fast).some(x=>x.title.includes('逐格跳動')),'門檻是角速度，不是每格度數');
});

check('騰空長到生理上不可能時，歸因於關鍵點遺失',()=>{
  const r=ok();r.flights=[{lowerMs:367,startTime:5.767,endTime:6.133}];
  const f=diagnoseCapture(r).find(x=>x.title.includes('疑似騰空長達'));
  assert.equal(f.level,'blocker');
  assert.ok(f.title.includes('367 ms'));
  assert.ok(f.cause.includes('足部關鍵點')&&f.cause.includes('不是騰空'));
  const okFlight=ok();okFlight.flights=[{lowerMs:MAX_PLAUSIBLE_FLIGHT_MS,startTime:1,endTime:1.2}];
  assert.ok(!diagnoseCapture(okFlight).some(x=>x.title.includes('疑似騰空長達')));
});

check('下界為 0 的觀測被單獨點名，不混進可證明的區間',()=>{
  const r=ok();r.flights=[{lowerMs:0,startTime:5.4,endTime:5.4},{lowerMs:33,startTime:7,endTime:7.1}];
  const f=diagnoseCapture(r).find(x=>x.title.includes('無法證明'));
  assert.ok(f&&f.level==='info');
  assert.ok(f.title.startsWith('1 段'));
  assert.ok(f.cause.includes('下界是 0')&&f.cause.includes('不構成證據'));
});

check('指得出現場的發現都帶時間，指不出的誠實留空',()=>{
  const frames=Array.from({length:40},(_,i)=>({t:i/30,landmarks:i<20?[{}]:null,
    metrics:{leftKnee:{value:i%2?175:115},rightKnee:{value:150}}}));
  const r=ok({settings:{sampleFps:30},summary:{continuity:.5,minLeftKneeSupport:120}});
  r.frames=frames;
  r.flights=[{lowerMs:0,startTime:2.1,endTime:2.1},{lowerMs:367,startTime:5.767,endTime:6.133}];
  r.supportKnee={left:[{minAngle:120,startTime:1.5},{minAngle:170,startTime:3}],right:[]};
  const by=t=>diagnoseCapture(r).find(f=>f.title.includes(t));

  assert.equal(by('不足以篩查騰空').at,null,'取樣率是整段設定，不該假裝指得出某一格');
  assert.equal(by('疑似騰空長達').at,5.767,'應指向最長的那一段');
  assert.equal(by('無法證明').at,2.1);
  assert.equal(by('支撐期最小角').at,1.5,'應指向最小角所在的那一段，不是第一段');
  assert.ok(by('追蹤連續率').at>=20/30,'應指向最長的留白起點');
  assert.ok(by('逐格跳動').at!=null);

  for(const f of diagnoseCapture(r))
    assert.ok(f.at===null||Number.isFinite(f.at),`at 必須是秒數或 null，得到 ${f.at}`);
});

check('沒有影格資料時不會硬編一個時間出來',()=>{
  const f=diagnoseCapture(ok({settings:{sampleFps:30},summary:{continuity:.2}}));
  for(const x of f) assert.ok(x.at===null||Number.isFinite(x.at));
});

check('警告掛得回受影響的數字',()=>{
  const m=affectedMetrics([
    {level:'blocker',title:'分析取樣 30 fps，不足以篩查騰空'},
    {level:'warn',title:'支撐期最小角偏小（左 126.7°）'}]);
  assert.equal(m.flight,'blocker');
  assert.equal(m.knee,'warn');
  assert.equal(m.continuity,undefined,'沒被點名的數字不該被連坐');
});

check('取不到骨架就沒有角度，連續率問題同時汙染膝角',()=>{
  const m=affectedMetrics([{level:'blocker',title:'追蹤連續率 28.3%'}]);
  assert.equal(m.continuity,'blocker');
  assert.equal(m.knee,'blocker','沒有骨架就沒有膝角，不能只標連續率');
});

check('同一數字被多條點名時取最嚴重的',()=>{
  const m=affectedMetrics([
    {level:'info',title:'支撐期最小角偏小'},
    {level:'blocker',title:'膝角逐格跳動過大'},
    {level:'warn',title:'支撐期最小角偏小'}]);
  assert.equal(m.knee,'blocker');
});

check('沒有發現就沒有數字被質疑',()=>assert.deepEqual(affectedMetrics([]),{}));

console.log(JSON.stringify({suite:'diagnose',cases,passed:true,
  scope:'capture-plausibility rules over report summaries; thresholds are not TR54 criteria and are not calibrated against real footage'}));
