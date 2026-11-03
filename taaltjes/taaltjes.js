// Taaltjes: woordjes oefenen met een boze-maar-lieve mascotte per taal.
// Talen staan in lang/*.js (LANGS.fr, LANGS.de, ...). Engels kan later als lang/en.js.
'use strict';
const TAAL_VOLGORDE = ['fr','de','en'];
const BINNENKORT = { en: { naam:'Engels', vlag:'🇬🇧' } };

const $ = s => document.querySelector(s);
const rand=a=>a[Math.floor(Math.random()*a.length)];
const shuffle=a=>{ a=[...a]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
const globaal = { get(k,d){ try { return JSON.parse(localStorage.getItem('taaltjes-'+k)) ?? d; } catch(e){ return d; } },
                  set(k,v){ try { localStorage.setItem('taaltjes-'+k, JSON.stringify(v)); } catch(e){} } };

let L=null, store=null;
let dir='fr', set='all', mode='kies', queue=[], qi=0, cur=null, curDir='fr', answered=false, teases=0;
let seeds=0, streak=0, right=0, wrong=[], tries={}, raceEnd=0, raceTimer=null, lastSticker='';

const img = k => 'img/'+L.code+'/'+k+'.webp';
const pickNew=list=>{ let x; do{ x=rand(list); } while(list.length>1 && x[0]===lastSticker); lastSticker=x[0]; return x; };

// ---------- taal kiezen ----------
function kiesTaal(code){
  if(!LANGS[code]) code='fr';
  L=LANGS[code];
  store = { get(k,d){ try { return JSON.parse(localStorage.getItem(L.store+k)) ?? d; } catch(e){ return d; } },
            set(k,v){ try { localStorage.setItem(L.store+k, JSON.stringify(v)); } catch(e){} } };
  globaal.set('taal', code);
  if(location.hash!=='#'+code) history.replaceState(null,'','#'+code);
  clearInterval(raceTimer);
  seeds=store.get('seeds',0); tries=store.get('tries',{}); streak=0;
  $('#seeds').textContent=seeds; $('#streak').textContent=0;
  dir = dir==='mix' ? 'mix' : (dir==='nl' ? 'nl' : 'fr');
  set='all';
  document.documentElement.lang = 'nl';
  $('#h1sub').textContent = L.vlag+' '+L.naam;
  $('#himg').alt = L.mascotte;
  // tabs
  $('#tabs').innerHTML = TAAL_VOLGORDE.map(c=>{
    const t=LANGS[c];
    if(!t){ const b=BINNENKORT[c]; return b ? `<button class="tab" disabled title="Binnenkort"><span class="fl">${b.vlag}</span>${b.naam} <small>binnenkort</small></button>` : ''; }
    return `<button class="tab${c===code?' on':''}" data-taal="${c}" aria-pressed="${c===code}"><img src="img/${c}/${t.ico}.webp" alt=""><span class="fl">${t.vlag}</span>${t.naam}</button>`;
  }).join('');
  // menu
  $('#dir').innerHTML = [['fr',L.naam+' → NL'],['nl','NL → '+L.naam],['mix','Door elkaar']]
    .map(([v,t])=>`<button data-v="${v}" class="${v===dir?'on':''}">${t}</button>`).join('');
  $('#set').innerHTML = L.sets.map(([v,t])=>`<button data-v="${v}" class="${v===set?'on':''}">${t}</button>`).join('');
  $('#ico1').innerHTML = `<img src="${img(L.ico)}" alt="" style="width:44px;height:44px;object-fit:contain">`;
  $('#typhint').textContent = L.code==='de' ? 'Moeilijker! Vergeet het lidwoord (der, die, das) niet. Umlauts mag je vergeten, maar de beer ziet het wel.'
                                            : 'Moeilijker! Accenten mag je vergeten, maar de '+L.dier+' ziet het wel.';
  $('#racenaam').textContent = L.race;
  $('#plaaguitleg').textContent = '🤫 Soms gooit '+L.mascotteNL+' er stiekem een plaagwoord tussen. Telt niet mee, maar goed = 3 zaadjes.';
  ['#game','#end'].forEach(s=>$(s).classList.add('hidden')); $('#menu').classList.remove('hidden');
  mood('', ...L.tekst.hallo, L.stk.menu);
  showRecord();
}
$('#tabs').addEventListener('click',e=>{ const b=e.target.closest('.tab[data-taal]'); if(b && b.dataset.taal!==L.code) kiesTaal(b.dataset.taal); });
window.addEventListener('hashchange',()=>{ const c=location.hash.slice(1); if(LANGS[c] && c!==L.code) kiesTaal(c); });

// ---------- mascotte ----------
const ham=$('#hamster'), himg=$('#himg');
function mood(m, fr, nl, stk){
  ham.classList.remove('is-angry','is-happy','shake','hop'); void ham.offsetWidth;
  const b=$('#bubble'); b.classList.remove('angry','happy');
  if(m==='angry'){ ham.classList.add('is-angry','shake'); b.classList.add('angry'); }
  if(m==='happy'){ ham.classList.add('is-happy','hop'); b.classList.add('happy'); }
  if(stk) himg.src=img(stk);
  $('#say').textContent=fr; $('#sub').textContent=nl;
}

// ---------- lastige foute antwoorden: kleine verschillen ----------
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function matchesIn(text, groups){
  const found=[];
  groups.forEach((g,gi)=>g.forEach((cls,ci)=>cls.forEach(ph=>{
    const re=new RegExp('(^|[^\\p{L}])('+esc(ph)+')(?![\\p{L}])','giu'); let m;
    while((m=re.exec(text))){ const s=m.index+m[1].length; found.push({s,e:s+m[2].length,gi,ci,txt:m[2]}); re.lastIndex=s+1; }
  })));
  found.sort((a,b)=>(b.e-b.s)-(a.e-a.s));
  const keep=[]; for(const f of found){ if(!keep.some(k=>f.s<k.e && k.s<f.e)) keep.push(f); }
  return keep;
}
const capLike=(rep,orig)=> orig[0]!==orig[0].toLowerCase() ? rep[0].toUpperCase()+rep.slice(1) : rep;
function variants(text, groups){
  const out=new Set(), ms=matchesIn(text,groups);
  for(const m of ms){
    groups[m.gi].forEach((cls,ci)=>{ if(ci===m.ci) return;
      out.add(text.slice(0,m.s)+capLike(cls[0],m.txt)+text.slice(m.e)); });
  }
  if(ms.length>=2){ const [a,b]=shuffle(ms); const ga=groups[a.gi].filter((_,i)=>i!==a.ci), gb=groups[b.gi].filter((_,i)=>i!==b.ci);
    const [x,y]=a.s<b.s?[a,b]:[b,a], rx=capLike(rand(x===a?ga:gb)[0],x.txt), ry=capLike(rand(y===a?ga:gb)[0],y.txt);
    out.add(text.slice(0,x.s)+rx+text.slice(x.e,y.s)+ry+text.slice(y.e)); }
  return [...out];
}
function bigrams(s){ s=norm(s); const o=new Set(); for(let i=0;i<s.length-1;i++) o.add(s.slice(i,i+2)); return o; }
function sim(a,b){ const A=bigrams(a),B=bigrams(b); let n=0; A.forEach(x=>{ if(B.has(x)) n++; }); return 2*n/((A.size+B.size)||1); }
const first=s=>alts(s)[0];
function makeOptions(w, key, list){
  const target=first(w[key]), bad=new Set(alts(w[key]).map(norm));
  const ok=s=>!bad.has(norm(s));
  const v=shuffle(variants(target, key===0?L.G:NL_G).filter(ok));
  const nV = v.length>=3 && Math.random()<.35 ? 3 : Math.min(2,v.length);
  const picked=v.slice(0,nV);
  const others=list.filter(o=>o!==w && L.kind(o)===L.kind(w)).map(o=>first(o[key])).filter(s=>ok(s)&&!picked.some(p=>norm(p)===norm(s)));
  const ranked=[...new Set(others)].sort((a,b)=>sim(b,target)-sim(a,target));
  for(const s of shuffle(ranked.slice(0,5))){ if(picked.length>=3) break; picked.push(s); }
  for(const s of shuffle(L.WORDS.map(o=>first(o[key])))){ if(picked.length>=3) break; if(ok(s)&&!picked.includes(s)) picked.push(s); }
  return shuffle([{label:target,ok:true}, ...picked.map(l=>({label:l,ok:false}))]);
}

// ---------- antwoord checken ----------
const norm=s=>s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/œ/g,'oe').replace(/ß/g,'ss')
  .replace(/\([^)]*\)/g,' ').replace(/[’']/g,"'").replace(/[?!.,;:…"]/g,' ').replace(/\s+/g,' ').trim();
