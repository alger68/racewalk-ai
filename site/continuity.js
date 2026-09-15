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
  const b=d.box,cx=b.cx+velocity.x*elapsed,cy=b.cy+velocity.y*elapsed;
  const w=Math.min(.55,Math.max((b.x2-b.x1)*1.25,d.scale*2.1/aspect));
  const h=Math.min(.85,Math.max((b.y2-b.y1)*1.22,d.scale*3.5));
  return {x1:Math.max(0,cx-w/2),y1:Math.max(0,cy-h/2),x2:Math.min(1,cx+w/2),y2:Math.min(1,cy+h/2)};
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
