/* Ratgeber: bewertet das eigene Blatt vor dem Spiel (Normalspiel, Hochzeit, Soli, Absagen, Reizgrenze).
 * Läuft nur im Browser und kennt nur die eigenen Karten – genau das, was der Spieler selbst sieht.
 * Methode: Die 30 unbekannten Karten werden vielfach zufällig verteilt und jedes Spiel wird mit einfachen,
 * festen Spielregeln für alle vier Plätze komplett durchgespielt. Abgerechnet wird nach den Hausregeln.
 * Nicht berücksichtigt: Re/Kontra-Ansagen und Sonderpunkte (Fuchs, Karlchen, Doppelkopf).
 */

// ---------- Kartenkodierung: k = Farbe*5 + Rang (Farbe C S H D, Rang A T K Q J) ----------
const SUITS = 'CSHD', RANKS = 'ATKQJ';
const VAL = [11, 10, 4, 3, 2];
const val = (k) => VAL[k % 5];
const suitOf = (k) => (k / 5) | 0;
const kindKey = (c) => SUITS.indexOf(c[0]) * 5 + RANKS.indexOf(c[1]);

// Trumpfreihenfolge, höchster zuerst (wie TRUMPS in engine.js)
const TRUMP_LISTS = {
  normal: [11, 3, 8, 13, 18, 4, 9, 14, 19, 15, 16, 17], // H10, Damen, Buben, Karo A 10 K
  damen: [3, 8, 13, 18],
  buben: [4, 9, 14, 19],
  koenige: [2, 7, 12, 17],
};
const MODE = {};
for (const name in TRUMP_LISTS) {
  const list = TRUMP_LISTS[name];
  const tr = new Int8Array(20).fill(-1), eff = new Int8Array(20), str = new Int16Array(20), pw = new Float32Array(20);
  list.forEach((k, i) => (tr[k] = list.length - 1 - i));
  for (let k = 0; k < 20; k++) {
    eff[k] = tr[k] >= 0 ? 4 : suitOf(k);               // 4 = Trumpf, sonst Fehlfarbe
    str[k] = tr[k] >= 0 ? 100 + tr[k] : VAL[k % 5];    // Stärke im Stich (Fehl: A > 10 > K > D > B)
    pw[k] = tr[k] >= 0 ? ((tr[k] + 1) * 12) / list.length : 0; // Wert als Trumpf beim Abwerfen
  }
  MODE[name] = { name, list, tr, eff, str, pw };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Ein komplettes Spiel durchspielen ----------
// hc: 4 × Int8Array(20) Kartenanzahl je Platz (Platz 0 spielt aus); team[p] 0/1; solo: Team 0 ist ein Solist
function playGame(hc, m, team, solo) {
  const rem = new Int8Array(20).fill(2);
  const augen = [0, 0], tricks = [0, 0];
  let leader = 0;
  for (let t = 0; t < 10; t++) {
    let leadEff = -1, wStr = -1, wP = -1, pts = 0;
    for (let i = 0; i < 4; i++) {
      const p = (leader + i) % 4;
      const k = i === 0 ? lead(p, hc[p], rem, m, team, solo) : follow(p, i, leadEff, wStr, wP, pts, hc[p], rem, m, team);
      hc[p][k]--; rem[k]--;
      if (i === 0) { leadEff = m.eff[k]; wStr = m.str[k]; wP = p; }
      else {
        const s = m.eff[k] === 4 || m.eff[k] === leadEff ? m.str[k] : -1;
        if (s > wStr) { wStr = s; wP = p; } // gleiche Karten: die erste gewinnt
      }
      pts += val(k);
    }
    augen[team[wP]] += pts; tricks[team[wP]]++;
    leader = wP;
  }
  return { augen, tricks };
}

function follow(p, i, leadEff, wStr, wP, pts, h, rem, m, team) {
  const { eff, str, pw } = m;
  let canFollow = false;
  for (let k = 0; k < 20; k++) if (h[k] && eff[k] === leadEff) { canFollow = true; break; }
  const legal = [];
  for (let k = 0; k < 20; k++) if (h[k] && (!canFollow || eff[k] === leadEff)) legal.push(k);
  if (legal.length === 1) return legal[0];
  const sIn = (k) => (eff[k] === 4 || eff[k] === leadEff ? str[k] : -1);
  const myT = team[p];
  let laterOpp = 0;
  for (let j = i + 1; j < 4; j++) if (team[(p + (j - i)) % 4] !== myT) laterOpp++;
  let outSuit = 0;
  if (leadEff !== 4) for (let k = 0; k < 20; k++) if (eff[k] === leadEff) outSuit += rem[k] - h[k];
  const trumpThreat = leadEff === 4 || outSuit < laterOpp * 2;
  // Kann ein späterer Gegner diese Stärke noch schlagen?
  const threatened = (sv) => {
    if (!laterOpp) return false;
    for (let k = 0; k < 20; k++) {
      if (rem[k] - h[k] <= 0) continue;
      if (eff[k] === 4) { if (trumpThreat && str[k] > sv) return true; }
      else if (eff[k] === leadEff && str[k] > sv) return true;
    }
    return false;
  };
  const argBest = (arr, f) => { let b = arr[0], bv = -1e9; for (const k of arr) { const v = f(k); if (v > bv) { bv = v; b = k; } } return b; };
  const smear = (k) => val(k) - 2 * pw[k];
  const dump = (k) => -(val(k) + 2 * pw[k]) - 0.01 * str[k];
  const W = legal.filter((k) => sIn(k) > wStr);
  if (team[wP] === myT) {
    if (!threatened(wStr)) return argBest(legal, smear);           // Partner sicher vorn: schmieren
    const masters = W.filter((k) => !threatened(sIn(k)));
    if (masters.length && pts >= 15) return argBest(masters, (k) => -str[k]);
    return argBest(legal, dump);
  }
  if (W.length) {
    if (!laterOpp) return argBest(W, smear);                       // als Letzter: mit Augen gewinnen
    const masters = W.filter((k) => !threatened(sIn(k)));
    if (masters.length) return argBest(masters, (k) => smear(k) - 0.01 * str[k]);
    if (pts >= 10) return argBest(W, (k) => sIn(k));
  }
  return argBest(legal, dump);
}

function lead(p, h, rem, m, team, solo) {
  const { eff, str } = m;
  let myTrumps = 0, outTrumps = 0, maxOut = -1, best = -1, low = -1;
  for (let k = 0; k < 20; k++) {
    if (eff[k] !== 4) continue;
    const o = rem[k] - h[k];
    if (o > 0) { outTrumps += o; if (str[k] > maxOut) maxOut = str[k]; }
    if (h[k]) {
      myTrumps += h[k];
      if (best < 0 || str[k] > str[best]) best = k;
      if (low < 0 || str[k] < str[low]) low = k;
    }
  }
  const declarer = team[p] === 0;
  if (myTrumps > 0 && outTrumps > 0 && (solo ? declarer : myTrumps >= 6)) return str[best] >= maxOut ? best : low; // Trumpf ziehen
  let pick = -1, pickV = -1;
  const suitLen = [0, 0, 0, 0], outSuit = [0, 0, 0, 0];
  for (let k = 0; k < 20; k++) if (eff[k] < 4) { suitLen[eff[k]] += h[k]; outSuit[eff[k]] += rem[k] - h[k]; }
  for (let k = 0; k < 20; k++) { // höchste noch ausstehende Fehlkarte (z. B. Ass) abholen
    if (!h[k] || eff[k] === 4) continue;
    let master = true;
    for (let j = 0; j < 20; j++) if (eff[j] === eff[k] && str[j] > str[k] && rem[j] - h[j] > 0) { master = false; break; }
    if (!master) continue;
    const v = val(k) + (outSuit[eff[k]] >= 3 ? 20 : 0);
    if (v > pickV) { pickV = v; pick = k; }
  }
  if (pick >= 0 && (pickV >= 20 || !solo || declarer)) return pick;
  let bs = -1; // sonst kleine Karte der längsten Fehlfarbe
  for (let s = 0; s < 4; s++) if (suitLen[s] && (bs < 0 || suitLen[s] > suitLen[bs])) bs = s;
  if (bs >= 0) {
    let c = -1;
    for (let k = 0; k < 20; k++) if (h[k] && eff[k] === bs && (c < 0 || str[k] < str[c])) c = k;
    return c;
  }
  return pick >= 0 ? pick : low;
}

// n Spiele simulieren. pos = Platz in der Ausspielreihenfolge (0 = kommt raus, 3 = Geber).
// kind: 'solo' | 'hochzeit' | 'normal'
function simulate(myCounts, pos, modeName, n, rng, kind) {
  const m = MODE[modeName];
  const res = { mine: new Int16Array(n), myTricks: new Int8Array(n), roles: new Int8Array(n) };
  const pool = [];
  for (let k = 0; k < 20; k++) for (let c = myCounts[k]; c < 2; c++) pool.push(k);
  const hc = [0, 1, 2, 3].map(() => new Int8Array(20));
  for (let s = 0; s < n; s++) {
    for (let i = pool.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    hc.forEach((x) => x.fill(0));
    hc[pos].set(myCounts);
    let idx = 0;
    for (let p = 0; p < 4; p++) if (p !== pos) for (let c = 0; c < 10; c++) hc[p][pool[idx++]]++;
    const team = [1, 1, 1, 1];
    let solo = false;
    if (kind === 'solo') { team[pos] = 0; solo = true; }
    else if (kind === 'hochzeit') {
      team[pos] = 0;
      const others = [0, 1, 2, 3].filter((p) => p !== pos);
      team[others[(rng() * 3) | 0]] = 0; // Partner: der erste fremde Fehlstich – hier vereinfacht zufällig
    } else {
      const holders = []; // Re = Kreuz-Damen
      for (let p = 0; p < 4; p++) for (let c = 0; c < hc[p][3]; c++) holders.push(p);
      team[holders[0]] = 0;
      if (holders[0] === holders[1]) { const o = [0, 1, 2, 3].filter((p) => p !== holders[0]); team[o[(rng() * 3) | 0]] = 0; }
      else team[holders[1]] = 0;
    }
    const r = playGame(hc, m, team, solo);
    res.mine[s] = r.augen[team[pos]];
    res.myTricks[s] = r.tricks[team[pos]];
    res.roles[s] = team[pos] === 0 ? 0 : 1;
  }
  return res;
}

// ---------- Abrechnung nach Hausregeln ----------
// L = Absage des Solisten beim Reizen: 0 keine, 1 keine 90, 2 keine 60, 3 keine 30, 4 schwarz
function scoreSolo(solAugen, solTricks, L) {
  const ach = (solAugen >= 151) + (solAugen >= 181) + (solAugen >= 211) + (solTricks === 10);
  const win = L === 0 ? solAugen >= 121 : ach >= L;
  if (win) return { win: true, me: 0, others: 8 + 4 * ach + 4 * L };
  const b = (solAugen < 90) + (solAugen < 60) + (solAugen < 30) + (solTricks === 0);
  return { win: false, me: (8 + 4 + 4 * b + 4 * L) * 3, others: 0 }; // gegen die Alten +4, alles dreifach
}
function scoreNormal(winnerAugen, loserTricks, kontraWon) {
  const loser = 240 - winnerAugen;
  return 1 + (kontraWon ? 1 : 0) + (loser < 90) + (loser < 60) + (loser < 30) + (loserTricks === 0);
}
// Vorteil = Ø Punkte jedes anderen Spielers − deine Punkte (positiv ist gut für dich)
function evalSolo(sim, L, bock) {
  let w = 0, adv = 0;
  const n = sim.mine.length;
  for (let i = 0; i < n; i++) { const r = scoreSolo(sim.mine[i], sim.myTricks[i], L); if (r.win) w++; adv += r.others - r.me; }
  return { win: w / n, vorteil: (adv / n) * (bock ? 2 : 1) };
}
function evalNormal(sim, bock) {
  let w = 0, adv = 0;
  const n = sim.mine.length;
  for (let i = 0; i < n; i++) {
    const a = sim.mine[i], tr = sim.myTricks[i], amRe = sim.roles[i] === 0;
    const reWin = (amRe ? a : 240 - a) >= 121;
    const won = amRe ? reWin : !reWin;
    const V = scoreNormal(won ? a : 240 - a, won ? 10 - tr : tr, !reWin);
    if (won) w++;
    adv += won ? (2 * V) / 3 : V / 3 - V;
  }
  return { win: w / n, vorteil: (adv / n) * (bock ? 2 : 1) };
}

// ---------- Blattwert fürs Normalspiel (Punktwertung, als Perzentil gegen Zufallsblätter) ----------
const TW = { 11: 3.0, 3: 2.6, 8: 2.3, 13: 2.0, 18: 1.8, 4: 1.5, 9: 1.4, 14: 1.3, 19: 1.2, 15: 1.0, 16: 0.9, 17: 0.8 };
function blattwert(c) {
  let s = 0, trumps = 0;
  for (const k in TW) { s += TW[k] * c[k]; trumps += c[k]; }
  [[0, 1, 2], [5, 6, 7], [10, 12]].forEach((ks, si) => { // Kreuz A 10 K, Pik A 10 K, Herz A K
    const len = ks.reduce((a, k) => a + c[k], 0), aces = c[ks[0]];
    if (si < 2) { if (aces >= 1) s += len <= 3 ? 2.0 : 1.2; if (aces === 2) s += 1.0; if (!aces && c[ks[1]]) s -= 0.3; }
    else { if (aces >= 1) s += len <= 2 ? 1.6 : 0.8; if (aces === 2) s += 0.5; }
    if (len === 0 && trumps >= 5) s += 0.8;
  });
  return s;
}
let refScores = null;
function percentile(score) {
  if (!refScores) {
    const rng = mulberry32(12345), arr = new Float32Array(20000), pool = [], c = new Int8Array(20);
    for (let k = 0; k < 20; k++) pool.push(k, k);
    for (let n = 0; n < arr.length; n++) {
      for (let i = 0; i < 10; i++) { const j = i + Math.floor(rng() * (40 - i)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
      c.fill(0); for (let i = 0; i < 10; i++) c[pool[i]]++;
      arr[n] = blattwert(c);
    }
    refScores = arr.sort();
  }
  let lo = 0, hi = refScores.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (refScores[mid] < score) lo = mid + 1; else hi = mid; }
  return lo / refScores.length;
}

// ---------- Öffentliche Schnittstelle ----------
export const SOLO_TYPES = [
  { type: 'solo_trumpf', mode: 'normal', name: 'Trumpfsolo' },
  { type: 'solo_damen', mode: 'damen', name: 'Damensolo' },
  { type: 'solo_buben', mode: 'buben', name: 'Bubensolo' },
  { type: 'solo_koenige', mode: 'koenige', name: 'Königssolo' },
];
export const ABSAGE = ['ohne Absage', 'keine 90', 'keine 60', 'keine 30', 'schwarz'];
export const SIMS = 2000;

function countsOf(hand) { const c = new Int8Array(20); for (const card of hand) c[kindKey(card)]++; return c; }
function seedOf(c, pos) { let h = 2166136261; for (let k = 0; k < 20; k++) { h ^= c[k] + 1; h = Math.imul(h, 16777619); } return Math.imul(h ^ pos, 2654435761); }

// Alle Simulationen für ein Blatt (synchron). Für Tests und für runAsync.
export function simulateAll(hand, pos, n = SIMS) {
  const c = countsOf(hand), rng = mulberry32(seedOf(c, pos));
  const out = { hoch: c[3] === 2, sims: {} };
  out.sims.normal = simulate(c, pos, 'normal', n, rng, out.hoch ? 'hochzeit' : 'normal');
  for (const s of SOLO_TYPES) out.sims[s.type] = simulate(c, pos, s.mode, n, rng, 'solo');
  return out;
}

// Dasselbe in kleinen Häppchen, damit die Seite flüssig bleibt. Gibt eine Abbruch-Funktion zurück.
export function runAsync(hand, pos, onDone, onProgress, n = SIMS) {
  const c = countsOf(hand), rng = mulberry32(seedOf(c, pos));
  const hoch = c[3] === 2;
  const jobs = [{ key: 'normal', mode: 'normal', kind: hoch ? 'hochzeit' : 'normal' }]
    .concat(SOLO_TYPES.map((s) => ({ key: s.type, mode: s.mode, kind: 'solo' })));
  const CHUNK = 250, parts = {};
  jobs.forEach((j) => (parts[j.key] = []));
  let ji = 0, done = 0, cancelled = false;
  function step() {
    if (cancelled) return;
    const t0 = Date.now();
    while (ji < jobs.length && Date.now() - t0 < 25) {
      const j = jobs[ji];
      parts[j.key].push(simulate(c, pos, j.mode, CHUNK, rng, j.kind));
      done += CHUNK;
      if (parts[j.key].length * CHUNK >= n) ji++;
    }
    if (ji < jobs.length) { if (onProgress) onProgress(done / (jobs.length * n)); setTimeout(step, 0); return; }
    const sims = {};
    for (const key in parts) {
      const ps = parts[key], len = ps.length * CHUNK;
      const o = { mine: new Int16Array(len), myTricks: new Int8Array(len), roles: new Int8Array(len) };
      ps.forEach((p, i) => { o.mine.set(p.mine, i * CHUNK); o.myTricks.set(p.myTricks, i * CHUNK); o.roles.set(p.roles, i * CHUNK); });
      sims[key] = o;
    }
    onDone({ hoch, sims });
  }
  setTimeout(step, 0);
  return () => { cancelled = true; };
}

// Auswertung. opts: { bock, pflichtOffen (Zahl), schmeissen (Grund oder null), armut (bool) }
export function summarize(hand, raw, opts = {}) {
  const c = countsOf(hand);
  const T = MODE.normal;
  let trumps = 0;
  for (let k = 0; k < 20; k++) if (T.tr[k] >= 0) trumps += c[k];
  const alte = c[3], dullen = c[11], kings = c[2] + c[7] + c[12] + c[17], damen = c[3] + c[8] + c[13] + c[18];
  const fehlAsse = c[0] + c[5] + c[10], fehlLen = [c[0] + c[1] + c[2], c[5] + c[6] + c[7], c[10] + c[12]];
  const bock = !!opts.bock;

  // Blattwert
  const pct = percentile(blattwert(c));
  const word = pct >= 0.85 ? 'sehr stark' : pct >= 0.65 ? 'gut' : pct >= 0.4 ? 'durchschnittlich' : pct >= 0.2 ? 'schwach' : 'sehr schwach';
  const factors = [];
  factors.push([trumps >= 7 ? '+' : trumps <= 4 ? '−' : '·', `${trumps} Trümpfe (Durchschnitt 6)`]);
  if (dullen) factors.push(['+', dullen === 2 ? 'beide Dullen' : 'eine Dulle']);
  if (alte === 2) factors.push(['+', 'beide Alten']);
  if (damen >= 3) factors.push(['+', `${damen} Damen`]);
  if (fehlAsse) factors.push(['+', `${fehlAsse} Fehl-${fehlAsse === 1 ? 'Ass' : 'Asse'}`]);
  ['Kreuz', 'Pik', 'Herz'].forEach((n, i) => { if (!fehlLen[i] && trumps >= 5) factors.push(['+', `${n} frei`]); });
  if (c[1] && !c[0]) factors.push(['−', 'Kreuz-10 ohne Ass']);
  if (c[6] && !c[5]) factors.push(['−', 'Pik-10 ohne Ass']);

  // Spielarten
  const normal = evalNormal(raw.sims.normal, bock);
  const solos = SOLO_TYPES.map((s) => {
    const evals = [0, 1, 2, 3, 4].map((L) => evalSolo(raw.sims[s.type], L, bock));
    let best = 0; evals.forEach((e, i) => { if (e.vorteil > evals[best].vorteil) best = i; });
    let limit = -1; evals.forEach((e, i) => { if (e.vorteil > normal.vorteil) limit = i; }); // höchste Absage, die das Normalspiel noch schlägt
    let tr = 0; for (let k = 0; k < 20; k++) if (MODE[s.mode].tr[k] >= 0) tr += c[k];
    return { ...s, evals, best, limit, trumps: tr };
  });
  const top = solos.slice().sort((a, b) => b.evals[b.best].vorteil - a.evals[a.best].vorteil)[0];
  const te = top.evals[top.best];

  // Empfehlung
  const pct0 = (x) => Math.round(x * 100) + ' %';
  const notes = [];
  let rec;
  const party = raw.hoch ? 'Re (Hochzeit)' : alte ? 'Re' : 'Kontra';
  if (te.vorteil > normal.vorteil + 0.5 && te.win >= 0.5) {
    rec = { kind: 'solo', type: top.type, level: top.best, title: `${top.name} ansagen`,
      text: `Gewinnchance ${pct0(te.win)}${top.best ? ` mit „${ABSAGE[top.best]}“` : ''}.` };
    if (top.best > 0) notes.push(`Ohne Absage gewinnst du zu ${pct0(top.evals[0].win)}. Die Absage „${ABSAGE[top.best]}“ bringt im Schnitt mehr Punkte – du kannst sie beim Reizen nutzen oder später ansagen.`);
    notes.push(top.limit >= 1 ? `Beim Reizen mitgehen bis „${ABSAGE[top.limit]}“, darüber passen.` : 'Beim Reizen nicht erhöhen: wirst du überboten, passen.');
  } else if (opts.schmeissen && normal.vorteil < 0 && te.vorteil < 0) {
    rec = { kind: 'schmeissen', title: 'Schmeißen', text: `Erlaubt, weil ${opts.schmeissen}. Das Spiel zählt dann nicht.` };
  } else {
    rec = { kind: raw.hoch ? 'hochzeit' : 'normal', title: raw.hoch ? 'Hochzeit ansagen' : 'Gesund – normal spielen',
      text: `Du spielst ${party}, Gewinnchance ${pct0(normal.win)}. Bestes Solo: ${top.name} mit ${pct0(top.evals[0].win)}.` };
    if (normal.win >= 0.7) notes.push(raw.hoch ? 'Starkes Blatt: Re nach dem Klärungsstich ansagen.' : `Starkes Blatt: ${alte ? 'Re' : 'Kontra'} früh ansagen.`);
    else if (normal.win >= 0.58) notes.push(`${alte ? 'Re' : 'Kontra'}-Ansage nach dem ersten Stich entscheiden.`);
    if (opts.armut) notes.push(`Mit ${trumps} ${trumps === 1 ? 'Trumpf' : 'Trümpfen'} ist eine Trumpfabgabe erlaubt – sinnvoll bei starken Fehl-Assen.`);
    if (opts.schmeissen) notes.push(`Schmeißen wäre erlaubt (${opts.schmeissen}).`);
  }
  if (raw.hoch) {
    const st = solos[0].evals[0];
    notes.push(`Stille Hochzeit („gesund“ sagen): wie ein Trumpfsolo, Gewinnchance ${pct0(st.win)}${st.vorteil > normal.vorteil ? ' – lohnt sich' : ' – lohnt sich nicht'}.`);
  }
  if (opts.pflichtOffen > 0 && rec.kind !== 'solo') {
    const p = solos.filter((s) => s.evals[0].win >= 0.6).sort((a, b) => b.evals[0].win - a.evals[0].win)[0];
    if (p) notes.push(`Du hast noch ${opts.pflichtOffen} Pflichtsolo${opts.pflichtOffen > 1 ? 's' : ''} offen. ${p.name} gewinnst du zu ${pct0(p.evals[0].win)} – eine gute Gelegenheit, ein fehlendes Solo kostet am Ende 100 Punkte.`);
  }
  if (bock) notes.push('Bockspiel: alle Punkte zählen doppelt.');

  return { rating: { pct, word, factors }, normal: { ...normal, party }, solos, rec, notes, trumps };
}

// Reizen: Lohnt die nötige Absage für dieses Solo?
export function reizAdvice(summary, type, minLevel) {
  const s = summary.solos.find((x) => x.type === type);
  if (!s || !minLevel) return null;
  const e = s.evals[minLevel];
  return { ok: s.limit >= minLevel, win: e.win, vorteil: e.vorteil, limit: s.limit, name: s.name };
}

export const _internal = { blattwert, percentile, scoreSolo, scoreNormal, countsOf };
