/**
 * Doko-Stammtisch – Server für Cloudflare Workers.
 *
 * - Die Spielseite (Ordner public/) liefert Cloudflare direkt als statische Dateien aus.
 * - Jeder Tisch ist ein eigenes Durable Object („Table“). Es hält den kompletten Spielstand,
 *   prüft jede Aktion mit derselben Regel-Engine wie die Seite und schickt jedem Spieler
 *   nur das, was er sehen darf (seine eigene Hand, sein Wissen über die Parteien).
 * - Verbindung per WebSocket mit „Hibernation“: Wenn niemand spielt, schläft der Tisch
 *   und verbraucht nichts. Der Spielstand bleibt gespeichert.
 * - Bots spielen über einen Alarm des Durable Objects, auch wenn gerade niemand klickt.
 * - Tisch-Chat: die letzten Nachrichten liegen mit im Speicher des Tisches.
 * - Anwesenheit: Jeder sieht, wer gerade verbunden ist, auch wer nur zuschaut.
 *
 * Optional: Tisch-Passwort als Secret setzen:  npx wrangler secret put TABLE_PASSWORD
 */
import E from '../public/engine.js';

const TABLE_PATH = /^\/api\/tisch\/([A-Za-z0-9_-]{1,40})$/;
const UID = /^[A-Za-z0-9_-]{16,64}$/;
const CHAT_KEEP = 80;       // so viele Nachrichten bleiben gespeichert
const CHAT_MAX_LEN = 300;   // Zeichen pro Nachricht
const CHAT_GAP_MS = 600;    // Mindestabstand zwischen zwei Nachrichten eines Spielers
const cleanName = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20) : '');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(TABLE_PATH);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Dieser Pfad erwartet eine WebSocket-Verbindung.', { status: 426 });
      const id = env.TABLES.idFromName(m[1].toLowerCase());
      // Tisch in Westeuropa anlegen (kurze Wege für Spieler in Deutschland)
      return env.TABLES.get(id, { locationHint: 'weur' }).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class Table {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    this.chat = [];
    // Ping/Pong beantwortet Cloudflare selbst, ohne den schlafenden Tisch aufzuwecken
    if (typeof WebSocketRequestResponsePair !== 'undefined' && ctx.setWebSocketAutoResponse) {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    }
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) || E.newTable();
      this.chat = (await ctx.storage.get('chat')) || [];
    });
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uid: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets(exclude) {
    return this.ctx.getWebSockets().filter((ws) => ws !== exclude);
  }

  onlineUids(exclude) {
    return this.sockets(exclude).map((ws) => (ws.deserializeAttachment() || {}).uid).filter(Boolean);
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch (e) { /* Verbindung schon zu */ }
  }

  // Wer ist gerade da? Spieler mit Platz, dazu alle, die nur zuschauen (ohne Kennungen).
  presence(exclude) {
    const seen = new Set(), list = [];
    for (const ws of this.sockets(exclude)) {
      const at = ws.deserializeAttachment() || {};
      if (!at.uid || seen.has(at.uid)) continue;
      seen.add(at.uid);
      const seat = this.state.seats.findIndex((s) => s && !s.bot && s.uid === at.uid);
      list.push({ name: seat >= 0 ? this.state.seats[seat].name : (at.name || 'Gast'), seat, me: false, uid: at.uid });
    }
    list.sort((a, b) => (a.seat < 0) - (b.seat < 0) || a.seat - b.seat || a.name.localeCompare(b.name, 'de'));
    return list;
  }

  broadcast(exclude) {
    const online = this.onlineUids(exclude);
    const present = this.presence(exclude);
    for (const ws of this.sockets(exclude)) {
      const at = ws.deserializeAttachment() || {};
      if (!at.uid) continue;
      const view = E.viewFor(this.state, at.uid, online);
      view.present = present.map((p) => ({ name: p.name, seat: p.seat, me: p.uid === at.uid }));
      this.send(ws, { t: 'state', view });
    }
  }

  // Chat-Eintrag ohne Kennung des Absenders weitergeben, nur mit „das war ich“
  chatFor(entry, uid) {
    const { uid: from, ...rest } = entry;
    return { ...rest, mine: from === uid };
  }

  async save() {
    await this.ctx.storage.put('state', this.state);
    const g = this.state.game;
    const s = g && this.state.seats[g.turn];
    if (this.state.phase === 'game' && g && g.phase !== 'done' && s && s.bot) {
      await this.ctx.storage.setAlarm(Date.now() + E.botDelay(this.state));
    }
  }

  async alarm() {
    const next = E.botStep(this.state);
    if (!next) return;
    this.state = next;
    await this.save();
    this.broadcast();
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 4000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    const at = ws.deserializeAttachment() || {};

    if (msg.t === 'hello') {
      const pw = this.env.TABLE_PASSWORD;
      if (pw && msg.password !== pw) {
        this.send(ws, { t: 'error', code: 'password', message: msg.password ? 'Das Tisch-Passwort stimmt nicht.' : 'Dieser Tisch braucht ein Passwort.' });
        return;
      }
      if (typeof msg.uid !== 'string' || !UID.test(msg.uid)) {
        this.send(ws, { t: 'error', code: 'uid', message: 'Ungültige Spieler-Kennung. Bitte Seite neu laden.' });
        return;
      }
      ws.serializeAttachment({ uid: msg.uid, name: cleanName(msg.name) });
      this.send(ws, { t: 'welcome' });
      this.send(ws, { t: 'chat', list: this.chat.map((c) => this.chatFor(c, msg.uid)) });
      this.broadcast(); // alle sehen, wer jetzt online ist
      return;
    }

    if (msg.t === 'ping') { this.send(ws, { t: 'pong' }); return; }

    if (!at.uid) { this.send(ws, { t: 'error', code: 'hello', message: 'Bitte zuerst anmelden.' }); return; }

    if (msg.t === 'nick') {
      // Name von Zuschauern (Spieler mit Platz ändern ihren Namen über „rename“)
      ws.serializeAttachment({ ...at, name: cleanName(msg.name) });
      this.broadcast();
      return;
    }

    if (msg.t === 'chat') {
      const text = typeof msg.text === 'string' ? msg.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, CHAT_MAX_LEN) : '';
      if (!text) return;
      const now = Date.now();
      if (at.lastChat && now - at.lastChat < CHAT_GAP_MS) { this.send(ws, { t: 'error', message: 'Nicht so schnell :-)' }); return; }
      ws.serializeAttachment({ ...at, lastChat: now });
      const seat = this.state.seats.findIndex((s) => s && !s.bot && s.uid === at.uid);
      const name = seat >= 0 ? this.state.seats[seat].name : (at.name || 'Gast');
      const entry = { id: now.toString(36) + Math.random().toString(36).slice(2, 6), ts: now, name, seat, text, uid: at.uid };
      this.chat.push(entry);
      if (this.chat.length > CHAT_KEEP) this.chat = this.chat.slice(-CHAT_KEEP);
      await this.ctx.storage.put('chat', this.chat);
      for (const o of this.sockets()) {
        const u = (o.deserializeAttachment() || {}).uid;
        if (u) this.send(o, { t: 'chat', add: this.chatFor(entry, u) });
      }
      return;
    }

    if (msg.t === 'act') {
      const r = E.dispatch(this.state, at.uid, msg.a, this.onlineUids());
      if (r.error) { this.send(ws, { t: 'error', message: r.error }); return; }
      this.state = r.state;
      await this.save();
      this.broadcast();
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch (e) { /* schon zu */ }
    this.broadcast(ws);
  }

  async webSocketError(ws) {
    this.broadcast(ws);
  }
}
