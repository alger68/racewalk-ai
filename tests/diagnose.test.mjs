import assert from 'node:assert/strict';
import {diagnoseCapture,MIN_SCREENING_FPS,LOW_CONTINUITY,IMPLAUSIBLE_SUPPORT_KNEE} from '../site/core.js';

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

console.log(JSON.stringify({suite:'diagnose',cases,passed:true,
  scope:'capture-plausibility rules over report summaries; thresholds are not TR54 criteria and are not calibrated against real footage'}));
