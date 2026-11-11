// Server-Test ohne Cloudflare: simuliert das Durable Object mit vier Spielern.
// Prüft, dass jeder nur seine eigenen Karten sieht und eine Partie komplett durchläuft.
import assert from 'node:assert';
import E from '../public/engine.js';

globalThis.WebSocketPair = class {};
const { Table } = await import('../src/worker.js');

function mockCtx() {
  const data = new Map();
  const sockets = [];
  return {
    sockets,
    alarmAt: null,
    storage: {
      async get(k) { return data.has(k) ? JSON.parse(data.get(k)) : undefined; },
      async put(k, v) { data.set(k, JSON.stringify(v)); },
      async setAlarm(t) { this.owner.alarmAt = t; },
    },
    getWebSockets() { return sockets.slice(); },
    acceptWebSocket(ws) { sockets.push(ws); },
    async blockConcurrencyWhile(fn) { await fn(); },
  };
}
function mockSocket(ctx) {
  let att = null;
  const ws = {
    inbox: [],
    send(m) { ws.inbox.push(JSON.parse(m)); },
    serializeAttachment(a) { att = JSON.parse(JSON.stringify(a)); },
    deserializeAttachment() { return att; },
    close() { const i = ctx.sockets.indexOf(ws); if (i >= 0) ctx.sockets.splice(i, 1); },
    last() { return [...ws.inbox].reverse().find((m) => m.t === 'state'); },
    lastError() { return [...ws.inbox].reverse().find((m) => m.t === 'error'); },
  };
  ctx.acceptWebSocket(ws);
  ws.serializeAttachment({ uid: null });
  return ws;
}

async function setup(env = {}) {
  const ctx = mockCtx(); ctx.storage.owner = ctx;
  const t = new Table(ctx, env);
  await new Promise((r) => setTimeout(r, 0));
  return { ctx, t };
}
const uids = ['AAAAAAAAAAAAAAAAAAAA0', 'BBBBBBBBBBBBBBBBBBBB1', 'CCCCCCCCCCCCCCCCCCCC2', 'DDDDDDDDDDDDDDDDDDDD3'];

// 1) Passwort
{
  const { ctx, t } = await setup({ TABLE_PASSWORD: 'karo' });
  const ws = mockSocket(ctx);
  await t.webSocketMessage(ws, JSON.stringify({ t: 'hello', uid: uids[0], password: 'falsch' }));
  assert.strictEqual(ws.lastError().code, 'password');
  await t.webSocketMessage(ws, JSON.stringify({ t: 'act', a: { t: 'sit', seat: 0, name: 'X' } }));
  assert.strictEqual(ws.lastError().code, 'hello');
  await t.webSocketMessage(ws, JSON.stringify({ t: 'hello', uid: uids[0], password: 'karo' }));
  assert.ok(ws.last());
}

// 2) Vier Menschen, komplette Partie
const { ctx, t } = await setup();
const socks = uids.map(() => mockSocket(ctx));
for (let i = 0; i < 4; i++) await t.webSocketMessage(socks[i], JSON.stringify({ t: 'hello', uid: uids[i] }));
for (let i = 0; i < 4; i++) await t.webSocketMessage(socks[i], JSON.stringify({ t: 'act', a: { t: 'sit', seat: i, name: 'Spieler ' + (i + 1), uid: uids[0] } }));
assert.deepStrictEqual(socks[2].last().view.seats.map((s) => s.mine), [false, false, true, false]);
// Fremden Platz kann man nicht räumen, man sitzt nicht doppelt
await t.webSocketMessage(socks[1], JSON.stringify({ t: 'act', a: { t: 'leave', seat: 0 } }));
assert.ok(socks[1].lastError());
await t.webSocketMessage(socks[0], JSON.stringify({ t: 'act', a: { t: 'start' } }));
assert.ok(socks[0].lastError(), 'ohne Pflichtsoli-Angabe kein Start');
await t.webSocketMessage(socks[1], JSON.stringify({ t: 'act', a: { t: 'pflicht', n: 1 } }));
await t.webSocketMessage(socks[0], JSON.stringify({ t: 'act', a: { t: 'start', hands: [['CQ0']] } }));
assert.strictEqual(t.state.game.hands[0].length, 10, 'Client darf keine Karten vorgeben');

