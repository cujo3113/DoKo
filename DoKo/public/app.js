// Versionsnummer an den Dateinamen, damit Browser nie alte und neue Dateien mischen
import E from './engine.js?v=23';
import { CARD_DEFS, CARD_BODY } from './cards.js?v=23';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Tisch und Modus ----------
  const params = new URLSearchParams(location.search);
  const TABLE = ((params.get('tisch') || 'stammtisch').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40)) || 'stammtisch';
  const PRACTICE = params.has('ueben') || location.protocol === 'file:';
  const online = !PRACTICE;          // gemeinsamer Tisch über den Server
  const readOnly = false;
  let conn = PRACTICE ? 'local' : 'connecting'; // 'online' | 'connecting' | 'local'
  let needPassword = false, pwError = '';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  function newId() {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const r = new Uint8Array(24); crypto.getRandomValues(r);
    return Array.from(r, (x) => abc[x % abc.length]).join('');
  }
  // Geheime Spieler-Kennung: bleibt in diesem Browser gespeichert, damit man nach dem Neuladen wieder auf seinem Platz sitzt.
  const me = { id: store.get('doko-uid') || newId(), name: '' };
  store.set('doko-uid', me.id);

  let state = null;      // Ansicht für diesen Spieler (vom Server oder lokal berechnet)
  let full = null;       // nur im Übungsmodus: der komplette Spielstand
  let selected = [];
  let selKey = '';
  let pendingSolo = null;   // Solo gewählt, aber noch nicht bestätigt
  let trickClearAt = 0;     // bis wann der fertige Stich noch liegen bleibt
  const TRICK_SHOW_MS = 2000;      // fertiger Stich bleibt 2 Sekunden liegen …
  const LAST_TRICK_SHOW_MS = 5000; // … der 10. Stich 5 Sekunden, erst dann kommt die Abrechnung
  let sideHold = null;             // Seitenleiste zeigt bis dahin noch den Stand vor dem letzten Stich
  let prevStateObj = null;
  let showLast = false;     // letzten Stich ansehen
  let confirmReset = false;

  function nick() {
    for (const id of ['nick', 'nick2']) { const el = $(id); if (el && el.value.trim()) return el.value.trim().slice(0, 20); }
    return store.get('doko-nick') || '';
  }
  function askName() {
    toast('Bitte zuerst deinen Namen eintragen.');
    const el = $('nick') || $('nick2');
    if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  function saveNick(v) { store.set('doko-nick', v); }

  function toast(msg, ms = 3200) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.tm); toast.tm = setTimeout(() => (t.hidden = true), ms);
  }

  const mySeat = () => (state ? state.me : -1);
  const seatName = (s) => (state.seats[s] ? state.seats[s].name : `Platz ${s + 1}`);

  // ---------- Verbindung zum Server ----------
  let ws = null, retry = 0, retryTimer = null, pingTimer = null;
  function connect() {
    clearTimeout(retryTimer);
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    conn = 'connecting'; renderMode();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try { ws = new WebSocket(`${proto}//${location.host}/api/tisch/${TABLE}`); }
    catch (e) { scheduleReconnect(); return; }
    ws.onopen = () => { retry = 0; hello(); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'welcome') { needPassword = false; pwError = ''; conn = 'online'; renderMode(); }
      else if (m.t === 'state') { state = m.view; conn = 'online'; renderMode(); onState(); }
      else if (m.t === 'error') {
        if (m.code === 'password') { needPassword = true; pwError = m.message; render(); }
        else toast(m.message || 'Das hat nicht geklappt.');
      }
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      conn = 'connecting'; renderMode();
      scheduleReconnect();
    };
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 30000);
  }
  function hello() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'hello', uid: me.id, password: store.get('doko-pw:' + TABLE) || '' }));
  }
  function scheduleReconnect() {
    clearTimeout(retryTimer);
    const wait = Math.min(10000, 500 * Math.pow(2, retry++));
    retryTimer = setTimeout(connect, wait);
  }
  document.addEventListener('visibilitychange', () => {
    if (online && document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) { retry = 0; connect(); }
  });

  // ---------- Aktionen ----------
  function act(a) {
    if (!online) {
      const r = E.dispatch(full, me.id, a);
      if (r.error) { toast(r.error); return false; }
      full = r.state; state = E.viewFor(full, me.id); onState(); return true;
    }
    if (!ws || ws.readyState !== 1) { toast('Keine Verbindung zum Tisch. Ich verbinde neu …'); connect(); return false; }
    ws.send(JSON.stringify({ t: 'act', a }));
    return true;
  }

  // ---------- Bots im Übungsmodus (online spielt der Server die Bots) ----------
  let botTimer = null;
  function scheduleBots() {
    clearTimeout(botTimer);
    if (online || !full) return;
    const rev = full.rev;
    botTimer = setTimeout(() => {
      if (!full || full.rev !== rev) return;
      const next = E.botStep(full);
      if (next) { full = next; state = E.viewFor(full, me.id); onState(); }
    }, E.botDelay(full));
  }

  // ---------- Klang (Web Audio, alles synthetisch) ----------
  const Sound = (() => {
    let ctx = null, noise = null, master = null;
    let on = true;
    try { on = localStorage.getItem('doko-sound') !== 'off'; } catch (e) {}
    function ensure() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
      master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return ctx;
    }
    const ready = () => on && ctx && ctx.state === 'running';
    function burst(t, { dur = 0.08, type = 'bandpass', f = 2500, f2 = null, q = 0.8, gain = 0.5, attack = 0.002 }) {
      const src = ctx.createBufferSource(); src.buffer = noise;
      src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.setValueAtTime(f, t); flt.Q.value = q;
      if (f2) flt.frequency.exponentialRampToValueAtTime(f2, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(flt); flt.connect(g); g.connect(master);
      src.start(t, Math.random() * 0.5, dur + 0.05);
    }
    function tone(t, { f = 440, f2 = null, dur = 0.15, gain = 0.1, type = 'sine' }) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
    }
    // --- Bausteine für natürlichere Klänge ---
    let pink = null, verb = null;
    function extras() {
      if (pink) return;
      // rosa Rauschen (weicher als weißes, klingt mehr nach Papier und Filz)
      pink = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = pink.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      }
      // kleiner Raumhall: Tisch im Zimmer
      const len = Math.floor(ctx.sampleRate * 0.35);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) { const x = ir.getChannelData(c); for (let i = 0; i < len; i++) x[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2) * (i < 40 ? i / 40 : 1); }
      verb = ctx.createConvolver(); verb.buffer = ir;
      const wet = ctx.createGain(); wet.gain.value = 0.16;
      verb.connect(wet); wet.connect(master);
    }
    function out(node) { node.connect(master); if (verb) node.connect(verb); }
    // gefiltertes Rauschen mit Hüllkurve
    function nz(t, { dur = 0.05, type = 'bandpass', f = 2000, f2 = null, q = 1, gain = 0.4, attack = 0.002, src = 'pink', curve = 'exp' }) {
      const n = ctx.createBufferSource(); n.buffer = src === 'pink' ? pink : noiseBuf();
      n.playbackRate.value = 0.9 + Math.random() * 0.2;
      const fl = ctx.createBiquadFilter(); fl.type = type; fl.Q.value = q; fl.frequency.setValueAtTime(f, t);
      if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + attack);
      if (curve === 'lin') g.gain.linearRampToValueAtTime(0.0001, t + dur); else g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(fl); fl.connect(g); out(g);
      n.start(t, Math.random() * 1.5, dur + 0.05);
    }
    const noiseBuf = () => noise; // weißes Rauschen aus ensure()
    // gedämpfte Eigenschwingungen (Holz)
    function modes(t, list, level = 1) {
      for (const [f, dec, g0] of list) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * (0.98 + Math.random() * 0.04);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(g0 * level, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
        o.connect(g); out(g); o.start(t); o.stop(t + dec + 0.03);
      }
    }
    // eine einzelne Karte, die beim Riffeln vom Daumen schnellt
    function flap(t, level, bright = 1) {
      nz(t, { src: 'white', type: 'bandpass', f: (1800 + Math.random() * 2600) * bright, q: 1.6, dur: 0.006 + Math.random() * 0.006, gain: 0.32 * level, attack: 0.0008 });
      nz(t, { type: 'lowpass', f: 900, dur: 0.012, gain: 0.12 * level, attack: 0.001 });
    }
    // Karte landet auf dem Filz
    function cardDown(t, level = 1) {
      nz(t - 0.045, { type: 'bandpass', f: 500, f2: 1600, q: 0.7, dur: 0.05, gain: 0.07 * level, attack: 0.04, curve: 'lin' }); // Luftzug
      nz(t, { src: 'white', type: 'highpass', f: 1800, dur: 0.009, gain: 0.22 * level, attack: 0.0008 });              // Kante
      nz(t, { type: 'lowpass', f: 320, dur: 0.05, gain: 0.55 * level, attack: 0.001 });                                   // Aufschlag
      nz(t + 0.004, { type: 'bandpass', f: 2600, q: 2, dur: 0.03, gain: 0.08 * level });                                    // Papier
    }
    // Hand wischt Karten über den Filz
    function slide(t, dur, level = 1) {
      nz(t, { type: 'bandpass', f: 900 + Math.random() * 300, f2: 1700 + Math.random() * 400, q: 0.9, dur, gain: 0.16 * level, attack: dur * 0.4, curve: 'lin' });
    }
    function riffle(t0) {
      // zwei Hälften schnellen ineinander: langsam - schnell - langsam, mit Anschwellen
      const n = 46 + Math.floor(Math.random() * 10);
      let t = t0;
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1);
        const env = Math.sin(Math.PI * Math.min(1, x * 1.15)) * 0.8 + 0.25;
        flap(t, env, 0.9 + x * 0.25);
        t += (0.026 - 0.015 * Math.sin(Math.PI * x)) * (0.85 + Math.random() * 0.3);
      }
      nz(t0, { type: 'lowpass', f: 650, dur: t - t0, gain: 0.06, attack: (t - t0) * 0.5, curve: 'lin' }); // Grundrauschen der Biegung
      // Brücke: Karten fallen zusammen
      let u = t + 0.08;
      for (let i = 0; i < 18; i++) { flap(u, 0.45 * (1 - i / 22), 0.65); u += 0.012 + Math.random() * 0.008; }
      // Stapel auf dem Tisch geradeklopfen
      cardDown(u + 0.12, 0.8); cardDown(u + 0.26, 0.6);
      return u + 0.4;
    }
    const fx = {
      card() { extras(); cardDown(ctx.currentTime + 0.05, 0.9 + Math.random() * 0.2); },
      collect() {
        extras(); const t = ctx.currentTime + 0.02;
        slide(t, 0.11, 0.8); slide(t + 0.07, 0.1, 0.7); slide(t + 0.14, 0.13, 0.9);
        cardDown(t + 0.3, 0.55);
      },
      shuffle() {
        extras(); let t = ctx.currentTime + 0.05;
        t = riffle(t);
        slide(t + 0.05, 0.25, 0.7); // abheben
        riffle(t + 0.4);
      },
      knock() {
        extras(); const t = ctx.currentTime + 0.02;
        const wood = [[180, 0.11, 0.55], [395, 0.07, 0.32], [720, 0.045, 0.22], [1180, 0.03, 0.12]];
        [[0, 1], [0.15, 0.8]].forEach(([d, lv]) => {
          modes(t + d, wood, lv);
          nz(t + d, { src: 'white', type: 'highpass', f: 2500, dur: 0.005, gain: 0.18 * lv, attack: 0.0006 });
          nz(t + d, { type: 'lowpass', f: 260, dur: 0.04, gain: 0.35 * lv });
        });
      },
      turn() { extras(); const t = ctx.currentTime; modes(t, [[880, 0.35, 0.05], [3520, 0.06, 0.012]]); modes(t + 0.1, [[1175, 0.4, 0.04], [4700, 0.05, 0.008]]); },
      end() { extras(); const t = ctx.currentTime; [523, 659, 784].forEach((f, i) => modes(t + i * 0.13, [[f, 0.9, 0.07], [f * 4, 0.12, 0.012]])); },
    };
    function play(name) { if (ready() && fx[name]) try { fx[name](); } catch (e) {} }
    function setOn(v) { on = v; try { localStorage.setItem('doko-sound', v ? 'on' : 'off'); } catch (e) {} if (v) ensure(); }
    // Browser spielen Ton erst nach einer Interaktion: beim ersten Klick freischalten
    ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (on) ensure(); }, { capture: true }));
    return { play, setOn, isOn: () => on, _fx: fx, _ensure: ensure };
  })();

  if (params.has('debug')) window.__doko = { Sound };
  // ---------- Stimme: Ansagen werden vorgelesen (Sprachausgabe des Browsers) ----------
  const Voice = (() => {
    const synth = window.speechSynthesis;
    let on = store.get('doko-voice') !== 'off';
    let voice = null, unlocked = false;
    // bekannte deutsche Frauenstimmen (Apple, Google, Microsoft) – die erste vorhandene gewinnt
    const PREF = ['Anna', 'Petra', 'Helena', 'Marlene', 'Vicki', 'Katja', 'Hedda', 'Amala', 'Seraphina', 'Google Deutsch', 'Sandy', 'Shelley'];
    function pick() {
      if (!synth) return null;
      const vs = synth.getVoices().filter((v) => /^de([-_]|$)/i.test(v.lang));
      for (const n of PREF) { const v = vs.find((x) => x.name.includes(n)); if (v) return v; }
      return vs.find((v) => /female|weib|frau/i.test(v.name)) || vs[0] || null;
    }
    if (synth) { voice = pick(); synth.onvoiceschanged = () => { voice = pick(); }; }
    function say(text) {
      if (!on || !synth || !text) return;
      try {
        voice = voice || pick();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'de-DE'; if (voice) u.voice = voice;
        u.rate = 0.8; u.pitch = 0.78; u.volume = 1; // tiefer und langsamer: möglichst verrucht
        synth.speak(u);
      } catch (e) { /* keine Sprachausgabe */ }
    }
    // iPhone/iPad: die erste Ausgabe muss durch einen Tipp ausgelöst werden
    ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => {
      if (unlocked || !synth || !on) return;
      unlocked = true; try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } catch (e) {}
    }, { capture: true }));
    function setOn(v) { on = v; store.set('doko-voice', v ? 'on' : 'off'); if (!v && synth) synth.cancel(); }
    return { say, setOn, isOn: () => on, available: !!synth };
  })();
  const SAY = {
    ann: { 1: { re: 'Re!', contra: 'Kontra!' }, 2: 'Keine neunzig.', 3: 'Keine sechzig.', 4: 'Keine dreißig.', 5: 'Schwarz!' },
    vorbehalt: 'Vorbehalt.',
    hochzeit: 'Hochzeit … wer will mich?',
    hzPartner: 'Ja, ich will.',
    hzAlone: 'Dann eben allein.',
    armut: 'Trumpfabgabe … wer erbarmt sich?',
    armutTaken: 'Angenommen.',
    armutNone: 'Keiner will … neu geben.',
    solo: { solo_trumpf: 'Trumpfsolo.', solo_damen: 'Damensolo.', solo_buben: 'Bubensolo.', solo_koenige: 'Königssolo.' },
    stille: 'Oh … eine stille Hochzeit.',
    schmeissen: 'Geschmissen. Neu geben, bitte.',
    bock: 'Bock!',
  };
  function renderVoiceBtn() {
    const b = $('voicebtn'); if (!b) return;
    if (!Voice.available) { b.hidden = true; return; }
    const on = Voice.isOn();
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>${on ? '' : '<path d="M4 4l16 16"/>'}</svg>Stimme ${on ? 'an' : 'aus'}`;
  }
  $('voicebtn').addEventListener('click', () => { Voice.setOn(!Voice.isOn()); renderVoiceBtn(); if (Voice.isOn()) Voice.say('Hallo, ihr Lieben.'); });
  renderVoiceBtn();

  function renderSoundBtn() {
    const b = $('soundbtn'); if (!b) return;
    const on = Sound.isOn();
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>${on ? '<path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>' : '<path d="M17 9l5 6M22 9l-5 6"/>'}</svg>Ton ${on ? 'an' : 'aus'}`;
  }
  $('soundbtn').addEventListener('click', () => { Sound.setOn(!Sound.isOn()); renderSoundBtn(); if (Sound.isOn()) setTimeout(() => Sound.play('card'), 30); });
  renderSoundBtn();

  // ---------- Kartengröße ----------
  let zoom = parseFloat(store.get('doko-zoom')) || 1;
  function applyZoom() {
    zoom = Math.min(1.6, Math.max(0.6, Math.round(zoom * 10) / 10));
    document.documentElement.style.setProperty('--zoom', String(zoom));
    $('zoomval').textContent = `Karten ${Math.round(zoom * 100)} %`;
    $('zoomout').disabled = zoom <= 0.6; $('zoomin').disabled = zoom >= 1.6;
    store.set('doko-zoom', String(zoom));
  }
  $('zoomout').addEventListener('click', () => { zoom -= 0.1; applyZoom(); });
  $('zoomin').addEventListener('click', () => { zoom += 0.1; applyZoom(); });
  applyZoom();

  // ---------- Tisch-Stil (jeder Spieler für sich, merkt sich der Browser) ----------
  const TABLES = [
    { id: 't-poker', name: 'Pokertisch' },
    { id: 't-wood', name: 'Holztisch' },
    { id: 't-classic', name: 'Spieltisch' },
    { id: '', name: 'Schlicht' },
  ];
  let tableIdx = Math.max(0, TABLES.findIndex(t => t.id === (store.get('doko-tisch') ?? 't-poker')));
  function applyTable() {
    const t = TABLES[tableIdx], felt = $('felt');
    TABLES.forEach(x => x.id && felt.classList.remove(x.id));
    if (t.id) felt.classList.add(t.id);
    store.set('doko-tisch', t.id);
    $('tablebtn').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="6"/></svg>${t.name}`;
    $('tablebtn').title = `Tisch wechseln (jetzt: ${t.name})`;
  }
  $('tablebtn').addEventListener('click', () => { tableIdx = (tableIdx + 1) % TABLES.length; applyTable(); });
  applyTable();

  // ---------- Seitenleiste und Vollbild ----------
  // Kopfzeilenhöhe messen, damit der Tisch genau den restlichen Bildschirm füllt
  const hdr = document.querySelector('header.top');
  const setHdr = () => document.documentElement.style.setProperty('--hdr', Math.ceil(hdr.getBoundingClientRect().height) + 'px');
  if (window.ResizeObserver) new ResizeObserver(setHdr).observe(hdr);
  setHdr(); addEventListener('resize', setHdr);
  const appEl = document.querySelector('.app');
  const ICON = {
    side: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
    fs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    fsx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  };
  function renderSideBtn() {
    const hidden = appEl.classList.contains('noside');
    const b = $('sidebtn');
    b.setAttribute('aria-pressed', String(!hidden));
    b.innerHTML = `${ICON.side}${hidden ? 'Spielzettel zeigen' : 'Spielzettel ausblenden'}`;
  }
  if (store.get('doko-side') === 'off') appEl.classList.add('noside');
  $('sidebtn').addEventListener('click', () => {
    appEl.classList.toggle('noside');
    store.set('doko-side', appEl.classList.contains('noside') ? 'off' : 'on');
    renderSideBtn();
  });
  renderSideBtn();

  const fsOk = document.fullscreenEnabled || document.webkitFullscreenEnabled;
  function renderFsBtn() {
    const b = $('fsbtn');
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    b.hidden = !fsOk;
    b.innerHTML = on ? `${ICON.fsx}Vollbild beenden` : `${ICON.fs}Vollbild`;
  }
  $('fsbtn').addEventListener('click', () => {
    const el = document.documentElement;
    const on = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      if (on) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else {
        const r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
        if (r && r.catch) r.catch(() => toast('Vollbild ist in diesem Browser nicht möglich.'));
      }
    } catch (e) { toast('Vollbild ist in diesem Browser nicht möglich.'); }
  });
  document.addEventListener('fullscreenchange', renderFsBtn);
  document.addEventListener('webkitfullscreenchange', renderFsBtn);
  renderFsBtn();

  let prevSnap = null;
  // Trumpfabgabe: Nachricht an alle, sobald die Karten zurückgegeben wurden
  function p0Armut(p, snap, g) { return p && snap && p.deal === snap.deal && p.phase === 'armut_return' && snap.phase === 'play' && g.armut; }
  function trumpsText(n) { return n === 0 ? 'kein Trumpf' : n === 1 ? '1 Trumpf' : `${n} Trümpfe`; }
  function armutReturnText(g) {
    const a = g.armut;
    return `Trumpfabgabe: ${seatName(a.taker)} gibt ${seatName(a.poor)} drei Karten zurück, davon ${trumpsText(a.returnedTrumps || 0)}.`;
  }
  // Was wird gesagt? (vergleicht den vorigen mit dem neuen Stand)
  function speakFor(p, snap, g) {
    if (!p || !snap) return;
    if (snap.deal !== p.deal) {
      if (/schmeißt/.test(snap.log) || /schmeißt/.test(state.log.slice(-3).join(' '))) Voice.say(SAY.schmeissen);
      else if (p.phase === 'armut_answer') Voice.say(SAY.armutNone);
      return;
    }
    if (snap.vb > p.vb && snap.phase === 'vorbehalt') Voice.say(SAY.vorbehalt);
    if (p.phase === 'vorbehalt' && snap.phase !== 'vorbehalt') {
      if (snap.type === 'hochzeit') Voice.say(SAY.hochzeit);
      else if (snap.type === 'armut') Voice.say(SAY.armut);
      else if (SAY.solo[snap.type]) Voice.say(SAY.solo[snap.type]);
    }
    if (snap.taker !== null && p.taker === null) Voice.say(SAY.armutTaken);
    if (snap.hzDone && !p.hzDone) Voice.say(snap.hzPartner !== null ? SAY.hzPartner : SAY.hzAlone);
    if (snap.stille && !p.stille && snap.phase !== 'done') Voice.say(SAY.stille);
    if (snap.ann > p.ann) {
      const a = g.ann.hist[g.ann.hist.length - 1];
      Voice.say(a.level === 1 ? SAY.ann[1][a.party] : SAY.ann[a.level]);
    }
    if (snap.phase === 'done' && p.phase !== 'done' && g.result && g.result.bockEvents && g.result.bockEvents.length) {
      setTimeout(() => Voice.say(SAY.bock), LAST_TRICK_SHOW_MS + 600);
    }
  }

  function soundsFor(st) {
    const g = st && st.game;
    const snap = g ? { deal: g.dealId, cur: g.current.length, tricks: g.tricks.length, ann: g.ann.hist.length, phase: g.phase, turn: g.turn,
      vb: g.decl.filter((d) => d && d !== 'gesund').length, type: g.type, hzDone: !!(g.hz && g.hz.done), hzPartner: g.hz ? g.hz.partner : null,
      taker: g.armut ? g.armut.taker : null, stille: !!g.stille, log: st.log[st.log.length - 1] || '' } : null;
    speakFor(prevSnap, snap, g);
    if (p0Armut(prevSnap, snap, g)) toast(armutReturnText(g), 7000);
    const p = prevSnap; prevSnap = snap;
    if (!p || !snap) return;
    const m = mySeat();
    if (snap.deal !== p.deal) { Sound.play('shuffle'); return; }
    if (snap.tricks > p.tricks) {
      const ms = snap.tricks >= 10 ? LAST_TRICK_SHOW_MS : TRICK_SHOW_MS;
      Sound.play('card'); setTimeout(() => Sound.play('collect'), ms - 250);
      // fertigen Stich liegen lassen, dann automatisch abräumen (beim 10. Stich danach die Abrechnung zeigen)
      trickClearAt = Date.now() + ms; showLast = false;
      if (snap.tricks >= 10) sideHold = prevStateObj;
      clearTimeout(soundsFor.t); soundsFor.t = setTimeout(() => { sideHold = null; render(); }, ms + 50);
    }
    else if (snap.cur > p.cur) Sound.play('card');
    if (snap.ann > p.ann) { setTimeout(() => Sound.play('knock'), 60); flashAnn(g.ann.hist[g.ann.hist.length - 1]); }
    if (snap.phase === 'done' && p.phase !== 'done') setTimeout(() => Sound.play('end'), LAST_TRICK_SHOW_MS + 100);
    else if (m >= 0 && snap.turn === m && (snap.turn !== p.turn || snap.phase !== p.phase) && snap.phase !== 'done' && !state.seats[m].bot) setTimeout(() => Sound.play('turn'), snap.tricks > p.tricks ? 900 : 250);
  }

  function onState() {
    soundsFor(state);
    const g = state && state.game;
    const k = g ? `${g.no}-${g.phase}-${g.turn}` : 'none';
    if (k !== selKey) { selected = []; selKey = k; pendingSolo = null; }
    render();
    scheduleBots();
    prevStateObj = state;
  }

  // ---------- Rendering ----------
  document.body.insertAdjacentHTML('afterbegin', '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>' + CARD_DEFS + '</defs></svg>');
  function cardSVG(c, trump) {
    return `<svg viewBox="-120 -168 240 336" aria-hidden="true">${CARD_BODY[E.key(c)]}</svg>`;
  }
  function cardHTML(c, opts = {}) {
    const s = E.suitOf(c);
    const cls = ['card', 's-' + s, opts.trump ? 'trump' : '', opts.cls || ''].join(' ');
    const inner = cardSVG(c, opts.trump);
    const aria = `${E.cardName(c)}${opts.trump ? ', Trumpf' : ''}`;
    if (opts.button) return `<button class="${cls}" data-card="${c}" aria-label="${esc(aria)}"${opts.disabled ? ' disabled' : ''}${opts.pressed !== undefined ? ` aria-pressed="${opts.pressed}"` : ''}>${inner}</button>`;
    return `<span class="${cls}" role="img" aria-label="${esc(aria)}">${inner}</span>`;
  }

  const base = () => { const m = mySeat(); return m >= 0 ? m : 0; };
  const posOf = (s) => (s - base() + 4) % 4;

  function publicType(g, viewer) {
    if (!g.type) return g.phase === 'vorbehalt' ? 'Vorbehalte werden abgefragt' : '–';
    if (g.type === 'hochzeit') {
      if (!g.hz.done) return `Hochzeit von ${seatName(g.hz.bride)} – sucht Partner`;
      if (g.hz.alone) return `Hochzeit – ${seatName(g.hz.bride)} spielt Solo`;
      return `Hochzeit: ${seatName(g.hz.bride)} & ${seatName(g.hz.partner)}`;
    }
    if (g.type === 'armut') return g.armut.taker === null ? `Trumpfabgabe von ${seatName(g.armut.poor)}` : `Trumpfabgabe: ${seatName(g.armut.poor)} & ${seatName(g.armut.taker)}`;
    if (g.type.startsWith('solo_')) return `${E.TYPE_LABEL[g.type]} von ${seatName(g.soloist)}`;
    if (g.stille) return 'Stille Hochzeit'; // nur gesetzt, wenn sie am Tisch schon klar ist
    return 'Normalspiel';
  }

  function annText(g, seat) {
    return g.ann.hist.filter((a) => a.seat === seat).map((a) => E.ANN_LABEL[a.party][a.level]);
  }
  // Ansage-Chips in Parteifarbe (blau = Re, rot = Kontra)
  function annChips(g, seat) {
    return g.ann.hist.filter((a) => a.seat === seat).map((a) => `<span class="chip annbig ${a.party}">${esc(E.ANN_LABEL[a.party][a.level])}${a.level === 1 ? ' angesagt' : ''}</span>`).join('');
  }
  function annClass(g, seat) {
    const a = g ? g.ann.hist.filter((x) => x.seat === seat) : [];
    return a.length ? ` ann-${a[0].party}` : '';
  }
  // große Einblendung über dem Tisch
  function flashAnn(a) {
    const el = $('annflash'); if (!el || !a) return;
    const label = E.ANN_LABEL[a.party][a.level];
    el.className = `annflash ${a.party}`;
    el.innerHTML = `<b>${esc(label)}!</b><span>${esc(seatName(a.seat))}${a.level > 1 ? ` · ${a.party === 're' ? 'Re' : 'Kontra'}` : ''}</span>`;
    el.hidden = false; void el.offsetWidth; el.classList.add('show');
    clearTimeout(flashAnn.t); flashAnn.t = setTimeout(() => { el.hidden = true; el.classList.remove('show'); }, 2600);
  }
  // Pflichtsoli-Stand eines Platzes
  function pflichtChip(s) {
    const n = state.pflichtSoli;
    if (!n) return '';
    const c = (state.soloCounts || [0, 0, 0, 0])[s];
    return `<span class="chip pfl${c >= n ? ' ok' : ''}" title="gespielte Pflichtsoli">Soli ${Math.min(c, n)}/${n}</span>`;
  }

  // Augen und Punkte eines Spielers, als Hover-/Tipp-Info
  function statHTML(s) {
    const g = state.game;
    if (!g) return '';
    const won = g.tricks.map((t, i) => ({ i: i + 1, p: t.points, w: t.winner })).filter((t) => t.w === s);
    const eyes = won.reduce((a, t) => a + t.p, 0);
    const total = E.totals(state)[s];
    const fmt = (v) => `${v} Pkt · ${E.euro(v)}`;
    const list = won.length ? `<span class="tricks">${won.map((t) => `<span>Stich ${t.i}: ${t.p}</span>`).join('')}</span>` : '<span>Noch kein Stich.</span>';
    return `<span class="stat" tabindex="0" aria-label="${esc(seatName(s))}: ${eyes} Augen in ${won.length} Stichen, Spielstand ${fmt(total)}"><b>${eyes}</b> Augen · ${won.length} ${won.length === 1 ? 'Stich' : 'Stiche'}`
      + `<span class="tip" role="tooltip"><strong>${esc(seatName(s))}</strong>`
      + `<span class="row"><span>Augen in diesem Spiel</span><span>${eyes}</span></span>`
      + `<span class="row"><span>Stiche</span><span>${won.length}</span></span>${list}`
      + `<span class="row"><span>Spielstand (${state.games.length} ${state.games.length === 1 ? 'Spiel' : 'Spiele'})</span><span>${fmt(total)}</span></span></span></span>`;
  }

  const DECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="1.5" width="9" height="12" rx="1.5" fill="#fff" stroke="#1a1a1a"/><rect x="2.5" y="2.5" width="9" height="12" rx="1.5" fill="#fff" stroke="#1a1a1a"/><path d="M7 6.5l2 2-2 2-2-2z" fill="#c8102e"/></svg>';
  // Symbole für Hochzeit (zwei Ringe) und Trumpfabgabe (Karten wandern)
  const ICO = {
    rings: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="14" r="5.5"/><circle cx="15" cy="14" r="5.5"/><path d="M7.5 5.5L9 3.5l1.5 2L9 7.5z" fill="currentColor" stroke-width="1"/></svg>',
    give: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="9" height="13" rx="1.5"/><path d="M14 11.5h7m-3-3l3 3-3 3" stroke-linecap="round"/></svg>',
    take: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="12" y="5" width="9" height="13" rx="1.5"/><path d="M3 11.5h7m-3-3l3 3-3 3" stroke-linecap="round"/></svg>',
    swap: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h14m-3-3l3 3-3 3M20 16H6m3-3l-3 3 3 3"/></svg>',
  };

  // Geber, wer rauskommt, wer am Zug ist
  function markers(g, s) {
    const out = [];
    if (!g) return out;
    if (g.dealer === s) out.push(`<span class="chip geber" title="Geber">${DECK_SVG}Geber</span>`);
    const first = (g.dealer + 1) % 4;
    if (s === first && (g.phase === 'vorbehalt' || g.phase.startsWith('armut') || (g.phase === 'play' && !g.tricks.length && !g.current.length))) out.push('<span class="chip lead" title="spielt die erste Karte aus">▶ kommt raus</span>');
    else if (g.phase === 'play' && g.turn === s && !g.current.length && g.tricks.length) out.push('<span class="chip lead">▶ spielt aus</span>');
    if (g.armut) {
      if (s === g.armut.poor) out.push(`<span class="chip armutgive" title="gibt die Trümpfe ab">${ICO.give}gibt Trümpfe ab</span>`);
      if (s === g.armut.taker) out.push(`<span class="chip armuttake" title="hat die Trümpfe aufgenommen">${ICO.take}nimmt Trümpfe</span>`);
    }
    if (g.type === 'hochzeit' && g.hz) {
      if (s === g.hz.bride) out.push(`<span class="chip hz" title="hat die Hochzeit">${ICO.rings}Hochzeit</span>`);
      if (s === g.hz.partner) out.push(`<span class="chip hzp" title="spielt mit der Hochzeit">${ICO.rings}Partner</span>`);
    }
    if (g.phase !== 'done' && g.turn === s) out.push('<span class="chip zug">am Zug</span>');
    return out;
  }

  // Große Anzeige oben: welches Spiel läuft gerade?
  function bannerHTML(g) {
    if (!state || state.phase === 'lobby' || !g) return '';
    const m = mySeat();
    let cls = 'gesund', title = 'Normalspiel', sub = '';
    if (g.phase === 'vorbehalt') { cls = ''; title = 'Vorbehalte'; sub = 'Gesund oder Vorbehalt?'; }
    else if (g.type === 'armut' || g.phase.startsWith('armut')) {
      cls = 'armut'; title = 'Trumpfabgabe';
      const a = g.armut;
      const given = a.trumps !== null && a.trumps !== undefined ? ` (3 Karten, davon ${trumpsText(a.trumps)})` : '';
      if (a.taker === null) sub = `${seatName(a.poor)} gibt ab${given}${g.phase === 'armut_answer' ? ` · ${seatName(g.turn)} überlegt` : ''}`;
      else if (a.returnedTrumps === null || a.returnedTrumps === undefined) sub = `${seatName(a.poor)} → ${seatName(a.taker)}${given} · Rückgabe läuft`;
      else sub = `${seatName(a.poor)} → ${seatName(a.taker)}${given} · zurück: ${trumpsText(a.returnedTrumps)}`;
    }
    else if (g.type === 'hochzeit') {
      if (g.hz.alone) { cls = 'solo'; title = 'Hochzeit ohne Partner'; sub = `Solo von ${seatName(g.hz.bride)}`; }
      else { cls = 'hochzeit'; title = 'Hochzeit'; sub = g.hz.done ? `${seatName(g.hz.bride)} & ${seatName(g.hz.partner)}` : `${seatName(g.hz.bride)} sucht Partner (erster fremder Fehlstich bis Stich 3)`; }
    } else if (g.type && g.type.startsWith('solo_')) { cls = 'solo'; title = E.TYPE_LABEL[g.type]; sub = `von ${seatName(g.soloist)}`; }
    else if (g.stille) { cls = 'solo'; title = 'Stille Hochzeit'; sub = `von ${seatName(g.soloist)}`; }
    else { title = 'Gesund'; sub = 'Normalspiel'; }
    const right = [];
    if (g.ann.re) right.push(`<span class="chip re">${E.ANN_LABEL.re[g.ann.re]}${g.ann.re > 1 ? ' (Re)' : ''}</span>`);
    if (g.ann.contra) right.push(`<span class="chip contra">${E.ANN_LABEL.contra[g.ann.contra]}${g.ann.contra > 1 ? ' (Kontra)' : ''}</span>`);
    if (g.bock) right.push(`<span class="chip bock" title="Alle Punkte zählen doppelt">BOCK ×2 · noch ${state.bockLeft}</span>`);
    if (g.phase === 'play') right.push(`<span class="chip">Stich ${Math.min(10, g.tricks.length + 1)}/10</span>`);
    const icon = cls === 'armut' ? ICO.swap : (g.type === 'hochzeit' ? ICO.rings : '');
    return `<div class="banner"><span class="gtype ${cls}">${icon}${esc(title)}</span>${sub ? `<span class="gsub">${esc(sub)}</span>` : ''}<span class="gright">${right.join('')}</span></div>`;
  }

  function seatTag(s, pos) {
    const st = state.seats[s];
    const g = state.game;
    const turn = g && g.phase !== 'done' && g.turn === s;
    const party = g ? g.known[s] : null;
    const chips = [];
    chips.push(...markers(g, s));
    if (st && st.bot) chips.push('<span class="chip bot">Bot</span>');
    if (online && st && !st.bot && !st.online) chips.push('<span class="chip off">offline</span>');
    const meta = [];
    if (g) {
      meta.push(`<span class="backs"><i></i>${g.hands[s].length}</span>`);
      if (g.phase === 'vorbehalt' && g.decl[s]) meta.push(`<span class="chip">${g.decl[s] === 'gesund' ? 'gesund' : 'Vorbehalt'}</span>`);
      if (party) meta.push(`<span class="chip ${party}">${party === 're' ? 'Re' : 'Kontra'}</span>`);
      meta.push(annChips(g, s));
      if (g.phase === 'play' || g.phase === 'done') meta.push(statHTML(s));
    }
    let take = '';
    const away = online && st && !st.bot && !st.online;
    if (st && (st.bot || away) && mySeat() < 0 && !readOnly) take = `<button class="mini" data-takeover="${s}">Platz übernehmen</button>`;
    else if (away && mySeat() >= 0) take = `<button class="mini" data-kick="${s}">Durch Bot ersetzen</button>`;
    if (g) meta.push(pflichtChip(s));
    return `<div class="seat pos-${pos}${turn ? ' turn' : ''}${annClass(g, s)}"><div class="seat-name">${esc(st ? st.name : 'frei')} ${chips.join('')}</div><div class="seat-meta">${meta.join('')}</div>${take}</div>`;
  }

  function trickHTML(g) {
    let cards = g.current, caption = '', winner = null;
    const lastT = g.tricks.length ? g.tricks[g.tricks.length - 1] : null;
    const kind = E.kindOf(g.type);
    if (!cards.length && lastT && Date.now() < trickClearAt) {
      // fertiger Stich bleibt kurz liegen, dann wird automatisch abgeräumt
      cards = lastT.cards; winner = lastT.winner;
      caption = `Stich ${g.tricks.length} an ${esc(seatName(lastT.winner))} · ${lastT.points} Augen`;
    } else if (!cards.length) {
      caption = g.turn === mySeat() ? 'Du spielst aus.' : `${esc(seatName(g.turn))} spielt aus.`;
    }
    const slots = cards.map((p) => `<div class="slot p${posOf(p.seat)}${p.seat === winner ? ' win' : ''}">${cardHTML(p.card, { trump: E.isTrump(p.card, kind) })}</div>`).join('');
    let last = '';
    if (lastT && cards !== lastT.cards) {
      last = `<button class="mini lastbtn" data-act="lasttrick" aria-pressed="${showLast}">${showLast ? 'Schließen' : 'Letzter Stich'}</button>`;
      if (showLast) {
        last += `<div class="lastview" role="dialog" aria-label="Letzter Stich"><div class="row4">${lastT.cards.map((p) => `<figure class="${p.seat === lastT.winner ? 'win' : ''}">${cardHTML(p.card, { trump: E.isTrump(p.card, kind) })}<figcaption>${esc(seatName(p.seat))}</figcaption></figure>`).join('')}</div>
          <p class="muted">Stich ${g.tricks.length} an <strong>${esc(seatName(lastT.winner))}</strong> · ${lastT.points} Augen</p></div>`;
      }
    }
    return `<div class="trick" aria-live="polite">${last}${slots}<div class="trick-caption">${caption}</div></div>`;
  }

  function endHTML() {
    const tot = E.totals(state);
    const pen = state.games.find((x) => x.pflicht);
    const order = [0, 1, 2, 3].sort((a, b) => tot[a] - tot[b]);
    return `<div class="panel">
      <h2>Partie beendet</h2>
      <p class="muted">${(() => { const n = state.games.filter((x) => !x.pflicht).length; return n === 1 ? '1 Spiel.' : `${n} Spiele.`; })()}${pen ? ` Fehlende Pflichtsoli: ${pen.missing.map((x, i) => (x ? `${esc(seatName(i))} ${x}` : null)).filter(Boolean).join(', ')} (je ${E.RULES.pflichtPenalty} Punkte).` : (state.pflichtSoli ? ' Alle Pflichtsoli wurden gespielt.' : '')}</p>
      <ul class="lines">${order.map((i) => `<li><span>${esc(seatName(i))}</span><span class="p">${tot[i]} Punkte · ${E.euro(tot[i])}</span></li>`).join('')}</ul>
      <div class="btnrow"><button class="btn" data-act="pdf">Spielzettel als PDF</button><button class="btn primary" data-act="reset"${readOnly ? ' disabled' : ''}>Neue Partie starten</button></div>
    </div>`;
  }

  function lobbyHTML() {
    const m = mySeat();
    const boxes = state.seats.map((s, i) => {
      if (s) {
        const mine = i === m;
        return `<div class="seatbox taken"><span>${esc(s.name)}${s.bot ? ' <span class="chip bot">Bot</span>' : ''}${online && !s.bot && !s.online ? ' <span class="chip off">offline</span>' : ''}${mine ? ' (du)' : ''}</span>${mine || s.bot ? `<button class="mini" data-leave="${i}">${mine ? 'Aufstehen' : 'Entfernen'}</button>`
          : online && !s.online ? (m < 0 ? `<button class="btn primary" data-takeover="${i}">Platz übernehmen</button>` : `<button class="mini" data-kick="${i}">Platz freigeben</button>`) : ''}</div>`;
      }
      return `<div class="seatbox"><span>Platz ${i + 1} frei</span>${m < 0 && !readOnly ? `<button class="btn primary" data-sit="${i}">Hinsetzen</button>` : ''}</div>`;
    }).join('');
    const full = state.seats.every((s) => s);
    return `<div class="panel">
      <h2>Wer spielt mit?</h2>
      <p class="muted">${online ? 'Schick deinen Freunden den Link zu dieser Seite. Wer sie öffnet, sitzt am selben Tisch. Freie Plätze kannst du mit Bots auffüllen.' : 'Übungsmodus: Du spielst allein gegen drei Bots, nur in diesem Fenster.'}</p>
      <label class="nick" for="nick"><strong>Dein Name</strong> <input id="nick" maxlength="20" autocomplete="nickname" placeholder="Name eintragen" value="${esc(nick())}"></label>
      <div class="seatlist">${boxes}</div>
      <div class="pflicht"><strong>Pflichtsoli pro Spieler</strong>
        <span class="seg" role="group" aria-label="Pflichtsoli pro Spieler">${[0, 1, 2, 3, 4].map((n) => `<button class="segbtn" data-pflicht="${n}" aria-pressed="${state.pflichtSoli === n}"${m < 0 ? ' disabled' : ''}>${n}</button>`).join('')}</span>
        <span class="muted">${state.pflichtSoli === null || state.pflichtSoli === undefined ? 'Bitte vor dem Start festlegen.' : 'Für jedes fehlende Solo gibt es am Ende der Partie 100 Punkte.'}</span></div>
      <div class="btnrow">
        <button class="btn" data-act="fillBots"${full || readOnly ? ' disabled' : ''}>Freie Plätze mit Bots füllen</button>
        <button class="btn primary" data-act="start"${!full || readOnly || typeof state.pflichtSoli !== 'number' ? ' disabled' : ''}>Spiel starten</button>
        ${online ? '<a class="btn" href="?ueben=1" target="_blank" rel="noopener">Allein gegen Bots üben</a>' : ''}
      </div>
    </div>`;
  }

  function vorbehaltHTML(g) {
    const m = mySeat();
    const order = [1, 2, 3, 4].map((i) => (g.dealer + i) % 4);
    const status = order.map((s) => `<span class="chip">${esc(seatName(s))}: ${g.decl[s] ? (g.decl[s] === 'gesund' ? 'gesund' : 'Vorbehalt') : s === g.turn ? 'überlegt …' : '–'}</span>`).join(' ');
    if (g.turn === m && pendingSolo) {
      const label = E.DECL_LABEL[pendingSolo];
      const txt = {
        hochzeit: ['Hochzeit ansagen?', 'Bist du sicher? Der erste fremde Fehlstich in den ersten drei Stichen bestimmt deinen Partner, sonst spielst du ein Solo. Sagst du stattdessen „Gesund“, spielst du eine stille Hochzeit.', 'Ja, Hochzeit ansagen'],
        armut: ['Trumpfabgabe machen?', 'Bist du sicher? Du gibst alle deine Trümpfe ab (aufgefüllt auf drei Karten). Nimmt keiner an, wird neu gegeben.', 'Ja, Trumpfabgabe'],
      }[pendingSolo] || [`${label} spielen?`, 'Bist du sicher? Ein angesagtes Solo kann nicht zurückgenommen werden.', `Ja, ${label} spielen`];
      return `<div class="panel confirm"><h2>${esc(txt[0])}</h2>
        <p class="muted">${esc(txt[1])}</p>
        <div class="btnrow"><button class="btn primary" data-decl="${pendingSolo}" data-sure="1">${esc(txt[2])}</button><button class="btn" data-act="cancelsolo">Abbrechen</button></div></div>`;
    }
    if (g.turn === m) {
      const o = g.declOptions;
      const nT = E.countTrumps(g.hands[m]);
      const b = (k, cls = '') => `<button class="btn ${cls}" data-decl="${k}">${E.DECL_LABEL[k]}</button>`;
      return `<div class="panel"><h2>Gesund oder Vorbehalt?</h2>
        <p class="muted">Du hast ${nT} Trümpfe${o.includes('hochzeit') ? ' und beide Kreuz-Damen. Sagst du gesund, spielst du eine stille Hochzeit' : ''}.</p>
        <div class="btnrow">${b('gesund', 'primary')}${o.includes('hochzeit') ? b('hochzeit') : ''}${o.includes('armut') ? b('armut') : ''}${o.includes('schmeissen') ? b('schmeissen', 'warn') : ''}</div>
        <div class="btnrow"><span class="muted">Solo:</span>${b('solo_trumpf')}${b('solo_damen')}${b('solo_buben')}${b('solo_koenige')}</div>
        <p class="muted">Mit „Sortieren“ unter dem Tisch kannst du deine Karten vorab nach einem Solo ordnen. Das sagt noch nichts an.</p>
        <div class="btnrow">${status}</div></div>`;
    }
    const why = m >= 0 ? E.schmeissReason(g.hands[m]) : null;
    const throwBtn = why ? `<div class="btnrow"><button class="btn warn" data-decl="schmeissen">Schmeißen</button><span class="muted">Möglich, weil ${esc(why)}.</span></div>` : '';
    return `<div class="panel"><h2>Vorbehalte</h2><p class="muted">${esc(seatName(g.turn))} ist dran.</p>${throwBtn}<div class="btnrow">${status}</div></div>`;
  }

  function armutHTML(g) {
    const m = mySeat();
    const poor = seatName(g.armut.poor);
    if (g.phase === 'armut_give') {
      if (g.turn === m) return `<div class="panel"><h2>Trumpfabgabe</h2><p class="muted">Wähle drei Karten. Alle deine Trümpfe müssen dabei sein.</p><div class="btnrow"><button class="btn primary" data-act="armutGive"${selected.length !== 3 ? ' disabled' : ''}>${selected.length}/3 Karten abgeben</button></div></div>`;
      return `<div class="panel"><h2>Trumpfabgabe</h2><p class="muted">${esc(poor)} sucht drei Karten zum Abgeben aus.</p></div>`;
    }
    if (g.phase === 'armut_answer') {
      const n = g.armut.trumps;
      if (g.turn === m) return `<div class="panel"><h2>${esc(poor)} schiebt dir drei Karten zu</h2><p class="muted">Darunter ${n} ${n === 1 ? 'Trumpf' : 'Trümpfe'}. Nimmst du an, spielst du mit ${esc(poor)} als Re und gibst drei Karten zurück.</p><div class="btnrow"><button class="btn primary" data-armut="1">Annehmen</button><button class="btn" data-armut="0">Ablehnen</button></div></div>`;
      return `<div class="panel"><h2>Trumpfabgabe</h2><p class="muted">${esc(poor)} gibt drei Karten ab (${n} Trumpf). ${esc(seatName(g.turn))} entscheidet.</p></div>`;
    }
    if (g.turn === m) return `<div class="panel"><h2>Drei Karten zurückgeben</h2><p class="muted">Du hast die Karten von ${esc(poor)} auf der Hand. Wähle drei beliebige Karten zum Zurückgeben.</p><div class="btnrow"><button class="btn primary" data-act="armutReturn"${selected.length !== 3 ? ' disabled' : ''}>${selected.length}/3 Karten zurückgeben</button></div></div>`;
    return `<div class="panel"><h2>Trumpfabgabe</h2><p class="muted">${esc(seatName(g.turn))} gibt drei Karten zurück.</p></div>`;
  }

  function resultHTML(g) {
    const r = g.result;
    if (!r || !Array.isArray(r.payers)) {
      // Spiel wurde noch mit einer älteren Version der App abgerechnet
      const pts = (r && r.points) || [0, 0, 0, 0];
      return `<div class="panel"><div class="result-head"><h2>Spiel beendet</h2><span class="muted">${esc((r && r.label) || '')}</span></div>
        <p class="muted">Dieses Spiel wurde noch nach der alten Zählung abgerechnet. Ab dem nächsten Spiel gilt die neue Zählung.</p>
        <div class="scores">${[0, 1, 2, 3].map((s) => `<div><span>${esc(seatName(s))}</span><b>${pts[s] || '–'}</b></div>`).join('')}</div>
        <div class="btnrow"><button class="btn primary" data-act="next"${readOnly ? ' disabled' : ''}>Nächstes Spiel</button></div></div>`;
    }
    const reNames = g.re.map(seatName).join(' & ');
    const coNames = [0, 1, 2, 3].filter((s) => !g.re.includes(s)).map(seatName).join(' & ');
    const head = r.winner === 're' ? 'Re gewinnt' : r.winner === 'contra' ? 'Kontra gewinnt' : 'Keiner gewinnt';
    const lines = r.lines.map((l) => `<li><span>${esc(l.text)}</span><span class="p">${l.party === 're' ? 'Re' : 'Kontra'} ${l.pts}</span></li>`).join('') || '<li><span>Keine Punkte</span><span class="p">0</span></li>';
    const sumRe = r.lines.filter((l) => l.party === 're').reduce((a, l) => a + l.pts, 0);
    const sumCo = r.lines.filter((l) => l.party === 'contra').reduce((a, l) => a + l.pts, 0);
    const fac = [];
    if (r.annMult > 1) fac.push(`× ${r.annMult} (${r.annMult === 4 ? 'Re und Kontra' : r.ann.re ? 'Re' : 'Kontra'} angesagt)`);
    if (r.m > 1) fac.push(`× ${r.m} (Bock)`);
    const payerNames = r.payers.map(seatName).join(' & ');
    const saldo = `${r.S}${r.lines.some((l) => l.extra) ? ` (${r.winner === 're' ? 'Re' : 'Kontra'} ${r.winner === 're' ? sumRe : sumCo} − ${r.winner === 're' ? 'Kontra' : 'Re'} ${r.winner === 're' ? sumCo : sumRe})` : ''}`;
    let calc;
    if (!r.winner) calc = 'Keine Partei hat ihr Ziel erreicht: <strong>Nullspiel</strong>, keine Punkte.';
    else if (r.nullspiel) calc = `Die Verlierer haben mindestens so viele Sonderpunkte wie die Gewinner Punkte (${saldo}): <strong>Nullspiel</strong>, keine Punkte.`;
    else if (r.soloLost) calc = `Saldo ${saldo} ${fac.join(' ')} = ${r.value}, verlorenes Solo dreifach: <strong>${3 * r.value} Punkte</strong> für ${esc(payerNames)} (${E.euro(3 * r.value)})`;
    else calc = `Saldo ${saldo} ${fac.join(' ')} = <strong>${r.value} Punkte</strong> für ${r.payers.length > 1 ? 'jeden Verlierer' : 'den Verlierer'} (${esc(payerNames)}, je ${E.euro(r.value)})`;
    const scores = [0, 1, 2, 3].map((s) => `<div><span>${esc(seatName(s))}</span><b>${r.points[s] ? r.points[s] : '–'}</b></div>`).join('');
    return `<div class="panel">
      <div class="result-head"><h2>${head}</h2><span class="muted">${esc(r.label)}${r.m > 1 ? ` · Bock ×${r.m}` : ''}</span></div>
      <p><strong>Re</strong> (${esc(reNames)}): ${r.eyes.re} Augen · <strong>Kontra</strong> (${esc(coNames)}): ${r.eyes.contra} Augen</p>
      <ul class="lines">${lines}</ul>
      <p>${calc}</p>
      ${r.bockEvents && r.bockEvents.length ? `<p class="bockmsg">Bock! ${esc(r.bockEvents.join(', '))}: ${r.bockAdded} Bockspiele dazu, jetzt ${state.bockLeft} offen.</p>` : ''}
      <div class="scores">${scores}</div>
      <div class="btnrow"><button class="btn primary" data-act="next"${readOnly ? ' disabled' : ''}>Nächstes Spiel</button></div>
    </div>`;
  }

  function meBar(g) {
    const m = mySeat();
    if (m < 0) return `<div class="mebar"><span class="hint">Du schaust zu.${online && !readOnly && state.seats.some((s) => !s) ? ' Setz dich auf einen freien Platz.' : ''}</span></div>`;
    const turn = g && g.phase !== 'done' && g.turn === m;
    let hint = '';
    if (!g) hint = state.phase === 'ended' ? 'Partie beendet.' : 'Warte auf den Spielbeginn.';
    else if (g.phase === 'play') {
      if (turn) {
        const legal = E.legalCards(g.hands[m], g.current, E.kindOf(g.type));
        hint = '<strong>Du bist dran.</strong>' + (legal.length < g.hands[m].length ? ' Du musst bedienen.' : '');
      } else hint = `${esc(seatName(g.turn))} ist dran.`;
    } else if (g.phase === 'done') hint = 'Spiel beendet.';
    else hint = turn ? '<strong>Du bist dran.</strong>' : `${esc(seatName(g.turn))} ist dran.`;
    const party = g ? g.known[m] : null;
    const opts = g ? g.annOptions : [];
    const ann = opts.map((L) => `<button class="annbtn ${party}" data-ann="${L}">${E.ANN_LABEL[party][L]}</button>`).join('');
    const pchip = party ? `<span class="chip ${party}">${party === 're' ? 'Re' : 'Kontra'}</span>` : '';
    const mine = g ? annChips(g, m) + pflichtChip(m) : '';
    const geber = markers(g, m).join(' ');
    const sorter = g && g.phase === 'vorbehalt' && g.hands[m].length
      ? `<span class="sortbar" role="group" aria-label="Karten vorsortieren">Sortieren: ${SORTS.map(([k, l]) => `<button data-sort="${k}" aria-pressed="${sortKind() === k}">${l}</button>`).join('')}</span>` : '';
    const myStat = g && (g.phase === 'play' || g.phase === 'done') ? `<span class="seat-meta">${statHTML(m)}</span>` : '';
    return `<div class="mebar${turn ? ' turn' : ''}${annClass(g, m)}"><span class="seat-name">${esc(seatName(m))} <button class="mini" data-act="editname" aria-label="Namen ändern" title="Namen ändern">✎</button> ${geber} ${pchip} ${mine}</span>${myStat}<span class="hint">${hint}</span>${sorter}${ann ? `<span class="annrow" aria-label="Ansagen">${ann}</span>` : ''}</div>`;
  }

  // Vorsortieren: nur die Ansicht, keine Ansage
  const SORTS = [['normal', 'Normal / Trumpfsolo'], ['damen', 'Damensolo'], ['buben', 'Bubensolo'], ['koenige', 'Königssolo']];
  let sortPref = { game: null, kind: 'normal' };
  const dealSig = () => (state && state.game ? state.game.dealId : null);
  const sortKind = () => (sortPref.game && sortPref.game === dealSig() ? sortPref.kind : 'normal');
  function handHTML(g) {
    const m = mySeat();
    if (!g || m < 0 || !g.hands[m].length) return '';
    const kind = g.phase === 'vorbehalt' ? sortKind() : E.kindOf(g.type || 'normal');
    const hand = E.sortHand(g.hands[m], kind);
    const selecting = (g.phase === 'armut_give' || g.phase === 'armut_return') && g.turn === m;
    const playing = g.phase === 'play' && g.turn === m;
    const legal = playing ? E.legalCards(g.hands[m], g.current, kind) : [];
    return `<div class="hand" role="group" aria-label="Deine Karten">${hand.map((c) => {
      const trump = E.isTrump(c, kind);
      if (selecting) return cardHTML(c, { button: true, trump, cls: 'playable' + (selected.includes(c) ? ' sel' : ''), pressed: selected.includes(c) });
      if (playing) { const ok = legal.includes(c); return cardHTML(c, { button: true, trump, cls: ok ? 'playable' : 'dim', disabled: !ok }); }
      return cardHTML(c, { button: true, trump, disabled: true });
    }).join('')}</div>`;
  }

  function renderFelt() {
    const felt = $('felt');
    if (needPassword) {
      felt.innerHTML = `<div class="mid"><form class="panel" id="pwform"><h2>Tisch „${esc(TABLE)}“</h2>
        <p class="muted">${esc(pwError || 'Dieser Tisch braucht ein Passwort.')}</p>
        <label class="nick" for="pw">Passwort <input id="pw" type="password" autocomplete="current-password" required></label>
        <div class="btnrow"><button class="btn primary" type="submit">Hinsetzen</button></div></form></div>`;
      $('pwform').addEventListener('submit', (ev) => {
        ev.preventDefault();
        store.set('doko-pw:' + TABLE, $('pw').value);
        needPassword = false; render();
        if (ws && ws.readyState === 1) hello(); else connect();
      });
      return;
    }
    if (!state) { felt.innerHTML = '<div class="mid"><div class="panel"><h2>Verbinde mit dem Tisch …</h2><p class="muted">Einen Moment. Falls das länger dauert, prüfe deine Internetverbindung.</p></div></div>'; return; }
    const g = state.game;
    let mid;
    if (state.phase === 'ended') mid = endHTML();
    else if (state.phase === 'lobby' || !g) mid = lobbyHTML();
    else if (g.phase === 'vorbehalt') mid = vorbehaltHTML(g);
    else if (g.phase.startsWith('armut')) mid = armutHTML(g);
    else if (g.phase === 'done' && Date.now() >= trickClearAt) mid = resultHTML(g);
    else if (g.phase === 'done') mid = trickHTML(g); // 10. Stich bleibt noch liegen
    else mid = trickHTML(g);
    const others = [1, 2, 3].map((p) => { const s = (base() + p) % 4; return seatTag(s, p); }).join('');
    const nickEl = $('nick'); const keepNick = nickEl ? nickEl.value : null;
    felt.innerHTML = `${bannerHTML(g)}${others}<div class="mid">${mid}</div>${meBar(g)}${handHTML(g)}`;
    if (keepNick !== null && $('nick')) $('nick').value = keepNick;
  }

  function renderSide() {
    if (sideHold && Date.now() < trickClearAt) {
      // während der 10. Stich liegt: Seitenleiste noch ohne Ergebnis
      const real = state; state = sideHold;
      try { renderSideNow(); } finally { state = real; }
      return;
    }
    renderSideNow();
  }
  function renderSideNow() {
    const side = $('side');
    if (!state) { side.innerHTML = ''; return; }
    const g = state.game;
    const m = mySeat();
    const names = [0, 1, 2, 3].map(seatName);
    let info = '';
    if (g) {
      const reA = g.ann.re ? E.ANN_LABEL.re[g.ann.re] + (g.ann.re > 1 ? ' (Re)' : '') : '–';
      const coA = g.ann.contra ? E.ANN_LABEL.contra[g.ann.contra] + (g.ann.contra > 1 ? ' (Kontra)' : '') : '–';
      const bl = state.bockLeft || 0;
      const bockNow = g.bock ? `ja, alles ×2 · noch ${bl} Bockspiel${bl === 1 ? '' : 'e'} inkl. diesem` : (bl ? `nein · ${bl} Bockspiele stehen an` : 'nein');
      const upcoming = 0;
      info = `<dl class="kv"><dt>Spiel</dt><dd>${g.no}</dd><dt>Geber</dt><dd>${esc(seatName(g.dealer))}</dd><dt>Spielart</dt><dd>${esc(publicType(g, m))}</dd>
        <dt>Re-Seite</dt><dd>${esc(reA)}</dd><dt>Kontra-Seite</dt><dd>${esc(coA)}</dd><dt>Bock</dt><dd>${bockNow}${upcoming ? ` · noch ${upcoming} Bockspiel${upcoming === 1 ? '' : 'e'} danach` : ''}</dd>
        ${state.pflichtSoli ? `<dt>Pflichtsoli</dt><dd>${state.pflichtSoli} pro Spieler · ${[0, 1, 2, 3].map((i) => `${esc(seatName(i))} ${Math.min(state.soloCounts[i], state.pflichtSoli)}`).join(', ')}</dd>` : ''}</dl>`;
    } else {
      const pending = state.bockLeft || 0;
      info = `<p class="notice">Noch kein Spiel gestartet.${pending ? ` ${pending} Bockspiele stehen an.` : ''}</p>`;
    }
    const run = [0, 0, 0, 0];
    const rows = state.games.map((x) => {
      x.points.forEach((p, i) => (run[i] += p));
      return `<tr class="${x.bock ? 'bock' : ''}${x.pflicht ? ' pflichtrow' : ''}"><td class="kind">${x.pflicht ? '' : x.no + ' '}${esc(x.label)}</td>${run.map((v, i) => `<td>${v}<span class="d">${x.points[i] ? '+' + x.points[i] : '·'}</span></td>`).join('')}</tr>`;
    }).join('');
    const zettel = state.games.length
      ? `<table><thead><tr><th>Spiel</th>${names.map((n) => `<th title="${esc(n)}">${esc(n)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody>
         <tfoot><tr><td class="kind">Zu zahlen</td>${run.map((v) => `<td class="eur">${E.euro(v)}</td>`).join('')}</tr></tfoot></table>`
      : '<div class="empty">Hier stehen nach jedem Spiel die Punkte der Verlierer, wie auf dem Doko-Block. Jeder Punkt kostet 5 Cent.</div>';
    // Verlauf nur für das aktuelle bzw. letzte Spiel: ab dem Eintrag „Spiel N: … gibt.“
    let from = -1;
    for (let i = state.log.length - 1; i >= 0; i--) if (/^Spiel \d+: .+ gibt\.$/.test(state.log[i])) { from = i; break; }
    if (from > 0 && /schmeißt/.test(state.log[from - 1])) from -= 1; // Schmeißen davor mit anzeigen
    const logLines = from >= 0 ? state.log.slice(from) : state.log.slice(-8);
    const logItems = logLines.slice().reverse().map((l) => `<li>${esc(l)}</li>`).join('');
    const logTitle = g ? `Verlauf <small>Spiel ${g.no}</small>` : 'Verlauf';
    const running = g && g.phase !== 'done';
    let reset = '';
    if (state.phase === 'game') {
      reset = confirmReset
        ? `<span class="notice">Partie beenden?${state.pflichtSoli ? ` Fehlende Pflichtsoli werden mit je ${E.RULES.pflichtPenalty} Punkten eingetragen.` : ''}</span><button class="sidebtn danger" data-act="endpartie">Ja, Partie beenden</button><button class="sidebtn" data-act="noreset">Abbrechen</button>`
        : `<button class="sidebtn" data-act="askreset"${readOnly || running ? ' disabled' : ''}>Partie beenden</button>${running ? '<span class="notice">geht nach dem laufenden Spiel</span>' : ''}`;
    } else if (state.phase === 'ended') reset = `<button class="sidebtn" data-act="reset"${readOnly ? ' disabled' : ''}>Neue Partie starten</button>`;
    const n2 = $('nick2'); const keep2 = n2 ? { v: n2.value, f: document.activeElement === n2 } : null;
    side.innerHTML = `
      <div class="box"><h3>Dieses Spiel</h3>${info}
        <div class="btnrow">${m >= 0 && state.phase === 'game' ? `<button class="sidebtn" data-leave="${m}">Platz an Bot abgeben</button>` : ''}</div></div>
      <div class="box"><h3>Spielzettel <small>${state.games.length ? state.games.length + (state.games.length === 1 ? ' Spiel' : ' Spiele') + ' · Verliererpunkte' : ''}</small></h3><div class="zettel" id="zettel">${zettel}</div>${state.games.length ? '<div class="btnrow"><button class="sidebtn" data-act="pdf">Spielzettel als PDF</button></div>' : ''}</div>
      <div class="box"><h3>${logTitle}</h3><ul class="log">${logItems || '<li>Noch nichts passiert.</li>'}</ul></div>
      <div class="box"><details class="rules"><summary>Hausregeln in dieser App</summary><ul>
        <li>40 Karten ohne Neunen, 10 pro Spieler. Trumpf: Herz 10, Damen, Buben, Karo Ass, 10, König. Bei zwei gleichen Karten sticht die erste.</li>
        <li>Soli: Trumpfsolo (Karo-Solo), Damensolo, Bubensolo, Königssolo. Ein Solo hat Vorrang vor Hochzeit und Trumpfabgabe, und es spielt wie immer der Spieler links vom Geber aus.</li>
        <li>Vorsortieren: Während der Vorbehaltsabfrage kannst du deine Karten nach Normalspiel oder einem Solo sortieren lassen. Das ist keine Ansage, das Spiel sagst du danach wie gewohnt an.</li>
        <li>Schmeißen: Ist dein höchster Trumpf kleiner als der Karo-Bube (oder hast du gar keinen Trumpf) oder hast du mindestens 5 Könige, kannst du während der Vorbehaltsabfrage jederzeit schmeißen. Derselbe Geber gibt neu, das Spiel zählt nicht.</li>
        <li>Hochzeit: Der erste fremde Fehlstich (Fehlfarbe ausgespielt, ein anderer gewinnt) in den ersten drei Stichen macht dessen Gewinner zum Partner. Trumpfstiche zählen nicht. Klappt das nicht, spielt die Hochzeit ein Solo.</li>
        <li>Stille Hochzeit: Beide Kreuz-Damen und „gesund“ gesagt. Wird wie ein Solo abgerechnet.</li>
        <li>Trumpfabgabe: Bei höchstens 3 Trümpfen gibst du alle Trümpfe (auf 3 Karten aufgefüllt) ab. Wer annimmt, gibt 3 Karten zurück und spielt mit dir Re. Nimmt keiner, wird neu gegeben.</li>
        <li>Ansagen: Re/Kontra bis zur 2. eigenen Karte (Erwiderung eine Karte länger), keine 90 bis zur 3., keine 60 bis zur 4., keine 30 bis zur 5., schwarz bis zur 6. Bei der Hochzeit beginnen die Fristen direkt nach dem Klärungsstich neu.</li>
        <li>Zählung: Punkte bekommen immer die Verlierer, jeder Punkt kostet 5 Cent.</li>
        <li>Normalspiel: Gewonnen 1, gegen die Alten 1, keine 90/60/30/schwarz je 1, jede erfüllte Absage („keine 90 angesagt“ usw.) 1, Trumpfabgabe gewonnen oder verloren 1 (Hochzeit gibt keinen Extrapunkt). Re angesagt verdoppelt die Summe, Kontra angesagt verdoppelt sie, beides vervierfacht.</li>
        <li>Sonderpunkte (nur ohne Solo, je 1 für die Partei): Doppelkopf (Stich mit mindestens 40 Augen), Herz-Stich durchgegangen, Karlchen gewinnt den letzten Stich, Karlchen gefangen, Fuchs gefangen, Fuchs gewinnt den letzten Stich, beide Kreuz-Damen in einem Stich (für Kontra). Sonderpunkte der Verlierer werden abgezogen. Haben die Verlierer mindestens so viele Sonderpunkte wie die Gewinner Punkte, ist es ein Nullspiel.</li>
        <li>Solo (auch stille Hochzeit und Hochzeit ohne Partner): gewonnen 8, jede weitere Zeile 4 (keine 90, keine 90 angesagt, keine 60 …). Verliert der Solist, kommt „gegen die Alten“ mit 4 dazu und alles zählt dreifach. Kontra angesagt verdoppelt, Re und Kontra vervierfacht, Re allein ändert nichts. Solo, Hochzeit und Trumpfabgabe müssen bestätigt werden.</li>
        <li>Pflichtsoli: Vor jeder Partie wird festgelegt, wie viele Soli jeder spielen muss (Damen-, Buben-, Königs-, Trumpfsolo, stille Hochzeit, Hochzeit ohne Partner). Beim Beenden der Partie gibt es für jedes fehlende Solo 100 Punkte.</li>
        <li>Bockrunde: entsteht automatisch. Jedes Nullspiel und jeder durchgegangene Herz-Stich (nicht im angesagten Solo, wohl aber bei stiller Hochzeit und Hochzeit ohne Partner) bringt 4 Bockspiele dazu. Ein Bockspiel verdoppelt alle Punkte. Ein Solo in der Bockrunde zählt doppelt, verbraucht aber kein Bockspiel.</li>
      </ul></details></div>
      <div class="box"><h3>Tisch</h3>
        <form class="btnrow" id="nameform"><label class="namelabel" for="nick2">Dein Name</label><input id="nick2" class="nameinput" maxlength="20" autocomplete="nickname" placeholder="Name eintragen" value="${esc(m >= 0 ? seatName(m) : nick())}"><button class="sidebtn" type="submit">${m >= 0 ? 'Name ändern' : 'Merken'}</button></form>
        <div class="btnrow">${reset}</div>
        ${online ? `<div class="btnrow"><button class="sidebtn" data-act="copylink">Tisch-Link kopieren</button></div><p class="notice" id="linktext">${esc(location.origin + location.pathname + (TABLE === 'stammtisch' ? '' : '?tisch=' + TABLE))}</p>` : ''}
        <p class="notice">${online ? 'Der Spielstand liegt auf dem Server. Jeder bekommt nur seine eigenen Karten zu sehen.' : 'Übungsmodus: Die Partie läuft nur in diesem Fenster.'}</p></div>`;
    if (keep2 && keep2.f) { const e = $('nick2'); e.value = keep2.v; e.focus(); } // nur beim Tippen den Entwurf behalten
    const z = $('zettel'); if (z) z.scrollTop = z.scrollHeight;
  }

  function renderMode() {
    const el = $('mode');
    if (conn === 'local') el.innerHTML = '<span class="dot"></span> Übungsmodus gegen Bots';
    else if (conn === 'online') el.innerHTML = `<span class="dot on"></span> verbunden · Tisch „${esc(TABLE)}“`;
    else el.innerHTML = '<span class="dot wait"></span> verbinde …';
  }

  function showError(where, e) {
    console.error(where, e);
    const msg = `<div class="mid"><div class="panel"><h2>Anzeige fehlgeschlagen</h2>
      <p class="muted">Beim Darstellen ${where === 'felt' ? 'des Tisches' : 'der Seitenleiste'} ist ein Fehler aufgetreten. Lade die Seite neu. Hilft das nicht, schick diese Meldung an den Gastgeber:</p>
      <p class="muted"><code>${esc(String(e && e.message || e))}</code></p>
      <div class="btnrow"><button class="btn primary" type="button" onclick="location.reload()">Seite neu laden</button></div></div></div>`;
    if (where === 'felt') $('felt').innerHTML = msg;
  }
  function render() {
    try { renderFelt(); } catch (e) { showError('felt', e); }
    try { renderSide(); } catch (e) { showError('side', e); }
  }

  // ---------- Spielzettel als PDF ----------
  function loadJsPdf() {
    if (window.jspdf) return Promise.resolve(window.jspdf);
    return new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = './vendor/jspdf.umd.min.js?v=1';
      sc.onload = () => (window.jspdf ? resolve(window.jspdf) : reject(new Error('jsPDF fehlt')));
      sc.onerror = () => reject(new Error('jsPDF konnte nicht geladen werden'));
      document.head.appendChild(sc);
    });
  }
  async function downloadPdf() {
    if (!state || !state.games.length) { toast('Noch keine Spiele auf dem Zettel.'); return; }
    let jsPDF;
    try { ({ jsPDF } = await loadJsPdf()); } catch (e) { toast('Das PDF-Modul ließ sich nicht laden. Bitte Seite neu laden.'); return; }
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const names = [0, 1, 2, 3].map(seatName);
    const now = new Date();
    const stamp = now.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const L = 14, R = 196, W = R - L;
    const col = { nr: L, spiel: L + 9, bock: L + 62, p0: L + 76 };
    const pw = (R - col.p0) / 4;
    const px = (i) => col.p0 + pw * (i + 1) - 2; // rechtsbündig
    const ink = [35, 58, 99], grey = [110, 120, 115], green = [21, 68, 52];
    let y = 18;
    const header = () => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...green);
      doc.text('Doko-Stammtisch – Spielzettel', L, y); y += 7;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...grey);
      doc.text(`Tisch „${TABLE}“ · Stand ${stamp} · Punkte bekommen die Verlierer · 1 Punkt = ${E.RULES.centPerPoint} Cent`, L, y); y += 8;
      doc.setFillColor(...green); doc.rect(L, y - 5, W, 8, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(255, 255, 255);
      doc.text('Nr', col.nr + 1, y); doc.text('Spiel', col.spiel, y); doc.text('Bock', col.bock, y);
      names.forEach((n, i) => doc.text(doc.splitTextToSize(n, pw - 3)[0], px(i), y, { align: 'right' }));
      y += 7;
    };
    header();
    const run = [0, 0, 0, 0];
    state.games.forEach((x, k) => {
      if (y > 272) { doc.addPage(); y = 18; header(); }
      x.points.forEach((p, i) => (run[i] += p));
      if (k % 2 === 0) { doc.setFillColor(242, 246, 243); doc.rect(L, y - 4.6, W, 7, 'F'); }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(40, 40, 40);
      doc.text(String(x.no), col.nr + 1, y);
      doc.text(doc.splitTextToSize(x.label || '', col.bock - col.spiel - 2)[0], col.spiel, y);
      if (x.bock) { doc.setTextColor(192, 57, 43); doc.text('×2', col.bock, y); }
      x.points.forEach((p, i) => {
        doc.setFont('helvetica', 'bold'); doc.setTextColor(...ink);
        doc.text(String(run[i]), px(i) - 9, y, { align: 'right' });
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...grey); doc.setFontSize(8);
        doc.text(p ? `+${p}` : '·', px(i), y, { align: 'right' });
        doc.setFontSize(9.5);
      });
      y += 7;
    });
    if (y > 262) { doc.addPage(); y = 18; header(); }
    doc.setDrawColor(...green); doc.setLineWidth(0.6); doc.line(L, y - 3, R, y - 3); y += 3;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...green);
    doc.text('Summe Punkte', col.spiel, y);
    run.forEach((v, i) => doc.text(String(v), px(i), y, { align: 'right' })); y += 7;
    doc.text('Zu zahlen', col.spiel, y);
    run.forEach((v, i) => doc.text(E.euro(v).replace(/ /g, ' '), px(i), y, { align: 'right' })); y += 10;
    const total = run.reduce((a, b) => a + b, 0);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...grey);
    doc.text(`${state.games.length} ${state.games.length === 1 ? "Spiel" : "Spiele"} · zusammen ${total} Punkte = ${E.euro(total).replace(/ /g, ' ')}`, L, y);
    const file = `Spielzettel-${TABLE}-${now.toISOString().slice(0, 10)}.pdf`;
    doc.save(file);
    toast('PDF wird heruntergeladen.');
  }

  // ---------- Eingaben ----------
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b || b.disabled) return;
    const d = b.dataset;
    const g = state && state.game;
    const m = mySeat();
    if (d.sit !== undefined) { const n = nick(); if (!n) return askName(); saveNick(n); return act({ t: 'sit', seat: +d.sit, name: n }); }
    if (d.takeover !== undefined) { const n = nick(); if (!n) return askName(); saveNick(n); return act({ t: 'takeover', seat: +d.takeover, name: n }); }
    if (d.leave !== undefined) return act({ t: 'leave', seat: +d.leave });
    if (d.kick !== undefined) return act({ t: 'kick', seat: +d.kick });
    if (d.pflicht !== undefined) return act({ t: 'pflicht', n: +d.pflicht });
    if (d.sort) { sortPref = { game: dealSig(), kind: d.sort }; return renderFelt(); }
    // Solo, Hochzeit und Trumpfabgabe erst nach Rückfrage ansagen
    if (d.decl && (d.decl.startsWith('solo_') || d.decl === 'hochzeit' || d.decl === 'armut') && !d.sure) { pendingSolo = d.decl; return renderFelt(); }
    if (d.decl) { pendingSolo = null; return act({ t: 'decl', choice: d.decl }); }
    if (d.armut !== undefined) return act({ t: 'armutAnswer', accept: d.armut === '1' });
    if (d.ann) return act({ t: 'announce', level: +d.ann });
    if (d.card && g) {
      if ((g.phase === 'armut_give' || g.phase === 'armut_return') && g.turn === m) {
        const i = selected.indexOf(d.card);
        if (i >= 0) selected.splice(i, 1); else if (selected.length < 3) selected.push(d.card); else toast('Es sind schon drei Karten ausgewählt.');
        return render();
      }
      if (g.phase === 'play' && g.turn === m) return act({ t: 'play', card: d.card });
      return;
    }
    switch (d.act) {
      case 'fillBots': return act({ t: 'fillBots' });
      case 'start': return act({ t: 'start' });
      case 'next': return act({ t: 'next' });
      case 'armutGive': return act({ t: 'armutGive', cards: selected.slice() });
      case 'armutReturn': return act({ t: 'armutReturn', cards: selected.slice() });
      case 'cancelsolo': pendingSolo = null; return renderFelt();
      case 'lasttrick': showLast = !showLast; return renderFelt();
      case 'pdf': return downloadPdf();
      case 'editname': { const e = $('nick2'); if (e) { e.focus(); e.select(); e.scrollIntoView({ block: 'center', behavior: 'smooth' }); } return; }
      case 'askreset': confirmReset = true; return renderSide();
      case 'noreset': confirmReset = false; return renderSide();
      case 'reset': confirmReset = false; return act({ t: 'reset', keepSeats: true });
      case 'endpartie': confirmReset = false; return act({ t: 'endPartie' });
      case 'copylink': {
        const text = $('linktext') ? $('linktext').textContent : location.href;
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Link kopiert. Schick ihn deinen Mitspielern.'), () => toast('Kopieren ging nicht. Markiere den Link unter dem Knopf.'));
        else toast('Markiere den Link unter dem Knopf und kopiere ihn.');
        return;
      }
    }
  });
  document.addEventListener('submit', (ev) => {
    if (ev.target.id !== 'nameform') return;
    ev.preventDefault();
    const n = $('nick2').value.trim().slice(0, 20);
    if (!n) return askName();
    saveNick(n);
    const l = $('nick'); if (l) l.value = n;
    if (mySeat() >= 0) { if (act({ t: 'rename', name: n })) toast(`Du heißt jetzt ${n}.`); }
    else toast('Name gemerkt. Setz dich jetzt auf einen freien Platz.');
    $('nick2').blur();
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id !== 'nick') return;
    const n = ev.target.value.trim(); if (!n) return;
    saveNick(n);
    const m = mySeat(); if (m >= 0) act({ t: 'rename', name: n });
  });

  // ---------- Start ----------
  function startLocal() {
    let s = E.newTable();
    s = E.dispatch(s, me.id, { t: 'sit', seat: 0, name: nick() || 'Du' }).state;
    s = E.dispatch(s, me.id, { t: 'fillBots' }).state;
    s = E.dispatch(s, me.id, { t: 'pflicht', n: 0 }).state;
    s = E.dispatch(s, me.id, { t: 'start' }).state;
    full = s; state = E.viewFor(full, me.id);
    renderMode(); onState();
  }

  render();
  renderMode();
  if (online) connect(); else startLocal();
