// Mondeling oefenen: de mascotte stelt een vraag, jij antwoordt in een hele zin.
// Alleen voor talen met L.MONDELING (nu: Duits). Gebruikt mood(), store, seeds, norm() uit taaltjes.js.
'use strict';
const M = { kap:'all', exam:false, queue:[], i:0, cur:null, goed:0, oefen:[], shown:false };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function mondInit(){
  const has = !!(L && L.MONDELING);
  $('#mondmenu').classList.toggle('hidden', !has);
  ['#mond','#mondend','#mondblad'].forEach(s=>$(s).classList.add('hidden'));
  if(!has) return;
  M.kap='all';
  $('#kap').innerHTML = [['all','Alles']].concat(L.HOOFDSTUKKEN.map(([n,t])=>[String(n),String(n)]))
    .map(([v,t])=>`<button data-v="${v}" class="${v===M.kap?'on':''}" title="${v==='all'?'Alle hoofdstukken':L.HOOFDSTUKKEN[+v-1][1]}">${t}</button>`).join('');
  kapNaam();
  $('#mic').classList.toggle('hidden', !SR);
}
function kapNaam(){ $('#kapnaam').textContent = M.kap==='all' ? 'Alle 40 vragen door elkaar' : 'Hoofdstuk '+M.kap+': '+L.HOOFDSTUKKEN[+M.kap-1][1]; }
$('#kap').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return;
  [...$('#kap').children].forEach(x=>x.classList.toggle('on',x===b)); M.kap=b.dataset.v; kapNaam(); });