function checkLeaks() {
  for (let i = 0; i < 4; i++) {
    const v = socks[i].last().view;
    const json = JSON.stringify(v);
    for (const u of uids) assert.ok(!json.includes(u), 'Spieler-Kennungen dürfen nicht verschickt werden');
    const g = v.game; if (!g) continue;
    assert.deepStrictEqual(g.hands[i], t.state.game.hands[i]);
    for (let q = 0; q < 4; q++) if (q !== i) assert.ok(g.hands[q].every((c) => c === 'XX'), 'fremde Hand sichtbar');
    if (g.phase !== 'done') assert.deepStrictEqual(g.re, []);
    assert.ok(!('initial' in g));
  }
}
checkLeaks();
let guard = 0;
while (t.state.game.phase !== 'done') {
  if (++guard > 200) throw new Error('Endlosschleife');
  const g = t.state.game, s = g.turn, v = socks[s].last().view;
  let a;
  if (v.game.phase === 'vorbehalt') a = { t: 'decl', choice: 'gesund' };
  else a = { t: 'play', card: E.legalCards(v.game.hands[s], v.game.current, E.kindOf(v.game.type))[0] };
  // ein anderer Spieler versucht vorzudrängeln
  await t.webSocketMessage(socks[(s + 1) % 4], JSON.stringify({ t: 'act', a }));
  assert.ok(socks[(s + 1) % 4].lastError());
  await t.webSocketMessage(socks[s], JSON.stringify({ t: 'act', a }));
  checkLeaks();
}
const done = socks[0].last().view.game;
assert.strictEqual(done.result.eyes.re + done.result.eyes.contra, 240);
assert.ok(done.re.length >= 1);
console.log('Partie mit 4 Spielern:', done.result.label, done.result.points);

// 3) Offline-Spieler durch Bot ersetzen, Bots spielen per Alarm
await t.webSocketMessage(socks[0], JSON.stringify({ t: 'act', a: { t: 'next' } }));
socks[3].close(); await t.webSocketClose(socks[3], 1000);
assert.strictEqual(socks[0].last().view.seats[3].online, false);
await t.webSocketMessage(socks[0], JSON.stringify({ t: 'act', a: { t: 'kick', seat: 1 } }));
assert.ok(socks[0].lastError(), 'Verbundene Spieler darf man nicht ersetzen');
await t.webSocketMessage(socks[0], JSON.stringify({ t: 'act', a: { t: 'kick', seat: 3 } }));
assert.strictEqual(t.state.seats[3].bot, true);
guard = 0;
while (t.state.game.phase !== 'done') {
  if (++guard > 300) throw new Error('Endlosschleife (Bots)');
  const g = t.state.game, s = g.turn;
  if (t.state.seats[s].bot) { assert.ok(ctx.alarmAt, 'Alarm für Bot fehlt'); ctx.alarmAt = null; await t.alarm(); continue; }
  const v = socks[s].last().view;
  const a = v.game.phase === 'vorbehalt' ? { t: 'decl', choice: 'gesund' }
    : v.game.phase === 'armut_answer' ? { t: 'armutAnswer', accept: false }
    : v.game.phase === 'armut_give' ? { t: 'armutGive', cards: [...v.game.hands[s].filter((c) => E.isTrump(c, 'normal')), ...v.game.hands[s].filter((c) => !E.isTrump(c, 'normal'))].slice(0, 3) }
    : v.game.phase === 'armut_return' ? { t: 'armutReturn', cards: v.game.hands[s].slice(0, 3) }
    : { t: 'play', card: E.legalCards(v.game.hands[s], v.game.current, E.kindOf(v.game.type))[0] };
  await t.webSocketMessage(socks[s], JSON.stringify({ t: 'act', a }));
  if (socks[s].inbox[socks[s].inbox.length - 1].t === 'error') throw new Error(socks[s].lastError().message + ' ' + JSON.stringify({ srv: t.state.game.phase, view: v.game.phase, turn: t.state.game.turn, s, a, rev: [t.state.rev, v.rev] }));
}
console.log('Partie mit Bot:', t.state.game.result.label, t.state.game.result.points);

// 3b) Neuer Spieler übernimmt direkt den Platz eines abwesenden Mitspielers
{
  await t.webSocketMessage(socks[0], JSON.stringify({ t: 'act', a: { t: 'next' } }));
  const neu = mockSocket(ctx); const NEU = 'NEUERSPIELER00000000X';
  await t.webSocketMessage(neu, JSON.stringify({ t: 'hello', uid: NEU }));
  await t.webSocketMessage(neu, JSON.stringify({ t: 'act', a: { t: 'takeover', seat: 1, name: 'Neu' } }));
  assert.ok(neu.lastError(), 'verbundene Spieler kann man nicht verdrängen');
  socks[1].close(); await t.webSocketClose(socks[1], 1000);
  const pointsBefore = JSON.stringify(t.state.games);
  const handBefore = t.state.game.hands[1].slice();
  await t.webSocketMessage(neu, JSON.stringify({ t: 'act', a: { t: 'takeover', seat: 1, name: 'Neu' } }));
  assert.strictEqual(t.state.seats[1].name, 'Neu'); assert.strictEqual(t.state.seats[1].uid, NEU); assert.ok(!t.state.seats[1].bot);
  assert.deepStrictEqual(neu.last().view.game.hands[1], handBefore, 'der Neue bekommt die Karten des Platzes');
  assert.strictEqual(JSON.stringify(t.state.games), pointsBefore, 'Spielzettel bleibt unverändert');
  assert.ok(t.state.log.some((l) => l === 'Neu spielt für Spieler 2 weiter.'));
  console.log('Platz übernommen: ok');
}
// 4) Spielstand übersteht den Neustart des Durable Objects
const t2 = new Table(ctx, {}); await new Promise((r) => setTimeout(r, 0));
assert.strictEqual(t2.state.games.length, 2);
console.log('Server-Tests bestanden.');
