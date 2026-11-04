/* Doppelkopf-Regel-Engine – läuft im Browser und auf dem Server (ES-Modul). (ohne Neunen, 10 Karten pro Spieler)
 * Reine Funktionen: apply(state, seat, action) -> {state} | {error}
 * Karten: Farbe C/S/H/D (Kreuz, Pik, Herz, Karo) + Wert A/T/K/Q/J (Ass, 10, König, Dame, Bube) + Kopie 0/1
 */
const DokoEngine = (() => {
  const RULES = {
    fuchs: false,            // Fuchs gefangen (nicht in euren Regeln, abschaltbar)
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
    return { v: 1, seats: [null, null, null, null], dealer: 3, bock: [], games: [], game: null, phase: 'lobby', log: [], rev: 0 };
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
      armut: null, hz: null, bock: state.bock[0] || 0, result: null,
    };
    log(state, `Spiel ${state.game.no}: ${seatName(state, d)} gibt.`);
  }

  const order4 = (start) => [0, 1, 2, 3].map((i) => (start + i) % 4);

  function countTrumps(hand, kind = 'normal') { return hand.filter((c) => isTrump(c, kind)).length; }
  function countCQ(hand) { return hand.filter((c) => key(c) === 'CQ').length; }

  // Schmeißen: höchster Trumpf ist der Karo-Bube (oder schwächer) oder mindestens 5 Könige
  function schmeissReason(h) {
    const top = Math.min(...h.map((c) => TRUMPS.normal.indexOf(key(c))).filter((i) => i >= 0), 99);
    if (top >= TRUMPS.normal.indexOf('DJ')) return 'höchster Trumpf ist der Karo-Bube';
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

    const lines = [];
    let V = 0;
    if (winner) {
      const loser = winner === 're' ? 'contra' : 're';
      const add = (text, n = 1) => { lines.push({ text, pts: n, party: winner }); V += n; };
      add('Gewonnen');
      if (winner === 'contra' && !solo) add('Gegen die Alten');
      if (eyes[loser] < 90) add('Unter 90 gespielt');
      if (eyes[loser] < 60) add('Unter 60 gespielt');
      if (eyes[loser] < 30) add('Unter 30 gespielt');
      if (tricks[loser] === 0) add('Schwarz gespielt');
      if (L.re >= 1) add('Re angesagt', 2);
      if (L.contra >= 1) add('Kontra angesagt', 2);
      for (const p of ['re', 'contra']) for (let l = 2; l <= L[p]; l++) add(`${ANN_LABEL[p][l]} abgesagt (${p === 're' ? 'Re' : 'Kontra'})`);
    }

    const extras = { re: 0, contra: 0 };
    if (!solo) {
      const ex = (party, text) => { extras[party]++; lines.push({ text, pts: 1, party, extra: true }); };
      g.tricks.forEach((t, i) => {
        const wp = partyOfSeat(t.winner);
        if (t.points >= 40) ex(wp, `Volle (${t.points} Augen, Stich ${i + 1})`);
        if (kind === 'normal' && t.cards.every((p) => suitOf(p.card) === 'H' && !isTrump(p.card, kind))) ex(wp, `Herz durchgegangen (Stich ${i + 1})`);
        if (RULES.fuchs) for (const p of t.cards) if (key(p.card) === 'DA' && partyOfSeat(p.seat) !== wp) ex(wp, 'Fuchs gefangen');
        if (t.cards.filter((p) => key(p.card) === 'CQ').length === 2) ex('contra', `Beide Kreuz-Damen in einem Stich (Stich ${i + 1})`);
        if (i === 9 && kind === 'normal') {
          const wi = t.cards.findIndex((p) => p.seat === t.winner);
          if (key(t.cards[wi].card) === 'CJ') ex(wp, 'Karlchen macht den letzten Stich');
          if (key(t.cards[wi].card) === 'DA') ex(wp, 'Fuchs macht den letzten Stich');
          t.cards.forEach((p, j) => { if (j !== wi && key(p.card) === 'CJ' && partyOfSeat(p.seat) !== wp) ex(wp, 'Karlchen gefangen'); });
        }
      });
    }

    const S = (winner === 're' ? V : winner === 'contra' ? -V : 0) + extras.re - extras.contra; // aus Re-Sicht
    const m = Math.pow(2, g.bock || 0);
    const points = [0, 1, 2, 3].map((s) => {
      const re = g.re.includes(s);
      if (solo) return (re ? 3 * S : -S) * m;
      return (re ? S : -S) * m;
    });
    let label = TYPE_LABEL[g.type];
    if (g.stille) label = 'Stille Hochzeit';
    if (g.type === 'hochzeit' && g.hz.alone) label = 'Hochzeit (Solo)';
    return { solo, eyes, tricks, winner, lines, V, extras, S, m, points, label, ann: { ...L } };
  }

  function finishGame(state) {
    const g = state.game;
    const r = scoreGame(g);
    g.result = r; g.phase = 'done';
    state.games.push({ no: g.no, label: r.label, re: g.re.slice(), soloist: g.soloist, eyes: r.eyes, winner: r.winner, points: r.points, bock: g.bock });
    const who = r.winner === 're' ? 'Re' : r.winner === 'contra' ? 'Kontra' : 'Niemand';
    log(state, `${who} gewinnt mit ${r.winner ? r.eyes[r.winner] : r.eyes.re} Augen. Spielwert ${Math.abs(r.S)}${r.m > 1 ? ` ×${r.m} (Bock)` : ''}.`);
  }

  function removeCards(hand, cards) {
    for (const c of cards) { const i = hand.indexOf(c); if (i < 0) return false; hand.splice(i, 1); }
    return true;
  }

  function addBock(state) {
    const g = state.game;
    const startsNow = !g || (g.phase !== 'done' && g.tricks.length === 0 && g.current.length === 0);
    const off = startsNow ? 0 : 1;
    for (let i = 0; i < RULES.bockGames; i++) state.bock[off + i] = (state.bock[off + i] || 0) + 1;
    if (g && startsNow) g.bock = (g.bock || 0) + 1;
  }

  function apply(state0, seat, a) {
    const state = clone(state0);
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
        addBock(state);
        log(state, `${seatName(state, seat)} sagt eine Bockrunde an.`);
        break;
      }
      case 'next': {
        if (!g || g.phase !== 'done') return err('Das Spiel ist noch nicht vorbei.');
        state.bock.shift();
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
  function botAction(state, seat) {
    const g = state.game;
    if (!g || g.turn !== seat) return null;
    const h = g.hands[seat];
    const kind = kindOf(g.type || 'normal');
    if (g.phase === 'vorbehalt') {
      const o = declOptions(g, seat);
      if (o.includes('hochzeit')) return { t: 'decl', choice: 'hochzeit' };
      if (o.includes('armut')) return { t: 'decl', choice: 'armut' };
      return { t: 'decl', choice: 'gesund' };
    }
    const cheapest = (cards, n) => cards.slice().sort((a, b) => pts(a) - pts(b) || (isTrump(a, 'normal') - isTrump(b, 'normal'))).slice(0, n);
    if (g.phase === 'armut_give') {
      const tr = h.filter((c) => isTrump(c, 'normal'));
      const rest = cheapest(h.filter((c) => !isTrump(c, 'normal')), 3 - tr.length);
      return { t: 'armutGive', cards: tr.concat(rest) };
    }
    if (g.phase === 'armut_answer') return { t: 'armutAnswer', accept: countTrumps(h) >= 6 };
    if (g.phase === 'armut_return') {
      const fehl = cheapest(h.filter((c) => !isTrump(c, 'normal')), 3);
      const tr = sortHand(h.filter((c) => isTrump(c, 'normal')), 'normal').reverse();
      return { t: 'armutReturn', cards: fehl.concat(tr).slice(0, 3) };
    }
    if (g.phase !== 'play') return null;
    const legal = legalCards(h, g.current, kind);
    const tIdx = (c) => TRUMPS[kind].indexOf(key(c));
    if (!g.current.length) {
      const aces = legal.filter((c) => !isTrump(c, kind) && rankOf(c) === 'A');
      if (aces.length) return { t: 'play', card: aces[0] };
      const fehl = legal.filter((c) => !isTrump(c, kind));
      if (fehl.length) return { t: 'play', card: cheapest(fehl, 1)[0] };
      return { t: 'play', card: legal.slice().sort((a, b) => tIdx(b) - tIdx(a))[0] };
    }
    const led = followSuit(g.current[0].card, kind);
    const wi = trickWinnerIdx(g.current, kind);
    const winSeat = g.current[wi].seat;
    const bestP = power(g.current[wi].card, led, kind);
    const mine = knownParty(g, seat, seat);
    const theirs = knownParty(g, seat, winSeat);
    const last = g.current.length === 3;
    if (mine && theirs === mine && (last || bestP >= 1000 - 4)) {
      const val = (c) => pts(c) - (isTrump(c, kind) && tIdx(c) < 5 ? 30 : 0);
      return { t: 'play', card: legal.slice().sort((a, b) => val(b) - val(a))[0] };
    }
    const winning = legal.filter((c) => power(c, led, kind) > bestP).sort((a, b) => power(a, led, kind) - power(b, led, kind));
    if (winning.length) {
      const pick = last ? winning.slice().sort((a, b) => pts(b) - pts(a))[0] : winning[0];
      return { t: 'play', card: pick };
    }
    return { t: 'play', card: legal.slice().sort((a, b) => pts(a) - pts(b) || (isTrump(a, kind) - isTrump(b, kind)))[0] };
  }

  // ---------- Mehrspieler: Ansicht pro Spieler, Rechteprüfung, Bot-Schritt ----------
  // Was ein Spieler sehen darf: eigene Hand, öffentliche Infos, sein Wissen über die Parteien.
  function viewFor(state, uid, onlineUids) {
    const me = state.seats.findIndex((s) => s && !s.bot && s.uid === uid);
    const v = {
      v: state.v, rev: state.rev, dealer: state.dealer, bock: state.bock.slice(), games: clone(state.games),
      phase: state.phase, log: state.log.slice(), me,
      seats: state.seats.map((s, i) => (s ? { name: s.name, bot: !!s.bot, mine: i === me, online: s.bot || !onlineUids || onlineUids.includes(s.uid) } : null)),
      game: null,
    };
    const g = state.game;
    if (!g) return v;
    const done = g.phase === 'done';
    const viewer = me >= 0 ? me : -1;
    const vg = {
      no: g.no, dealId: g.dealId, dealer: g.dealer, phase: g.phase, turn: g.turn, type: g.type, bock: g.bock,
      tricks: clone(g.tricks), current: clone(g.current), ann: clone(g.ann), hz: g.hz ? clone(g.hz) : null,
      hands: g.hands.map((h, i) => (i === me ? h.slice() : h.map(() => 'XX'))),
      decl: g.decl.map((d, i) => (i === me || !d ? d : d === 'gesund' ? 'gesund' : 'vorbehalt')),
      known: [0, 1, 2, 3].map((t) => knownParty(g, viewer, t)),
      stille: done || me === g.soloist ? g.stille : false,
      soloist: isSoloType(g.type) || done || (g.stille && me === g.soloist) ? g.soloist : null,
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
      case 'sit': case 'takeover':
        if (!validSeat(a.seat)) return { error: 'Ungültiger Platz.' };
        a.uid = uid; seat = a.seat; break;
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
  function botStep(state) {
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
    return g && g.current.length === 0 && g.tricks.length ? 1500 : 850;
  }

  function totals(state) {
    const t = [0, 0, 0, 0];
    for (const g of state.games) g.points.forEach((p, i) => (t[i] += p));
    return t;
  }

  return {
    RULES, SOLOS, schmeissReason, viewFor, dispatch, botStep, botDelay, SUIT_SYM, SUIT_NAME, RANK_SHORT, TYPE_LABEL, DECL_LABEL, ANN_LABEL,
    newTable, apply, botAction, legalCards, sortHand, kindOf, isTrump, partyOf, knownParty,
    announceOptions, declOptions, scoreGame, totals, cardName, pts, key, suitOf, rankOf, trickWinnerIdx, countTrumps,
  };
})();
export default DokoEngine;