const plain=s=>s.toLowerCase().replace(/\([^)]*\)/g,' ').replace(/[’']/g,"'").replace(/[?!.,;:…"]/g,' ').replace(/\s+/g,' ').trim();
function alts(s){ return s.split(' / ').map(x=>x.trim()); }
// coulance: in Nederlandse antwoorden mag een getal ook in cijfers (14 = veertien) en wij/we, zij/ze, jij/je
const NL_NUM=['nul','een','twee','drie','vier','vijf','zes','zeven','acht','negen','tien','elf','twaalf','dertien','veertien','vijftien','zestien','zeventien','achttien','negentien','twintig'];
const digitsToNL=s=>s.replace(/\b(\d{1,2})\b/g,(m,d)=>{ const n=+d; return n===1?m:(NL_NUM[n]||m); });
const nlLoose=s=>digitsToNL(s).replace(/(^|\s)wij(?=\s)/gi,'$1we').replace(/(^|\s)zij(?=\s)/gi,'$1ze').replace(/(^|\s)jij(?=\s)/gi,'$1je');
const artRe = list => new RegExp('^('+list.map(esc).join('|')+')\\s*','i');
// geeft: false (fout), true (goed), of 'lidwoord' (goed, maar het lidwoord ontbrak)
function isRight(given, target, dutch){
  if(dutch){ given=nlLoose(given); target=alts(target).map(nlLoose).join(' / '); }
  const g=norm(given); if(!g) return false;
  const lw = dutch ? ['het','de','een'] : L.lidwoorden;
  const re = artRe(lw), gHasArt = re.test(g) && g.replace(re,'').length>0;
  for(const t of alts(target)){
    const n=norm(t);
    if(n===g) return true;
    const tHasArt = re.test(n);
    // Duits: het lidwoord hoort erbij. Vergeten = goed met een seintje; verkeerd lidwoord = fout.
    if(!dutch && L.code==='de'){ if(tHasArt && !gHasArt && n.replace(re,'')===g) return 'lidwoord'; continue; }
    if(n.replace(re,'')===g.replace(re,'')) return true;
  }
  return false;
}
function accentOK(given,target){ const g=plain(given).replace(/ß/g,'ss'); return alts(target).some(t=>{ const p=plain(t).replace(/ß/g,'ss'); const re=artRe(L.lidwoorden); return p===g || p.replace(re,'')===g; }); }

