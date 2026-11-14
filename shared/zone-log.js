/* Comfort Zone logger. Remembers, in this browser only, which tool pages you open and
   which outside links you click, so /comfort-zone/ can draw your reading bubble.
   Nothing is sent anywhere. Clear it from the Comfort Zone page. */
(() => {
  try {
    const KEY = "comfortZone.log", MAX = 4000;
    const parts = location.pathname.split("/").filter(Boolean);
    const tool = parts[0] || "home";
    const ctx = () => tool === "country-desk"
      ? (parts[1] === "all" ? decodeURIComponent(location.hash.slice(1)) : (parts[1] || ""))
      : "";
    const push = e => {
      try {
        const log = JSON.parse(localStorage.getItem(KEY) || "[]");
        log.push(e);
        if (log.length > MAX) log.splice(0, log.length - MAX);
        localStorage.setItem(KEY, JSON.stringify(log));
      } catch (_) { /* storage blocked: nothing to remember */ }
    };
    if (tool !== "comfort-zone") push({ t: Date.now(), k: "view", tool, ctx: ctx() });
    addEventListener("hashchange", () => push({ t: Date.now(), k: "view", tool, ctx: ctx() }));
    document.addEventListener("click", e => {
      const a = e.target && e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      let u;
      try { u = new URL(a.href, location.href); } catch (_) { return; }
      if (u.origin === location.origin || !/^https?:$/.test(u.protocol)) return;
      push({ t: Date.now(), k: "click", tool, ctx: ctx(), host: u.hostname.replace(/^www\./, ""),
             title: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) });
    }, true);
  } catch (_) { /* never break the host page */ }
})();
