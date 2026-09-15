/** Conservative single-target association. IDs are session labels, not biometric identities. */
import { bboxFromLandmarks } from './core.js?v=3.0.5';
const TORSO = [11, 12, 23, 24];
const copyPose = pose => pose.map(p => p ? { ...p } : p);
const good = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
  (p.visibility ?? 1) >= .35 && (p.presence ?? 1) >= .35;
const mean = pts => ({ x: pts.reduce((s,p)=>s+p.x,0)/pts.length, y: pts.reduce((s,p)=>s+p.y,0)/pts.length });
const dist = (a,b,aspect) => Math.hypot((a.x-b.x)*aspect,a.y-b.y);
export function describePose(pose, aspect=1) {
  const shoulders=[pose?.[11],pose?.[12]].filter(good), hips=[pose?.[23],pose?.[24]].filter(good);
  if (!shoulders.length || !hips.length) return null;
  const s=mean(shoulders), h=mean(hips), scale=dist(s,h,aspect), box=bboxFromLandmarks(pose,.35);
  if (!box || scale<.008 || !Number.isFinite(scale)) return null;
  return { x:(s.x+h.x)/2, y:(s.y+h.y)/2, scale, box, shoulders:s, hips:h };
}
export function selectionCandidates(people, intent=null, aspect=1) {
  return (people||[]).map((pose,index)=>({index,d:describePose(pose,aspect)})).filter(({d})=>{
    if (!d) return false;
    if (!intent) return true;
    if (intent.kind==='point') {
      const p=intent.point,b=d.box;
      return p.x>=b.x1 && p.x<=b.x2 && p.y>=b.y1 && p.y<=b.y2;
    }
    if (intent.kind==='box') {
      const b=intent.box;
      // The torso must be inside the user's ROI. Never snap to a nearby person.
      return d.x>=b.x1 && d.x<=b.x2 && d.y>=b.y1 && d.y<=b.y2;
    }
    return false;
  }).map(x=>x.index);
}
export function appearanceDistance(a,b) {
  if (!a?.hist || !b?.hist || a.hist.length!==b.hist.length) return null;
  let coefficient=0;
  for(let i=0;i<a.hist.length;i++) coefficient+=Math.sqrt(Math.max(0,a.hist[i]*b.hist[i]));
  return Math.sqrt(Math.max(0,1-Math.min(1,coefficient)));
}
/** Read a small shirt/torso patch. Kept in memory only; not part of diagnostics. */
export function sampleAppearance(video,pose,canvas) {
  const aspect=video.videoWidth/video.videoHeight,d=describePose(pose,aspect);
  if (!d || !canvas || !video.videoWidth || !video.videoHeight) return null;
  const points=TORSO.map(i=>pose[i]).filter(good);
  const cx=(d.shoulders.x+d.hips.x)/2,cy=d.shoulders.y*.6+d.hips.y*.4;
  const width=Math.max(d.scale*.18/aspect,(Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x)))*.5);
  const height=Math.max(.006,Math.abs(d.hips.y-d.shoulders.y)*.55);
  const x=Math.max(0,cx-width/2),y=Math.max(0,cy-height/2);
  const w=Math.min(width,1-x),h=Math.min(height,1-y);
  if(w<=0||h<=0)return null;
  canvas.width=20;canvas.height=24;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  try {
    ctx.drawImage(video,x*video.videoWidth,y*video.videoHeight,w*video.videoWidth,h*video.videoHeight,0,0,20,24);
    const rgba=ctx.getImageData(0,0,20,24).data,hist=Array(16).fill(0);let count=0;
    for(let i=0;i<rgba.length;i+=4){
      if(rgba[i+3]<200)continue;
      const r=rgba[i]/255,g=rgba[i+1]/255,b=rgba[i+2]/255,max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
      let bin;
      if(max<.10 || delta/Math.max(.001,max)<.20) bin=12+Math.min(3,Math.floor(max*4));
      else {let hue=max===r?((g-b)/delta)%6:max===g?(b-r)/delta+2:(r-g)/delta+4;hue=(hue+6)%6;bin=Math.min(11,Math.floor(hue*2));}
      hist[bin]++;count++;
    }
    return count?{hist:hist.map(v=>v/count)}:null;
  }catch{return null;}
}
/** Fit coordinates to decoded video content, excluding any letterboxing. */
export function contentRect(width,height,frameWidth,frameHeight) {
  if(!(width>0&&height>0&&frameWidth>0&&frameHeight>0))return {x:0,y:0,width,height};
  const s=Math.min(width/frameWidth,height/frameHeight),w=frameWidth*s,h=frameHeight*s;
  return {x:(width-w)/2,y:(height-h)/2,width:w,height:h};
}
export class LockedTarget {
  constructor({id,landmarks,time,appearance=null,aspect=1}) {
    const d=describePose(landmarks,aspect);
    if(!d||!id||!Number.isFinite(time))throw new Error('指定選手缺少可靠肩髖點或時間，請改選清楚影格');
    this.id=id;this.aspect=aspect;this.anchor=d;this.last=d;this.time=time;
    this.seedPose=copyPose(landmarks);this.appearance=appearance;
    this.velocity={x:0,y:0};this.halted=null;
  }
  stop(state,reason) { this.halted={index:-1,state,reason,targetId:this.id};return this.halted; }
  match(people,time,appearances=[]) {
    if(this.halted)return {...this.halted}; // No automatic reacquisition after uncertainty.
    const dt=time-this.time;
    if(!(dt>0&&dt<=.5))return this.stop('lost','時間不連續；需重新指定選手');
    const predicted={x:this.last.x+this.velocity.x*dt,y:this.last.y+this.velocity.y*dt};
    const gate=.55+Math.min(.60,dt*2.5),rank=[];
    for(let i=0;i<(people||[]).length;i++) {
      const d=describePose(people[i],this.aspect);if(!d)continue;
      const motion=dist(d,predicted,this.aspect)/this.last.scale;
      const ratio=d.scale/this.last.scale,anchorRatio=d.scale/this.anchor.scale;
      if(motion>gate || ratio<.65 || ratio>1.55 || anchorRatio<.45 || anchorRatio>2.2)continue;
      const color=appearanceDistance(this.appearance,appearances[i]);
      if(color!=null&&color>.62)continue;
      rank.push({index:i,d,motion,color,score:motion+.35*Math.abs(Math.log(ratio))+.45*(color??0)});
    }
    rank.sort((a,b)=>a.score-b.score);
    if(!rank.length)return this.stop('lost','指定選手失聯或位置／身形／衣色不符；未改選其他人');
    const best=rank[0];
    if(rank[1] && (rank[1].score-best.score<.25 || dist(best.d,rank[1].d,this.aspect)/this.last.scale<.45))
      return this.stop('ambiguous','有兩個相近的可配對人物，無法可靠區分；暫停取值');
    // If a different-colored person substantially overlaps the target, its
    // skeleton may contaminate the target. Do not trust a single winning score.
    for(let i=0;i<(people||[]).length;i++) {
      if(i===best.index)continue;const d=describePose(people[i],this.aspect);if(!d)continue;
      if(dist(d,best.d,this.aspect)/Math.min(d.scale,best.d.scale)<.38)
        return this.stop('ambiguous','選手軀幹重疊，骨架歸屬不明；請人工複查');
    }
    const vx=(best.d.x-this.last.x)/dt,vy=(best.d.y-this.last.y)/dt;
    this.velocity={x:.5*this.velocity.x+.5*vx,y:.5*this.velocity.y+.5*vy};
    this.last=best.d;this.time=time;
    return {index:best.index,state:'locked',reason:'位置／尺度與起始衣色檢查通過',targetId:this.id,score:best.score};
  }
}
