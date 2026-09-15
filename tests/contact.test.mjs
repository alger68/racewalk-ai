import assert from 'node:assert/strict';
import {contactStates,flightIntervals,lowpass,residualNoise,fillGaps,footHeights,MIN_SWING_MS} from '../site/core.js';

let cases=0;const check=(name,fn)=>{fn();cases++;console.log('PASS',name);};

// 合成步態：左右腳交替觸地，之間夾一段已知長度的騰空。
// 擺動期用 sin(pi*u)**0.6 而非 raised cosine——後者在觸地瞬間導數為零
// （腳以零速度離地落地），生理上不成立，會讓門檻式偵測看起來比實際更差。
function gait({fps=30,cycles=4,contactMs=300,flightMs=30,ground=.9,amp=.12,noise=0,seed=1}){
  const period=contactMs+flightMs,swing=contactMs+2*flightMs,lead=swing;
  const sched=side=>Array.from({length:cycles},(_,k)=>{const b=2*k*period+lead+(side==='R'?period:0);return [b,b+contactMs];});
  const L=sched('L'),R=sched('R'),endMs=R[R.length-1][1]+swing;
  let s=seed>>>0||1;const rand=()=>{s=(1664525*s+1013904223)>>>0;return s/4294967296;};
  const gauss=()=>Math.sqrt(-2*Math.log(Math.max(rand(),1e-12)))*Math.cos(2*Math.PI*rand());
  const height=(sc,t)=>{
    if(sc.some(([a,b])=>a<=t&&t<=b))return ground;
    const ends=sc.filter(([,b])=>b<=t).map(([,b])=>b),starts=sc.filter(([a])=>a>=t).map(([a])=>a);
    const prev=ends.length?Math.max(...ends):sc[0][0]-swing,next=starts.length?Math.min(...starts):sc[sc.length-1][1]+swing;
    if(next<=prev)return ground;
    const u=Math.min(1,Math.max(0,(t-prev)/(next-prev)));
    return ground-amp*Math.sin(Math.PI*u)**.6;
  };
  const dt=1000/fps,frames=[];
  for(let i=0;i*dt<=endMs;i++){const t=i*dt;
    const ly=height(L,t)+(noise?gauss()*noise:0),ry=height(R,t)+(noise?gauss()*noise:0);
    frames.push(mkFrame(t/1000,ly,ry));}
  return {frames,ground,flightMs,fps};
}
function mkFrame(t,ly,ry,vis=1){
  return {t,landmarks:Array.from({length:33},(_,i)=>{
    const isL=[27,29,31].includes(i),isR=[28,30,32].includes(i);
    return {x:.5,y:isL?ly:isR?ry:.4,visibility:(isL||isR)?vis:1};
  })};
}
const provable=f=>f.filter(x=>x.lowerMs>40);

// ---------------------------------------------------------------- 取樣界線

check('下界永不超過真值（嚴謹性）',()=>{
  for(const fps of [240,120,60,30])for(const flightMs of [50,90,150]){
    const g=gait({fps,flightMs});
    for(const f of flightIntervals(g.frames,g.ground,fps))
      assert.ok(f.lowerMs<flightMs,
        `${fps}fps 騰空 ${flightMs}ms：下界 ${f.lowerMs.toFixed(1)} 不該超過真值`);
  }
});

check('upperMs 不是嚴謹上界，門檻寬度會讓觀察區段小於真值',()=>{
  // 記錄這個已知限制：腳剛離地時仍在門檻帶內而被標成 contact，
  // 因此 upperMs 可能小於真實騰空時間。判讀只該採信 lowerMs。
  const g=gait({fps:240,flightMs:90});
  const fl=flightIntervals(g.frames,g.ground,240);
  assert.ok(fl.length>0);
  assert.ok(fl.some(f=>f.upperMs<g.flightMs),'此合成案例應重現 upperMs 低估');
});

check('單格離地證明不了任何事（下界為 0）',()=>{
  const f=[mkFrame(0,.9,.9),mkFrame(.033,.75,.75),mkFrame(.066,.9,.9)];
  const fl=flightIntervals(f,.9,30,.02);
  assert.equal(fl.length,1);assert.equal(fl[0].lowerMs,0);
});

// ------------------------------------------------------- 界線的前提不可省

check('序列端點的離地區段不輸出',()=>{
  // 開頭就離地：騰空何時開始沒有被觀察到，界線失去依據
  const f=[mkFrame(0,.75,.75),mkFrame(.033,.75,.75),mkFrame(.066,.9,.9)];
  assert.equal(flightIntervals(f,.9,30,.02).length,0);
});

