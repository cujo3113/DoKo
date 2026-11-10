/* Doppelkopf-Regel-Engine – läuft im Browser und auf dem Server (ES-Modul). (ohne Neunen, 10 Karten pro Spieler)
 * Reine Funktionen: apply(state, seat, action) -> {state} | {error}
 * Karten: Farbe C/S/H/D (Kreuz, Pik, Herz, Karo) + Wert A/T/K/Q/J (Ass, 10, König, Dame, Bube) + Kopie 0/1
 */
const DokoEngine = (() => {
  const RULES = {
    fuchs: true,             // Fuchs gefangen gibt einen Sonderpunkt
    centPerPoint: 5,         // Jeder Punkt kostet die Verlierer 5 Cent
    bots: { solo: true, announce: true, think: true, rollouts: 260, soloRate: 0.85, soloSims: 80, stille: true }, // Bot-Verhalten
    hochzeitTricks: 3,       // Klärungsstiche bei der Hochzeit
    armutMaxTrumps: 3,       // Trumpfabgabe bei höchstens so vielen Trümpfen
    bockGames: 4,            // Länge einer Bockrunde
  };

  const SUITS = ['C', 'S', 'H', 'D'];
  const RANKS = ['A', 'T', 'K', 'Q', 'J'];
  const POINTS = { A: 11, T: 10, K: 4, Q: 3, J: 2 };
  const SUIT_NAME = { C: 'Kreuz', S: 'Pik', H: 'Herz', D: 'Karo' };
  const RANK_NAME = { A: 'Ass', T: '10', K: 'König', Q: 'Dame', J: 'Bube' };
  const RANK_SHORT = { A: 'A', T: '10', K: 'K', Q: 'D', J: 'B' };
  const SUIT_SYM = { C: '♣', S: '♠', H: '♥', D: '♦' };

  const TRUMPS = {
    normal: ['HT', 'CQ', 'SQ', 'HQ', 'DQ', 'CJ', 'SJ', 'HJ', 'DJ', 'DA', 'DT', 'DK'],
    damen: ['CQ', 'SQ', 'HQ', 'DQ'],
    buben: ['CJ', 'SJ', 'HJ', 'DJ'],
    koenige: ['CK', 'SK', 'HK', 'DK'],
  };
  const FEHL = {
    normal: ['A', 'T', 'K'],
    damen: ['A', 'T', 'K', 'J'],
    buben: ['A', 'T', 'K', 'Q'],
    koenige: ['A', 'T', 'Q', 'J'],
  };

  const TYPE_LABEL = {
    normal: 'Normalspiel', hochzeit: 'Hochzeit', armut: 'Trumpfabgabe',
    solo_trumpf: 'Trumpfsolo', solo_damen: 'Damensolo', solo_buben: 'Bubensolo', solo_koenige: 'Königssolo',
  };
  const DECL_LABEL = {
    gesund: 'Gesund', hochzeit: 'Hochzeit', armut: 'Trumpfabgabe', schmeissen: 'Schmeißen',
    solo_trumpf: 'Trumpfsolo', solo_damen: 'Damensolo', solo_buben: 'Bubensolo', solo_koenige: 'Königssolo',
  };
  const SOLOS = ['solo_trumpf', 'solo_damen', 'solo_buben', 'solo_koenige'];
  const ANN_LABEL = { re: ['', 'Re', 'keine 90', 'keine 60', 'keine 30', 'schwarz'],
                      contra: ['', 'Kontra', 'keine 90', 'keine 60', 'keine 30', 'schwarz'] };
  // Ansage erlaubt, solange man noch mindestens so viele Karten auf der Hand hat
  const ANN_MIN_CARDS = [99, 9, 8, 7, 6, 5];

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const key = (c) => c.slice(0, 2);
  const suitOf = (c) => c[0];
  const rankOf = (c) => c[1];
  const pts = (c) => POINTS[rankOf(c)];
  const cardName = (c) => `${SUIT_NAME[suitOf(c)]} ${RANK_NAME[rankOf(c)]}`;

  function kindOf(type) {
    if (type === 'solo_damen') return 'damen';
    if (type === 'solo_buben') return 'buben';
    if (type === 'solo_koenige') return 'koenige';
    return 'normal';
  }
  const isSoloType = (t) => !!t && t.startsWith('solo_');

  function isTrump(c, kind) { return TRUMPS[kind].includes(key(c)); }
  // "Farbe" für Bedienpflicht: 'T' für Trumpf, sonst Fehlfarbe
  function followSuit(c, kind) { return isTrump(c, kind) ? 'T' : suitOf(c); }

  // Stärke einer Karte im Stich (höher = besser); -1 = kann den Stich nicht gewinnen
  function power(c, ledSuit, kind) {
    const t = TRUMPS[kind].indexOf(key(c));
    if (t >= 0) return 1000 - t;
    if (suitOf(c) !== ledSuit) return -1;
    return 100 - FEHL[kind].indexOf(rankOf(c));
  }

  function trickWinnerIdx(cards, kind) {
    const led = followSuit(cards[0].card, kind);
    let best = 0, bestP = power(cards[0].card, led, kind);
    for (let i = 1; i < cards.length; i++) {
      const p = power(cards[i].card, led, kind);
      if (p > bestP) { best = i; bestP = p; } // gleiche Karten: die erste gewinnt
    }
    return best;
  }

  function legalCards(hand, current, kind) {
    if (!current.length) return hand.slice();
    const led = followSuit(current[0].card, kind);
    const same = hand.filter((c) => followSuit(c, kind) === led);
    return same.length ? same : hand.slice();
  }

  function sortHand(hand, kind) {
    const order = (c) => {
      const t = TRUMPS[kind].indexOf(key(c));
      if (t >= 0) return t;
      return 100 + SUITS.indexOf(suitOf(c)) * 10 + FEHL[kind].indexOf(rankOf(c));
    };
    return hand.slice().sort((a, b) => order(a) - order(b));
  }

  function newDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) for (const k of [0, 1]) d.push(s + r + k);
    return d;
  }
  function shuffle(a, rnd = Math.random) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  function newTable() {
    return { v: 1, seats: [null, null, null, null], dealer: 3, bock: [], bockLeft: 0, games: [], game: null, phase: 'lobby', log: [], rev: 0 };
  }

  function seatName(state, s) { return state.seats[s] ? state.seats[s].name : `Platz ${s + 1}`; }
  function log(state, text) { state.log.push(text); if (state.log.length > 40) state.log.splice(0, state.log.length - 40); }

  function deal(state, presetHands) {
    const deck = shuffle(newDeck());
    const hands = presetHands ? clone(presetHands) : [0, 1, 2, 3].map((i) => deck.slice(i * 10, i * 10 + 10));
    const d = state.dealer;
    state.phase = 'game';
    state.game = {
      no: state.games.length + 1, dealId: Math.random().toString(36).slice(2, 10), dealer: d, hands, initial: clone(hands),
      phase: 'vorbehalt', turn: (d + 1) % 4, decl: [null, null, null, null],
      type: null, stille: false, soloist: null, re: [],
      tricks: [], current: [], ann: { re: 0, contra: 0, hist: [] },
      armut: null, hz: null, bock: state.bockLeft > 0 ? 1 : 0, result: null,
    };
    log(state, `Spiel ${state.game.no}: ${seatName(state, d)} gibt.`);
  }

  const order4 = (start) => [0, 1, 2, 3].map((i) => (start + i) % 4);

  function countTrumps(hand, kind = 'normal') { return hand.filter((c) => isTrump(c, kind)).length; }
  function countCQ(hand) { return hand.filter((c) => key(c) === 'CQ').length; }

  // Schmeißen: höchster Trumpf ist der Karo-Bube (oder schwächer) oder mindestens 5 Könige
  function schmeissReason(h) {
    const top = Math.min(...h.map((c) => TRUMPS.normal.indexOf(key(c))).filter((i) => i >= 0), 99);
    if (top > TRUMPS.normal.indexOf('DJ')) return top === 99 ? 'kein Trumpf' : 'höchster Trumpf ist kleiner als der Karo-Bube';
    const kings = h.filter((c) => rankOf(c) === 'K').length;
    if (kings >= 5) return `${kings} Könige`;
    return null;
  }

  function declOptions(game, seat) {
    const h = game.hands[seat];
    const o = ['gesund'];
    if (countCQ(h) === 2) o.push('hochzeit');
    if (countTrumps(h) <= RULES.armutMaxTrumps) o.push('armut');
    o.push(...SOLOS);
    if (schmeissReason(h)) o.push('schmeissen');
    return o;
  }

  function startPlay(state) {
    const g = state.game;
    g.phase = 'play';
    g.turn = (g.dealer + 1) % 4; // auch beim Solo: normale Reihenfolge
  }

  function resolveVorbehalt(state) {
    const g = state.game;
    const ord = order4((g.dealer + 1) % 4);
    const solo = ord.find((s) => isSoloType(g.decl[s]));
    const hz = ord.find((s) => g.decl[s] === 'hochzeit');
    const ar = ord.find((s) => g.decl[s] === 'armut');
    if (solo !== undefined) {
      g.type = g.decl[solo]; g.soloist = solo; g.re = [solo];
      log(state, `${seatName(state, solo)} spielt ${TYPE_LABEL[g.type]}.`);
      startPlay(state);
    } else if (hz !== undefined) {
      g.type = 'hochzeit'; g.re = [hz];
      g.hz = { bride: hz, partner: null, clar: 0, done: false, alone: false };
      log(state, `${seatName(state, hz)} hat eine Hochzeit. Der erste fremde Fehlstich entscheidet.`);
      startPlay(state);
    } else if (ar !== undefined) {
      g.type = 'armut'; g.phase = 'armut_give'; g.turn = ar;
      g.armut = { poor: ar, cards: null, declined: [], taker: null, returnedTrumps: null };
      log(state, `${seatName(state, ar)} macht eine Trumpfabgabe.`);
    } else {
      g.type = 'normal';
      g.re = [0, 1, 2, 3].filter((s) => countCQ(g.hands[s]) > 0);
      if (g.re.length === 1) { g.stille = true; g.soloist = g.re[0]; }
      startPlay(state);
    }
  }

  function partyOf(g, seat) {
    if (!g || !g.type || g.phase === 'vorbehalt' || g.phase.startsWith('armut')) return null;
    if (g.type === 'hochzeit' && !g.hz.done && seat !== g.hz.bride) return null;
    return g.re.includes(seat) ? 're' : 'contra';
  }

  // Was weiß `viewer` über die Partei von `target`? ('re' | 'contra' | null)
  function knownParty(g, viewer, target) {
    if (!g || !g.type || g.phase === 'vorbehalt' || g.phase.startsWith('armut')) return null;
    const truth = g.re.includes(target) ? 're' : 'contra';
    if (g.phase === 'done') return truth;
    if (isSoloType(g.type) || g.type === 'armut') return truth;
    if (g.type === 'hochzeit') return g.hz.done || target === g.hz.bride ? truth : null;
    // Normalspiel (inkl. stiller Hochzeit)
    if (viewer === target) return truth;
    const revealed = new Set();
    for (const t of g.tricks.concat([{ cards: g.current }])) for (const p of t.cards) if (key(p.card) === 'CQ') revealed.add(p.seat);
    const annBy = {};
    for (const a of g.ann.hist) annBy[a.seat] = a.party;
    if (annBy[target]) return annBy[target];
    if (revealed.has(target)) return 're';
    const knownRe = new Set(revealed);
    for (const s in annBy) if (annBy[s] === 're') knownRe.add(+s);
    if (viewer !== null && viewer !== undefined && g.re.includes(viewer)) knownRe.add(viewer);
    if (knownRe.size >= 2 && !knownRe.has(target)) return 'contra';
    return null;
  }

  function annThreshold(g, party, level) {
    let t = ANN_MIN_CARDS[level];
    if (g.type === 'hochzeit') t -= g.hz.clar;
    const other = party === 're' ? 'contra' : 're';
    if (level === 1 && g.ann[other] >= 1) t -= 1; // Erwiderung: eine Karte länger
    return t;
  }

  function announceOptions(g, seat) {
    if (!g || g.phase !== 'play') return [];
    if (g.type === 'hochzeit' && !g.hz.done) return [];
    const party = partyOf(g, seat);
    if (!party) return [];
    const n = g.hands[seat].length;
    const out = [];
    for (let L = g.ann[party] + 1; L <= 5; L++) if (n >= annThreshold(g, party, L)) out.push(L);
    return out;
  }

  function finishTrick(state) {
    const g = state.game;
    const kind = kindOf(g.type);
    const wi = trickWinnerIdx(g.current, kind);
    const winner = g.current[wi].seat;
    const points = g.current.reduce((s, p) => s + pts(p.card), 0);
    g.tricks.push({ cards: g.current, winner, points });
    g.current = [];
    g.turn = winner;
    if (g.type === 'hochzeit' && !g.hz.done) {
      const fehlStich = followSuit(g.tricks[g.tricks.length - 1].cards[0].card, 'normal') !== 'T';
      if (fehlStich && winner !== g.hz.bride) {
        g.hz.partner = winner; g.hz.done = true; g.hz.clar = g.tricks.length; g.re = [g.hz.bride, winner];
        log(state, `Hochzeit: ${seatName(state, winner)} spielt mit ${seatName(state, g.hz.bride)}.`);
      } else if (g.tricks.length >= RULES.hochzeitTricks) {
        g.hz.done = true; g.hz.alone = true; g.hz.clar = g.tricks.length;
        log(state, `Hochzeit: kein fremder Fehlstich in den ersten drei Stichen – ${seatName(state, g.hz.bride)} spielt ein Solo.`);
      }
    }
    if (g.tricks.length === 10) finishGame(state);
  }

  function scoreGame(g) {
    const solo = isSoloType(g.type) || g.stille || (g.type === 'hochzeit' && g.hz.alone);
    const kind = kindOf(g.type);
    const partyOfSeat = (s) => (g.re.includes(s) ? 're' : 'contra');
    const eyes = { re: 0, contra: 0 }, tricks = { re: 0, contra: 0 };
    for (const t of g.tricks) { const p = partyOfSeat(t.winner); eyes[p] += t.points; tricks[p]++; }
    const L = { re: g.ann.re, contra: g.ann.contra };

    const met = (me) => {
      const op = me === 're' ? 'contra' : 're';
      if (L[me] >= 5) return tricks[op] === 0;
      if (L[me] === 4) return eyes[op] < 30;
      if (L[me] === 3) return eyes[op] < 60;
      if (L[me] === 2) return eyes[op] < 90;
      if (L[op] >= 5) return tricks[me] > 0;
      if (L[op] === 4) return eyes[me] >= 30;
      if (L[op] === 3) return eyes[me] >= 60;
      if (L[op] === 2) return eyes[me] >= 90;
      if (me === 're') return eyes.re >= ((L.contra >= 1 && L.re === 0) ? 120 : 121);
      return eyes.contra >= ((L.re >= 1 && L.contra === 0) ? 121 : 120);
    };
    const reMet = met('re'), coMet = met('contra');
    const winner = reMet && !coMet ? 're' : coMet && !reMet ? 'contra' : null;

    // ---- Zählung nach Hausregel-Tabelle: Punkte bekommen immer die Verlierer ----
    const loser = winner === 're' ? 'contra' : winner === 'contra' ? 're' : null;
    const PL = (p) => (p === 're' ? 'Re' : 'Kontra');
    const levels = loser ? [eyes[loser] < 90, eyes[loser] < 60, eyes[loser] < 30, tricks[loser] === 0].filter(Boolean).length : 0;
    const LV = ['keine 90', 'keine 60', 'keine 30', 'schwarz'];
    const lines = [];
    let V = 0; // Punkte der Gewinnerseite (ohne Sonderpunkte)
    const add = (text, n = 1) => { lines.push({ text, pts: n, party: winner }); V += n; };
    if (winner && solo) {
      // Solo: gewonnen 8, jede weitere Zeile der Tabelle 4. Der Solist ist immer Re (die Alten).
      add(winner === 're' ? 'Solo gewonnen' : 'Solo verloren', 8);
      if (winner === 'contra') add('Gegen die Alten', 4);
      for (let i = 0; i < levels; i++) add(LV[i], 4);
      for (const p of ['re', 'contra']) for (let l = 2; l <= L[p]; l++) add(`${ANN_LABEL[p][l]} angesagt (${PL(p)})`, 4);
    } else if (winner) {
      add('Gewonnen');
      if (winner === 'contra' && g.type !== 'armut') add('Gegen die Alten'); // bei verlorener Trumpfabgabe nicht
      for (let i = 0; i < levels; i++) add(LV[i]);
      for (const p of ['re', 'contra']) for (let l = 2; l <= L[p]; l++) add(`${ANN_LABEL[p][l]} angesagt (${PL(p)})`);
      if (g.type === 'armut') add(winner === 're' ? 'Trumpfabgabe gewonnen' : 'Trumpfabgabe verloren');
    }

    const extras = { re: 0, contra: 0 };
    if (!solo) {
      const ex = (party, text) => { extras[party]++; lines.push({ text, pts: 1, party, extra: true }); };
      g.tricks.forEach((t, i) => {
        const wp = partyOfSeat(t.winner);
        if (t.points >= 40) ex(wp, `Doppelkopf (${t.points} Augen, Stich ${i + 1})`);
        if (kind === 'normal' && t.cards.every((p) => suitOf(p.card) === 'H' && !isTrump(p.card, kind))) ex(wp, `Herz-Stich durchgegangen (Stich ${i + 1})`);
        if (RULES.fuchs) for (const p of t.cards) if (key(p.card) === 'DA' && partyOfSeat(p.seat) !== wp) ex(wp, `Fuchs gefangen (Stich ${i + 1})`);
        if (t.cards.filter((p) => key(p.card) === 'CQ').length === 2) ex('contra', `Beide Kreuz-Damen in einem Stich (Stich ${i + 1})`);
        if (i === 9 && kind === 'normal') {
          const wi = t.cards.findIndex((p) => p.seat === t.winner);
          if (key(t.cards[wi].card) === 'CJ') ex(wp, 'Karlchen gewinnt den letzten Stich');
          if (key(t.cards[wi].card) === 'DA') ex(wp, 'Fuchs gewinnt den letzten Stich');
          t.cards.forEach((p, j) => { if (j !== wi && key(p.card) === 'CJ' && partyOfSeat(p.seat) !== wp) ex(wp, 'Karlchen gefangen'); });
        }
      });
    }

    // Saldo der Gewinner: eigene Punkte + eigene Sonderpunkte − Sonderpunkte der Verlierer.
    // Ist der Saldo 0 oder kleiner (Verlierer haben mehr Sonderpunkte), ist es ein Nullspiel.
    const S = winner ? V + extras[winner] - extras[loser] : 0;
    const nullspiel = !winner || S <= 0;
    // Normalspiel: Re ×2, Kontra ×2, beides ×4. Solo: nur Kontra ×2, Re und Kontra ×4, Re allein ändert nichts.
    const annMult = solo
      ? (L.contra >= 1 ? (L.re >= 1 ? 4 : 2) : 1)
      : (L.re >= 1 ? 2 : 1) * (L.contra >= 1 ? 2 : 1);
    const m = g.bock ? 2 : 1; // Bockspiel verdoppelt alles (Bockrunden verlängern sich, sie stapeln sich nicht)
    const value = nullspiel ? 0 : S * annMult * m; // Punkte je Verlierer
    const soloLost = solo && winner === 'contra' && !nullspiel; // verlorenes Solo zählt dreifach
    const payers = nullspiel ? [] : [0, 1, 2, 3].filter((x) => partyOfSeat(x) === loser);
    const points = [0, 1, 2, 3].map((x) => (payers.includes(x) ? (soloLost ? 3 * value : value) : 0));
    let label = TYPE_LABEL[g.type];
    if (g.stille) label = 'Stille Hochzeit';
    if (g.type === 'hochzeit' && g.hz.alone) label = 'Hochzeit (Solo)';
    // Bock-Ereignisse: Nullspiel; durchgegangener Herz-Stich (nicht im angesagten Solo,
    // wohl aber in stiller Hochzeit und Hochzeit ohne Partner). Jedes Ereignis bringt 4 Bockspiele.
    const bockEvents = [];
    if (nullspiel) bockEvents.push('Nullspiel');
    if (!isSoloType(g.type)) g.tricks.forEach((t, i) => {
      if (t.cards.every((p) => suitOf(p.card) === 'H' && !isTrump(p.card, kind))) bockEvents.push(`Herz-Stich (Stich ${i + 1})`);
    });
    return { solo, eyes, tricks, winner, lines, V, extras, S, nullspiel, soloLost, annMult, m, value, payers, points, label, ann: { ...L }, bockEvents, bockAdded: bockEvents.length * RULES.bockGames };
  }

  function finishGame(state) {
    const g = state.game;
    const r = scoreGame(g);
    g.result = r; g.phase = 'done';
    state.games.push({ no: g.no, label: r.label, re: g.re.slice(), soloist: g.soloist, eyes: r.eyes, winner: r.winner, points: r.points, bock: g.bock ? 1 : 0, nullspiel: r.nullspiel, solo: r.solo });
    // Bockrunde: ein Bockspiel ist verbraucht, außer es war ein Solo (das verlängert die Runde um 1)
    if (g.bock && !r.solo) state.bockLeft = Math.max(0, state.bockLeft - 1);
    if (r.bockAdded) {
      state.bockLeft += r.bockAdded;
      log(state, `Bock! ${r.bockEvents.join(', ')}: ${r.bockAdded} Bockspiele dazu, jetzt ${state.bockLeft} offen.`);
    }
    const who = r.winner === 're' ? 'Re' : r.winner === 'contra' ? 'Kontra' : 'Niemand';
    const names = r.payers.map((s) => seatName(state, s)).join(' & ');
    log(state, `${who} gewinnt mit ${r.winner ? r.eyes[r.winner] : r.eyes.re} Augen. ${r.payers.length ? `${names} ${r.payers.length > 1 ? 'bekommen je' : 'bekommt'} ${r.points[r.payers[0]]} Punkte.` : 'Nullspiel, keine Punkte.'}`);
  }

  function removeCards(hand, cards) {
    for (const c of cards) { const i = hand.indexOf(c); if (i < 0) return false; hand.splice(i, 1); }
    return true;
  }

  // Altstände (Bock als Liste) in den Zähler offener Bockspiele übernehmen
  function normalize(state) {
    if (typeof state.bockLeft !== 'number') {
      state.bockLeft = (state.bock || []).filter((x) => x > 0).length;
      state.bock = [];
    }
    return state;
  }

  function apply(state0, seat, a) {
    const state = normalize(clone(state0));
    const g = state.game;
    const err = (e) => ({ error: e });
    switch (a.t) {
      case 'sit': {
        if (state.seats[a.seat]) return err('Platz ist besetzt.');
        if (state.seats.some((s) => s && !s.bot && s.uid === a.uid)) return err('Du sitzt schon am Tisch.');
        state.seats[a.seat] = { uid: a.uid, name: String(a.name || 'Gast').slice(0, 20), bot: false };
        log(state, `${state.seats[a.seat].name} setzt sich an Platz ${a.seat + 1}.`);
        break;
      }
      case 'rename': {
        const s = state.seats[a.seat]; if (!s || s.bot || s.uid !== a.uid) return err('Nicht dein Platz.');
        s.name = String(a.name || 'Gast').slice(0, 20); break;
      }
      case 'leave': {
        const s = state.seats[a.seat];
        if (!s) return err('Platz ist leer.');
        if (state.phase === 'game' && !s.bot) {
          state.seats[a.seat] = { uid: null, name: `${s.name} (Bot)`, bot: true };
        } else state.seats[a.seat] = null;
        log(state, `${s.name} verlässt den Tisch.`);
        break;
      }
      case 'takeover': {
        const s = state.seats[a.seat];
        if (!s || !s.bot) return err('Nur Bot-Plätze können übernommen werden.');
        if (state.seats.some((x) => x && !x.bot && x.uid === a.uid)) return err('Du sitzt schon am Tisch.');
        state.seats[a.seat] = { uid: a.uid, name: String(a.name || 'Gast').slice(0, 20), bot: false };
        log(state, `${state.seats[a.seat].name} übernimmt Platz ${a.seat + 1}.`);
        break;
      }
      case 'fillBots': {
        let n = 1;
        for (let i = 0; i < 4; i++) if (!state.seats[i]) state.seats[i] = { uid: null, name: `Bot ${n++}`, bot: true };
        break;
      }
      case 'start': {
        if (state.phase !== 'lobby') return err('Das Spiel läuft schon.');
        if (state.seats.some((s) => !s)) return err('Es braucht vier Spieler.');
        deal(state, a.hands);
        break;
      }
      case 'decl': {
        if (!g || g.phase !== 'vorbehalt') return err('Gerade keine Vorbehaltsabfrage.');
        if (a.choice === 'schmeissen') {
          const why = schmeissReason(g.hands[seat]);
          if (!why) return err('Schmeißen geht nur mit Karo-Bube als höchstem Trumpf oder fünf Königen.');
          log(state, `${seatName(state, seat)} schmeißt (${why}). Es wird neu gegeben.`);
          state.game = null; deal(state);
          break;
        }
        if (g.turn !== seat) return err('Du bist nicht dran.');
        if (!declOptions(g, seat).includes(a.choice)) return err('Dieser Vorbehalt ist nicht möglich.');
        g.decl[seat] = a.choice;
        log(state, `${seatName(state, seat)}: ${a.choice === 'gesund' ? 'gesund' : 'Vorbehalt'}`);
        g.turn = (seat + 1) % 4;
        if (g.decl.every((d) => d)) resolveVorbehalt(state);
        break;
      }
      case 'armutGive': {
        if (!g || g.phase !== 'armut_give' || g.turn !== seat) return err('Nicht dran.');
        const h = g.hands[seat];
        const cards = a.cards || [];
        if (cards.length !== 3 || new Set(cards).size !== 3) return err('Wähle genau drei Karten.');
        if (!cards.every((c) => h.includes(c))) return err('Karte nicht auf der Hand.');
        const trumps = h.filter((c) => isTrump(c, 'normal'));
        if (!trumps.every((c) => cards.includes(c))) return err('Alle Trümpfe müssen abgegeben werden.');
        removeCards(h, cards);
        g.armut.cards = cards;
        g.phase = 'armut_answer'; g.turn = (seat + 1) % 4;
        log(state, `${seatName(state, seat)} schiebt drei Karten (${trumps.length} Trumpf).`);
        break;
      }
      case 'armutAnswer': {
        if (!g || g.phase !== 'armut_answer' || g.turn !== seat) return err('Nicht dran.');
        if (a.accept) {
          g.armut.taker = seat; g.hands[seat].push(...g.armut.cards);
          g.phase = 'armut_return';
          log(state, `${seatName(state, seat)} nimmt die Trumpfabgabe an.`);
        } else {
          g.armut.declined.push(seat);
          log(state, `${seatName(state, seat)} lehnt ab.`);
          const next = (seat + 1) % 4;
          if (next === g.armut.poor) {
            log(state, 'Niemand nimmt – es wird neu gegeben.');
            state.game = null; deal(state);
          } else g.turn = next;
        }
        break;
      }
      case 'armutReturn': {
        if (!g || g.phase !== 'armut_return' || g.turn !== seat) return err('Nicht dran.');
        const h = g.hands[seat], cards = a.cards || [];
        if (cards.length !== 3 || new Set(cards).size !== 3 || !cards.every((c) => h.includes(c))) return err('Wähle genau drei Karten.');
        removeCards(h, cards);
        g.hands[g.armut.poor].push(...cards);
        g.armut.returnedTrumps = countTrumps(cards);
        g.re = [g.armut.poor, seat];
        log(state, `${seatName(state, seat)} gibt drei Karten zurück (${g.armut.returnedTrumps} Trumpf).`);
        startPlay(state);
        break;
      }
      case 'play': {
        if (!g || g.phase !== 'play') return err('Gerade wird nicht gespielt.');
        if (g.turn !== seat) return err('Du bist nicht dran.');
        const h = g.hands[seat];
        if (!h.includes(a.card)) return err('Karte nicht auf der Hand.');
        if (!legalCards(h, g.current, kindOf(g.type)).includes(a.card)) return err('Du musst bedienen.');
        h.splice(h.indexOf(a.card), 1);
        g.current.push({ seat, card: a.card });
        if (g.current.length === 4) finishTrick(state);
        else g.turn = (seat + 1) % 4;
        break;
      }
      case 'announce': {
        if (!announceOptions(g, seat).includes(a.level)) return err('Diese Ansage ist jetzt nicht mehr möglich.');
        const party = partyOf(g, seat);
        g.ann[party] = a.level;
        g.ann.hist.push({ seat, party, level: a.level, trick: g.tricks.length });
        log(state, `${seatName(state, seat)}: ${ANN_LABEL[party][a.level]}${a.level > 1 ? ' (' + (party === 're' ? 'Re' : 'Kontra') + ')' : ''}!`);
        break;
      }
      case 'bock': {
        return err('Bockrunden entstehen jetzt automatisch (Nullspiel, Herz-Stich).');
        break;
      }
      case 'next': {
        if (!g || g.phase !== 'done') return err('Das Spiel ist noch nicht vorbei.');
        // Bockspiele wurden schon beim Abrechnen gezählt (siehe finishGame)
        state.dealer = (state.dealer + 1) % 4;
        deal(state, a.hands);
        break;
      }
      case 'reset': {
        const seats = state.seats;
        const fresh = newTable();
        fresh.seats = a.keepSeats ? seats.map((s) => (s && s.bot && s.uid === null && /\(Bot\)$/.test(s.name) ? null : s)) : [null, null, null, null];
        fresh.rev = state.rev;
        Object.assign(state, fresh);
        log(state, 'Neue Partie.');
        break;
      }
      default: return err('Unbekannte Aktion.');
    }
    state.rev = (state.rev || 0) + 1;
    return { state };
  }

  // ---------- Bots ----------
  // Die Bots nutzen nur Wissen, das auch ein Mensch am Tisch hätte: eigene Karten,
  // gespielte Karten, wer welche Farbe nicht mehr bedienen konnte, bekannte Parteien.
  const ALL_KEYS = []; for (const su of SUITS) for (const r of RANKS) ALL_KEYS.push(su + r, su + r);

  // Probespiele: Wie oft gewinnt diese Hand das Solo, wenn die übrigen 30 Karten zufällig verteilt sind?
  function soloWinRate(hand, type, seat) {
    const kind = kindOf(type);
    const rest = ALL_KEYS.slice();
    hand.forEach((c) => { const i = rest.indexOf(key(c)); if (i >= 0) rest.splice(i, 1); });
    const rand = rng((hand.join('').length * 977 + seat * 13 + type.length * 7 + Date.now()) | 0);
    const party = (p) => (p === seat ? 're' : 'contra');
    let wins = 0;
    const n = RULES.bots.soloSims;
    for (let k = 0; k < n; k++) {
      const cards = rest.slice();
      for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
      const hands = [[], [], [], []];
      let ci = 0; for (let p = 0; p < 4; p++) hands[p] = p === seat ? hand.map(key) : cards.slice(ci, (ci += 10));
      let eyes = 0, turn = (k % 4), cur = [], trickNo = 0; // Ausspieler variiert
      while (trickNo < 10) {
        const c = quickPolicy(hands[turn], cur, kind, party, turn, trickNo);
        hands[turn].splice(hands[turn].indexOf(c), 1);
        cur.push({ seat: turn, card: c });
        turn = (turn + 1) % 4;
        if (cur.length === 4) {
          const led = followSuit(cur[0].card, kind);
          let wi = 0, wp = power(cur[0].card, led, kind);
          for (let i = 1; i < 4; i++) { const pw = power(cur[i].card, led, kind); if (pw > wp) { wp = pw; wi = i; } }
          if (cur[wi].seat === seat) eyes += cur.reduce((x, q) => x + pts(q.card), 0);
          turn = cur[wi].seat; cur = []; trickNo++;
        }
      }
      if (eyes >= 121) wins++;
    }
    return wins / n;
  }

  function botDecl(g, seat) {
    const h = g.hands[seat];
    const o = declOptions(g, seat);
    const has = (k) => h.filter((c) => key(c) === k).length;
    const cnt = (r) => h.filter((c) => rankOf(c) === r).length;
    const aces = cnt('A');
    const nT = countTrumps(h);
    const hiT = h.filter((c) => { const i = TRUMPS.normal.indexOf(key(c)); return i >= 0 && i < 5; }).length;
    // Solo nur, wenn es in vielen Probespielen fast immer gewonnen wird (ein verlorenes Solo kostet dreifach)
    if (RULES.bots.solo) {
      const cand = [];
      if (cnt('Q') >= 4) cand.push('solo_damen');
      if (cnt('J') >= 4) cand.push('solo_buben');
      if (cnt('K') >= 4) cand.push('solo_koenige');
      if (nT >= 7 && hiT >= 3) cand.push('solo_trumpf');
      let best = null, bestRate = RULES.bots.soloRate;
      for (const t of cand) { const r = soloWinRate(h, t, seat); if (r >= bestRate) { best = t; bestRate = r; } }
      if (best) return best;
    }
    if (o.includes('schmeissen')) return 'schmeissen';
    if (o.includes('hochzeit')) return RULES.bots.stille && soloWinRate(h, 'solo_trumpf', seat) >= RULES.bots.soloRate ? 'gesund' : 'hochzeit'; // sehr starke Hand: heimlich allein
    if (o.includes('armut')) return 'armut';
    return 'gesund';
  }

  function botAnnounce(g, seat) {
    if (!RULES.bots.announce || g.ann.hist.some((x) => x.seat === seat)) return null;
    if (isSoloType(g.type) || g.stille || (g.type === 'hochzeit' && g.hz.alone)) return null;
    if (!announceOptions(g, seat).includes(1)) return null;
    const party = partyOf(g, seat);
    if (!party || g.ann[party] >= 1) return null;
    const kind = kindOf(g.type);
    const h = g.hands[seat];
    const nT = h.filter((c) => isTrump(c, kind)).length;
    const hi = h.filter((c) => { const i = TRUMPS[kind].indexOf(key(c)); return i >= 0 && i < 5; }).length;
    const aces = h.filter((c) => rankOf(c) === 'A' && !isTrump(c, kind)).length;
    const strong = (nT >= 6 && hi >= 3) || (nT >= 5 && hi >= 3 && aces >= 2) || (nT >= 7 && hi >= 2);
    return strong ? { t: 'announce', level: 1 } : null;
  }

  function botCard(g, seat) {
    const kind = kindOf(g.type);
    const h = g.hands[seat];
    const legal = legalCards(h, g.current, kind);
    if (legal.length === 1) return legal[0];
    const T = TRUMPS[kind];
    const tIdx = (c) => T.indexOf(key(c));
    const isT = (c) => tIdx(c) >= 0;
    const trumpCost = (c) => (isT(c) ? (T.length - tIdx(c)) * 3 : 0); // hohe Trümpfe sind wertvoll
    const minBy = (arr, f) => arr.reduce((b, c) => (f(c) < f(b) ? c : b));
    const maxBy = (arr, f) => arr.reduce((b, c) => (f(c) > f(b) ? c : b));

    // Wissen: ungesehene Karten und Fehlfarben
    const playedTricks = g.tricks.concat(g.current.length ? [{ cards: g.current }] : []);
    const unseen = ALL_KEYS.slice();
    const drop = (k) => { const i = unseen.indexOf(k); if (i >= 0) unseen.splice(i, 1); };
    h.forEach((c) => drop(key(c)));
    playedTricks.forEach((t) => t.cards.forEach((p) => drop(key(p.card))));
    const voids = [0, 1, 2, 3].map(() => new Set());
    playedTricks.forEach((t) => {
      const ld = followSuit(t.cards[0].card, kind);
      t.cards.slice(1).forEach((p) => { if (followSuit(p.card, kind) !== ld) voids[p.seat].add(ld); });
    });
    const unseenOf = (su) => unseen.filter((k) => followSuit(k, kind) === su).length;
    const timesLed = (su) => g.tricks.filter((t) => followSuit(t.cards[0].card, kind) === su).length;

    // Parteien aus Sicht dieses Spielers
    const myParty = knownParty(g, seat, seat);
    const partyOfP = (p) => (p === seat ? myParty : knownParty(g, seat, p));
    const isPartner = (p) => !!myParty && partyOfP(p) === myParty;
    const isOpp = (p) => !!myParty && !!partyOfP(p) && partyOfP(p) !== myParty;

    const after = []; for (let i = g.current.length + 1; i < 4; i++) after.push((seat + i - g.current.length) % 4);
    const threats = after.filter((p) => !isPartner(p));

    // Kann eine noch ungesehene Karte diese Karte schlagen, gespielt von einem der Spieler p?
    function beatable(card, led, players) {
      if (!players.length) return false;
      const myPow = power(card, led, kind);
      const ledLeft = led === 'T' ? 0 : unseenOf(led);
      for (const u of unseen) {
        if (power(u, led, kind) <= myPow) continue;
        const uT = isTrump(u, kind);
        for (const p of players) {
          if (led === 'T') { if (uT && !voids[p].has('T')) return true; }
          else if (!uT) { if (suitOf(u) === led && !voids[p].has(led)) return true; }
          else if (!voids[p].has('T') && (voids[p].has(led) || ledLeft < players.length)) return true;
        }
      }
      return false;
    }

    // ---- Ausspielen ----
    if (!g.current.length) {
      const fehl = legal.filter((c) => !isT(c));
      const trumps = legal.filter(isT);
      // Hochzeit: die Braut sucht über einen Fehlstich einen Partner -> kleine Fehlkarte
      if (g.type === 'hochzeit' && g.hz && !g.hz.done && seat === g.hz.bride && fehl.length) {
        return minBy(fehl, (c) => power(c, suitOf(c), kind) + pts(c));
      }
      // sicheres Fehl-Ass: Farbe noch nicht gelaufen, genug Karten draußen, kein Gegner blank
      const aces = fehl.filter((c) => rankOf(c) === 'A' && timesLed(suitOf(c)) === 0 && unseenOf(suitOf(c)) >= 3
        && ![0, 1, 2, 3].some((p) => p !== seat && !isPartner(p) && voids[p].has(suitOf(c))));
      if (aces.length) return maxBy(aces, (c) => unseenOf(suitOf(c)));
      // höchster noch ausstehender Trumpf in meiner Hand: zieht Trümpfe (Solist oder viele Trümpfe)
      const myTrumps = h.filter(isT).length;
      const topTrump = trumps.length ? minBy(trumps, tIdx) : null;
      const soloist = myParty === 're' && (isSoloType(g.type) || g.stille || (g.type === 'hochzeit' && g.hz && g.hz.alone));
      if (topTrump && !unseen.some((k) => isTrump(k, kind) && tIdx(k) < tIdx(topTrump)) && (soloist || myTrumps >= 4)) return topTrump;
      // Partner ist in einer Farbe blank -> diese Farbe anspielen, damit er stechen kann
      const partnerVoid = fehl.filter((c) => [0, 1, 2, 3].some((p) => p !== seat && isPartner(p) && voids[p].has(suitOf(c)) && !voids[p].has('T')));
      if (partnerVoid.length) return minBy(partnerVoid, pts);
      // sonst: kleine Fehlkarte einer Farbe, in der kein Gegner blank ist; Asse und Zehnen schonen
      const safeFehl = fehl.filter((c) => ![0, 1, 2, 3].some((p) => p !== seat && isOpp(p) && voids[p].has(suitOf(c))));
      const pool = safeFehl.length ? safeFehl : fehl;
      if (pool.length && !soloist) return minBy(pool, (c) => pts(c) * 2 + (rankOf(c) === 'A' ? 10 : 0));
      if (trumps.length) {
        // kleiner Trumpf, aber nicht den Fuchs und nicht Karlchen verschenken
        const lowT = trumps.filter((c) => key(c) !== 'DA' && key(c) !== 'CJ');
        return maxBy(lowT.length ? lowT : trumps, tIdx);
      }
      return minBy(legal, pts);
    }

    // ---- Zugeben ----
    const led = followSuit(g.current[0].card, kind);
    const wi = trickWinnerIdx(g.current, kind);
    const wSeat = g.current[wi].seat;
    const wCard = g.current[wi].card;
    const wPow = power(wCard, led, kind);
    const trickPts = g.current.reduce((n, p) => n + pts(p.card), 0);
    const lastTrick = g.tricks.length === 9;
    const keepCJ = (c) => key(c) === 'CJ' && !lastTrick ? 25 : 0; // Karlchen für den letzten Stich aufheben

    // Partner liegt vorn und kann nicht mehr überstochen werden -> schmieren
    if (isPartner(wSeat) && !beatable(wCard, led, threats)) {
      return maxBy(legal, (c) => pts(c) * 10 - (isT(c) && tIdx(c) < 6 ? 120 : 0) - keepCJ(c) * 4);
    }
    const winners = legal.filter((c) => power(c, led, kind) > wPow);
    const expected = trickPts + after.length * 5; // grob geschätzte Augen, die noch kommen
    if (winners.length && !isPartner(wSeat)) {
      const safe = winners.filter((c) => !beatable(c, led, threats));
      // Letzter Stich mit Karlchen oder Fuchs gewinnen lohnt doppelt
      if (lastTrick) {
        const special = (safe.length ? safe : winners).filter((c) => key(c) === 'CJ' || key(c) === 'DA');
        if (special.length) return special[0];
      }
      if (safe.length) {
        // als Letzter: Gewinner mit möglichst vielen Augen; sonst den billigsten sicheren Gewinner
        if (!after.length) return maxBy(safe, (c) => pts(c) - trumpCost(c) - keepCJ(c));
        if (expected >= 8 || isOpp(wSeat)) return minBy(safe, (c) => trumpCost(c) + keepCJ(c) + (key(c) === 'DA' ? 15 : 0));
      }
      // unsicher: nur mit billigem Gewinner (z. B. Fehl-Ass beim Bedienen) mitgehen, wenn genug liegt
      const cheap = winners.filter((c) => trumpCost(c) <= 12 && key(c) !== 'DA' && key(c) !== 'CJ');
      if (cheap.length && (expected >= 12 || !after.length)) return minBy(cheap, (c) => trumpCost(c) - pts(c));
    }
    // abwerfen: wenig Augen, keine hohen Trümpfe, Asse/Fuchs/Karlchen schonen
    return minBy(legal, (c) => pts(c) * 3 + trumpCost(c) + (rankOf(c) === 'A' && !isT(c) ? 8 : 0) + (key(c) === 'DA' ? 20 : 0) + keepCJ(c));
  }

  // ---- Vorausdenken (Monte-Carlo): unbekannte Karten passend verteilen, Rest des Spiels durchspielen ----
  function rng(seed) { let x = seed >>> 0 || 1; return () => ((x ^= x << 13, x ^= x >>> 17, x ^= x << 5) >>> 0) / 4294967296; }
  function quickPolicy(hand, current, kind, partyOf2, me, trickNo) {
    const legal = legalCards(hand, current, kind);
    if (legal.length === 1) return legal[0];
    const T = TRUMPS[kind];
    const ti = (c) => T.indexOf(key(c));
    const tc = (c) => (ti(c) >= 0 ? (T.length - ti(c)) * 3 : 0);
    let best = legal[0], bv;
    const pick = (f, max) => { bv = undefined; for (const c of legal) { const v = f(c); if (bv === undefined || (max ? v > bv : v < bv)) { bv = v; best = c; } } return best; };
    if (!current.length) {
      const aceIdx = legal.findIndex((c) => rankOf(c) === 'A' && ti(c) < 0);
      if (aceIdx >= 0) return legal[aceIdx];
      if (legal.some((c) => ti(c) < 0)) return pick((c) => (ti(c) < 0 ? pts(c) : 99), false);
      return pick((c) => ti(c) + (key(c) === 'DA' ? -5 : 0), true);
    }
    const led = followSuit(current[0].card, kind);
    let wi = 0, wp = power(current[0].card, led, kind);
    for (let i = 1; i < current.length; i++) { const p = power(current[i].card, led, kind); if (p > wp) { wp = p; wi = i; } }
    const ws = current[wi].seat;
    const partnerWin = partyOf2(ws) === partyOf2(me);
    const last = current.length === 3;
    if (partnerWin && (last || wp >= 1000 - 3)) return pick((c) => pts(c) * 10 - (ti(c) >= 0 && ti(c) < 6 ? 150 : 0) - (key(c) === 'CJ' && trickNo < 9 ? 60 : 0), true);
    if (!partnerWin) {
      let anyWin = false; for (const c of legal) if (power(c, led, kind) > wp) { anyWin = true; break; }
      if (anyWin) return pick((c) => (power(c, led, kind) > wp ? (last ? -pts(c) + tc(c) : tc(c)) : 1e6), false);
    }
    return pick((c) => pts(c) * 3 + tc(c) + (key(c) === 'DA' ? 20 : 0), false);
  }

  function thinkCard(g, seat) {
    const kind = kindOf(g.type);
    const h = g.hands[seat];
    const legal = legalCards(h, g.current, kind);
    const cand = []; const seenK = new Set();
    for (const c of legal) if (!seenK.has(key(c))) { seenK.add(key(c)); cand.push(c); }
    if (cand.length === 1) return cand[0];

    // Wissen des Bots
    const playedTricks = g.tricks.concat(g.current.length ? [{ cards: g.current }] : []);
    const unseen = ALL_KEYS.slice();
    const drop = (k) => { const i = unseen.indexOf(k); if (i >= 0) unseen.splice(i, 1); };
    h.forEach((c) => drop(key(c)));
    const playedCQ = [0, 0, 0, 0];
    playedTricks.forEach((t) => t.cards.forEach((p) => { drop(key(p.card)); if (key(p.card) === 'CQ') playedCQ[p.seat]++; }));
    const voids = [0, 1, 2, 3].map(() => new Set());
    playedTricks.forEach((t) => { const ld = followSuit(t.cards[0].card, kind); t.cards.slice(1).forEach((p) => { if (followSuit(p.card, kind) !== ld) voids[p.seat].add(ld); }); });
    const others = [0, 1, 2, 3].filter((p) => p !== seat);
    const need = [0, 0, 0, 0]; const noCQ = [false, false, false, false];
    const cqParties = g.type === 'normal'; // Parteien hängen an den Kreuz-Damen
    if (cqParties) for (const p of others) {
      const kp = knownParty(g, seat, p);
      if (kp === 'contra') noCQ[p] = true;
      else if (kp === 're' && playedCQ[p] === 0) need[p] = 1;
    }
    if (g.type === 'hochzeit' && g.hz && g.hz.bride !== seat) need[g.hz.bride] = 2 - playedCQ[g.hz.bride];
    const cap = [0, 1, 2, 3].map((p) => (p === seat ? 0 : g.hands[p].length));

    const myKeys = h.map(key);
    const rand = rng((g.tricks.length * 7919 + g.current.length * 104729 + seat * 31 + myKeys.join('').length * 17 + Date.now()) | 0);
    function sampleWorld() {
      for (let attempt = 0; attempt < 30; attempt++) {
        const relax = attempt > 20;
        const cards = unseen.slice();
        for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
        const hands = [[], [], [], []]; const left = cap.slice();
        let ok = true;
        // Pflichtkarten (Kreuz-Damen) zuerst
        for (const p of others) for (let n = 0; n < need[p]; n++) {
          const i = cards.indexOf('CQ'); if (i < 0 || left[p] <= 0) { ok = relax; break; }
          hands[p].push('CQ'); left[p]--; cards.splice(i, 1);
        }
        if (!ok) continue;
        for (const c of cards) {
          const su = followSuit(c, kind);
          const elig = others.filter((p) => left[p] > 0 && (relax || (!voids[p].has(su) && !(c === 'CQ' && noCQ[p]))));
          if (!elig.length) { ok = false; break; }
          // gleichmäßig nach freien Plätzen gewichten
          let r = rand() * elig.reduce((n, p) => n + left[p], 0), pick = elig[0];
          for (const p of elig) { r -= left[p]; if (r < 0) { pick = p; break; } }
          hands[pick].push(c); left[pick]--;
        }
        if (ok) return hands;
      }
      return null;
    }

    const myPartyKnown = knownParty(g, seat, seat);
    function rollout(world, first) {
      const hands = world.map((x) => x.slice());
      hands[seat] = myKeys.slice(); hands[seat].splice(hands[seat].indexOf(key(first)), 1);
      // Parteien in dieser Welt
      let re;
      if (cqParties) {
        re = new Set();
        for (let p = 0; p < 4; p++) if (playedCQ[p] || hands[p].includes('CQ') || (p === seat && (myKeys.includes('CQ')))) re.add(p);
      } else re = new Set(g.re);
      let hzOpen = g.type === 'hochzeit' && g.hz && !g.hz.done;
      const party = (p) => (re.has(p) ? 're' : 'contra');
      const eyes = { re: 0, contra: 0 };
      g.tricks.forEach((t) => { eyes[party(t.winner)] += t.points; });
      let cur = g.current.map((p) => ({ seat: p.seat, card: key(p.card) }));
      cur.push({ seat, card: key(first) });
      let turn = (seat + 1) % 4;
      let trickNo = g.tricks.length;
      while (true) {
        if (cur.length === 4) {
          const led = followSuit(cur[0].card, kind);
          let wi = 0, wp = power(cur[0].card, led, kind);
          for (let i = 1; i < 4; i++) { const pw = power(cur[i].card, led, kind); if (pw > wp) { wp = pw; wi = i; } }
          const w = cur[wi].seat;
          if (hzOpen) {
            if (led !== 'T' && w !== g.hz.bride) { re.add(w); hzOpen = false; }
            else if (trickNo + 1 >= RULES.hochzeitTricks) hzOpen = false;
          }
          eyes[party(w)] += cur.reduce((n, p) => n + pts(p.card), 0);
          trickNo++; cur = []; turn = w;
          if (trickNo === 10) break;
        }
        const c = quickPolicy(hands[turn], cur, kind, party, turn, trickNo);
        hands[turn].splice(hands[turn].indexOf(c), 1);
        cur.push({ seat: turn, card: c });
        turn = (turn + 1) % 4;
      }
      const mine = myPartyKnown || party(seat);
      const reWins = eyes.re >= 121;
      const win = mine === 're' ? reWins : !reWins;
      return eyes[mine] + (win ? 45 : 0);
    }

    const N = Math.max(10, Math.ceil(RULES.bots.rollouts / cand.length));
    const score = cand.map(() => 0);
    let used = 0;
    for (let i = 0; i < N; i++) {
      const world = sampleWorld();
      if (!world) continue;
      used++;
      cand.forEach((c, j) => { score[j] += rollout(world, c); });
    }
    if (!used) return null;
    let bi = 0; for (let j = 1; j < cand.length; j++) if (score[j] > score[bi]) bi = j;
    return cand[bi];
  }

  function botAction(state, seat) {
    const g = state.game;
    if (!g || g.turn !== seat) return null;
    const h = g.hands[seat];
    if (g.phase === 'vorbehalt') return { t: 'decl', choice: botDecl(g, seat) };
    const lowFirst = (cards) => cards.slice().sort((a, b) => pts(a) - pts(b));
    if (g.phase === 'armut_give') {
      const tr = h.filter((c) => isTrump(c, 'normal'));
      const fehl = lowFirst(h.filter((c) => !isTrump(c, 'normal') && rankOf(c) !== 'A'));
      const rest = fehl.length >= 3 - tr.length ? fehl : lowFirst(h.filter((c) => !isTrump(c, 'normal')));
      return { t: 'armutGive', cards: tr.concat(rest.slice(0, 3 - tr.length)) };
    }
    if (g.phase === 'armut_answer') {
      const nT = countTrumps(h);
      const hi = h.filter((c) => { const i = TRUMPS.normal.indexOf(key(c)); return i >= 0 && i < 5; }).length;
      return { t: 'armutAnswer', accept: (nT >= 6 && hi >= 2) || nT >= 7 };
    }
    if (g.phase === 'armut_return') {
      // kleine Fehlkarten zurück, möglichst kurze Farben (macht blank); notfalls schwache Trümpfe
      const fehl = h.filter((c) => !isTrump(c, 'normal'));
      const len = (c) => fehl.filter((x) => suitOf(x) === suitOf(c)).length;
      const back = fehl.slice().sort((a, b) => len(a) - len(b) || pts(a) - pts(b)).filter((c) => rankOf(c) !== 'A');
      const weakT = sortHand(h.filter((c) => isTrump(c, 'normal')), 'normal').reverse();
      return { t: 'armutReturn', cards: back.concat(fehl.filter((c) => rankOf(c) === 'A'), weakT).slice(0, 3) };
    }
    if (g.phase !== 'play') return null;
    const ann = botAnnounce(g, seat);
    if (ann) return ann;
    const thought = RULES.bots.think ? thinkCard(g, seat) : null;
    return { t: 'play', card: thought || botCard(g, seat) };
  }

  // ---------- Mehrspieler: Ansicht pro Spieler, Rechteprüfung, Bot-Schritt ----------
  // Was ein Spieler sehen darf: eigene Hand, öffentliche Infos, sein Wissen über die Parteien.
  function viewFor(state, uid, onlineUids) {
    const me = state.seats.findIndex((s) => s && !s.bot && s.uid === uid);
    const v = {
      v: state.v, rev: state.rev, dealer: state.dealer, bockLeft: typeof state.bockLeft === 'number' ? state.bockLeft : (state.bock || []).filter((x) => x > 0).length, games: clone(state.games),
      phase: state.phase, log: state.log.slice(), me,
      seats: state.seats.map((s, i) => (s ? { name: s.name, bot: !!s.bot, mine: i === me, online: s.bot || !onlineUids || onlineUids.includes(s.uid) } : null)),
      game: null,
    };
    const g = state.game;
    if (!g) return v;
    const done = g.phase === 'done';
    const viewer = me >= 0 ? me : -1;
    // Stille Hochzeit bleibt geheim (auch auf dem eigenen Bildschirm), bis sie am Tisch eindeutig ist:
    // derselbe Spieler hat beide Kreuz-Damen ausgespielt, oder das Spiel ist vorbei.
    const cqBySoloist = g.stille ? g.tricks.concat([{ cards: g.current }]).reduce((n, t) => n + t.cards.filter((p) => p.seat === g.soloist && key(p.card) === 'CQ').length, 0) : 0;
    const stilleKnown = g.stille && (done || cqBySoloist === 2);
    const vg = {
      no: g.no, dealId: g.dealId, dealer: g.dealer, phase: g.phase, turn: g.turn, type: g.type, bock: g.bock,
      tricks: clone(g.tricks), current: clone(g.current), ann: clone(g.ann), hz: g.hz ? clone(g.hz) : null,
      hands: g.hands.map((h, i) => (i === me ? h.slice() : h.map(() => 'XX'))),
      decl: g.decl.map((d, i) => (i === me || !d ? d : d === 'gesund' ? 'gesund' : 'vorbehalt')),
      known: [0, 1, 2, 3].map((t) => knownParty(g, viewer, t)),
      stille: stilleKnown,
      soloist: isSoloType(g.type) || done || stilleKnown ? g.soloist : null,
      re: done ? g.re.slice() : [],
      result: done ? clone(g.result) : null,
      annOptions: me >= 0 ? announceOptions(g, me) : [],
      declOptions: me >= 0 && g.phase === 'vorbehalt' ? declOptions(g, me) : [],
      armut: null,
    };
    if (g.armut) {
      const a = g.armut;
      vg.armut = {
        poor: a.poor, declined: a.declined.slice(), taker: a.taker, returnedTrumps: a.returnedTrumps,
        trumps: a.cards ? countTrumps(a.cards) : null,
        cards: me === a.poor && a.cards ? a.cards.slice() : null,
      };
    }
    v.game = vg;
    return v;
  }

  // Aktion eines Spielers (über seine geheime ID) prüfen und anwenden.
  function dispatch(state, uid, a0, onlineUids) {
    if (!a0 || typeof a0 !== 'object' || typeof a0.t !== 'string') return { error: 'Ungültige Aktion.' };
    const a = { ...a0 };
    delete a.hands; // Karten verteilt nur der Server
    const mine = state.seats.findIndex((s) => s && !s.bot && s.uid === uid);
    const validSeat = (x) => Number.isInteger(x) && x >= 0 && x < 4;
    let seat = mine;
    switch (a.t) {
      case 'sit':
        if (!validSeat(a.seat)) return { error: 'Ungültiger Platz.' };
        a.uid = uid; seat = a.seat; break;
      case 'takeover': {
        // Platz eines Bots oder eines abwesenden Mitspielers übernehmen (Spielstand und Punkte bleiben)
        if (!validSeat(a.seat)) return { error: 'Ungültiger Platz.' };
        if (mine >= 0) return { error: 'Du sitzt schon am Tisch.' };
        const s = state.seats[a.seat];
        if (s && !s.bot) {
          if (onlineUids && onlineUids.includes(s.uid)) return { error: `${s.name} ist noch verbunden.` };
          const old = s.name;
          const r1 = apply(state, a.seat, { t: 'leave', seat: a.seat });
          if (r1.error) return r1;
          const st = r1.state;
          if (!st.seats[a.seat]) return apply(st, a.seat, { t: 'sit', seat: a.seat, uid, name: a.name }); // vor dem Spiel: einfach hinsetzen
          const r2 = apply(st, a.seat, { t: 'takeover', seat: a.seat, uid, name: a.name });
          if (!r2.error) r2.state.log.push(`${r2.state.seats[a.seat].name} spielt für ${old} weiter.`);
          return r2;
        }
        a.uid = uid; seat = a.seat; break;
      }
      case 'rename':
        if (mine < 0) return { error: 'Du sitzt nicht am Tisch.' };
        a.uid = uid; a.seat = mine; break;
      case 'leave': {
        if (!validSeat(a.seat)) return { error: 'Ungültiger Platz.' };
        const s = state.seats[a.seat];
        if (!s) return { error: 'Platz ist leer.' };
        if (a.seat !== mine && !s.bot) return { error: 'Du kannst nur deinen eigenen Platz freigeben.' };
        if (s.bot && state.phase === 'game') return { error: 'Während des Spiels bleibt der Bot sitzen. Übernimm den Platz stattdessen.' };
        seat = a.seat; break;
      }
      case 'kick': {
        // Abwesenden Mitspieler durch einen Bot ersetzen, damit das Spiel weitergeht
        if (mine < 0) return { error: 'Setz dich zuerst an den Tisch.' };
        if (!validSeat(a.seat)) return { error: 'Ungültiger Platz.' };
        const s = state.seats[a.seat];
        if (!s || s.bot || a.seat === mine) return { error: 'Das geht nur bei einem anderen Mitspieler.' };
        if (onlineUids && onlineUids.includes(s.uid)) return { error: `${s.name} ist noch verbunden.` };
        return apply(state, a.seat, { t: 'leave', seat: a.seat });
      }
      case 'fillBots': case 'start': case 'next': case 'bock': case 'reset':
        if (mine < 0) return { error: 'Setz dich zuerst an den Tisch.' };
        break;
      default:
        if (mine < 0) return { error: 'Du sitzt nicht am Tisch.' };
    }
    return apply(state, seat, a);
  }

  // Ein Zug des Bots, der gerade dran ist (oder null)
  function botStep(state0) {
    const state = normalize(clone(state0));
    const g = state.game;
    if (state.phase !== 'game' || !g || g.phase === 'done') return null;
    const s = state.seats[g.turn];
    if (!s || !s.bot) return null;
    const a = botAction(state, g.turn);
    if (!a) return null;
    const r = apply(state, g.turn, a);
    return r.error ? null : r.state;
  }
  function botDelay(state) {
    const g = state.game;
    return g && g.current.length === 0 && g.tricks.length ? 2200 : 850; // fertiger Stich bleibt 2 Sekunden liegen
  }

  function totals(state) {
    const t = [0, 0, 0, 0];
    for (const g of state.games) g.points.forEach((p, i) => (t[i] += p));
    return t;
  }
  const euro = (pts) => (pts * RULES.centPerPoint / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

  return {
    RULES, SOLOS, schmeissReason, viewFor, dispatch, botStep, botDelay, SUIT_SYM, SUIT_NAME, RANK_SHORT, TYPE_LABEL, DECL_LABEL, ANN_LABEL,
    newTable, apply, botAction, legalCards, sortHand, kindOf, isTrump, partyOf, knownParty,
    announceOptions, declOptions, scoreGame, totals, euro, cardName, pts, key, suitOf, rankOf, trickWinnerIdx, countTrumps,
  };
})();
export default DokoEngine;
