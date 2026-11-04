import E from './engine.js';
import { CARD_DEFS, CARD_BODY } from './cards.js';

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
  let confirmReset = false;

  function nick() {
    const el = $('nick'); if (el && el.value.trim()) return el.value.trim();
    return store.get('doko-nick') || 'Gast';
  }
  function saveNick(v) { store.set('doko-nick', v); }

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.tm); toast.tm = setTimeout(() => (t.hidden = true), 3200);
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
    const fx = {
      card() { const t = ctx.currentTime; burst(t, { f: 2200, q: 0.7, dur: 0.07, gain: 0.55 }); burst(t + 0.01, { type: 'lowpass', f: 500, dur: 0.06, gain: 0.5 }); tone(t + 0.008, { f: 140, f2: 60, dur: 0.07, gain: 0.25 }); },
      collect() { const t = ctx.currentTime; burst(t, { f: 700, f2: 3200, q: 0.9, dur: 0.28, gain: 0.32, attack: 0.06 }); burst(t + 0.2, { type: 'lowpass', f: 600, dur: 0.06, gain: 0.35 }); },
      shuffle() {
        let t = ctx.currentTime + 0.05;
        for (let r = 0; r < 2; r++) {
          // Riffeln: viele kurze Klicks, erst langsam, dann schneller
          const n = 34;
          for (let i = 0; i < n; i++) { const step = 0.034 - 0.018 * (i / n); burst(t, { type: 'highpass', f: 2600 + Math.random() * 1500, q: 0.6, dur: 0.018, gain: 0.25 + Math.random() * 0.2 }); t += step * (0.8 + Math.random() * 0.4); }
          // Zusammenschieben
          burst(t + 0.04, { f: 1200, f2: 3000, q: 0.7, dur: 0.22, gain: 0.3, attack: 0.03 });
          burst(t + 0.27, { type: 'lowpass', f: 450, dur: 0.07, gain: 0.45 });
          t += 0.55;
        }
      },
      knock() { const t = ctx.currentTime; for (const d of [0, 0.15]) { tone(t + d, { f: 110, f2: 55, dur: 0.12, gain: 0.5 }); burst(t + d, { type: 'lowpass', f: 900, dur: 0.05, gain: 0.5 }); } },
      turn() { const t = ctx.currentTime; tone(t, { f: 988, dur: 0.18, gain: 0.07 }); tone(t + 0.09, { f: 1319, dur: 0.22, gain: 0.05 }); },
      end() { const t = ctx.currentTime; [523, 659, 784].forEach((f, i) => tone(t + i * 0.11, { f, dur: 0.5, gain: 0.08, type: 'triangle' })); },
    };
    function play(name) { if (ready() && fx[name]) try { fx[name](); } catch (e) {} }
    function setOn(v) { on = v; try { localStorage.setItem('doko-sound', v ? 'on' : 'off'); } catch (e) {} if (v) ensure(); }
    // Browser spielen Ton erst nach einer Interaktion: beim ersten Klick freischalten
    ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (on) ensure(); }, { capture: true }));
    return { play, setOn, isOn: () => on };
  })();

  function renderSoundBtn() {
    const b = $('soundbtn'); if (!b) return;
    const on = Sound.isOn();
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>${on ? '<path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>' : '<path d="M17 9l5 6M22 9l-5 6"/>'}</svg>Ton ${on ? 'an' : 'aus'}`;
  }
  $('soundbtn').addEventListener('click', () => { Sound.setOn(!Sound.isOn()); renderSoundBtn(); if (Sound.isOn()) setTimeout(() => Sound.play('card'), 30); });
  renderSoundBtn();

  let prevSnap = null;
  function soundsFor(st) {
    const g = st && st.game;
    const snap = g ? { deal: g.dealId, cur: g.current.length, tricks: g.tricks.length, ann: g.ann.hist.length, phase: g.phase, turn: g.turn } : null;
    const p = prevSnap; prevSnap = snap;
    if (!p || !snap) return;
    const m = mySeat();
    if (snap.deal !== p.deal) { Sound.play('shuffle'); return; }
    if (snap.tricks > p.tricks) { Sound.play('card'); setTimeout(() => Sound.play('collect'), 650); }
    else if (snap.cur > p.cur) Sound.play('card');
    if (snap.ann > p.ann) setTimeout(() => Sound.play('knock'), 60);
    if (snap.phase === 'done' && p.phase !== 'done') setTimeout(() => Sound.play('end'), 900);
    else if (m >= 0 && snap.turn === m && (snap.turn !== p.turn || snap.phase !== p.phase) && snap.phase !== 'done' && !state.seats[m].bot) setTimeout(() => Sound.play('turn'), snap.tricks > p.tricks ? 900 : 250);
  }

  function onState() {
    soundsFor(state);
    const g = state && state.game;
    const k = g ? `${g.no}-${g.phase}-${g.turn}` : 'none';
    if (k !== selKey) { selected = []; selKey = k; }
    render();
    scheduleBots();
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
    if (g.stille && (viewer === g.soloist || g.phase === 'done')) return 'Stille Hochzeit';
    return 'Normalspiel';
  }

  function annText(g, seat) {
    return g.ann.hist.filter((a) => a.seat === seat).map((a) => E.ANN_LABEL[a.party][a.level]);
  }

  // Augen und Punkte eines Spielers, als Hover-/Tipp-Info
  function statHTML(s) {
    const g = state.game;
    if (!g) return '';
    const won = g.tricks.map((t, i) => ({ i: i + 1, p: t.points, w: t.winner })).filter((t) => t.w === s);
    const eyes = won.reduce((a, t) => a + t.p, 0);
    const total = E.totals(state)[s];
    const fmt = (v) => (v > 0 ? '+' + v : String(v));
    const list = won.length ? `<span class="tricks">${won.map((t) => `<span>Stich ${t.i}: ${t.p}</span>`).join('')}</span>` : '<span>Noch kein Stich.</span>';
    return `<span class="stat" tabindex="0" aria-label="${esc(seatName(s))}: ${eyes} Augen in ${won.length} Stichen, Spielstand ${fmt(total)}"><b>${eyes}</b> Augen · ${won.length} ${won.length === 1 ? 'Stich' : 'Stiche'}`
      + `<span class="tip" role="tooltip"><strong>${esc(seatName(s))}</strong>`
      + `<span class="row"><span>Augen in diesem Spiel</span><span>${eyes}</span></span>`
      + `<span class="row"><span>Stiche</span><span>${won.length}</span></span>${list}`
      + `<span class="row"><span>Spielstand (${state.games.length} ${state.games.length === 1 ? 'Spiel' : 'Spiele'})</span><span>${fmt(total)}</span></span></span></span>`;
  }

  function seatTag(s, pos) {
    const st = state.seats[s];
    const g = state.game;
    const turn = g && g.phase !== 'done' && g.turn === s;
    const party = g ? g.known[s] : null;
    const chips = [];
    if (g && g.dealer === s) chips.push('<span class="chip geber">Geber</span>');
    if (st && st.bot) chips.push('<span class="chip bot">Bot</span>');
    if (online && st && !st.bot && !st.online) chips.push('<span class="chip off">offline</span>');
    const meta = [];
    if (g) {
      meta.push(`<span class="backs"><i></i>${g.hands[s].length}</span>`);
      if (g.phase === 'vorbehalt' && g.decl[s]) meta.push(`<span class="chip">${g.decl[s] === 'gesund' ? 'gesund' : 'Vorbehalt'}</span>`);
      if (party) meta.push(`<span class="chip ${party}">${party === 're' ? 'Re' : 'Kontra'}</span>`);
      for (const t of annText(g, s)) meta.push(`<span class="chip ann">${esc(t)}</span>`);
      if (g.phase === 'play' || g.phase === 'done') meta.push(statHTML(s));
    }
    let take = '';
    if (st && st.bot && mySeat() < 0 && !readOnly) take = `<button class="mini" data-takeover="${s}">Platz übernehmen</button>`;
    else if (online && st && !st.bot && !st.online && mySeat() >= 0 && g && g.phase !== 'done') take = `<button class="mini" data-kick="${s}">Durch Bot ersetzen</button>`;
    return `<div class="seat pos-${pos}${turn ? ' turn' : ''}"><div class="seat-name">${esc(st ? st.name : 'frei')} ${chips.join('')}</div><div class="seat-meta">${meta.join('')}</div>${take}</div>`;
  }

  function trickHTML(g) {
    let cards = g.current, caption = '', winner = null;
    if (!cards.length && g.tricks.length) {
      const t = g.tricks[g.tricks.length - 1];
      cards = t.cards; winner = t.winner;
      caption = `Stich ${g.tricks.length} an ${esc(seatName(t.winner))} · ${t.points} Augen`;
    } else if (!cards.length) {
      caption = g.turn === mySeat() ? 'Du spielst aus.' : `${esc(seatName(g.turn))} spielt aus.`;
    }
    const kind = E.kindOf(g.type);
    const slots = cards.map((p) => `<div class="slot p${posOf(p.seat)}${p.seat === winner ? ' win' : ''}">${cardHTML(p.card, { trump: E.isTrump(p.card, kind) })}</div>`).join('');
    return `<div class="trick" aria-live="polite">${slots}<div class="trick-caption">${caption}</div></div>`;
  }

  function lobbyHTML() {
    const m = mySeat();
    const boxes = state.seats.map((s, i) => {
      if (s) {
        const mine = i === m;
        return `<div class="seatbox taken"><span>${esc(s.name)}${s.bot ? ' <span class="chip bot">Bot</span>' : ''}${online && !s.bot && !s.online ? ' <span class="chip off">offline</span>' : ''}${mine ? ' (du)' : ''}</span>${mine || s.bot ? `<button class="mini" data-leave="${i}">${mine ? 'Aufstehen' : 'Entfernen'}</button>` : ''}</div>`;
      }
      return `<div class="seatbox"><span>Platz ${i + 1} frei</span>${m < 0 && !readOnly ? `<button class="btn primary" data-sit="${i}">Hinsetzen</button>` : ''}</div>`;
    }).join('');
    const full = state.seats.every((s) => s);
    return `<div class="panel">
      <h2>Wer spielt mit?</h2>
      <p class="muted">${online ? 'Schick deinen Freunden den Link zu dieser Seite. Wer sie öffnet, sitzt am selben Tisch. Freie Plätze kannst du mit Bots auffüllen.' : 'Übungsmodus: Du spielst allein gegen drei Bots, nur in diesem Fenster.'}</p>
      <label class="nick">Dein Name <input id="nick" maxlength="20" value="${esc(nick())}"></label>
      <div class="seatlist">${boxes}</div>
      <div class="btnrow">
        <button class="btn" data-act="fillBots"${full || readOnly ? ' disabled' : ''}>Freie Plätze mit Bots füllen</button>
        <button class="btn primary" data-act="start"${!full || readOnly ? ' disabled' : ''}>Spiel starten</button>
        ${online ? '<a class="btn" href="?ueben=1" target="_blank" rel="noopener">Allein gegen Bots üben</a>' : ''}
      </div>
    </div>`;
  }

  function vorbehaltHTML(g) {
    const m = mySeat();
    const order = [1, 2, 3, 4].map((i) => (g.dealer + i) % 4);
    const status = order.map((s) => `<span class="chip">${esc(seatName(s))}: ${g.decl[s] ? (g.decl[s] === 'gesund' ? 'gesund' : 'Vorbehalt') : s === g.turn ? 'überlegt …' : '–'}</span>`).join(' ');
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
    const reNames = g.re.map(seatName).join(' & ');
    const coNames = [0, 1, 2, 3].filter((s) => !g.re.includes(s)).map(seatName).join(' & ');
    const head = r.winner === 're' ? 'Re gewinnt' : r.winner === 'contra' ? 'Kontra gewinnt' : 'Keiner gewinnt';
    const lines = r.lines.map((l) => `<li><span>${esc(l.text)}${l.extra ? '' : ''}</span><span class="p">${l.party === 're' ? 'Re' : 'Kontra'} +${l.pts}</span></li>`).join('') || '<li><span>Keine Punkte</span><span class="p">0</span></li>';
    const scores = [0, 1, 2, 3].map((s) => `<div><span>${esc(seatName(s))}</span><b>${r.points[s] > 0 ? '+' : ''}${r.points[s]}</b></div>`).join('');
    return `<div class="panel">
      <div class="result-head"><h2>${head}</h2><span class="muted">${esc(r.label)}${r.m > 1 ? ` · Bock ×${r.m}` : ''}${r.solo ? ' · Solo zählt dreifach' : ''}</span></div>
      <p><strong>Re</strong> (${esc(reNames)}): ${r.eyes.re} Augen · <strong>Kontra</strong> (${esc(coNames)}): ${r.eyes.contra} Augen</p>
      <ul class="lines">${lines}</ul>
      <p class="muted">Spielwert ${Math.abs(r.S)}${r.m > 1 ? ` × ${r.m}` : ''}</p>
      <div class="scores">${scores}</div>
      <div class="btnrow"><button class="btn primary" data-act="next"${readOnly ? ' disabled' : ''}>Nächstes Spiel</button><button class="btn" data-act="bock"${readOnly ? ' disabled' : ''}>Bockrunde ansagen</button></div>
    </div>`;
  }

  function meBar(g) {
    const m = mySeat();
    if (m < 0) return `<div class="mebar"><span class="hint">Du schaust zu.${online && !readOnly && state.seats.some((s) => !s) ? ' Setz dich auf einen freien Platz.' : ''}</span></div>`;
    const turn = g && g.phase !== 'done' && g.turn === m;
    let hint = '';
    if (!g) hint = 'Warte auf den Spielbeginn.';
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
    const mine = g ? annText(g, m).map((t) => `<span class="chip ann">${esc(t)}</span>`).join('') : '';
    const geber = g && g.dealer === m ? '<span class="chip geber">Geber</span>' : '';
    const sorter = g && g.phase === 'vorbehalt' && g.hands[m].length
      ? `<span class="sortbar" role="group" aria-label="Karten vorsortieren">Sortieren: ${SORTS.map(([k, l]) => `<button data-sort="${k}" aria-pressed="${sortKind() === k}">${l}</button>`).join('')}</span>` : '';
    const myStat = g && (g.phase === 'play' || g.phase === 'done') ? `<span class="seat-meta">${statHTML(m)}</span>` : '';
    return `<div class="mebar${turn ? ' turn' : ''}"><span class="seat-name">${esc(seatName(m))} ${geber} ${pchip} ${mine}</span>${myStat}<span class="hint">${hint}</span>${sorter}${ann ? `<span class="annrow" aria-label="Ansagen">${ann}</span>` : ''}</div>`;
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
    if (state.phase === 'lobby' || !g) mid = lobbyHTML();
    else if (g.phase === 'vorbehalt') mid = vorbehaltHTML(g);
    else if (g.phase.startsWith('armut')) mid = armutHTML(g);
    else if (g.phase === 'done') mid = resultHTML(g);
    else mid = trickHTML(g);
    const others = [1, 2, 3].map((p) => { const s = (base() + p) % 4; return seatTag(s, p); }).join('');
    const nickEl = $('nick'); const keepNick = nickEl ? nickEl.value : null;
    felt.innerHTML = `${others}<div class="mid">${mid}</div>${meBar(g)}${handHTML(g)}`;
    if (keepNick !== null && $('nick')) $('nick').value = keepNick;
  }

  function renderSide() {
    const side = $('side');
    if (!state) { side.innerHTML = ''; return; }
    const g = state.game;
    const m = mySeat();
    const names = [0, 1, 2, 3].map(seatName);
    let info = '';
    if (g) {
      const reA = g.ann.re ? E.ANN_LABEL.re[g.ann.re] + (g.ann.re > 1 ? ' (Re)' : '') : '–';
      const coA = g.ann.contra ? E.ANN_LABEL.contra[g.ann.contra] + (g.ann.contra > 1 ? ' (Kontra)' : '') : '–';
      const bockNow = g.bock ? `×${Math.pow(2, g.bock)}` : 'nein';
      const upcoming = state.bock.slice(1).filter((x) => x > 0).length;
      info = `<dl class="kv"><dt>Spiel</dt><dd>${g.no}</dd><dt>Geber</dt><dd>${esc(seatName(g.dealer))}</dd><dt>Spielart</dt><dd>${esc(publicType(g, m))}</dd>
        <dt>Re-Seite</dt><dd>${esc(reA)}</dd><dt>Kontra-Seite</dt><dd>${esc(coA)}</dd><dt>Bock</dt><dd>${bockNow}${upcoming ? ` · noch ${upcoming} Bockspiel${upcoming === 1 ? '' : 'e'} danach` : ''}</dd></dl>`;
    } else {
      const pending = state.bock.filter((x) => x > 0).length;
      info = `<p class="notice">Noch kein Spiel gestartet.${pending ? ` ${pending} Bockspiele stehen an.` : ''}</p>`;
    }
    const run = [0, 0, 0, 0];
    const rows = state.games.map((x) => {
      x.points.forEach((p, i) => (run[i] += p));
      return `<tr class="${x.bock ? 'bock' : ''}"><td class="kind">${x.no} ${esc(x.label)}</td>${run.map((v, i) => `<td>${v}<span class="d">${x.points[i] > 0 ? '+' : ''}${x.points[i]}</span></td>`).join('')}</tr>`;
    }).join('');
    const zettel = state.games.length
      ? `<table><thead><tr><th>Spiel</th>${names.map((n) => `<th title="${esc(n)}">${esc(n)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">Hier stehen nach jedem Spiel die Punkte, wie auf dem Doko-Block.</div>';
    const logItems = state.log.slice(-8).reverse().map((l) => `<li>${esc(l)}</li>`).join('');
    const reset = confirmReset
      ? `<span class="notice">Punkte und Spielstand löschen?</span><button class="sidebtn danger" data-act="reset">Ja, neue Partie</button><button class="sidebtn" data-act="noreset">Abbrechen</button>`
      : `<button class="sidebtn" data-act="askreset"${readOnly ? ' disabled' : ''}>Neue Partie</button>`;
    side.innerHTML = `
      <div class="box"><h3>Dieses Spiel</h3>${info}
        <div class="btnrow"><button class="sidebtn" data-act="bock"${readOnly || !state.seats.some((s) => s) ? ' disabled' : ''}>Bockrunde ansagen</button>${m >= 0 && state.phase === 'game' ? `<button class="sidebtn" data-leave="${m}">Platz an Bot abgeben</button>` : ''}</div></div>
      <div class="box"><h3>Spielzettel <small>${state.games.length ? state.games.length + (state.games.length === 1 ? ' Spiel' : ' Spiele') : ''}</small></h3><div class="zettel" id="zettel">${zettel}</div></div>
      <div class="box"><h3>Verlauf</h3><ul class="log">${logItems || '<li>Noch nichts passiert.</li>'}</ul></div>
      <div class="box"><details class="rules"><summary>Hausregeln in dieser App</summary><ul>
        <li>40 Karten ohne Neunen, 10 pro Spieler. Trumpf: Herz 10, Damen, Buben, Karo Ass, 10, König. Bei zwei gleichen Karten sticht die erste.</li>
        <li>Soli: Trumpfsolo (Karo-Solo), Damensolo, Bubensolo, Königssolo. Ein Solo hat Vorrang vor Hochzeit und Trumpfabgabe, zählt dreifach, und es spielt wie immer der Spieler links vom Geber aus.</li>
        <li>Vorsortieren: Während der Vorbehaltsabfrage kannst du deine Karten nach Normalspiel oder einem Solo sortieren lassen. Das ist keine Ansage, das Spiel sagst du danach wie gewohnt an.</li>
        <li>Schmeißen: Ist dein höchster Trumpf der Karo-Bube (oder hast du gar keinen höheren) oder hast du mindestens 5 Könige, kannst du während der Vorbehaltsabfrage jederzeit schmeißen. Derselbe Geber gibt neu, das Spiel zählt nicht.</li>
        <li>Hochzeit: Der erste fremde Fehlstich (Fehlfarbe ausgespielt, ein anderer gewinnt) in den ersten drei Stichen macht dessen Gewinner zum Partner. Trumpfstiche zählen nicht. Klappt das nicht, spielt die Hochzeit ein Solo.</li>
        <li>Stille Hochzeit: Beide Kreuz-Damen und „gesund“ gesagt. Wird wie ein Solo abgerechnet.</li>
        <li>Trumpfabgabe: Bei höchstens 3 Trümpfen gibst du alle Trümpfe (auf 3 Karten aufgefüllt) ab. Wer annimmt, gibt 3 Karten zurück und spielt mit dir Re. Nimmt keiner, wird neu gegeben.</li>
        <li>Ansagen: Re/Kontra bis zur 2. eigenen Karte (Erwiderung eine Karte länger), keine 90 bis zur 3., keine 60 bis zur 4., keine 30 bis zur 5., schwarz bis zur 6. Bei der Hochzeit beginnen die Fristen direkt nach dem Klärungsstich neu.</li>
        <li>Sonderpunkte (nur ohne Solo): Volle (Stich mit mindestens 40 Augen), Herz durchgegangen (alle vier bedienen Herz), Karlchen macht den letzten Stich, Karlchen im letzten Stich gefangen, Fuchs (Karo-Ass) macht den letzten Stich. Fallen beide Kreuz-Damen in denselben Stich, bekommt Kontra einen Punkt.</li>
        <li>Abrechnung: Gewonnen 1, gegen die Alten 1, unter 90/60/30/schwarz je 1, Re und Kontra je 2, jede Absage 1. Erreicht keine Partei ihr Ziel, zählen nur die Sonderpunkte.</li>
        <li>Bockrunde: Die nächsten 4 Spiele zählen doppelt, mehrere Bockrunden stapeln sich. Vor der ersten Karte angesagt, zählt schon das laufende Spiel.</li>
      </ul></details></div>
      <div class="box"><h3>Tisch</h3><div class="btnrow">${reset}</div>
        ${online ? `<div class="btnrow"><button class="sidebtn" data-act="copylink">Tisch-Link kopieren</button></div><p class="notice" id="linktext">${esc(location.origin + location.pathname + (TABLE === 'stammtisch' ? '' : '?tisch=' + TABLE))}</p>` : ''}
        <p class="notice">${online ? 'Der Spielstand liegt auf dem Server. Jeder bekommt nur seine eigenen Karten zu sehen.' : 'Übungsmodus: Die Partie läuft nur in diesem Fenster.'}</p></div>`;
    const z = $('zettel'); if (z) z.scrollTop = z.scrollHeight;
  }

  function renderMode() {
    const el = $('mode');
    if (conn === 'local') el.innerHTML = '<span class="dot"></span> Übungsmodus gegen Bots';
    else if (conn === 'online') el.innerHTML = `<span class="dot on"></span> verbunden · Tisch „${esc(TABLE)}“`;
    else el.innerHTML = '<span class="dot wait"></span> verbinde …';
  }

  function render() { renderFelt(); renderSide(); }

  // ---------- Eingaben ----------
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b || b.disabled) return;
    const d = b.dataset;
    const g = state && state.game;
    const m = mySeat();
    if (d.sit !== undefined) { const n = nick(); saveNick(n); return act({ t: 'sit', seat: +d.sit, name: n }); }
    if (d.takeover !== undefined) { const n = nick(); saveNick(n); return act({ t: 'takeover', seat: +d.takeover, name: n }); }
    if (d.leave !== undefined) return act({ t: 'leave', seat: +d.leave });
    if (d.kick !== undefined) return act({ t: 'kick', seat: +d.kick });
    if (d.sort) { sortPref = { game: dealSig(), kind: d.sort }; return renderFelt(); }
    if (d.decl) return act({ t: 'decl', choice: d.decl });
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
      case 'bock': return act({ t: 'bock' });
      case 'armutGive': return act({ t: 'armutGive', cards: selected.slice() });
      case 'armutReturn': return act({ t: 'armutReturn', cards: selected.slice() });
      case 'askreset': confirmReset = true; return renderSide();
      case 'noreset': confirmReset = false; return renderSide();
      case 'reset': confirmReset = false; return act({ t: 'reset', keepSeats: true });
      case 'copylink': {
        const text = $('linktext') ? $('linktext').textContent : location.href;
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Link kopiert. Schick ihn deinen Mitspielern.'), () => toast('Kopieren ging nicht. Markiere den Link unter dem Knopf.'));
        else toast('Markiere den Link unter dem Knopf und kopiere ihn.');
        return;
      }
    }
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
    s = E.dispatch(s, me.id, { t: 'sit', seat: 0, name: nick() === 'Gast' ? 'Du' : nick() }).state;
    s = E.dispatch(s, me.id, { t: 'fillBots' }).state;
    s = E.dispatch(s, me.id, { t: 'start' }).state;
    full = s; state = E.viewFor(full, me.id);
    renderMode(); onState();
  }

  render();
  renderMode();
  if (online) connect(); else startLocal();