// ---------- spelverloop ----------
function pool(){ return L.WORDS.filter(w=>set==='all'||w[2]===set); }
function weightPick(list,n){
  const bag=[]; list.forEach(w=>{ const k=tries[w[0]]||0; for(let i=0;i<1+Math.min(k,3);i++) bag.push(w); });
  const out=[]; const seen=new Set();
  for(const w of shuffle(bag)){ if(!seen.has(w[0])){ seen.add(w[0]); out.push(w); } if(out.length>=n) break; }
  return out;
}
function sprinkleTeases(q){ // af en toe, niet te vaak: meestal 1, soms 2, soms 0
  const n = Math.random()<.2 ? 0 : Math.random()<.75 ? 1 : 2;
  shuffle(L.TEASE).slice(0,n).forEach(t=>{ const pos=3+Math.floor(Math.random()*Math.max(1,q.length-3)); q.splice(pos,0,{tease:t}); });
  return q;
}
const realCount=()=>queue.filter(x=>!x.tease).length;
function start(m, onlyThese){
  mode=m; qi=0; right=0; wrong=[]; streak=0; teases=0; $('#streak').textContent=0;
  const p=pool();
  queue = onlyThese ? shuffle(onlyThese) : (m==='race' ? weightPick(p,p.length) : weightPick(p, Math.min(15,p.length)));
  if(m==='typ') queue=queue.filter(w=>!/…/.test(w[0]));
  if(!onlyThese && m!=='race') queue=sprinkleTeases(queue);
  $('#menu').classList.add('hidden'); $('#end').classList.add('hidden'); $('#game').classList.remove('hidden');
  $('#timer').classList.toggle('hidden', m!=='race');
  if(m==='race'){ raceEnd=Date.now()+60000; clearInterval(raceTimer); raceTimer=setInterval(tick,100); }
  if(m==='race') mood('', ...L.tekst.raceStart, L.stk.raceStart); else mood('', ...L.tekst.start, L.stk.start);
  ask();
}
function tick(){ const left=raceEnd-Date.now(); $('#bar').style.width=Math.max(0,left/600)+'%'; if(left<=0){ clearInterval(raceTimer); finish(); } }
function ask(){
  if(qi>=queue.length){ if(mode==='race'){ queue=queue.concat(weightPick(pool(),pool().length)); } else return finish(); }
  if(mode==='race' && !queue[qi].tease && qi>4 && teases<3 && Math.random()<.1) queue.splice(qi,0,{tease:rand(L.TEASE)});
  const item=queue[qi]; answered=false;
  const isT=!!item.tease; cur = isT ? item.tease : item;
  curDir = dir==='mix' ? (Math.random()<.5?'fr':'nl') : dir;
  const q = curDir==='fr'?first(cur[0]):first(cur[1]);
  $('#game').classList.toggle('teasing',isT);
  $('#qlabel').textContent = isT ? '🤫 Plaagwoord! Stond níet op je lijstje' : curDir==='fr' ? 'Wat betekent…' : 'Hoe zeg je in het '+L.naam+'…';
  $('#qtext').textContent=q;
  const done=queue.slice(0,qi).filter(x=>!x.tease).length;
  $('#progress').textContent = mode==='race' ? `${right} goed` : isT ? 'bonus +3 🌻' : `${done+1} / ${realCount()}`;
  if(isT){ teases++; mood('', ...L.tekst.psst, cur[2]); }
  $('#answer').innerHTML=''; $('#nextrow').style.display='none';
  const typing = mode==='typ';
  $('#opts').classList.toggle('hidden',typing); $('#typing').classList.toggle('hidden',!typing);
  if(typing){
    const inp=$('#inp'); inp.value=''; inp.disabled=false; inp.focus();
    $('#accents').innerHTML = curDir==='nl' ? L.accents.map(c=>`<button type="button">${c}</button>`).join('') : '';
  } else {
    const key = curDir==='fr'?1:0;
    const options = isT ? teaseOptions(cur,key) : makeOptions(cur, key, pool());
    $('#opts').innerHTML = options.map((o,i)=>`<button class="opt" data-i="${i}"><small>${i+1}</small> ${o.label}</button>`).join('');
    $('#opts').onclick = e => { const b=e.target.closest('.opt'); if(!b||answered) return; judge(options[+b.dataset.i].ok, b); };
  }
}
function teaseOptions(t,key){
  const others=shuffle(L.TEASE.filter(x=>x!==t)).slice(0,3).map(x=>({label:first(x[key]),ok:false}));
  return shuffle([{label:first(t[key]),ok:true},...others]);
}
function judge(ok, btn, note){
  answered=true; const isT=!!queue[qi].tease;
  const target = curDir==='fr'?cur[1]:cur[0];
  if(isT){
    if(ok){ seeds+=3; mood('happy', ...L.tekst.plaagGoed, L.stk.plaagGoed); }
    else mood('happy', ...L.tekst.plaagFout, L.stk.plaagFout);
  } else if(ok){
    right++; streak++; seeds++;
    tries[cur[0]]=Math.max(0,(tries[cur[0]]||0)-1);
    const [s,f,n] = (streak>0 && streak%5===0) ? pickNew(L.STREAK) : pickNew(L.HAPPY);
    mood('happy',f,n,s);
  } else {
    streak=0; wrong.push(cur); tries[cur[0]]=(tries[cur[0]]||0)+1;
    const [s,f,n]=pickNew(L.ANGRY); mood('angry',f,n,s);
  }
  store.set('seeds',seeds); store.set('tries',tries);
  if(btn){ btn.classList.add(ok?'good':'bad');
    if(!ok) [...$('#opts').children].forEach(b=>{ if(b.textContent.replace(/^\d\s/,'')===first(target)) b.classList.add('good'); }); }
  const notes = { accent:'Goed! Let op de '+(L.code==='de'?'umlauts':'accenten')+': ', lidwoord:'Goed, maar vergeet het lidwoord niet: ' };
  $('#answer').innerHTML = ok ? (note ? notes[note]+`<b>${target}</b>` : `Goed! <b>${target}</b>`)
    : `Het goede antwoord: <b>${target}</b>${isT?' <span class="small">(telt niet mee, plagen mag)</span>':''}`;
  $('#seeds').textContent=seeds; $('#streak').textContent=streak;
  if(mode==='race'){ qi++; setTimeout(()=>{ if(Date.now()<raceEnd) ask(); }, ok?500:1700); $('#progress').textContent=`${right} goed`; }
  else { $('#nextrow').style.display='flex'; $('#next').focus(); }
}
$('#check').onclick=()=>{ if(answered) return; const v=$('#inp').value; const target=curDir==='fr'?cur[1]:cur[0];
  const r=isRight(v,target,curDir==='fr'); $('#inp').disabled=true;
  const note = r==='lidwoord' ? 'lidwoord' : (r && curDir==='nl' && !accentOK(v,target)) ? 'accent' : null;
  judge(!!r,null,note); };
