// Camera <-> mic alignment from a clap. One physical event, two sensors, NO input device.
// Replaces gate 2, whose click reference carries 12-54 ms of BLE HID jitter.
const fs=require('fs'), p=require('path');
const dir=process.argv[2]||p.join(process.env.HOME,'dev/stc-screen-recorder/scratch/out');
const J=n=>JSON.parse(fs.readFileSync(p.join(dir,n),'utf8'));
const a=J('anchors.json');
const mot=J('camera-motion.json');
const NS=1e6;

// ---------- audio ----------
const buf=fs.readFileSync(p.join(dir,'mic.wav'));
let off=12,fmt=null,dataOff=0,dataLen=0;
while(off<buf.length-8){const id=buf.toString('ascii',off,off+4),sz=buf.readUInt32LE(off+4);
 if(id==='fmt ')fmt={ch:buf.readUInt16LE(off+10),sr:buf.readUInt32LE(off+12)};
 if(id==='data'){dataOff=off+8;dataLen=Math.min(sz,buf.length-off-8);break;} off+=8+sz+(sz&1);}
const sr=fmt.sr,n=Math.floor(dataLen/2/fmt.ch);
const d=new Float32Array(n);
for(let i=0;i<n;i++) d[i]=buf.readInt16LE(dataOff+i*2*fmt.ch)/32768;
let meanAbs=0; for(let i=0;i<n;i++) meanAbs+=Math.abs(d[i]); meanAbs/=n;

const W=Math.round(sr*0.005), F=Math.floor(n/W);
const pkw=new Float32Array(F);
for(let i=0;i<F;i++){let m=0;for(let j=0;j<W;j++)m=Math.max(m,Math.abs(d[i*W+j]));pkw[i]=m;}
const order=[...pkw.keys()].sort((x,y)=>pkw[y]-pkw[x]);
const SNR_MIN=15, cands=[];
for(const i of order){ if(cands.length>=10)break; if(cands.some(q=>Math.abs(q-i)<60))continue;
  if(pkw[i]/meanAbs < SNR_MIN) break; cands.push(i); }
const claps=cands.map(wi=>{
  const s0=wi*W; let pv=0,pi=s0;
  for(let j=0;j<W;j++){const v=Math.abs(d[s0+j]); if(v>pv){pv=v;pi=s0+j;}}
  let o=pi; for(let i=pi;i>Math.max(0,pi-Math.round(sr*0.04));i--) if(Math.abs(d[i])>pv*0.15) o=i;
  return {sec:o/sr, pv, snr:pv/meanAbs};
}).sort((x,y)=>x.sec-y.sec);

console.log(`mic.wav   ${(n/sr).toFixed(2)}s  noise floor ${(20*Math.log10(meanAbs)).toFixed(1)} dBFS`);
console.log(`camera    ${mot.length} frames, ${mot[mot.length-1].ptsSec.toFixed(2)}s, ${(mot.length/mot[mot.length-1].ptsSec).toFixed(1)} fps`);
console.log(`anchors   camera t0 ${(Number(a.cameraFirstPtsNs)/NS).toFixed(2)} ms   mic t0 ${(Number(a.micFirstPtsNs)/NS).toFixed(2)} ms  (mach)`);
if(!claps.length){ console.log(`\n*** No transient above ${SNR_MIN}x the noise floor. No clap in this take. ***`); process.exit(2); }

// ---------- camera motion, attributed to the MIDPOINT of the frame interval ----------
const mt=[], mv=[];
for(let i=1;i<mot.length;i++){ mt.push((mot[i].ptsSec+mot[i-1].ptsSec)/2); mv.push(mot[i].motion); }
const mMean=mv.reduce((s,c)=>s+c,0)/mv.length;

