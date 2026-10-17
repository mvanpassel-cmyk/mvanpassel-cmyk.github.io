/* Shared list of programmes and partners per JEE technical area. Used by the JEE, IHR benchmarks, SPAR and PHEPA pages. */
(function(){
  const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let data=null;
  const css=`.prog{margin:6px 0 12px;border:1px dashed var(--line,#ccc);border-radius:10px;padding:0 12px}
.prog>summary{cursor:pointer;padding:8px 0;font-size:14px;color:var(--muted,#666)}
.prog ul{margin:0 0 10px 0;padding:0;list-style:none}
.prog li{margin:0 0 8px;font-size:14px}
.prog .pk{display:inline-block;border:1px solid var(--line,#ccc);border-radius:6px;padding:0 6px;font-size:11px;color:var(--muted,#666);margin-right:6px}
.prog .pd{display:block;font-size:13px;color:var(--muted,#666)}`;
  function areaOf(id){ const m=String(id).match(/^(PoE|CE|RE|[PDR]\d)/); return m?m[1]:null; }
  window.Programmes={
    load(base){ const st=document.createElement("style"); st.textContent=css; document.head.appendChild(st);
      return fetch((base||"../shared/")+"programmes.json").then(r=>r.json()).then(d=>{data=d;return d}).catch(()=>null); },
    areaOf,
    list(areas,{includeAll=false}={}){ if(!data) return [];
      const A=new Set((areas||[]).map(a=>areaOf(a)||a).filter(Boolean));
      return data.programmes.filter(p=>p.areas.some(a=>A.has(a))||(includeAll&&p.areas.includes("all")))
        .sort((a,b)=>(b.areas.some(x=>A.has(x))-a.areas.some(x=>A.has(x)))||(!!b.nl-!!a.nl)||a.name.localeCompare(b.name)); },
    html(areas,opts={}){ const l=this.list(areas,opts); if(!l.length) return "";
      return `<details class="prog"><summary>Programmes, networks and funders that support this area (${l.length})</summary><ul>${l.map(p=>`<li><span class="pk">${esc(p.kind)}</span><a href="${esc(p.url)}" rel="noopener">${esc(p.name)}</a> <span class="pd">${esc(p.org)} · ${esc(p.desc)}</span></li>`).join("")}</ul><p class="pd">A pointer, not an endorsement; check current eligibility. Cross-cutting programmes (SPH portal, GHSA, IANPHI, GHPP-NL/DE) are listed where they apply to all areas.</p></details>`; }
  };
})();
