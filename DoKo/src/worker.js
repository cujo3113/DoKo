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
 *
 * Optional: Tisch-Passwort als Secret setzen:  npx wrangler secret put TABLE_PASSWORD
 */
import E from '../public/engine.js';

const TABLE_PATH = /^\/api\/tisch\/([A-Za-z0-9_-]{1,40})$/;
const UID = /^[A-Za-z0-9_-]{16,64}$/;

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
    // Ping/Pong beantwortet Cloudflare selbst, ohne den schlafenden Tisch aufzuwecken
    if (typeof WebSocketRequestResponsePair !== 'undefined' && ctx.setWebSocketAutoResponse) {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    }
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) || E.newTable();
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

  broadcast(exclude) {
    const online = this.onlineUids(exclude);
    for (const ws of this.sockets(exclude)) {
      const at = ws.deserializeAttachment() || {};
      if (at.uid) this.send(ws, { t: 'state', view: E.viewFor(this.state, at.uid, online) });
    }
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
      ws.serializeAttachment({ uid: msg.uid });
      this.send(ws, { t: 'welcome' });
      this.broadcast(); // alle sehen, wer jetzt online ist
      return;
    }

    if (msg.t === 'ping') { this.send(ws, { t: 'pong' }); return; }

    if (!at.uid) { this.send(ws, { t: 'error', code: 'hello', message: 'Bitte zuerst anmelden.' }); return; }

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
