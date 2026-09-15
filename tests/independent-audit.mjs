import fs from 'node:fs';
import {computeFrameMetrics,angleDeg} from '../site/core.js';
import {ContinuousTarget} from '../site/continuity.js';
const results=[];
function check(name,actual,expected,pass,note=''){results.push({name,actual,expected,pass,note});}
const W=1920,H=1080;
const make=()=>Array.from({length:33},()=>({x:.5,y:.5,visibility:1,presence:1}));
let lm=make();
// Perpendicular equal-length vectors in true pixels: hip=(800,400), knee=(1000,600), ankle=(1200,400).
for(const [i,x,y] of [[23,800,400],[25,1000,600],[27,1200,400]])lm[i]={x:x/W,y:y/H,visibility:1,presence:1};
const value=computeFrameMetrics({index:0,landmarks:lm},{width:W,height:H,uncertaintyEnabled:false}).leftKnee?.value;
check('Pixel geometry: right-angle knee on 1920x1080',value,90,Math.abs(value-90)<1e-6,'A 2D pixel-angle test, not validation of biological joint angles.');
const reference=angleDeg({x:800,y:400},{x:1000,y:600},{x:1200,y:400});
check('Reference dot-product right angle',reference,90,Math.abs(reference-90)<1e-6);
for(const i of [23,25,27]){lm[i].visibility=0;lm[i].presence=0;}
const invisible=computeFrameMetrics({index:0,landmarks:lm},{width:W,height:H,uncertaintyEnabled:false}).leftKnee?.value??null;
check('Invisible knee must not produce a usable numeric measurement',invisible,null,invisible===null,'Checks per-joint confidence handling, separately from whole-person association.');
const pose=x=>{const p=make();for(const [i,dx,dy] of [[11,-.025,-.1],[12,.025,-.1],[23,-.02,.02],[24,.02,.02],[25,-.02,.1],[26,.02,.1],[27,-.02,.2],[28,.02,.2]])p[i]={x:x+dx,y:.4+dy,visibility:1,presence:1};return p;};
const tracker=new ContinuousTarget({id:'audit-target',landmarks:pose(.5),time:0,aspect:W/H});
const missing=tracker.match([],1);
const returned=tracker.match([pose(.5)],1.033);
check('Long gap remains unmeasured without explicit reselection',returned.index,-1,returned.index===-1);
const edgeFailures=[];for(const vx of [-100,-3,0,3,100,NaN]){tracker.good.velocity={x:vx,y:vx};const r=tracker.regionAt(9);if(!(r.x1>=0&&r.x2<=1&&r.y1>=0&&r.y2<=1&&r.x2>r.x1&&r.y2>r.y1))edgeFailures.push({vx:String(vx),r});}
check('Extreme-velocity crop remains ordered and inside frame',edgeFailures,[],edgeFailures.length===0);
fs.mkdirSync('audit-results',{recursive:true});fs.writeFileSync('audit-results/numerical-audit.json',JSON.stringify({subjectCommit:'f2791d61a1f4c289a4d41fb27a9281b7026ede57',results},null,2));
console.log(JSON.stringify(results,null,2));