// ---------- voorlezen ----------
let stemDE=null;
function kiesStem(){ const v=speechSynthesis.getVoices(); stemDE = v.find(x=>/^de(-|_)DE/i.test(x.lang) && /google|anna|helena|petra|markus/i.test(x.name)) || v.find(x=>/^de/i.test(x.lang)) || null; }
if('speechSynthesis' in window){ kiesStem(); speechSynthesis.onvoiceschanged=kiesStem; }
function zeg(t){
  if(!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(t.replace(/___/g,'…')); u.lang=L.speech||'de-DE'; u.rate=.9; if(stemDE) u.voice=stemDE;
  speechSynthesis.speak(u);
}

// ---------- ronde ----------
function mondStart(exam, alleen){
  M.exam=exam; M.i=0; M.goed=0; M.oefen=[];
  const lijst = L.MONDELING.filter(v=>M.kap==='all' || v[1]===+M.kap);
  M.queue = alleen ? shuffle(alleen) : shuffle(lijst).slice(0, M.kap==='all' ? 10 : lijst.length);
  ['#menu','#end','#game','#mondend','#mondblad'].forEach(s=>$(s).classList.add('hidden'));
  $('#mond').classList.remove('hidden');
  mood('', exam ? 'Prüfung! Ich frage, du antwortest.' : 'Ich frage, du antwortest. In ganzen Sätzen!',
           exam ? 'Examen! Ik vraag, jij antwoordt. Hardop, zonder spiekhulp.' : 'Ik vraag, jij antwoordt. In hele zinnen!', L.stk.start);
  vraag();
}
function vraag(){
  if(M.i>=M.queue.length) return mondEind();
  const v=M.cur=M.queue[M.i]; M.shown=false;
  $('#mlabel').textContent = 'Hoofdstuk '+v[1]+' · '+L.HOOFDSTUKKEN[v[1]-1][1];
  $('#mprog').textContent = (M.i+1)+' / '+M.queue.length;
  $('#mq').textContent = v[2];
  $('#mnl').textContent = v[3]; $('#mnl').classList.add('hidden');
  $('#mnlbtn').classList.toggle('hidden', M.exam);
  $('#mtyp').classList.toggle('hidden', M.exam);
  $('#minp').value=''; $('#minp').disabled=false;
  const oud = store.get('mond-ans',{})[v[0]];
  $('#mvorig').innerHTML = oud && !M.exam ? 'Vorige keer zei je: <i>'+escH(oud)+'</i>' : '';
  $('#mcheck').innerHTML=''; $('#mvoorbeeld').classList.add('hidden'); $('#mrate').classList.add('hidden');
  $('#mtoon').classList.remove('hidden');
  $('#mtoon').textContent = M.exam ? 'Ik heb geantwoord → laat zien' : 'Klaar → check en voorbeeld';
  zeg(v[2]);
  if(!M.exam) setTimeout(()=>$('#minp').focus({preventScroll:true}),50);
}
const escH=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function check(ans, v){
  const a=ans.trim(), w=a.split(/\s+/).filter(Boolean), n=' '+norm(a)+' ';
  const out=[];
  out.push([w.length>=3, w.length>=3 ? 'Hele zin' : 'Maak er een hele zin van (minstens 3 woorden)']);
  const sleutel = v[5].some(k=>n.includes(' '+k+' '));
  out.push([sleutel, sleutel ? 'Goed werkwoord ('+v[5].join(' / ')+')' : 'Gebruik: '+v[5].map(k=>'<b>'+herstel(k)+'</b>').join(' of ')]);
  if(/ (du|dein|deine|deinen|deiner|dir) /.test(n)) out.push([false,'Je praat over jezelf: <b>ich / mein / mir</b>, niet du / dein / dir']);
  if(/^[a-zäöü]/.test(a)) out.push([false,'Begin met een hoofdletter']);
  return out;
}
const herstel=k=>({heisse:'heiße',heisst:'heißt',heist:'heißt',schlaft:'schläft',schlaeft:'schläft',frist:'frisst'}[k]||k);

$('#mnlbtn').onclick=()=>$('#mnl').classList.toggle('hidden');
$('#mspeak').onclick=()=>zeg(M.cur[2]);
$('#mtoon').onclick=toon;
$('#minp').addEventListener('keydown',e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); if(!M.shown) toon(); } });
function toon(){
  if(M.shown) return; M.shown=true; const v=M.cur;
  $('#mtoon').classList.add('hidden'); $('#mnlbtn').classList.add('hidden');
  if(!M.exam){
    const a=$('#minp').value.trim(); $('#minp').disabled=true;
    if(a){ const ans=store.get('mond-ans',{}); ans[v[0]]=a; store.set('mond-ans',ans);
      $('#mcheck').innerHTML = check(a,v).map(([ok,t])=>`<li class="${ok?'ok':'no'}">${ok?'✔':'✖'} ${t}</li>`).join(''); }
    else $('#mcheck').innerHTML = '<li class="no">✖ Je hebt niets getypt. Zeg het dan in elk geval hardop!</li>';
  }
  $('#mnl').classList.remove('hidden');
  $('#mvb').innerHTML = v[4].map(s=>`<div class="vb"><button class="speak" title="Laat voorlezen" data-s="${escH(s)}">🔊</button><span>${escH(s).replace(/___/g,'<u>&nbsp;…&nbsp;</u>')}</span></div>`).join('');
  $('#mtip').textContent = '💡 '+v[6];
  $('#mvoorbeeld').classList.remove('hidden'); $('#mrate').classList.remove('hidden');
}
$('#mvb').onclick=e=>{ const b=e.target.closest('[data-s]'); if(b) zeg(b.dataset.s); };
$('#mja').onclick=()=>beoordeel(true);
$('#mnee').onclick=()=>beoordeel(false);
function beoordeel(ok){
  const v=M.cur, t=store.get('mond-tries',{});
  if(ok){ M.goed++; seeds++; t[v[0]]=Math.max(0,(t[v[0]]||0)-1); const [s,f,n]=pickNew(L.HAPPY); mood('happy',f,n,s); }
  else { M.oefen.push(v); t[v[0]]=(t[v[0]]||0)+1; const [s,f,n]=pickNew(L.ANGRY); mood('angry',f,n,s); }
  store.set('mond-tries',t); store.set('seeds',seeds); $('#seeds').textContent=seeds;
  M.i++; setTimeout(vraag, ok?700:1300);
}
$('#mstop').onclick=mondEind;

