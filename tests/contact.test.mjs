import assert from 'node:assert/strict';
import {contactStates,flightIntervals,lowpass,residualNoise,fillGaps,footHeights,
        supportKnee,verticalSupportIndex,runsOf,angleDeg,MIN_SWING_MS,
        judgeDetection,DETECTION_BANDS} from '../site/core.js';

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

// -------------------------------------------- 支撐期膝角（TR54 彎膝規則）
//
// 規則規範的是「前導腳自觸地起到通過身體垂直位置為止」。擺動期把膝蓋彎到
// 90 度是正常動作——取整段最小值會把它算進去，得到與規則無關的數字。

// 左腿可控的合成畫面：右腳固定踩地，只操作左腿。
// 髖在畫面中前進、觸地期間踝固定，因此髖會在支撐期通過踝的正上方。
//
// 膝蓋放在髖—踝連線的中點上，bend 是垂直於該連線推開的量。這樣 bend=0
// 就是真正的直腿（180°），與髖的前後位置無關——把膝蓋固定在踝的正上方
// 反而會讓髖前傾時算出 143°，那是模型的錯，不是偵測器的。
function legFrames({fps=30,durMs=2000,contacts=[[0,600],[1000,1600]],ankleXs=[.35,.65],
                    ground=.9,liftTo=.75,swingBend=.1,standBend=0}){
  const dt=1000/fps,out=[];
  for(let i=0;i*dt<=durMs;i++){
    const t=i*dt,hipX=.2+.6*(t/durMs);
    const idx=contacts.findIndex(([a,b])=>a<=t&&t<=b),planted=idx>=0;
    const ankleX=planted?ankleXs[idx]:.5;
    const footY=planted?ground:liftTo,bend=planted?standBend:swingBend;
    const hip={x:hipX,y:footY-.4},ankle={x:ankleX,y:footY};
    const knee={x:(hip.x+ankle.x)/2+bend,y:(hip.y+ankle.y)/2};
    const lm=Array.from({length:33},()=>({x:.5,y:.4,visibility:1}));
    lm[23]={...hip,visibility:1};
    lm[25]={...knee,visibility:1};
    for(const j of [27,29,31])lm[j]={...ankle,visibility:1};
    lm[24]={x:hipX,y:ground-.4,visibility:1};                 // 右腿固定踩地
    lm[26]={x:.5,y:ground-.2,visibility:1};
    for(const j of [28,30,32])lm[j]={x:.5,y:ground,visibility:1};
    out.push({t:t/1000,landmarks:lm});
  }
  return out;
}

check('支撐期伸直、擺動期彎膝 → 只有擺動期的值被排除',()=>{
  const f=legFrames({}),k=supportKnee(f,.9,30);
  assert.equal(k.left.length,2,'應該偵測到兩次觸地');
  for(const c of k.left)assert.ok(c.minAngle>175,`支撐期應接近伸直，得到 ${c.minAngle.toFixed(1)}°`);

  // 同一段畫面取整段最小值會抓到擺動期的彎膝——這正是修正前的行為
  const whole=Math.min(...f.map(x=>angleDeg(x.landmarks[23],x.landmarks[25],x.landmarks[27]))
                        .filter(Number.isFinite));
  assert.ok(whole<140,`整段最小值應該被擺動期拉低，得到 ${whole.toFixed(1)}°`);
  assert.ok(k.minLeft-whole>35,'支撐期最小值必須明顯高於整段最小值');
});

check('支撐期真的彎膝時會被抓到',()=>{
  const k=supportKnee(legFrames({standBend:.1}),.9,30);
  assert.ok(k.minLeft!=null&&k.minLeft<160,`應偵測到支撐期彎膝，得到 ${k.minLeft}`);
});

check('髖通過踝正上方的影格被找到',()=>{
  const f=legFrames({}),idx=verticalSupportIndex(f,'L',0,20);
  assert.ok(idx!=null&&idx>0);
  const before=f[idx].landmarks[23].x-f[idx].landmarks[27].x;
  const after=f[idx+1].landmarks[23].x-f[idx+1].landmarks[27].x;
  assert.ok(before===0||before*after<0,'該影格前後應有變號');
});

check('髖未通過踝時標記 partial，不假裝涵蓋完整區間',()=>{
  // 髖始終在踝左側 → 選手還沒走到中線就出框
  const f=legFrames({}).map(fr=>({...fr,landmarks:fr.landmarks.map((p,i)=>i===23?{...p,x:.05}:p)}));
  const k=supportKnee(f,.9,30);
  assert.ok(k.left.length>0);
  assert.ok(k.left.every(c=>c.partial===true&&c.supportIndex===null));
});

check('沒有觸地就沒有支撐期膝角',()=>{
  const f=legFrames({contacts:[],ankleXs:[.5]});
  const k=supportKnee(f,.9,30);
  assert.equal(k.minLeft,null);
});

check('runsOf 切出連續區段',()=>{
  assert.deepEqual(runsOf(['a','a','b','a'],'a'),[{start:0,end:1},{start:3,end:3}]);
  assert.deepEqual(runsOf([],'a'),[]);
});

check('偵測分帶只落在文獻撐得起的三帶上',()=>{
  const band=ms=>judgeDetection(ms).band;
  // 錨點一：未見裁判察覺 40 ms 以下騰空的已發表報告
  assert.equal(band(0),'below-reported');
  assert.equal(band(20),'below-reported');   // 菁英選手的常態
  assert.equal(band(39.9),'below-reported');
  // 錨點二：40–45 ms，8 位國際裁判中 3 位察覺
  assert.equal(band(40),'at-threshold');
  assert.equal(band(44.9),'at-threshold');
  // 研究指出低於約 45 ms 無法察覺屬人類視覺系統的正常表現
  assert.equal(band(45),'above-threshold');
  assert.equal(band(120),'above-threshold');
});

check('每一帶都附得出出處，不是裸門檻',()=>{
  for(const ms of [10,42,200]){
    const d=judgeDetection(ms);
    assert.ok(d.evidence.length>0,'分帶必須帶證據敘述');
    assert.ok(d.source.includes('docs/RULES.md'),'必須指得回出處文件');
    assert.equal(d.flightMs,ms);
  }
  assert.equal(DETECTION_BANDS.length,3,'文獻只撐得起三帶；加帶前要先有新出處');
});

check('非有限輸入不給分帶，而不是猜一個',()=>{
  for(const v of [null,undefined,NaN,Infinity]) assert.equal(judgeDetection(v),null);
});

check('分帶吃 lowerMs，所以只會低估不會高估',()=>{
  // 真實騰空 100 ms，取樣界線給的 lowerMs 一定 <= 100；
  // 分帶單調不減，所以用 lowerMs 得到的帶不會高於用真值得到的帶。
  const order=DETECTION_BANDS.map(b=>b.band);
  const rank=ms=>order.indexOf(judgeDetection(ms).band);
  const g=gait({fps:240,flightMs:100}),f=flightIntervals(g.frames,g.ground,240);
  assert.ok(f.length>0);
  for(const iv of f){
    assert.ok(iv.lowerMs<=100+1e-9,'下界不得超過真值');
    assert.ok(rank(iv.lowerMs)<=rank(100),'用下界分帶不得比用真值更嚴');
    assert.equal(iv.detection.band,judgeDetection(iv.lowerMs).band);
  }
});

console.log(JSON.stringify({suite:'contact',cases,passed:true,
  scope:'synthetic gait invariants and sampling-bound validity; not measured racewalking accuracy on real video'}));
