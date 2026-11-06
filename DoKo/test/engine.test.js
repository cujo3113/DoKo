// Regeltests: node test/engine.test.js
import E from '../public/engine.js';
import assert from 'node:assert';

function run(state, act) { const r = E.apply(state, act.seat, act.a); if (r.error) throw new Error(r.error + ' ' + JSON.stringify(act)); return r.state; }
function playOut(state, hook) {
  let guard = 0;
  while (state.game && state.game.phase !== 'done') {
    if (++guard > 500) throw new Error('loop');
    const s = state.game.turn;
    if (hook) { const x = hook(state, s); if (x) { state = x; continue; } }
    const a = E.botAction(state, s);
    state = run(state, { seat: s, a });
  }
  return state;
}
function table() {
  let s = E.newTable();
  s = run(s, { seat: 0, a: { t: 'fillBots' } });
  return s;
}

// 1) Viele Zufallsspiele: Augen = 240, nur eine Seite bekommt Punkte, 10 Stiche
const types = {};
let s = table(); s = run(s, { seat: 0, a: { t: 'start' } });
for (let i = 0; i < 200; i++) {
  s = playOut(s, (st, seat) => {
    // gelegentlich zufällige Ansagen
    const o = E.announceOptions(st.game, seat);
    if (o.length && Math.random() < 0.15) return run(st, { seat, a: { t: 'announce', level: o[Math.floor(Math.random() * o.length)] } });
    // gelegentlich ein Solo ansagen
    if (st.game.phase === 'vorbehalt' && Math.random() < 0.05) return run(st, { seat, a: { t: 'decl', choice: ['solo_trumpf', 'solo_damen', 'solo_buben', 'solo_koenige'][i % 4] } });
    return null;
  });
  const g = s.game, r = g.result;
  assert.strictEqual(g.tricks.length, 10);
  assert.strictEqual(r.eyes.re + r.eyes.contra, 240);
  assert(r.points.every((p) => p >= 0));
  assert(r.payers.every((x) => g.re.includes(x)) || r.payers.every((x) => !g.re.includes(x)));
  assert(r.points.every((p, i) => (r.payers.includes(i) ? p === (r.soloLost ? 3 : 1) * r.value : p === 0)));
  if (r.payers.length) assert(r.payers.every((x) => (r.winner === 're') !== g.re.includes(x)), 'Nur Verlierer zahlen');
  assert(g.hands.every((h) => h.length === 0));
  types[r.label] = (types[r.label] || 0) + 1;
  s = run(s, { seat: 0, a: { t: 'next' } });
}
console.log('Spieltypen in 200 Zufallsspielen:', types);

