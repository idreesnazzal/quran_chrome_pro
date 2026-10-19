/* Read-only review probes: node review/reproduce.js */
'use strict';
const H = require('../tests/harness.js');
const {performance} = require('perf_hooks');
const e = H.newEngine(), {C, R} = e;
function loc(q) { if (q == null || q < 0) return String(q); let a=C.ayahs[C.ayahOf[q]]; return `${a.sura}:${a.aya}#${C.wordOf[q]+1}`; }
function state(t) { let r=t.result(); return {steps:t.steps, prev:t.prev, coldUntil:t.coldUntil, best:r&&loc(r.pos), cache:t.peekCache.length, hold:t.opener.hold.join(' ')}; }
function ev(idx, entries) { e.event({resultIndex:idx,results:entries.map(([t,fin])=>({t,fin}))}); }
console.log('baseline', {ayahs:C.ayahs.length, words:C.L, vocab:C.uni.size});
const t = new R.Tracker(C); t.setPrior([C.ayahs.findIndex(a=>a.sura===112&&a.aya===1)],1);
console.log('peek cold before',state(t)); t.peek(['بسم','الله','الرحمن','الرحيم']); console.log('peek cold after',state(t)); t.peek(['قل']); console.log('peek revised away from basmala',state(t));
e.start(1); ev(0,[['قل',true]]); ev(1,[['قل',true],['قل هو الله احد',true]]);
console.log('repeat-prefix', {heard:R._session.heard.join(' '),lastFinal:R._session.lastFinal.join(' ')});
e.start(1); ev(0,[['والعصر',false]]); console.log('stale-before', {lastInterim:R._session.lastInterim.join(' '),heard:R._session.heard.join(' ')});
e.start(1); console.log('stale-new-session', {lastInterim:R._session.lastInterim.join(' '),heard:R._session.heard.join(' ')});
R._session.rec.onend(); console.log('stale-onend', {heard:R._session.heard.join(' '),steps:R.tracker().steps}); e.R.stop();
const a1=C.ayahs.findIndex(a=>a.sura===112&&a.aya===1), a2=C.ayahs.findIndex(a=>a.sura===94&&a.aya===1);
const p=new R.Tracker(C);p.setPrior([a1],1); let z=p.peek(['قل']); console.log('prior-before', {best:loc(z.pos),cache:p.peekCache.length}); const a109=C.ayahs.findIndex(a=>a.sura===109&&a.aya===1);p.setPrior([a109],1000000);z=p.peek(['قل']); console.log('prior-after-same-peek', {best:loc(z.pos),cache:p.peekCache.length});p.peek([]);z=p.peek(['قل']);console.log('prior-after-invalidate', {best:loc(z.pos),cache:p.peekCache.length});
// Distinct starts, excluding virtual basmala, with 3..6-grams over the real sequence.
const real=[];for(let i=0;i<C.L;i++)if(!C.virt[i])real.push(i);
const W=real.map(q=>C.words[q]);
for(let k=3;k<=6;k++) {let map=new Map();for(let i=0;i<=W.length-k;i++){let s=W.slice(i,i+k).join(' ');let row=map.get(s);if(row)row.push(i);else map.set(s,[i]);}let pairs=[...map].filter(([s,ps])=>ps.length>1).sort((a,b)=>b[1].length-a[1].length);console.log('ngrams',k,{repeatedTypes:pairs.length,max:pairs.slice(0,4).map(([s,ps])=>[s,ps.length,ps.slice(0,3).map(i=>loc(real[i]))])});}
const counts = new Map();for(let k=1;k<=14;k++){const m=new Map();for(let i=0;i<=W.length-k;i++){const s=W.slice(i,i+k).join(' ');m.set(s,(m.get(s)||0)+1);} for(let i=0;i<=W.length-k;i++){if(C.wordOf[real[i]]===0&&!counts.has(i)&&m.get(W.slice(i,i+k).join(' '))===1) counts.set(i,k);}}
let amb=[];for(let i=0;i<W.length;i++)if(C.wordOf[real[i]]===0 && (!counts.has(i)||counts.get(i)>10))amb.push([loc(real[i]), counts.get(i)||'>14',W.slice(i,i+11).join(' ')]);
console.log('openings >10',amb.length,amb.slice(0,16));
let freqs=[...C.uni].sort((a,b)=>b[1].length-a[1].length).slice(0,120);let similar=[];for(let i=0;i<freqs.length;i++)for(let j=i+1;j<freqs.length;j++){let s=R.wordSim(freqs[i][0],freqs[j][0]);if(s>=0.75)similar.push([freqs[i][0],freqs[i][1].length,freqs[j][0],freqs[j][1].length,+s.toFixed(3)]);} similar.sort((a,b)=>b[4]-a[4]);console.log('similar common top120 >=.75',similar.length,similar.slice(0,30));
let prefixes=[];for(let [w,ps] of C.uni){if(w.length<2||ps.length<20)continue;let extensions=[...C.uni].filter(([v,vps])=>v.startsWith(w)&&v!==w&&vps.length>=10).sort((a,b)=>b[1].length-a[1].length).slice(0,3);if(extensions.length)prefixes.push([w,ps.length,...extensions.map(([v,p])=>`${v}:${p.length}`)]);}prefixes.sort((a,b)=>b[1]-a[1]);console.log('prefix examples',prefixes.slice(0,20));
// Measured word boxes versus raw split word counts (same rule as index.html).
const fs=require('fs'),vm=require('vm');const bx={window:{}};vm.runInNewContext(fs.readFileSync(require('path').join(__dirname,'../data/word_boxes.js'),'utf8'),bx);const boxes=bx.window.QURAN_WORD_BOXES;let fallback=[];for (let a of C.ayahs){let raw=a.rawText.replace(/\(\d+\)\s*$/,'').trim().split(/\s+/).filter(Boolean);let b=boxes[`${a.sura}_${a.aya}`];if(!b||b.length!==raw.length*3) fallback.push(`${a.sura}:${a.aya}`);} console.log('boxes',{measured:Object.keys(boxes).length,fallback:fallback.length,which:fallback});
// Timing: warm, one burst of fresh 15 words vs cached repeat of same interim; 1-hour equivalent throughput via repeated 600 words.
const a=C.ayahs.findIndex(a=>a.sura===67&&a.aya===1),s=C.ayahFirst[a];let words=C.words.slice(s,s+600).filter(Boolean);let bench=new R.Tracker(C);bench.setPrior([a],1);let start=performance.now();bench.peek(words.slice(0,15));let first=performance.now()-start;start=performance.now();bench.peek(words.slice(0,15));let cached=performance.now()-start;start=performance.now();bench.push(words);let push=performance.now()-start;console.log('timings ms',{peek15_first:+first.toFixed(2),peek15_same:+cached.toFixed(2),push600:+push.toFixed(2),avg_per_word:+(push/600).toFixed(3),simCache:C.simCache.size,seedCache:C.seedCache.size,peekCache:bench.peekCache.length});
let beforeMem=process.memoryUsage().heapUsed;start=performance.now();const real9000=[];for(let q=0;q<C.L&&real9000.length<9000;q++)if(!C.virt[q])real9000.push(C.words[q]);for(let i=0;i<real9000.length;i+=15)bench.push(real9000.slice(i,i+15)); console.log('synthetic9000', {words:real9000.length,seconds:+((performance.now()-start)/1000).toFixed(2),heapBeforeMB:+(beforeMem/1048576).toFixed(1),heapAfterMB:+(process.memoryUsage().heapUsed/1048576).toFixed(1),simCache:C.simCache.size,seedCache:C.seedCache.size,steps:bench.steps});
console.log('corpus endpoints',{last:loc(C.L-1),lastText:C.words[C.L-1],virtual:C.virt.filter(Boolean).length,surah9first:C.virt[C.ayahFirst[C.ayahs.findIndex(a=>a.sura===9&&a.aya===1)]-1]||0});
for (const n of [10,30,100]) {let start=performance.now();R.tokenize(('ميم ').repeat(n));console.log('strong-letter-run',{n,ms:+(performance.now()-start).toFixed(2)});}