const camT0=Number(a.cameraFirstPtsNs), micT0=Number(a.micFirstPtsNs);
console.log(`\nclaps found: ${claps.length}`);
const deltas=[];
for(const c of claps){
  const clapMach=micT0+c.sec*1e9;
  const wantCam=(clapMach-camT0)/1e9;                 // seconds into the camera track
  let bi=-1,bv=-1;
  for(let i=0;i<mt.length;i++){
    if(Math.abs(mt[i]-wantCam)>0.30) continue;
    if(mv[i]>bv){bv=mv[i];bi=i;}
  }
  if(bi<0){ console.log(`  clap ${c.sec.toFixed(4)}s (${(20*Math.log10(c.pv)).toFixed(1)} dBFS) — no camera frames in window`); continue; }
  // parabolic interpolation for sub-frame precision
  let tPeak=mt[bi];
  if(bi>0&&bi<mt.length-1){
    const y0=mv[bi-1],y1=mv[bi],y2=mv[bi+1], den=(y0-2*y1+y2);
    if(den!==0){ const dl=0.5*(y0-y2)/den; if(Math.abs(dl)<=1) tPeak=mt[bi]+dl*(mt[bi+1]-mt[bi-1])/2; }
  }
  const camMach=camT0+tPeak*1e9;
  const delta=(camMach-clapMach)/1e6;
  // LOCAL prominence: in a continuously-moving scene a clap cannot be 8x the GLOBAL mean, but it is
  // still a clear local maximum. Compare against the median motion in the surrounding window.
  const win=[]; for(let i=0;i<mt.length;i++) if(Math.abs(mt[i]-wantCam)<=0.30) win.push(mv[i]);
  win.sort((x,y)=>x-y);
  const localMed=win[win.length>>1]||1e-9;
  const prom=bv/localMed;
  const ok=prom>=1.8;
  console.log(`  clap ${c.sec.toFixed(4)}s ${(20*Math.log10(c.pv)).toFixed(1).padStart(6)} dBFS SNR ${c.snr.toFixed(0).padStart(3)}x`
    + `  -> cam peak ${tPeak.toFixed(4)}s (local prom ${prom.toFixed(1)}x)`
    + `  Δ=${delta.toFixed(1).padStart(7)} ms (${(delta/16.667).toFixed(2)} fr)  ${ok?'USABLE':'rejected: no local motion peak'}`);
  if(ok) deltas.push(delta);
}
if(deltas.length<2){
  console.log(`\n*** INCONCLUSIVE: ${deltas.length} usable clap(s). Need >=2 to separate a systematic offset`);
  console.log(`*** from a one-off. Re-record with 3-4 deliberate claps. ***`);
  process.exit(2);
}
const mean=deltas.reduce((s,c)=>s+c,0)/deltas.length;
const sd=Math.sqrt(deltas.reduce((s,c)=>s+(c-mean)*(c-mean),0)/(deltas.length-1));
// robust statistics too: one bad frame-peak pick should not move the verdict
const srt=[...deltas].sort((x,y)=>x-y);
const med=srt.length%2 ? srt[srt.length>>1] : (srt[srt.length/2-1]+srt[srt.length/2])/2;
const mad=[...deltas].map(x=>Math.abs(x-med)).sort((x,y)=>x-y)[deltas.length>>1];
const outliers=deltas.filter(x=>Math.abs(x-med)>Math.max(3*mad,15));
console.log(`\n  CAMERA − MIC   mean ${mean.toFixed(1)} ms (sd ${sd.toFixed(1)})   median ${med.toFixed(1)} ms (MAD ${mad.toFixed(1)})   n = ${deltas.length}`);
console.log(`                 median = ${(med/16.667).toFixed(2)} frames @60fps`);
if(outliers.length) console.log(`  outliers excluded from the median's influence: ${outliers.map(x=>x.toFixed(1)+' ms').join(', ')}`);
console.log(`\nA/V ALIGNMENT: ${Math.abs(med)<=16.7?'PASS':'FAIL'}  (median |Δ| ${Math.abs(med).toFixed(1)} ms vs 16.7 ms = 1 frame @60)`);
console.log(`\nNote: camera motion peaks at maximum hand VELOCITY, which is at/just before impact, so a`);
console.log(`small negative bias (camera slightly early) is physical, not a clock error. The camera`);
console.log(`sampling interval is ${(1000/(mot.length/mot[mot.length-1].ptsSec)).toFixed(1)} ms, which bounds this method's resolution.`);