// 2) Abrechnung nach Hausregel-Tabelle (Punkte bekommen die Verlierer, 5 Cent je Punkt)
function mk(re, extra = {}) {
  return { type: 'normal', re, stille: false, hz: null, bock: 0, ann: { re: 0, contra: 0, hist: [] }, tricks: [], ...extra };
}
function tricksFor(re, ptsRe, ptsCo, nRe = 6) {
  const co = [0, 1, 2, 3].filter((x) => !re.includes(x));
  const t = [];
  const split = (total, n) => { if (!n) return []; const a = Array(n).fill(Math.floor(total / n)); a[0] += total - a.reduce((x, y) => x + y, 0); return a; };
  const cards = [{ seat: 0, card: 'SK0' }, { seat: 1, card: 'SK1' }, { seat: 2, card: 'CK0' }, { seat: 3, card: 'CK1' }];
  split(ptsRe, nRe).forEach((p) => t.push({ cards, winner: re[0], points: p }));
  split(ptsCo, 10 - nRe).forEach((p) => t.push({ cards, winner: co[0], points: p }));
  return t;
}
const EX = [];
function ex(title, g, expectPoints) {
  const r = E.scoreGame(g);
  assert.deepStrictEqual(r.points, expectPoints, title + ': ' + JSON.stringify(r.lines));
  EX.push({ title, r });
  return r;
}
let g, r;
// A Normalspiel: Re gewinnt 151:89 -> gewonnen 1 + keine 90 1 = 2 je Kontra-Spieler
g = mk([0, 2]); g.tricks = tricksFor([0, 2], 151, 89);
ex('A Re gewinnt 151:89', g, [0, 2, 0, 2]);
// B Kontra gewinnt 125:115, Re hatte angesagt -> (gewonnen 1 + gegen die Alten 1) x2 = 4 je Re-Spieler
g = mk([0, 2], { ann: { re: 1, contra: 0, hist: [] } }); g.tricks = tricksFor([0, 2], 115, 125, 5);
ex('B Kontra gewinnt, Re angesagt', g, [4, 0, 4, 0]);
// C 120:120 ohne Ansage -> Kontra gewinnt (gewonnen + gegen die Alten) = 2
g = mk([0, 2]); g.tricks = tricksFor([0, 2], 120, 120, 5);
ex('C 120:120', g, [2, 0, 2, 0]);
// D Re + Kontra + keine 90 (Re), Re 190:50; Doppelkopf Re, Fuchs gefangen Kontra
//   gewonnen 1, keine 90 1, keine 60 1, keine 90 angesagt 1 = 4; Sonderpunkte 1:1 -> 4; x4 = 16
g = mk([0, 2], { ann: { re: 2, contra: 1, hist: [] } }); g.tricks = tricksFor([0, 2], 190, 50, 7);
g.tricks[0] = { cards: [{ seat: 0, card: 'CA0' }, { seat: 1, card: 'CT0' }, { seat: 2, card: 'CA1' }, { seat: 3, card: 'CT1' }], winner: 0, points: 42 };
g.tricks[1] = { cards: [{ seat: 0, card: 'SK0' }, { seat: 1, card: 'SK1' }, { seat: 2, card: 'CK0' }, { seat: 3, card: 'CK1' }], winner: 0, points: g.tricks[1].points + g.tricks[0].points - 42 };
g.tricks[8] = { cards: [{ seat: 0, card: 'DA0' }, { seat: 1, card: 'DT0' }, { seat: 2, card: 'SK1' }, { seat: 3, card: 'CK1' }], winner: 1, points: g.tricks[8].points };
ex('D Re+Kontra, keine 90 angesagt', g, [0, 16, 0, 16]);
// E wie D, aber in der Bockrunde -> 32
g.bock = 1; ex('E wie D mit Bock', g, [0, 32, 0, 32]);
// F Hochzeit gewonnen 130:110 -> gewonnen 1 + Hochzeit 1 = 2
g = mk([0, 1], { type: 'hochzeit', hz: { bride: 0, partner: 1, alone: false, done: true, clar: 1 } }); g.tricks = tricksFor([0, 1], 130, 110);
ex('F Hochzeit gewonnen', g, [0, 0, 2, 2]);
// G Trumpfabgabe verloren 115:125 -> gewonnen 1 + gegen die Alten 1 + Trumpfabgabe verloren 1 = 3 je Re-Spieler
g = mk([1, 3], { type: 'armut', armut: { poor: 3, taker: 1 } }); g.tricks = tricksFor([1, 3], 115, 125, 5);
ex('G Trumpfabgabe verloren', g, [0, 3, 0, 3]);
// H Solo gewonnen 200:40 (keine 60) -> 20 je Gegenspieler
g = mk([0], { type: 'solo_damen', soloist: 0 }); g.tricks = tricksFor([0], 200, 40, 7);
ex('H Damensolo gewonnen, keine 60', g, [0, 20, 20, 20]);
// I Solo gewonnen 171:69 mit Re und keine 90 angesagt -> (12 + 4) x2 = 32 je Gegenspieler
g = mk([0], { type: 'solo_trumpf', soloist: 0, ann: { re: 2, contra: 0, hist: [] } }); g.tricks = tricksFor([0], 171, 69);
ex('I Trumpfsolo, Re + keine 90', g, [0, 32, 32, 32]);
// J Solo verloren 100:140, Kontra angesagt -> 8 x2 = 16, dreifach = 48 für den Solisten
g = mk([2], { type: 'solo_buben', soloist: 2, ann: { re: 0, contra: 1, hist: [] } }); g.tricks = tricksFor([2], 100, 140, 4);
ex('J Bubensolo verloren, Kontra angesagt', g, [0, 0, 48, 0]);
// K Stille Hochzeit verloren 110:130 -> 8, dreifach = 24 für den Solisten
g = mk([3], { stille: true, soloist: 3 }); g.tricks = tricksFor([3], 110, 130, 4);
ex('K Stille Hochzeit verloren', g, [0, 0, 0, 24]);
// M Solo gewonnen 130:110 mit Re UND Kontra -> 8 x4 = 32 je Gegenspieler
g = mk([1], { type: 'solo_koenige', soloist: 1, ann: { re: 1, contra: 1, hist: [] } }); g.tricks = tricksFor([1], 130, 110, 5);
ex('M Königssolo, Re und Kontra', g, [32, 0, 32, 32]);
// N Solo verloren mit Re und Kontra, Solist hat nur 80 -> keine 90 = 12 x4 = 48, dreifach = 144
g = mk([0], { type: 'solo_damen', soloist: 0, ann: { re: 1, contra: 1, hist: [] } }); g.tricks = tricksFor([0], 80, 160, 3);
ex('N Damensolo verloren, Re und Kontra, Solist unter 90', g, [144, 0, 0, 0]);
// L Re gewinnt knapp (1 Punkt), Kontra hat 2 Sonderpunkte -> Nullspiel
g = mk([0, 2]); g.tricks = tricksFor([0, 2], 125, 115);
g.tricks[9] = { cards: [{ seat: 0, card: 'DK0' }, { seat: 1, card: 'DA0' }, { seat: 2, card: 'DK1' }, { seat: 3, card: 'SK1' }], winner: 1, points: g.tricks[9].points };
g.tricks[8] = { cards: [{ seat: 0, card: 'DA1' }, { seat: 1, card: 'SK0' }, { seat: 2, card: 'CK0' }, { seat: 3, card: 'CK1' }], winner: 1, points: g.tricks[8].points };
ex('L Verlierer haben mehr Sonderpunkte -> Nullspiel', g, [0, 0, 0, 0]);
// L2 wie L, aber nur ein Sonderpunkt für Kontra -> 1 - 1 = 0 -> ebenfalls Nullspiel
g.tricks[9] = { cards: [{ seat: 0, card: 'DK0' }, { seat: 1, card: 'SK0' }, { seat: 2, card: 'DK1' }, { seat: 3, card: 'SK1' }], winner: 1, points: g.tricks[9].points };
ex('L2 Sonderpunkte gleichen aus -> Nullspiel', g, [0, 0, 0, 0]);
assert.strictEqual(E.euro(16), (0.8).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
for (const { title, r } of EX) console.log(`${title}: ${r.lines.map((l) => `${l.text} ${l.party === 're' ? 'Re' : 'Ko'} ${l.pts}`).join(', ')} | x${r.annMult} x${r.m} = ${r.value}${r.soloLost ? ' x3' : ''}${r.nullspiel ? ' (Nullspiel)' : ''} | ${r.points.join(' ')}`);

// Sonderpunkte: Doppelkopf, Herz durch, Karlchen
g = mk([0, 2]); g.tricks = tricksFor([0, 2], 130, 110, 5);
g.tricks[0] = { cards: [{ seat: 0, card: 'HA0' }, { seat: 1, card: 'HK0' }, { seat: 2, card: 'HA1' }, { seat: 3, card: 'HK1' }], winner: 0, points: 30 };
g.tricks[1] = { cards: [{ seat: 0, card: 'CA0' }, { seat: 1, card: 'CT0' }, { seat: 2, card: 'CA1' }, { seat: 3, card: 'CT1' }], winner: 0, points: 42 };
g.tricks[9] = { cards: [{ seat: 1, card: 'DK0' }, { seat: 2, card: 'CJ0' }, { seat: 3, card: 'DK1' }, { seat: 0, card: 'SJ0' }], winner: 2, points: 12 };
r = E.scoreGame(g);
const exTexts = r.lines.filter((l) => l.extra).map((l) => l.text);
assert(exTexts.some((t) => t.startsWith('Herz-Stich durch')), exTexts);
assert(exTexts.some((t) => t.startsWith('Doppelkopf')), exTexts);
assert(exTexts.includes('Karlchen gewinnt den letzten Stich'), exTexts);
assert.strictEqual(r.extras.re, 3);
g.tricks[9] = { cards: [{ seat: 1, card: 'HJ0' }, { seat: 2, card: 'CJ0' }, { seat: 3, card: 'CQ0' }, { seat: 0, card: 'SJ0' }], winner: 3, points: 10 };
r = E.scoreGame(g);
assert(r.lines.some((l) => l.text === 'Karlchen gefangen' && l.party === 'contra'));

// 3) Trumpfreihenfolge & Bedienen
const K = E.kindOf('normal');
assert.strictEqual(E.trickWinnerIdx([{ seat: 0, card: 'HT0' }, { seat: 1, card: 'HT1' }, { seat: 2, card: 'CQ0' }, { seat: 3, card: 'DK0' }], K), 0);
assert.strictEqual(E.trickWinnerIdx([{ seat: 0, card: 'HA0' }, { seat: 1, card: 'HK0' }, { seat: 2, card: 'DK0' }, { seat: 3, card: 'HA1' }], K), 2);
assert.deepStrictEqual(E.legalCards(['HA0', 'HT0', 'CA0'], [{ seat: 0, card: 'HK0' }], K), ['HA0']); // Herz 10 ist Trumpf
assert.strictEqual(E.trickWinnerIdx([{ seat: 0, card: 'HT0' }, { seat: 1, card: 'HA0' }, { seat: 2, card: 'HQ0' }, { seat: 3, card: 'HK0' }], 'damen'), 2);
assert.deepStrictEqual(E.legalCards(['HQ0', 'HT0', 'CA0'], [{ seat: 0, card: 'HK0' }], 'damen'), ['HT0']);

// 4) Hochzeit, stille Hochzeit, Trumpfabgabe mit festen Händen
const hands = [
  ['CQ0', 'CQ1', 'HT0', 'SQ0', 'DJ0', 'CA0', 'CT0', 'SA0', 'HA0', 'HK0'],
  ['HT1', 'SQ1', 'HQ0', 'HQ1', 'DQ0', 'CJ0', 'SJ0', 'DA0', 'DT0', 'DK0'],
  ['DQ1', 'CJ1', 'SJ1', 'HJ0', 'HJ1', 'DJ1', 'DA1', 'CA1', 'SA1', 'HA1'],
  ['DT1', 'DK1', 'CT1', 'CK0', 'CK1', 'ST0', 'ST1', 'SK0', 'SK1', 'HK1'],
];
s = table(); s = run(s, { seat: 0, a: { t: 'start', hands } });
// Platz 0 gibt nicht (dealer 3) -> Reihenfolge 0,1,2,3
s = run(s, { seat: 0, a: { t: 'decl', choice: 'gesund' } });
s = run(s, { seat: 1, a: { t: 'decl', choice: 'gesund' } });
s = run(s, { seat: 2, a: { t: 'decl', choice: 'gesund' } });
// Platz 3 hat 2 Trümpfe -> Trumpfabgabe möglich
assert(E.declOptions(s.game, 3).includes('armut'));
s = run(s, { seat: 3, a: { t: 'decl', choice: 'armut' } });
assert.strictEqual(s.game.phase, 'armut_give');
let bad = E.apply(s, 3, { t: 'armutGive', cards: ['DT1', 'CT1', 'CK0'] });
assert(bad.error);
s = run(s, { seat: 3, a: { t: 'armutGive', cards: ['DT1', 'DK1', 'HK1'] } });
s = run(s, { seat: 0, a: { t: 'armutAnswer', accept: false } });
s = run(s, { seat: 1, a: { t: 'armutAnswer', accept: true } });
s = run(s, { seat: 1, a: { t: 'armutReturn', cards: ['HK1', 'DA0', 'DK0'] } });
assert.deepStrictEqual(s.game.re.sort(), [1, 3]);
assert.strictEqual(s.game.hands[3].length, 10); assert.strictEqual(s.game.hands[1].length, 10);
s = playOut(s);
console.log('Trumpfabgabe:', s.game.result.label, s.game.result.points);

// Stille Hochzeit
s = table(); s = run(s, { seat: 0, a: { t: 'start', hands } });
for (const p of [0, 1, 2, 3]) s = run(s, { seat: p, a: { t: 'decl', choice: 'gesund' } });
assert.strictEqual(s.game.stille, true);
assert.strictEqual(E.knownParty(s.game, 1, 0), null); // andere wissen es nicht
s = playOut(s);
assert.strictEqual(s.game.result.label, 'Stille Hochzeit');
{ const pt = s.game.result.points; assert(pt[0] === 0 ? pt[1] === pt[2] && pt[2] === pt[3] && pt[1] > 0 : pt[1] + pt[2] + pt[3] === 0); }
console.log('Stille Hochzeit:', s.game.result.points);

// Hochzeit angesagt
s = table(); s = run(s, { seat: 0, a: { t: 'start', hands } });
s = run(s, { seat: 0, a: { t: 'decl', choice: 'hochzeit' } });
for (const p of [1, 2, 3]) s = run(s, { seat: p, a: { t: 'decl', choice: 'gesund' } });
assert.strictEqual(s.game.type, 'hochzeit');
assert.deepStrictEqual(E.announceOptions(s.game, 1), []);
s = playOut(s);
console.log('Hochzeit:', s.game.result.label, 'Partner', s.game.hz.partner, 'Klärung nach Stich', s.game.hz.clar, s.game.result.points);

// Solo hat Vorrang vor Hochzeit, Solist spielt aus
s = table(); s = run(s, { seat: 0, a: { t: 'start', hands } });
s = run(s, { seat: 0, a: { t: 'decl', choice: 'hochzeit' } });
s = run(s, { seat: 1, a: { t: 'decl', choice: 'gesund' } });
s = run(s, { seat: 2, a: { t: 'decl', choice: 'solo_buben' } });
s = run(s, { seat: 3, a: { t: 'decl', choice: 'gesund' } });
assert.strictEqual(s.game.type, 'solo_buben'); assert.strictEqual(s.game.turn, 0); // normale Reihenfolge

// Hochzeit: fremde Trumpfstiche zählen nicht, nach 3 Stichen ohne fremden Fehlstich -> Solo
function hz() { let x = table(); x = run(x, { seat: 0, a: { t: 'start', hands } }); x = run(x, { seat: 0, a: { t: 'decl', choice: 'hochzeit' } }); for (const p of [1, 2, 3]) x = run(x, { seat: p, a: { t: 'decl', choice: 'gesund' } }); return x; }
const plays = (x, list) => { for (const [seat, card] of list) x = run(x, { seat, a: { t: 'play', card } }); return x; };
s = hz();
s = plays(s, [[0, 'SQ0'], [1, 'HT1'], [2, 'DQ1'], [3, 'DT1']]);
assert.strictEqual(s.game.hz.done, false);
s = plays(s, [[1, 'HQ0'], [2, 'CJ1'], [3, 'DK1'], [0, 'DJ0']]);
s = plays(s, [[1, 'HQ1'], [2, 'SJ1'], [3, 'CT1'], [0, 'CQ0']]);
assert.strictEqual(s.game.hz.done, true); assert.strictEqual(s.game.hz.alone, true); assert.strictEqual(s.game.hz.clar, 3);
assert.deepStrictEqual(s.game.re, [0]);
assert.deepStrictEqual(E.announceOptions(s.game, 1), [1, 2, 3, 4, 5]); // Ansagen direkt nach dem Klärungsstich
s = playOut(s); assert.strictEqual(s.game.result.label, 'Hochzeit (Solo)'); assert.strictEqual(s.game.result.solo, true);
// Erster fremder Fehlstich klärt
s = hz();
s = plays(s, [[0, 'CA0'], [1, 'DK0'], [2, 'CA1'], [3, 'CT1']]);
assert.strictEqual(s.game.hz.partner, 1); assert.strictEqual(s.game.hz.clar, 1); assert.deepStrictEqual(s.game.re, [0, 1]);
assert.deepStrictEqual(E.announceOptions(s.game, 2), [1, 2, 3, 4, 5]);
assert.deepStrictEqual(E.announceOptions(s.game, 0), [1, 2, 3, 4, 5]);

// Schmeißen (Platz 3: höchster Trumpf Karo 10, 6 Könige) – auch außer der Reihe
s = table(); s = run(s, { seat: 0, a: { t: 'start', hands } });
assert.ok(E.declOptions(s.game, 3).includes('schmeissen'));
assert.ok(!E.declOptions(s.game, 0).includes('schmeissen'));
assert.ok(E.apply(s, 0, { t: 'decl', choice: 'schmeissen' }).error);
const dealer = s.game.dealer;
s = run(s, { seat: 3, a: { t: 'decl', choice: 'schmeissen' } });
assert.strictEqual(s.game.phase, 'vorbehalt'); assert.strictEqual(s.game.dealer, dealer); assert.strictEqual(s.games.length, 0);
assert.strictEqual(E.schmeissReason(['DJ0', 'DA0', 'CA0', 'CA1', 'ST0', 'ST1', 'SA0', 'HA0', 'HA1', 'CT0']), 'höchster Trumpf ist der Karo-Bube');
assert.strictEqual(E.schmeissReason(['HJ0', 'DA0', 'CA0', 'CA1', 'ST0', 'ST1', 'SA0', 'HA0', 'HA1', 'CT0']), null);
assert.strictEqual(E.schmeissReason(['CQ0', 'CK0', 'CK1', 'SK0', 'SK1', 'HK0', 'ST1', 'SA0', 'HA1', 'CT0']), '5 Könige');

// Königssolo
assert.strictEqual(E.trickWinnerIdx([{ seat: 0, card: 'SK0' }, { seat: 1, card: 'CK0' }, { seat: 2, card: 'HT0' }, { seat: 3, card: 'DK0' }], 'koenige'), 1);
assert.deepStrictEqual(E.legalCards(['HA0', 'HK0', 'CQ0'], [{ seat: 0, card: 'HT0' }], 'koenige'), ['HA0']);
assert.strictEqual(E.trickWinnerIdx([{ seat: 0, card: 'HQ0' }, { seat: 1, card: 'HA0' }, { seat: 2, card: 'HT0' }, { seat: 3, card: 'HJ0' }], 'koenige'), 1);

// Fuchs im letzten Stich, beide Kreuz-Damen in einem Stich
g = mk([0, 2]); g.tricks = tricksFor([0, 2], 130, 110);
g.tricks[3] = { cards: [{ seat: 0, card: 'CQ0' }, { seat: 1, card: 'SK1' }, { seat: 2, card: 'CQ1' }, { seat: 3, card: 'CK1' }], winner: 0, points: 14 };
g.tricks[9] = { cards: [{ seat: 1, card: 'DK0' }, { seat: 2, card: 'DA0' }, { seat: 3, card: 'DK1' }, { seat: 0, card: 'DT0' }], winner: 2, points: 29 };
r = E.scoreGame(g);
assert(r.lines.some((l) => l.text === 'Fuchs gewinnt den letzten Stich' && l.party === 're'));
assert(r.lines.some((l) => l.text.startsWith('Beide Kreuz-Damen') && l.party === 'contra'));

// Ansage-Fristen
s = table(); s = run(s, { seat: 0, a: { t: 'start', hands } });
for (const p of [0, 1, 2, 3]) s = run(s, { seat: p, a: { t: 'decl', choice: 'gesund' } });
assert.deepStrictEqual(E.announceOptions(s.game, 1), [1, 2, 3, 4, 5]);
// zwei Stiche spielen -> 8 Karten: Kontra nicht mehr (nur mit Erwiderung)
for (let i = 0; i < 8; i++) { const t = s.game.turn; s = run(s, { seat: t, a: E.botAction(s, t) }); }
assert.deepStrictEqual(E.announceOptions(s.game, 1), [2, 3, 4, 5]); for (let i = 0; i < 4; i++) { const t = s.game.turn; s = run(s, { seat: t, a: E.botAction(s, t) }); } assert.deepStrictEqual(E.announceOptions(s.game, 1), [3, 4, 5]);

// Bock
s = table(); s = run(s, { seat: 0, a: { t: 'bock' } }); s = run(s, { seat: 0, a: { t: 'start' } });
assert.strictEqual(s.game.bock, 1);
// Bock: Ein Solo verbraucht kein Bockspiel
s = table(); s = run(s, { seat: 0, a: { t: 'bock' } }); s = run(s, { seat: 0, a: { t: 'start' } });
const bockLeft = (x) => x.bock.filter((b) => b > 0).length;
assert.strictEqual(bockLeft(s), 4);
const finish = (x, solo) => { x = JSON.parse(JSON.stringify(x)); x.game.phase = 'done'; x.game.result = { solo }; x.game.type = solo ? 'solo_damen' : 'normal'; return x; };
s = run(finish(s, false), { seat: 0, a: { t: 'next' } }); assert.strictEqual(bockLeft(s), 3); assert.strictEqual(s.game.bock, 1);
s = run(finish(s, false), { seat: 0, a: { t: 'next' } }); assert.strictEqual(bockLeft(s), 2);
s = run(finish(s, true), { seat: 0, a: { t: 'next' } }); assert.strictEqual(bockLeft(s), 2, 'Solo darf kein Bockspiel verbrauchen'); assert.strictEqual(s.game.bock, 1);
s = run(finish(s, false), { seat: 0, a: { t: 'next' } }); assert.strictEqual(bockLeft(s), 1);
s = run(finish(s, false), { seat: 0, a: { t: 'next' } }); assert.strictEqual(bockLeft(s), 0); assert.strictEqual(s.game.bock, 0);
console.log('Alle Tests bestanden.');
