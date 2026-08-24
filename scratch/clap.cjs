// Gate 2, headless. Reads LPCM mic.wav directly (no AAC priming to confound the measurement).
const fs=require('fs'),p=require('path');
const dir=process.argv[2]||p.join(process.env.HOME,'dev/stc-screen-recorder/scratch/out');
const a=JSON.parse(fs.readFileSync(p.join(dir,'anchors.json'),'utf8'));
const ev=JSON.parse(fs.readFileSync(p.join(dir,'events.json'),'utf8'));
let wav=p.join(dir,'mic.wav');
if(!fs.existsSync(wav)){ console.error("no mic.wav in "+dir+" (older runs wrote mic.m4a — re-capture)"); process.exit(1); }
const buf=fs.readFileSync(wav);
let off=12,fmt=null,dataOff=0,dataLen=0;
while(off<buf.length-8){const id=buf.toString('ascii',off,off+4),sz=buf.readUInt32LE(off+4);
 if(id==='fmt ')fmt={ch:buf.readUInt16LE(off+10),sr:buf.readUInt32LE(off+12),bits:buf.readUInt16LE(off+22)};
 if(id==='data'){dataOff=off+8;dataLen=Math.min(sz,buf.length-off-8);break;} off+=8+sz+(sz&1);}
const sr=fmt.sr,n=Math.floor(dataLen/2/fmt.ch);
const d=new Float32Array(n);
for(let i=0;i<n;i++) d[i]=buf.readInt16LE(dataOff+i*2*fmt.ch)/32768;
console.log(`mic.wav ${fmt.ch}ch ${sr}Hz ${fmt.bits}bit  ${(n/sr).toFixed(2)}s  (recording was ${a.recordSeconds}s)`);

// health check — flat full-scale level means the capture is broken, not quiet
const W=Math.round(sr*0.005),F=Math.floor(n/W);
const e=new Float32Array(F);
for(let i=0;i<F;i++){let s=0;for(let j=0;j<W;j++){const v=d[i*W+j];s+=v*v;}e[i]=Math.sqrt(s/W);}
const secs=[];for(let s=0;s<Math.floor(n/sr);s++){let t=0;for(let i=s*sr;i<(s+1)*sr;i++)t+=Math.abs(d[i]);secs.push(t/sr);}
const lo=Math.min(...secs),hi=Math.max(...secs);
let peak=0,pi=0; for(let i=0;i<n;i++){const v=Math.abs(d[i]); if(v>peak){peak=v;pi=i;}}
console.log(`per-second mean|x|: min=${lo.toFixed(4)} max=${hi.toFixed(4)} ratio=${(hi/(lo||1e-9)).toFixed(1)}x`);
console.log(`peak ${peak.toFixed(4)} (${(20*Math.log10(peak||1e-9)).toFixed(1)} dBFS) at ${(pi/sr).toFixed(3)}s`);
// Crest factor, not per-second mean ratio: a clap is a ~10 ms transient and barely moves a 1 s mean.
//   broken AAC noise (run 1): peak 1.00 / mean 0.337 = 3.0   -> structureless
//   quiet, no clap  (run 3): peak 0.058                      -> no transient
//   real clap       (run 4): peak 1.00 / mean 0.005 = 200    -> good
let meanAbs=0; for(let i=0;i<n;i++) meanAbs+=Math.abs(d[i]); meanAbs/=n;
const crest = peak/(meanAbs||1e-9);
console.log(`crest factor: ${crest.toFixed(1)}x  (peak / mean|x|)`);
let bad=null;
if(crest < 5) bad=`crest factor only ${crest.toFixed(1)}x — structureless signal, no transient present`;
else if(peak < 0.15) bad=`peak is only ${(20*Math.log10(peak||1e-9)).toFixed(1)} dBFS — no loud transient anywhere. `
   + `Most likely no clap was performed on this take; failing that, check the mic is unmuted and its gain is up`;
if(bad){
  console.log(`\n*** GATE 2 NOT MEASURABLE: ${bad}. ***`);
  console.log(`*** Refusing to report a verdict: onset detection on a track with no transient fits noise`);
  console.log(`*** and produces a confident, meaningless number. ***`);
  process.exit(2);
}

const on=new Float32Array(F);
for(let i=1;i<F;i++) on[i]=Math.max(0,e[i]-e[i-1]);
const micT0=Number(a.micFirstPtsNs);
const clicks=ev.filter(x=>x.typeName==='leftMouseDown');

// Gate 2 asks about a clap PERFORMED WITH a click, so select the loudest transient that coincides
// with a mouse-down — not the loudest in the file (which may be an unpaired clap).
const clicks2=ev.filter(x=>x.typeName==='leftMouseDown')
                .map(c=>({c, t:(Number(c.tNs)-micT0)/1e9}));
const W2=Math.round(sr*0.005), F2=Math.floor(n/W2);
const pkw=new Float32Array(F2);
for(let i=0;i<F2;i++){let m=0;for(let j=0;j<W2;j++)m=Math.max(m,Math.abs(d[i*W2+j]));pkw[i]=m;}
const ordered=[...pkw.keys()].sort((x,y)=>pkw[y]-pkw[x]);
const cands=[];
for(const i of ordered){ if(cands.length>=12)break; if(cands.some(q=>Math.abs(q-i)<60))continue; cands.push(i); }