check('被 unknown 夾住的離地區段不輸出',()=>{
  const blind=mkFrame(0,.9,.9,0); // 關鍵點不可見 → unknown
  const f=[blind,mkFrame(.033,.75,.75),{...blind,t:.066}];
  assert.equal(flightIntervals(f,.9,30,.02).length,0);
});

check('遮擋不會被讀成騰空',()=>{
  const g=gait({fps:30,flightMs:30});
  const lo=Math.floor(g.frames.length/3),hi=Math.floor(g.frames.length/2);
  for(let i=lo;i<hi;i++)g.frames[i]=mkFrame(g.frames[i].t,.75,.75,0); // 飄到空中且不可信
  for(const f of flightIntervals(g.frames,g.ground,30))
    assert.ok(f.endIndex<lo||f.startIndex>hi,`遮擋區間 ${lo}–${hi} 內不該有騰空標記`);
});

// -------------------------------------------------------------- 不誤報

for(const fps of [240,120,60,30])check(`合規選手（騰空 30ms）在 ${fps}fps 不被標記`,()=>{
  const g=gait({fps,flightMs:30,noise:.002});
  assert.deepEqual(provable(flightIntervals(g.frames,g.ground,fps)),[]);
});

// -------------------------------------------------------------- 抓得到

for(const fps of [240,120,60,30])check(`明顯騰空（120ms）在 ${fps}fps 證得出來`,()=>{
  const g=gait({fps,flightMs:120,noise:.002});
  assert.ok(provable(flightIntervals(g.frames,g.ground,fps)).length>0);
});

check('低幀率以漏報而非誤報的形式失去靈敏度',()=>{
  const at=fps=>provable(flightIntervals(gait({fps,flightMs:50,noise:.002}).frames,.9,fps)).length;
  assert.ok(at(30)<=at(240));
});

// ------------------------------------------------------------ 訊號處理

check('零相位：單峰位置不移動',()=>{
  const x=Array.from({length:240},(_,i)=>Math.exp(-(((i-120)/20)**2)));
  const y=lowpass(x,240,20),peak=y.indexOf(Math.max(...y));
  assert.ok(Math.abs(peak-120)<=1);
});

check('常數輸入得到常數輸出',()=>{
  // 狀態若從零開始，數百像素的 DC 偏移會在開頭衝出巨大暫態
  const y=lowpass(new Array(200).fill(.9),240);
  assert.ok(Math.max(...y.map(v=>Math.abs(v-.9)))<1e-9);
});

check('雜訊估計接近真實標準差',()=>{
  let s=7;const rand=()=>{s=(1664525*s+1013904223)>>>0;return s/4294967296;};
  const g=()=>Math.sqrt(-2*Math.log(Math.max(rand(),1e-12)))*Math.cos(2*Math.PI*rand());
  const v=Array.from({length:4000},()=>g()*.01);
  assert.ok(Math.abs(residualNoise(v)-.01)<.002);
});

check('平滑趨勢不被誤判成雜訊',()=>{
  assert.ok(residualNoise(Array.from({length:500},(_,i)=>Math.sin(i/80)))<1e-3);
});

check('內插不造出水平平台',()=>{
  const out=fillGaps([0,10,20,99,99,99,60,70],[true,true,true,false,false,false,true,true]);
  assert.deepEqual(out.slice(3,6),[30,40,50]);
  assert.equal(new Set(out.slice(3,6)).size,3);
});

check('頭尾無效區段延伸最近的有效值',()=>{
  assert.deepEqual(fillGaps([99,99,5,7,99],[false,false,true,true,false]),[5,5,5,7,7]);
});

// ------------------------------------------------------ 最短時間約束

check('觸地期間的短暫掉格被補回，不算成騰空',()=>{
  const fps=240,dt=1000/fps,n=Math.ceil(400/dt);
  const f=Array.from({length:n},(_,i)=>{
    const t=i*dt,drop=t>=200&&t<200+MIN_SWING_MS*.4; // 遠短於最短擺動時間
    return mkFrame(t/1000,drop?.75:.9,.9);});
  const st=contactStates(f,'L',.9,fps);
  assert.ok(!st.includes('off'),'同一隻腳不可能在 40ms 內離地再回到地面');
});

check('單腳最低點取三個足部關鍵點的最大 y',()=>{
  const {y,valid}=footHeights([mkFrame(0,.8,.5)],'L');
  assert.equal(y[0],.8);assert.equal(valid[0],true);
});

check('足部關鍵點不足兩個時標為不可信',()=>{
  const f=mkFrame(0,.9,.9);for(const i of [27,29])f.landmarks[i].visibility=0;
  assert.equal(footHeights([f],'L').valid[0],false);
});

console.log(JSON.stringify({suite:'contact',cases,passed:true,
  scope:'synthetic gait invariants and sampling-bound validity; not measured racewalking accuracy on real video'}));
