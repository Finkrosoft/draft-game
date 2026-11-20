# Charakter-Auktion

Lokales Party-Spiel: Der Fernseher zeigt das Spielfeld, alle bieten per Handy (QR-Code, kein Login).

## Starten

Voraussetzung: Node.js 18+

```bash
npm install
npm start
```

Die Konsole zeigt drei Links:

| Wofür | Link |
|---|---|
| TV / Gamemaster am selben Rechner | `http://localhost:3000/host` |
| TV auf anderem Gerät | `http://<LAN-IP>:3000/host?key=<code>` |
| Spieler (steckt im QR-Code) | `http://<LAN-IP>:3000/play` |

Handys und Rechner müssen im selben WLAN sein. Falls die erkannte IP falsch ist (VPN, Docker …):
`PUBLIC_HOST=192.168.1.50 npm start`. Port ändern: `PORT=8080 npm start`. Fester Gamemaster-Code: `HOST_KEY=geheim npm start`.

## Charakter hinzufügen

Bilder in `characters/` legen. **Unterordner = Kategorie, Dateiname = Name + Startwert:**

```
characters/
  Krieger/
    Eisenfaust_300M.png        → Eisenfaust, Krieger, 300 Mio
    Schatten_Klinge_1.2Mrd.jpg → Schatten Klinge, Krieger, 1,2 Mrd
  Magier/
    Frostrune_275M.webp
```

- Wert-Endungen: `k`, `M`/`Mio`, `B`/`Mrd`, oder eine nackte Zahl (`250000000`)
- `_` im Namen wird zu Leerzeichen
- Optional eine JSON-Datei mit gleichem Namen daneben, die Werte überschreibt:
  `Eisenfaust_300M.json` → `{ "name": "Eisenfaust der Große", "value": "350M", "category": "Boss" }`
- Formate: png, jpg, webp, gif, svg, avif
- Nach dem Hinzufügen in der Lobby auf **Ordner neu einlesen** klicken (beim Spielstart passiert das automatisch)

Die mitgelieferten Bilder sind nur Platzhalter. Einfach löschen und durch eigene ersetzen.

## Ablauf

1. **Lobby (TV):** Der Gamemaster stellt Spieleranzahl (2–8), Reihen (5–10), Glücksrad-Werte und Hintergrund ein. Die Spieler scannen den QR-Code und geben Name und Foto ein.
2. **Start:** Der Gamemaster bestätigt. Das Raster hat eine Spalte pro Spieler und eine Zeile pro Runde. Alle starten mit **1 Mrd**.
3. **Auktion:** Ein Charakter nach dem anderen wird versteigert.
   - Das erste Gebot muss mindestens dem Startwert entsprechen, jedes weitere muss höher sein. Niemand kann mehr bieten, als er hat.
   - **Aussteigen** gilt für den aktuellen Charakter. Bleibt nur noch der Höchstbietende übrig, bekommt er den Charakter automatisch (oder der Gamemaster drückt **Zuschlag**).
   - **Skippen:** Bei Mehrheit kommt der Charakter zurück auf den Stapel.
   - Wer in der aktuellen Reihe schon einen Charakter hat, bietet in dieser Runde nicht mehr mit.
   - Ist der Stapel leer, kommen die übersprungenen Charakter wieder dran. Sind alle vergeben, wird der ganze Pool neu gemischt.
4. **Rundenende:** Sobald jeder Spieler einen Charakter in der Reihe hat, kommen die zwei Glücksräder. Das erste Rad zieht einen Spieler (der danach vom Rad verschwindet), das zweite bestimmt den Betrag, der seinem Guthaben gutgeschrieben wird. Das wiederholt sich, bis alle dran waren.
5. **Ende:** Wenn das Raster voll ist, ist das Spiel vorbei. Wer gewonnen hat, diskutiert ihr selbst aus.

### Joker (jeder Spieler hat jeden Joker 1× pro Spiel)

| Joker | Wirkung |
|---|---|
| Weißes Monster | +100 Mio Guthaben |
| Sperre | Ein Spieler darf beim aktuellen Charakter nicht mitbieten (nicht beim Höchstbietenden möglich) |
| Tausch | Du tauschst deinen Charakter in einer Reihe gegen den eines anderen Spielers in derselben Reihe (beide müssen dort einen haben) |

### Gamemaster-Knöpfe im Spiel

**Zuschlag** · **Charakter skippen** · **Verschenken an …** (gratis zuweisen, falls jemand pleite ist und die Runde sonst hängt) · **Neu starten** · **Zur Lobby**

## Technik

- `server.js`: Express + Socket.IO, die gesamte Spiellogik läuft auf dem Server (Clients können nicht schummeln)
- `public/host.*`: TV-Ansicht, `public/play.*`: Handy-Ansicht
- Der Spielstand liegt nur im Speicher. Ein Server-Neustart setzt das Spiel zurück. Handys verbinden sich nach einem Neuladen der Seite automatisch wieder (Token im localStorage).
- Test: `npm test` spielt ein komplettes Spiel automatisch durch
