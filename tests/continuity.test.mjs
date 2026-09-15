import assert from 'node:assert/strict';
import {ContinuousTarget,dedupePoses,gapIntervals} from '../site/continuity.js';
const pose=(x,y=.2)=>{const lm=Array.from({length:33},()=>({x,y,visibility:1,presence:1}));for(const [i,dx,dy] of [[11,-.025,0],[12,.025,0],[23,-.02,.12],[24,.02,.12],[25,-.02,.20],[26,.02,.20],[27,-.02,.30],[28,.02,.30],[29,-.02,.31],[30,.02,.31],[31,-.03,.32],[32,.03,.32]])lm[i]={x:x+dx,y:y+dy,visibility:1,presence:1};return lm;};
const shirt=i=>({hist:Array.from({length:16},(_,j)=>Number(i===j))});
const make=()=>new ContinuousTarget({id:'T001',landmarks:pose(.4),time:0,appearance:shirt(0),aspect:16/9});
let count=0;const test=(name,fn)=>{fn();count++;console.log('PASS',name);};
test('collapse duplicate anatomical observations',()=>assert.equal(dedupePoses([pose(.4),pose(.4001),pose(.8)],16/9).length,2));
test('nearby distinct torsos remain separate',()=>assert.equal(dedupePoses([pose(.4),pose(.45)],16/9).length,2));
test('duplicate suppression keeps higher quality observation',()=>{const a=pose(.4),b=pose(.4);a.forEach(p=>p.visibility=.5);assert.equal(dedupePoses([a,b])[0],b);});
test('missing frame returns null index without halting scan',()=>{const t=make();assert.equal(t.match([],.033).index,-1);assert.equal(t.requiresReview,false);});
test('three valid observations required for recovery',()=>{const t=make();t.match([],.033);assert.equal(t.match([pose(.4)],.066,[shirt(0)]).state,'reacquiring');assert.equal(t.match([pose(.4)],.1,[shirt(0)]).index,-1);assert.equal(t.match([pose(.4)],.133,[shirt(0)]).state,'recovered');});
test('wrong outfit never provides recovery values',()=>{const t=make();t.match([],.033);for(let i=2;i<12;i++)assert.equal(t.match([pose(.4)],i/30,[shirt(6)]).index,-1);});
test('distant bystander does not replace selected person',()=>{const t=make();for(let i=1;i<20;i++)assert.equal(t.match([pose(.8)],i/30,[shirt(0)]).index,-1);});
test('long uncertainty requires explicit reselection',()=>{const t=make();t.match([],.033);assert.equal(t.match([pose(.4)],1,[shirt(0)]).state,'needs-review');assert.equal(t.match([pose(.4)],1.033,[shirt(0)]).index,-1);});
test('ROI follows selected torso with bounded coordinates',()=>{const r=make().regionAt(.033);assert(r.x1<.4&&r.x2>.4&&r.y1<.26&&r.y2>.26);assert(r.x1>=0&&r.y1>=0&&r.x2<=1&&r.y2<=1);});
// 實拍回歸：選手走到畫面右緣時，預測中心被甩出畫面，四邊各自夾到 [0,1]
// 讓 x1 落在 x2 右邊，裁出負寬度，推論層丟例外，整段 9 秒分析中止。
test('fast motion at the frame edge never yields an inverted region',()=>{
  const t=make();
  for(const vx of [0,1,2,3,5,50,-5,NaN]){
    t.good.velocity={x:vx,y:vx};
    const r=t.regionAt(1);
    assert.ok(r.x2>r.x1,`vx=${vx}：x1=${r.x1} 不該落在 x2=${r.x2} 右邊`);
    assert.ok(r.y2>r.y1,`vx=${vx}：y1 不該落在 y2 下方`);
    assert.ok(r.x1>=0&&r.y1>=0&&r.x2<=1&&r.y2<=1,`vx=${vx}：框必須留在畫面內`);
  }
});

test('every region stays large enough for the inference layer to accept',()=>{
  // 推論層要求裁切後至少 12x20 px。取常見與最小的實拍解析度各驗一次。
  const t=make();
  for(const [W,H] of [[1920,1080],[1280,720],[640,360]]){
    for(const vx of [0,3,-3]){
      t.good.velocity={x:vx,y:0};
      const r=t.regionAt(1);
      const x=Math.max(0,Math.min(W-1,Math.floor(r.x1*W))),y=Math.max(0,Math.min(H-1,Math.floor(r.y1*H)));
      const w=Math.min(W-x,Math.ceil((r.x2-r.x1)*W)),h=Math.min(H-y,Math.ceil((r.y2-r.y1)*H));
      assert.ok(w>=12&&h>=20,`${W}x${H} vx=${vx}：裁出 ${w}x${h}px，推論層會拒收`);
    }
  }
});

test('a seeded target that is never matched keeps a usable region',()=>{
  // 診斷檔的情境：0.2 秒失聯，之後 8 秒都沒配對成功。
  // 區域凍結在種子位置是可以接受的，裁不出框則不行。
  const t=make();
  for(let i=1;i<=250;i++){
    const time=i/30;
    t.match([],time);
    const r=t.regionAt(time);
    assert.ok(r.x2-r.x1>=.05&&r.y2-r.y1>=.08,`第 ${i} 格區域退化：${JSON.stringify(r)}`);
  }
  assert.equal(t.requiresReview,true,'超過 0.75 秒應轉為需重新指定');
});

test('uncertain interval metadata separates valid segments',()=>{const f=[{t:0,landmarks:pose(.4)},{t:.1,landmarks:null},{t:.2,landmarks:null},{t:.3,landmarks:pose(.4)},{t:.4,landmarks:null}];assert.deepEqual(gapIntervals(f).map(x=>x.frames),[2,1]);});
console.log(JSON.stringify({suite:'continuity',cases:count,passed:true,scope:'synthetic invariants, not measured racewalking accuracy'}));