function mondEind(){
  speechSynthesis && speechSynthesis.cancel();
  $('#mond').classList.add('hidden'); $('#mondend').classList.remove('hidden');
  const tot=M.goed+M.oefen.length, pct=tot?M.goed/tot:0;
  $('#metitle').textContent = tot ? `${M.goed} van de ${tot} kon je` : 'Gestopt';
  if(tot && pct===1) mood('happy',...L.tekst.perfect,L.stk.perfect);
  else if(pct>=.7) { const [s,f,n]=pickNew(L.HAPPY); mood('happy',f,n,s); }
  else if(tot) mood('angry',...L.tekst.matig,L.stk.matig);
  $('#melist').innerHTML = M.oefen.length ? '<p>Deze nog even oefenen:</p>'+M.oefen.map(v=>`<li><b>${v[2]}</b><br><span>${escH(v[4][0]).replace(/___/g,'…')}</span></li>`).join('') : (tot?`<p>Alles goed! ${L.mascotteNL} is sprakeloos.</p>`:'');
  $('#mepractice').classList.toggle('hidden', !M.oefen.length);
}
$('#meagain').onclick=()=>mondStart(M.exam);
$('#mepractice').onclick=()=>mondStart(false, M.oefen);
$('#mehome').onclick=$('#mbhome').onclick=()=>{ ['#mondend','#mondblad'].forEach(s=>$(s).classList.add('hidden')); $('#menu').classList.remove('hidden'); mood('', ...L.tekst.opnieuw, L.stk.menu); };

// ---------- antwoordenblad ----------
$('#mblad').onclick=()=>{
  const ans=store.get('mond-ans',{});
  $('#menu').classList.add('hidden'); $('#mondblad').classList.remove('hidden');
  $('#mbody').innerHTML = L.HOOFDSTUKKEN.map(([k,t])=>`<h3>${k}. ${t}</h3><ol start="${(k-1)*5+1}">`+
    L.MONDELING.filter(v=>v[1]===k).map(v=>`<li><b>${v[2]}</b><br>${ans[v[0]] ? '<span class="mine">'+escH(ans[v[0]])+'</span>' : '<span class="small">nog niet beantwoord · voorbeeld: '+escH(v[4][0])+'</span>'}</li>`).join('')+'</ol>').join('');
  mood('', 'Deine Antworten!', 'Jouw antwoorden! Lees ze hardop voor.', L.stk.menu);
};

// ---------- inspreken (als de browser het kan) ----------
if(SR){
  let rec=null;
  $('#mic').onclick=()=>{
    if(rec){ rec.stop(); return; }
    rec=new SR(); rec.lang=L.speech||'de-DE'; rec.interimResults=true; rec.maxAlternatives=1;
    const start=$('#minp').value;
    $('#mic').classList.add('rec');
    rec.onresult=e=>{ const t=[...e.results].map(r=>r[0].transcript).join(' '); $('#minp').value=(start?start+' ':'')+t.charAt(0).toUpperCase()+t.slice(1); };
    rec.onend=rec.onerror=()=>{ $('#mic').classList.remove('rec'); rec=null; };
    try{ rec.start(); }catch(e){ rec=null; $('#mic').classList.remove('rec'); }
  };
}
document.addEventListener('click',e=>{ const b=e.target.closest('[data-mond]'); if(b) mondStart(b.dataset.mond==='exam'); });
$('#maccents').onclick=e=>{ const b=e.target.closest('button'); if(!b) return; const i=$('#minp'); if(i.disabled) return; const p=i.selectionStart??i.value.length;
  i.value=i.value.slice(0,p)+b.textContent+i.value.slice(p); i.focus(); i.setSelectionRange(p+1,p+1); };
mondInit();
