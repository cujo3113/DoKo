# Doko-Stammtisch

Online-Doppelkopf für den Freundeskreis, ohne Neunen und mit unseren Hausregeln. Die Seite läuft kostenlos auf Cloudflare. Mitspieler brauchen kein Konto, nur den Link.

- **Fair:** Der Server prüft jede Aktion und schickt jedem Spieler nur seine eigenen Karten.
- **Schnell:** Der Tisch läuft in einem Cloudflare-Rechenzentrum in Westeuropa.
- **Kostenlos:** Der kostenlose Workers-Plan reicht für einen Stammtisch locker. Ohne hinterlegte Zahlungsmethode kann auch nichts berechnet werden.
- **Datensparsam:** Keine Werbung, kein Tracking. Die Schriften liegen auf deinem eigenen Server, es wird nichts von Google geladen.

---

## Einmalig einrichten (ca. 10 Minuten)

Du brauchst einen Computer mit Internet. Alle Befehle werden im Terminal eingegeben (Mac: „Terminal“, Windows: „Eingabeaufforderung“ oder „PowerShell“).

### 1. Node.js installieren

Lade die **LTS-Version** von <https://nodejs.org> herunter und installiere sie. Prüfen im Terminal:

```
node --version
```

Es sollte eine Versionsnummer erscheinen, z. B. `v22.…`.

### 2. Kostenloses Cloudflare-Konto anlegen

Registriere dich auf <https://dash.cloudflare.com/sign-up>. Eine Kreditkarte ist nicht nötig.

### 3. Projekt entpacken und Abhängigkeiten installieren

Entpacke `doko-stammtisch.zip` in einen Ordner. Wechsle im Terminal in diesen Ordner und führe aus:

```
npm install
```

Damit wird `wrangler` installiert, das Werkzeug von Cloudflare zum Veröffentlichen.

### 4. Bei Cloudflare anmelden

```
npx wrangler login
```

Es öffnet sich ein Browserfenster. Dort auf „Allow“ klicken.

### 5. Veröffentlichen

```
npx wrangler deploy
```

Beim allerersten Mal fragt Cloudflare eventuell nach einer Subdomain für `workers.dev`. Wähle einen Namen, z. B. deinen Vornamen. Am Ende steht die Adresse deines Spiels, etwa:

```
https://doko-stammtisch.deinname.workers.dev
```

Diesen Link schickst du deinen Freunden. Fertig.

---

## Benutzung

| Was | Wie |
|---|---|
| Gemeinsamer Tisch | Link öffnen, Namen eintragen, „Hinsetzen“. Fehlende Spieler mit Bots auffüllen und „Spiel starten“. |
| Weitere Tische | Link mit `?tisch=name` ergänzen, z. B. `…workers.dev/?tisch=freitag`. Jeder Name ist ein eigener Tisch mit eigenem Spielzettel. |
| Allein üben | `…workers.dev/?ueben=1` (läuft nur im eigenen Browser gegen drei Bots). |
| Seite neu geladen | Du sitzt automatisch wieder auf deinem Platz, solange du denselben Browser benutzt. |
| Mitspieler weg | Bei einem Spieler, der offline ist, erscheint „Durch Bot ersetzen“. Über „Platz übernehmen“ kann er (oder jemand anderes) später zurückkommen. |
| Ton | Knopf oben rechts. Jeder stellt das für sich ein. |
| Tisch | Knopf oben (z. B. „Pokertisch“) wechselt zwischen Pokertisch, Holztisch, Spieltisch und Schlicht. Jeder stellt das für sich ein, der Browser merkt es sich. |

### Tisch-Passwort (optional)

Damit nicht jeder mit dem Link mitspielen kann:

```
npx wrangler secret put TABLE_PASSWORD
```

Passwort eingeben, fertig. Beim nächsten Öffnen fragt die Seite einmal danach und merkt es sich im Browser. Entfernen mit `npx wrangler secret delete TABLE_PASSWORD`.

---

## Änderungen veröffentlichen

Dateien ändern und erneut ausführen:

```
npx wrangler deploy
```

Laufende Spielstände bleiben erhalten.

**Ohne Terminal:** Du kannst den Ordner auch in ein GitHub-Repository legen und es im Cloudflare-Dashboard unter „Workers & Pages“ verbinden. Dann wird jede Änderung im Repository automatisch veröffentlicht.

### Lokal ausprobieren

```
npm run dev
```

Dann <http://localhost:8787> öffnen, gern in zwei verschiedenen Browsern, um zwei Spieler zu simulieren.

### Tests

```
npm test
```

Damit laufen die Regeltests (Abrechnung, Hochzeit, Schmeißen usw.) und eine simulierte Partie mit vier Spielern am Server. Die Server-Simulation prüft auch, dass kein Spieler fremde Karten zu sehen bekommt.

---

## Aufbau

| Datei | Inhalt |
|---|---|
| `public/engine.js` | Die Spielregeln. Läuft im Browser und auf dem Server. Hausregeln oben in `RULES` (z. B. Länge der Bockrunde). |
| `public/app.js` | Oberfläche, Verbindung zum Server, Soundeffekte. |
| `public/index.html` | Seite und Gestaltung. |
| `public/cards.js` | Kartenbild (Vierfarbenblatt). |
| `src/worker.js` | Der Server: ein „Durable Object“ pro Tisch, Verbindung per WebSocket. |
| `wrangler.toml` | Cloudflare-Einstellungen. |

## Kosten und Grenzen

Der kostenlose Workers-Plan erlaubt laut Cloudflare unter anderem 100.000 Anfragen pro Tag (auch für Durable Objects) und 5 GB Speicher. Die Seite selbst (statische Dateien) ist unbegrenzt kostenlos. Ein Doko-Abend erzeugt grob einige tausend Aktionen. Ist der Tisch leer, „schläft“ er und verbraucht nichts. Aktuelle Werte: <https://developers.cloudflare.com/workers/platform/pricing/>

Eine eigene Domain (z. B. `unser-doko.de`) ist optional. Sie kostet je nach Anbieter etwa 10 € im Jahr und lässt sich im Cloudflare-Dashboard mit dem Worker verbinden.

## Lizenzen

- Kartenbild: Adrian Kennard, <https://www.me.uk/cards/>, CC0 (gemeinfrei). Für dieses Spiel auf vier Farben und deutsche Eckzeichen angepasst.
- Schriften: Alegreya SC, Source Sans 3, Kalam. Alle unter der SIL Open Font License, siehe `public/fonts/`.