$('#inp').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); answered? $('#next').click() : $('#check').click(); } });
$('#accents').onclick=e=>{ const b=e.target.closest('button'); if(!b) return; const i=$('#inp'); const p=i.selectionStart??i.value.length;
  i.value=i.value.slice(0,p)+b.textContent+i.value.slice(p); i.focus(); i.setSelectionRange(p+1,p+1); };
$('#next').onclick=()=>{ qi++; ask(); };
$('#stop').onclick=()=>finish();
document.addEventListener('keydown',e=>{ if(e.key==='Enter' && answered && mode!=='typ' && !$('#game').classList.contains('hidden')){ e.preventDefault(); $('#next').click(); }
  if(!answered && mode!=='typ' && /^[1-4]$/.test(e.key) && !$('#game').classList.contains('hidden')){ const b=$('#opts').children[+e.key-1]; if(b) b.click(); } });

function finish(){
  clearInterval(raceTimer);
  $('#game').classList.add('hidden'); $('#end').classList.remove('hidden');
  const total = mode==='race' ? right+wrong.length : realCount();
  let title, fr, nl, stk, m='happy';
  if(mode==='race'){
    const rec=store.get('record',0); const isRec=right>rec; if(isRec) store.set('record',right);
    title = isRec ? `Nieuw record: ${right}! 🏆` : `${right} goed in 60 seconden`;
    if(isRec){ [fr,nl]=L.tekst.record; stk=L.stk.record; }
    else if(right>=10){ [stk,fr,nl]=pickNew(L.HAPPY); }
    else { [fr,nl]=L.tekst.traag; stk=L.stk.traag; m='angry'; }
  } else {
    const pct = total ? right/total : 0;
    title = `${right} van de ${total} goed`;
    if(pct===1){ [fr,nl]=L.tekst.perfect; stk=L.stk.perfect; }
    else if(pct>=.7) [stk,fr,nl]=pickNew(L.HAPPY);
    else if(pct>=.4){ [fr,nl]=L.tekst.matig; stk=L.stk.matig; m='angry'; }
    else { [fr,nl]=L.tekst.ramp; stk=L.stk.ramp; m='angry'; }
  }
  mood(m, fr, nl, stk);
  $('#endtitle').textContent=title;
  $('#endtext').innerHTML = wrong.length ? `<p>Deze moet je nog even oefenen:</p>` : `<p>Geen enkele fout. ${L.mascotteNL} is sprakeloos.</p>`;
  const uniq=[...new Map(wrong.map(w=>[w[0],w])).values()];
  $('#mistakes').innerHTML = uniq.map(w=>`<li><b>${w[0]}</b> <span>= ${w[1]}</span></li>`).join('');
  $('#practice').classList.toggle('hidden', !uniq.length);
  $('#practice').onclick=()=>start(mode==='race'?'kies':mode, uniq);
  showRecord();
}
$('#again').onclick=()=>start(mode);
$('#home').onclick=()=>{ $('#end').classList.add('hidden'); $('#menu').classList.remove('hidden'); mood('', ...L.tekst.opnieuw, L.stk.menu); };
$('#menu').addEventListener('click',e=>{
  const s=e.target.closest('.seg button'); if(s){ const g=s.parentElement; [...g.children].forEach(b=>b.classList.toggle('on',b===s));
    if(g.id==='dir') dir=s.dataset.v; else set=s.dataset.v; return; }
  const m=e.target.closest('.mode'); if(m) start(m.dataset.m); });
function showRecord(){ const r=store.get('record',0); $('#record').textContent = `Record ${L.race.toLowerCase()}: ${r} · Zaadjes verzameld: ${seeds}`; }

kiesTaal(LANGS[location.hash.slice(1)] ? location.hash.slice(1) : globaal.get('taal','fr'));
