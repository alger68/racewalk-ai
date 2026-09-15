/** Missing observations do not terminate the scan. No biometric identity claim. */
import {LockedTarget, describePose} from './target-lock.js?v=3.0.5';
const TORSO=[11,12,23,24];
const visible=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&(p.visibility??1)>=.35&&(p.presence??1)>=.35;
const metric=(a,b,aspect)=>Math.hypot((a.x-b.x)*aspect,a.y-b.y);
function sameObservation(a,b,aspect){
 const da=describePose(a,aspect),db=describePose(b,aspect);if(!da||!db)return false;
 const scale=Math.min(da.scale,db.scale),ratio=da.scale/db.scale;
 if(ratio<.7||ratio>1.43||metric(da,db,aspect)/scale>.20)return false;
 const distances=TORSO.filter(i=>visible(a[i])&&visible(b[i])).map(i=>metric(a[i],b[i],aspect)/scale);
 // Anatomical shoulder/hip agreement is required; box overlap alone is insufficient.
 return distances.length>=3&&Math.max(...distances)<.45&&Math.sqrt(distances.reduce((s,x)=>s+x*x,0)/distances.length)<.22;
}
const clamp=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
// 裁切區的下限。比這更小的框對姿態估計沒有意義，而且會被推論層當成無效框。
const MIN_REGION_W=.08,MIN_REGION_H=.12;
// velocity 是 Δ位置/Δ時間，取樣間隔短的時候會爆衝（0.1 畫面寬 / 0.033 秒 = 3/秒）。
// 外推位移設上限，否則預測中心會被甩出畫面。
const MAX_DRIFT=.25;
const quality=pose=>[11,12,23,24,25,26,27,28].reduce((s,i)=>s+((pose?.[i]?.visibility??0)*(pose?.[i]?.presence??1)),0);
export function dedupePoses(people=[],aspect=1){
 const kept=[];
 for(const item of people.map((pose,index)=>({pose,index,quality:quality(pose)})).sort((a,b)=>b.quality-a.quality)){
  if(!kept.some(k=>sameObservation(k.pose,item.pose,aspect)))kept.push(item);
 }
 return kept.sort((a,b)=>a.index-b.index).map(x=>x.pose);
}
/** Preserve strict matching; separately stage three-frame bounded recovery. */
export class ContinuousTarget {
 constructor(options){
  this.options=options;this.good=new LockedTarget(options);this.trial=null;this.hits=0;
  this.firstMissing=null;this.requiresReview=false;this.recoveryFrames=3;this.maxGapSeconds=.75;
 }
 regionAt(time){
  const source=this.trial||this.good,d=source.last,velocity=source.velocity;
  const elapsed=Math.min(.30,Math.max(0,time-source.time)),aspect=this.good.aspect;
  const b=d.box;
  const w=clamp(Math.min(.55,Math.max((b.x2-b.x1)*1.25,d.scale*2.1/aspect)),MIN_REGION_W,1);
  const h=clamp(Math.min(.85,Math.max((b.y2-b.y1)*1.22,d.scale*3.5)),MIN_REGION_H,1);
  // 先把預測中心夾回畫面內，再往外展開。
  // 四個邊各自夾到 [0,1] 會讓 x1 落在 x2 右邊，裁出負寬度的框——
  // 選手走到畫面邊緣時整段分析會因此中止，實拍上真的發生過。
  const drift=v=>Number.isFinite(v)?clamp(v*elapsed,-MAX_DRIFT,MAX_DRIFT):0;
  const cx=clamp(b.cx+drift(velocity.x),w/2,1-w/2),cy=clamp(b.cy+drift(velocity.y),h/2,1-h/2);
  return {x1:cx-w/2,y1:cy-h/2,x2:cx+w/2,y2:cy+h/2};
 }
 probe(source){
  const clone=new LockedTarget({...this.options});clone.last={...source.last};clone.time=source.time;
  clone.velocity={...source.velocity};return clone;
 }
 match(people,time,appearances=[]){
  if(this.requiresReview)return {index:-1,state:'needs-review',targetId:this.good.id,reason:'失聯已超過 0.75 秒；繼續掃描但停止取值，需重新指定'};
  if(this.firstMissing!==null&&time-this.good.time>this.maxGapSeconds){this.requiresReview=true;return this.match(people,time,appearances);}
  const candidate=this.probe(this.trial||this.good),result=candidate.match(people,time,appearances);
  if(result.index<0){
   if(this.firstMissing===null)this.firstMissing=time;
   this.trial=null;this.hits=0;
   return {...result,state:result.state==='ambiguous'?'ambiguous':'searching',reason:result.reason+'；此格留白並繼續掃描'};
  }
  if(this.firstMissing===null){this.good=candidate;return result;}
  this.trial=candidate;this.hits++;
  if(this.hits<this.recoveryFrames)return {index:-1,state:'reacquiring',targetId:this.good.id,reason:`重新核對指定選手 ${this.hits}/${this.recoveryFrames} 格；核對期間不取值`};
  this.good=this.trial;this.trial=null;this.hits=0;this.firstMissing=null;
  return {...result,state:'recovered',reason:'連續 3 格通過原指定選手的位置／尺度／起始衣色檢查；恢復取值'};
 }
}
export function gapIntervals(frames){
 const intervals=[];let current=null;
 for(const f of frames){
  if(!f.landmarks){if(!current){current={start:f.t,end:f.t,frames:0,reason:f.trackReason,state:f.trackState};intervals.push(current);}current.end=f.t;current.frames++;}
  else current=null;
 }
 return intervals;
}
