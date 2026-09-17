import assert from 'node:assert/strict';
import {gaitMetrics,asymmetryPct,MIN_COMPLETE_CONTACTS} from '../site/core.js';

let cases=0;const check=(name,fn)=>{fn();cases++;console.log('PASS',name);};

// 合成步態：左右腳交替，每腳觸地 contactMs，中間夾 flightMs 的雙腳離地。
// 可指定左右不同的觸地時間，用來驗證對稱性指標。
function gait({fps=120,cycles=6,leftMs=300,rightMs=300,flightMs=40,ground=.9,amp=.12}){
  const sched=[];let t=leftMs+2*flightMs;   // 開頭留一段擺動，避免第一次觸地被截斷
  for(let k=0;k<cycles;k++){
    sched.push({side:'L',a:t,b:t+leftMs}); t+=leftMs+flightMs;
    sched.push({side:'R',a:t,b:t+rightMs}); t+=rightMs+flightMs;
  }
  const endMs=t+leftMs+2*flightMs;
  const height=(side,ms)=>{
    const own=sched.filter(s=>s.side===side);
    if(own.some(s=>s.a<=ms&&ms<=s.b))return ground;
    const prev=Math.max(...own.filter(s=>s.b<=ms).map(s=>s.b),own[0].a-400);
    const next=Math.min(...own.filter(s=>s.a>=ms).map(s=>s.a),own[own.length-1].b+400);
    if(next<=prev)return ground;
    const u=Math.min(1,Math.max(0,(ms-prev)/(next-prev)));
    return ground-amp*Math.pow(Math.sin(Math.PI*u),.6);
  };
  const frames=[];
  for(let ms=0;ms<=endMs;ms+=1000/fps){
    const ly=height('L',ms),ry=height('R',ms);
    frames.push({t:ms/1000,landmarks:Array.from({length:33},(_,i)=>{
      const isL=[27,29,31].includes(i),isR=[28,30,32].includes(i);
      return {x:.5,y:isL?ly:isR?ry:.4,visibility:1};})});
  }
  return {frames,ground};
}

check('觸地時間接近真值',()=>{
  const g=gait({leftMs:300,rightMs:300});
  const m=gaitMetrics(g.frames,g.ground,120);
  assert.ok(m.enough,`完整觸地只有 ${m.completeContacts} 次`);
  for(const side of ['left','right'])
    assert.ok(Math.abs(m.contactMs[side]-300)<35,`${side} 量到 ${m.contactMs[side]?.toFixed(0)}ms`);
});

check('步頻算得出來，且與週期一致',()=>{
  // 每步週期 = 觸地 300 + 騰空 40 = 340ms → 每分鐘約 176 步
  const g=gait({leftMs:300,rightMs:300,flightMs:40});
  const m=gaitMetrics(g.frames,g.ground,120);
  assert.ok(Math.abs(m.cadenceSpm-60/0.34)<12,`量到 ${m.cadenceSpm?.toFixed(1)} spm`);
});

check('左右不對稱時指標抓得到，對稱時接近 0',()=>{
  const even=gait({leftMs:300,rightMs:300});
  const a=gaitMetrics(even.frames,even.ground,120).asymmetry.contactPct;
  assert.ok(a<8,`對稱案例卻得到 ${a?.toFixed(1)}%`);
  // 左腳觸地比右腳長 20%
  const uneven=gait({leftMs:330,rightMs:270});
  const b=gaitMetrics(uneven.frames,uneven.ground,120).asymmetry.contactPct;
  assert.ok(b>10,`不對稱案例只得到 ${b?.toFixed(1)}%`);
  assert.ok(b>a+5,'不對稱應明顯高於對稱');
});

check('截斷的觸地不列入——影片頭尾那次長度是不知道的',()=>{
  const g=gait({cycles:6});
  const m=gaitMetrics(g.frames,g.ground,120);
  for(const side of ['left','right'])
    for(const c of m.contacts[side]){
      assert.ok(c.startTime>g.frames[0].t,'不得從第一格開始');
      assert.ok(c.endTime<g.frames[g.frames.length-1].t,'不得到最後一格');
    }
});

check('步數不足時不給步頻與對稱性，而不是用一兩步硬算',()=>{
  const g=gait({cycles:1});
  const m=gaitMetrics(g.frames,g.ground,120);
  if(!m.enough){
    assert.equal(m.cadenceSpm,null);
    assert.ok(m.completeContacts<MIN_COMPLETE_CONTACTS);
  }
});

check('沒有資料時不編造',()=>{
  for(const bad of [null,[],undefined]){
    const m=gaitMetrics(bad,.9,120);
    assert.equal(m.cadenceSpm,null);assert.equal(m.enough,false);
  }
  assert.equal(gaitMetrics([{t:0,landmarks:[]}],null,120).cadenceSpm,null);
  assert.equal(gaitMetrics([{t:0,landmarks:[]}],.9,0).cadenceSpm,null);
});

check('對稱性指標本身的邊界',()=>{
  assert.equal(asymmetryPct(300,300),0);
  assert.ok(Math.abs(asymmetryPct(330,270)-20)<1e-9);
  for(const bad of [[NaN,300],[300,null],[0,0]]) assert.equal(asymmetryPct(...bad),null);
});

console.log(JSON.stringify({suite:'gait',cases,passed:true,
  scope:'cadence, contact time and left/right asymmetry on synthetic gait; not validated against real racewalking footage'}));