// precise onset: first sample within 40 ms before the peak exceeding 15% of it
function onsetOf(peakIdxSamples, peakVal){
  let o=peakIdxSamples;
  for(let i=peakIdxSamples;i>Math.max(0,peakIdxSamples-Math.round(sr*0.04));i--)
    if(Math.abs(d[i])>peakVal*0.15) o=i;
  return o;
}
// Report EVERY click that has a coincident transient. One sample cannot separate a clock offset
// from human clap/click asynchrony; a distribution can.
let paired=[], unpaired=[];
for(const wi of cands){
  const wStart=wi*W2; let pv=0, pIdx=wStart;
  for(let j=0;j<W2;j++){ const v=Math.abs(d[wStart+j]); if(v>pv){pv=v;pIdx=wStart+j;} }
  const oIdx=onsetOf(pIdx,pv), oSec=oIdx/sr;
  let best=null;
  for(const k of clicks2){ const dd=oSec-k.t; if(!best||Math.abs(dd)<Math.abs(best.dd)) best={dd,t:k.t}; }
  // Require real SNR. A transient only a few x the noise floor is a noise fit, and averaging those
  // in is how a meaningless verdict gets produced with a straight face.
  const snr = pv/(meanAbs||1e-9);
  if(best && Math.abs(best.dd)<=0.25) paired.push({pv,oSec,dd:best.dd,clickT:best.t,snr});
  else if(pv>0.15) unpaired.push({pv,oSec});
}
paired.sort((x,y)=>x.oSec-y.oSec);
if(unpaired.length) console.log(`  unpaired loud transients (ignored): ${unpaired.map(u=>u.oSec.toFixed(3)+'s@'+u.pv.toFixed(2)).join(', ')}`);
if(!paired.length){
  console.log(`\n*** GATE 2 NOT MEASURABLE: no loud transient within 250 ms of any click. ***`);
  process.exit(2);
}
const scr0=Number(a.screenFirstDisplayTimeNs), cam0=Number(a.cameraFirstPtsNs);
const SNR_MIN=15;
const usable=paired.filter(p=>p.snr>=SNR_MIN);
console.log(`\nclick-coincident transients (${paired.length}; ${usable.length} above the SNR floor of ${SNR_MIN}x):`);
for(const p of paired){
  const machNs=micT0+p.oSec*1e9;
  console.log(`  click ${p.clickT.toFixed(4)}s -> sound onset ${p.oSec.toFixed(4)}s  `
    + `Δ=${(p.dd*1000).toFixed(1).padStart(6)} ms (${(p.dd*1000/16.667).toFixed(2)} fr)  `
    + `${(20*Math.log10(p.pv)).toFixed(1).padStart(6)} dBFS  SNR ${p.snr.toFixed(0).padStart(3)}x  `
    + `${p.snr>=SNR_MIN?'USABLE':'rejected: noise-floor fit'}`);
}
const ds=usable.map(p=>p.dd*1000);
if(!ds.length){ console.log(`\n*** GATE 2 NOT MEASURABLE: no click-coincident transient clears the SNR floor. ***`); process.exit(2); }
const mean=ds.reduce((s,c)=>s+c,0)/ds.length;
const sd=Math.sqrt(ds.reduce((s,c)=>s+(c-mean)*(c-mean),0)/Math.max(1,ds.length-1));
console.log(`\n  mean Δ = ${mean.toFixed(1)} ms   sd = ${ds.length>1?sd.toFixed(1):'n/a'} ms   n = ${ds.length}`);
if(ds.length<3){
  console.log(`\n*** GATE 2 INCONCLUSIVE: only ${ds.length} paired sample(s).`);
  console.log(`*** A single clap/click pair cannot separate a clock offset from human asynchrony`);
  console.log(`*** (hand coordination error is easily +/-50 ms). Need >=3 paired samples.`);
  console.log(`*** BEST METHOD: click a loud mouse hard several times — the sound IS the click,`);
  console.log(`*** so there is no human coordination error at all.`);
} else if(Math.abs(mean)<=16.7){
  console.log(`\nGATE 2: PASS  (mean |Δ| = ${Math.abs(mean).toFixed(1)} ms <= 16.7 ms, n=${ds.length})`);
} else {
  console.log(`\nGATE 2: FAIL  (mean Δ = ${mean.toFixed(1)} ms > 16.7 ms over n=${ds.length}; `
    + `sd ${sd.toFixed(1)} ms ${sd<10?'is small, so this looks SYSTEMATIC — subtract it as a constant':'is large, so this is dominated by human asynchrony'})`);
}
console.log(`\n(camera pipeline latency ${((Number(a.cameraFirstRecvMachRaw)*a.nsPerMachTick-cam0)/1e6).toFixed(1)} ms, mic ${((Number(a.micFirstRecvMachRaw)*a.nsPerMachTick-micT0)/1e6).toFixed(1)} ms — already compensated in the PTS)`);
