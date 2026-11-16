/* store.js: de enige plek die met de database praat.
   Twee varianten met dezelfde functies:
   - Firebase Realtime Database (echte multiplayer, iedereen op eigen telefoon)
   - Demo (localStorage + BroadcastChannel: alleen tabbladen op één apparaat) */
(function () {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
  const params = new URLSearchParams(location.search);
  const cfg = window.FIREBASE_CONFIG || {};
  const configured = cfg.apiKey && !String(cfg.apiKey).startsWith('VUL');
  const DEMO = params.has('demo') || !configured;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Kan ' + src + ' niet laden'));
      document.head.appendChild(s);
    });
  }

  /* ---------- kleine pad-helpers voor de demo-variant ---------- */
  function getPath(obj, path) {
    return path.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const keys = path.split('/').filter(Boolean);
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (value === null || value === undefined) delete o[last];
    else o[last] = JSON.parse(JSON.stringify(value));
  }

  /* =================== Firebase =================== */
  function firebaseStore() {
    let db, auth, offset = 0;
    const TS = () => firebase.database.ServerValue.TIMESTAMP;

    const api = {
      mode: 'firebase',
      uid: null,
      async init() {
        await loadScript(SDK + 'firebase-app-compat.js');
        await loadScript(SDK + 'firebase-auth-compat.js');
        await loadScript(SDK + 'firebase-database-compat.js');
        firebase.initializeApp(cfg);
        auth = firebase.auth();
        db = firebase.database();
        const emu = window.FIREBASE_EMULATOR; // alleen voor lokaal testen
        if (emu) {
          auth.useEmulator('http://' + emu.host + ':' + emu.auth);
          db.useEmulator(emu.host, emu.db);
        }
        const user = await new Promise((resolve, reject) => {
          const off = auth.onAuthStateChanged((u) => {
            if (u) { off(); resolve(u); }
            else auth.signInAnonymously().catch((e) => { off(); reject(e); });
          });
        });
        api.uid = user.uid;
        db.ref('.info/serverTimeOffset').on('value', (s) => { offset = s.val() || 0; });
      },
      now() { return Date.now() + offset; },
      onConnection(cb) {
        db.ref('.info/connected').on('value', (s) => cb(!!s.val()));
      },
      async hostOf(code) {
        const s = await db.ref('games/' + code + '/host').once('value');
        return s.exists() ? s.val() : null;
      },
      async claimHost(code, meta) {
        const h = await api.hostOf(code);
        if (h) return h === api.uid ? 'resume' : 'taken';
        await db.ref('games/' + code + '/host').set(api.uid);
        await db.ref('games/' + code).update({ meta: Object.assign({ created: TS() }, meta), state: { phase: 'lobby' } });
        return 'new';
      },
      subscribe(code, cb) {
        const ref = db.ref('games/' + code);
        const fn = (s) => cb(s.val());
        ref.on('value', fn);
        return () => ref.off('value', fn);
      },
      async join(code, name) {
        const ref = db.ref('games/' + code + '/players/' + api.uid);
        const existing = await ref.once('value');
        const patch = { name, online: true };
        if (!existing.exists()) patch.joinedAt = TS();
        await ref.update(patch);
        // 'offAt' laat de quizmaster zien hoe lang iemand al weg is (tunnel of echt vertrokken?)
        db.ref('.info/connected').on('value', (s) => {
          if (!s.val()) return;
          ref.onDisconnect().update({ online: false, offAt: TS() });
          ref.update({ online: true }).catch(() => {});
        });
      },
      async rename(code, name) {
        await db.ref('games/' + code + '/players/' + api.uid + '/name').set(name);
      },
      hostUpdate(code, patch) {
        return db.ref('games/' + code).update(patch);
      },
      deleteGame(code) {
        return db.ref('games/' + code).remove();
      },
      async submitAnswer(code, qkey, payload) {
        try {
          await db.ref('games/' + code + '/answers/' + qkey + '/' + api.uid).set(payload);
          return 'ok';
        } catch (e) {
          return 'rejected';
        }
      }
    };
    return api;
  }

  /* =================== Demo =================== */
  function demoStore() {
    const chan = ('BroadcastChannel' in window) ? new BroadcastChannel('pubquiz-demo') : null;
    const subs = {};
    const KEY = (code) => 'pubquiz-demo:' + code;
    const read = (code) => {
      try { return JSON.parse(localStorage.getItem(KEY(code)) || 'null'); } catch (e) { return null; }
    };
    const write = (code, data) => {
      if (data == null) localStorage.removeItem(KEY(code));
      else localStorage.setItem(KEY(code), JSON.stringify(data));
      notify(code);
      if (chan) chan.postMessage(code);
    };
    const notify = (code) => (subs[code] || []).forEach((cb) => cb(read(code)));
    if (chan) chan.onmessage = (e) => notify(e.data);
    window.addEventListener('storage', (e) => {
      if (e.key && e.key.startsWith('pubquiz-demo:')) notify(e.key.slice('pubquiz-demo:'.length));
    });

    let uid = sessionStorage.getItem('pubquiz-demo-uid');
    if (!uid) {
      uid = 'demo-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('pubquiz-demo-uid', uid);
    }

    const api = {
      mode: 'demo',
      uid,
      async init() {},
      now() { return Date.now(); },
      onConnection(cb) {
        cb(navigator.onLine !== false);
        window.addEventListener('online', () => cb(true));
        window.addEventListener('offline', () => cb(false));
      },
      async hostOf(code) {
        const g = read(code);
        return g && g.host ? g.host : null;
      },
      async claimHost(code, meta) {
        const g = read(code);
        if (g && g.host) return g.host === uid ? 'resume' : 'taken';
        write(code, { host: uid, meta: Object.assign({ created: Date.now() }, meta), state: { phase: 'lobby' } });
        return 'new';
      },
      subscribe(code, cb) {
        (subs[code] = subs[code] || []).push(cb);
        setTimeout(() => cb(read(code)), 0);
        return () => { subs[code] = (subs[code] || []).filter((f) => f !== cb); };
      },
      async join(code, name) {
        const g = read(code);
        if (!g || !g.host) throw new Error('Spel bestaat niet');
        const p = (g.players && g.players[uid]) || { joinedAt: Date.now() };
        p.name = name; p.online = true;
        setPath(g, 'players/' + uid, p);
        write(code, g);
        window.addEventListener('pagehide', () => {
          const g2 = read(code);
          if (g2 && g2.players && g2.players[uid]) { g2.players[uid].online = false; g2.players[uid].offAt = Date.now(); write(code, g2); }
        });
      },
      async rename(code, name) {
        const g = read(code);
        if (g && g.players && g.players[uid]) { g.players[uid].name = name; write(code, g); }
      },
      async hostUpdate(code, patch) {
        const g = read(code) || {};
        Object.keys(patch).forEach((p) => setPath(g, p, patch[p]));
        write(code, g);
      },
      async deleteGame(code) { write(code, null); },
      async submitAnswer(code, qkey, payload) {
        const g = read(code);
        // zelfde regels als database.rules.json
        if (!g || !g.state || g.state.phase !== 'question' || g.state.qkey !== qkey) return 'rejected';
        if (getPath(g, 'answers/' + qkey + '/' + uid)) return 'rejected';
        setPath(g, 'answers/' + qkey + '/' + uid, payload);
        write(code, g);
        return 'ok';
      }
    };
    return api;
  }

  window.Store = DEMO ? demoStore() : firebaseStore();
  window.Store.isDemo = DEMO;
})();
