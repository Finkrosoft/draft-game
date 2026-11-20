'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const CHAR_DIR = path.resolve(process.env.CHAR_DIR || path.join(__dirname, 'characters'));
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(3).toString('hex');
const MIO = 1e6;

const RULES = {
  startMoney: 1000 * MIO,      // 1 Milliarde
  monsterBonus: 100 * MIO,     // Joker "Weißes Monster"
  minPlayers: 2,
  maxPlayers: 8,
  minRows: 5,
  maxRows: 10,
  spinMs: Number(process.env.SPIN_MS) || 5200,
};

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const AMOUNT_RE = /^(-?\d+(?:[.,]\d+)?)(k|tsd|m|mio|b|bn|mrd)?$/i;
const MULT = { k: 1e3, tsd: 1e3, m: 1e6, mio: 1e6, b: 1e9, bn: 1e9, mrd: 1e9 };

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : NaN;
  const m = String(input ?? '').trim().replace(/\s+/g, '').match(AMOUNT_RE);
  if (!m) return NaN;
  const n = parseFloat(m[1].replace(',', '.'));
  return Math.round(n * (MULT[(m[2] || '').toLowerCase()] || 1));
}

function fmt(n) {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return `${s}${+(a / 1e9).toFixed(2)} Mrd`;
  if (a >= 1e6) return `${s}${+(a / 1e6).toFixed(1)} Mio`;
  return `${s}${a}`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rid = () => crypto.randomBytes(5).toString('hex');

function lanAddress() {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  const score = (ip) => (ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 0);
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  ips.sort((a, b) => score(b) - score(a));
  return ips[0] || 'localhost';
}

const PUBLIC_BASE = process.env.PUBLIC_URL || `http://${lanAddress()}:${PORT}`;
const JOIN_URL = `${PUBLIC_BASE}/play`;

function parseDataUrl(dataUrl, maxBytes) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) fail('Bildformat nicht unterstützt (PNG, JPG, WEBP, GIF).');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) fail(`Bild ist zu groß (max. ${Math.round(maxBytes / 1e6)} MB).`);
  return { mime: m[1], buf };
}

// ---------------------------------------------------------------------------
// Charakter aus dem Ordner einlesen
//   characters/<Kategorie>/<Name>_<Wert>.png      z. B. Krieger/Eisenfaust_300M.png
//   optional daneben <Name>_<Wert>.json  { "name": "...", "value": "300M", "category": "..." }
// ---------------------------------------------------------------------------
let characters = [];
let charMap = new Map();

function scanCharacters() {
  const out = [];
  if (!fs.existsSync(CHAR_DIR)) return out;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (!IMG_EXT.has(ext)) continue;

      const base = e.name.slice(0, -ext.length);
      const rel = path.relative(CHAR_DIR, full).split(path.sep);
      let category = rel.length > 1 ? rel.slice(0, -1).join(' / ') : 'Ohne Kategorie';
      let name = base;
      let value = NaN;

      const m = base.match(/^(.*?)[\s_-]+(-?\d+(?:[.,]\d+)?\s*(?:k|tsd|m|mio|b|bn|mrd)?)$/i);
      if (m) { name = m[1]; value = parseAmount(m[2]); }

      const sidecar = path.join(dir, `${base}.json`);
      if (fs.existsSync(sidecar)) {
        try {
          const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
          if (meta.name) name = String(meta.name);
          if (meta.value !== undefined) value = parseAmount(meta.value);
          if (meta.category) category = String(meta.category);
        } catch (err) {
          console.warn(`  ! ${rel.join('/')}: JSON fehlerhaft (${err.message})`);
        }
      }

      if (!Number.isFinite(value) || value < 0) {
        console.warn(`  ! Übersprungen, kein Wert im Namen: ${rel.join('/')}  (Beispiel: Eisenfaust_300M.png)`);
        continue;
      }

      out.push({
        id: crypto.createHash('sha1').update(rel.join('/')).digest('hex').slice(0, 10),
        name: name.replace(/_/g, ' ').trim(),
        value,
        category,
        image: '/characters/' + rel.map(encodeURIComponent).join('/'),
      });
    }
  };
  walk(CHAR_DIR);
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function loadCharacters() {
  characters = scanCharacters();
  charMap = new Map(characters.map((c) => [c.id, c]));
  console.log(`  ${characters.length} Charakter aus ${CHAR_DIR} geladen`);
}

// ---------------------------------------------------------------------------
// Spielzustand
// ---------------------------------------------------------------------------
const config = {
  maxPlayers: 4,
  rows: 5,
  wheelValues: [0, 25 * MIO, 50 * MIO, 100 * MIO, 150 * MIO, 200 * MIO, 300 * MIO, 500 * MIO],
  bgColor: '#141633',
};

let players = [];          // { id, token, name, money, jokers, avatarVersion, sockets }
const avatars = new Map(); // playerId -> { mime, buf }
let background = null;     // { mime, buf }
let bgVersion = 0;
let spinNonce = 0;

const newGame = () => ({
  phase: 'lobby',          // lobby | auction | wheel | finished
  grid: [],                // grid[reihe][spalte = spielerindex] = { charId, price } | null
  round: 0,                // aktuelle Reihe
  queue: [],
  skipped: [],
  current: null,           // { charId, highest, withdrawn[], blocked[], skips[] }
  wheel: null,
  log: [],
});
let game = newGame();

const log = (msg) => {
  game.log.push({ t: Date.now(), msg });
  if (game.log.length > 40) game.log.shift();
};

const getPlayer = (id) => players.find((p) => p.id === id) || fail('Spieler nicht gefunden.');
const colOf = (p) => players.indexOf(p);
const hasSlot = (p) => !!(game.grid[game.round] && game.grid[game.round][colOf(p)]);
const needIds = () => players.filter((p) => !hasSlot(p)).map((p) => p.id);
const votersFor = (c) => needIds().filter((id) => !c.blocked.includes(id));

function requireAuction() {
  if (game.phase !== 'auction' || !game.current) fail('Gerade läuft keine Auktion.');
  return game.current;
}

function nextCharacter() {
  if (!game.queue.length) {
    if (game.skipped.length) {
      game.queue = shuffle(game.skipped);
      game.skipped = [];
      log('Übersprungene Charakter kommen wieder dran');
    } else {
      game.queue = shuffle(characters.map((c) => c.id));
      log('Alle Charakter vergeben – der Pool wird neu gemischt');
    }
  }
  game.current = { charId: game.queue.shift(), highest: null, withdrawn: [], blocked: [], skips: [] };
}

function skipCurrent(reason) {
  const c = game.current;
  game.skipped.push(c.charId);
  log(`${charMap.get(c.charId)?.name ?? '?'} übersprungen (${reason})`);
  nextCharacter();
}

function assign(p, price, how) {
  const c = game.current;
  const ch = charMap.get(c.charId);
  p.money -= price;
  game.grid[game.round][colOf(p)] = { charId: c.charId, price };
  log(`${p.name} ${how} ${ch.name} für ${fmt(price)}`);
  game.lastAward = { playerId: p.id, charId: c.charId, price, t: Date.now() };
  game.current = null;
  if (needIds().length === 0) startWheel();
  else nextCharacter();
}

function award() {
  const { playerId, amount } = game.current.highest;
  assign(getPlayer(playerId), amount, 'ersteigert');
}

// Prüft nach jeder Aktion, ob die Auktion entschieden ist
function resolveIfDone() {
  const c = game.current;
  if (!c || game.phase !== 'auction') return;
  const active = votersFor(c).filter((id) => !c.withdrawn.includes(id));

  if (c.highest) {
    // Wer nicht mehr überbieten kann, zählt nicht mehr als Gegner
    const rivals = active.filter((id) => id !== c.highest.playerId && getPlayer(id).money > c.highest.amount);
    if (rivals.length === 0) return award();
  } else if (active.length === 0) {
    return skipCurrent('niemand hat geboten');
  }

  const voters = votersFor(c);
  if (c.skips.length > voters.length / 2) skipCurrent('Mehrheit hat geskippt');
}

function startWheel() {
  game.phase = 'wheel';
  game.current = null;
  game.wheel = { remaining: players.map((p) => p.id), selected: null, spin: null, results: [], busyUntil: 0 };
  log(`Reihe ${game.round + 1} ist voll – Glücksrad!`);
}

function requireWheelIdle() {
  if (game.phase !== 'wheel') fail('Gerade ist keine Glücksrad-Phase.');
  if (game.wheel.busyUntil > Date.now()) fail('Das Rad dreht sich noch …');
  return game.wheel;
}

// ---------------------------------------------------------------------------
// Öffentlicher Zustand (ohne Tokens)
// ---------------------------------------------------------------------------
function publicState() {
  const c = game.current;
  const w = game.wheel;
  return {
    phase: game.phase,
    rules: RULES,
    config,
    joinUrl: JOIN_URL,
    characterCount: characters.length,
    players: players.map((p, i) => ({
      id: p.id,
      name: p.name,
      money: p.money,
      jokers: p.jokers,
      connected: p.sockets > 0,
      avatar: p.avatarVersion ? `/avatar/${p.id}?v=${p.avatarVersion}` : null,
      column: i,
    })),
    grid: game.grid.map((row) => row.map((cell) => cell && { ...cell, char: charMap.get(cell.charId) || null })),
    round: game.round,
    current: c && {
      char: charMap.get(c.charId),
      highest: c.highest,
      withdrawn: c.withdrawn,
      blocked: c.blocked,
      skips: c.skips,
      need: needIds(),
      skipNeeded: Math.floor(votersFor(c).length / 2) + 1,
    },
    wheel: w && {
      remaining: w.remaining,
      selected: w.selected,
      results: w.results,
      busy: w.busyUntil > Date.now(),
      spin: w.spin && { ...w.spin, remainingMs: Math.max(0, w.spin.endsAt - Date.now()) },
    },
    queueLeft: game.queue.length,
    skippedCount: game.skipped.length,
    lastAward: game.lastAward || null,
    background: background ? `/background?v=${bgVersion}` : null,
    log: game.log.slice(-8),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
const pub = path.join(__dirname, 'public');
app.get('/', (req, res) => res.redirect('/host'));
app.get('/host', (req, res) => res.sendFile(path.join(pub, 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(pub, 'play.html')));
app.use(express.static(pub, { index: false }));
app.use('/characters', express.static(CHAR_DIR, { fallthrough: false }));

app.get('/avatar/:id', (req, res) => {
  const a = avatars.get(req.params.id);
  if (!a) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(a.mime).send(a.buf);
});
app.get('/background', (req, res) => {
  if (!background) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(background.mime).send(background.buf);
});
app.get('/api/qr', async (req, res) => {
  res.type('image/svg+xml').send(await QRCode.toString(JOIN_URL, { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } }));
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 12e6 });
const broadcast = () => io.emit('state', publicState());

// ---------------------------------------------------------------------------
// Socket-Events
// ---------------------------------------------------------------------------
const isLoopback = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);

io.on('connection', (socket) => {
  socket.emit('state', publicState());

  const on = (event, handler) => {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const res = handler(payload && typeof payload === 'object' ? payload : {});
        broadcast();                      // Zustand zuerst, damit Clients beim Ack schon aktuell sind
        reply({ ok: true, ...(res || {}) });
      } catch (err) {
        if (err instanceof GameError) reply({ ok: false, error: err.message });
        else { console.error(err); reply({ ok: false, error: 'Interner Fehler – siehe Server-Konsole.' }); }
      }
    });
  };

  const me = () => players.find((p) => p.id === socket.data.playerId) || fail('Du bist nicht im Spiel.');
  const host = () => { if (!socket.data.host) fail('Nur der Gamemaster darf das.'); };

  const bind = (p) => {
    if (socket.data.playerId) return;
    socket.data.playerId = p.id;
    p.sockets++;
  };

  const setAvatar = (p, dataUrl) => {
    if (!dataUrl) return;
    avatars.set(p.id, parseDataUrl(dataUrl, 3e6));
    p.avatarVersion++;
  };

  socket.on('disconnect', () => {
    const p = players.find((x) => x.id === socket.data.playerId);
    if (p) { p.sockets = Math.max(0, p.sockets - 1); broadcast(); }
  });

  // ----- Spieler -----------------------------------------------------------
  on('player:join', ({ name, avatar }) => {
    if (socket.data.playerId) fail('Du bist schon beigetreten.');
    if (game.phase !== 'lobby') fail('Das Spiel läuft schon – beitreten geht nur in der Lobby.');
    if (players.length >= config.maxPlayers) fail('Die Lobby ist voll.');
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) fail('Bitte gib einen Namen ein.');
    if (players.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail('Der Name ist schon vergeben.');

    const p = {
      id: rid(),
      token: crypto.randomBytes(16).toString('hex'),
      name,
      money: RULES.startMoney,
      jokers: { monster: false, block: false, swap: false },
      avatarVersion: 0,
      sockets: 0,
    };
    setAvatar(p, avatar);
    players.push(p);
    bind(p);
    log(`${name} ist beigetreten`);
    return { token: p.token, playerId: p.id };
  });

  on('player:resume', ({ token }) => {
    const p = players.find((x) => x.token === token) || fail('Sitzung nicht mehr gültig.');
    bind(p);
    return { playerId: p.id };
  });

  on('player:leave', () => {
    const p = me();
    if (game.phase !== 'lobby') fail('Verlassen geht nur in der Lobby.');
    players = players.filter((x) => x !== p);
    avatars.delete(p.id);
    socket.data.playerId = null;
    log(`${p.name} hat die Lobby verlassen`);
  });

  on('bid', ({ amount }) => {
    const p = me();
    const c = requireAuction();
    const ch = charMap.get(c.charId);
    amount = Math.round(Number(amount));
    if (!Number.isFinite(amount) || amount <= 0) fail('Ungültiger Betrag.');
    if (hasSlot(p)) fail('Du hast in dieser Reihe schon einen Charakter.');
    if (c.blocked.includes(p.id)) fail('Du bist für diesen Charakter gesperrt.');
    if (c.withdrawn.includes(p.id)) fail('Du bist bei diesem Charakter schon ausgestiegen.');
    if (c.highest?.playerId === p.id) fail('Du bist schon Höchstbietender.');
    if (amount < ch.value) fail(`Mindestens ${fmt(ch.value)} (Startwert).`);
    if (c.highest && amount <= c.highest.amount) fail(`Du musst mehr als ${fmt(c.highest.amount)} bieten.`);
    if (amount > p.money) fail('So viel Kohle hast du nicht.');
    c.highest = { playerId: p.id, amount };
    c.skips = c.skips.filter((id) => id !== p.id);
    resolveIfDone();
  });

  on('withdraw', () => {
    const p = me();
    const c = requireAuction();
    if (hasSlot(p)) fail('Du bietest in dieser Reihe nicht mehr mit.');
    if (c.withdrawn.includes(p.id)) fail('Du bist schon ausgestiegen.');
    if (c.highest?.playerId === p.id) fail('Als Höchstbietender kannst du nicht aussteigen.');
    c.withdrawn.push(p.id);
    resolveIfDone();
  });

  on('skip', () => {
    const p = me();
    const c = requireAuction();
    if (hasSlot(p) || c.blocked.includes(p.id)) fail('Du kannst hier nicht abstimmen.');
    if (c.skips.includes(p.id)) c.skips = c.skips.filter((id) => id !== p.id);
    else c.skips.push(p.id);
    resolveIfDone();
  });

  on('joker', ({ type, targetId, row }) => {
    const p = me();
    if (!['auction', 'wheel'].includes(game.phase)) fail('Joker gehen nur während des Spiels.');
    if (!['monster', 'block', 'swap'].includes(type)) fail('Unbekannter Joker.');
    if (p.jokers[type]) fail('Diesen Joker hast du schon verbraucht.');

    if (type === 'monster') {
      p.money += RULES.monsterBonus;
      log(`${p.name} trinkt ein weißes Monster: +${fmt(RULES.monsterBonus)}`);
    } else if (type === 'block') {
      const c = requireAuction();
      const t = getPlayer(targetId);
      if (t.id === p.id) fail('Du kannst dich nicht selbst sperren.');
      if (hasSlot(t)) fail(`${t.name} bietet in dieser Reihe eh nicht mehr mit.`);
      if (c.blocked.includes(t.id)) fail(`${t.name} ist schon gesperrt.`);
      if (c.highest?.playerId === t.id) fail('Der Höchstbietende kann nicht gesperrt werden.');
      c.blocked.push(t.id);
      c.skips = c.skips.filter((id) => id !== t.id);
      log(`${p.name} sperrt ${t.name} für ${charMap.get(c.charId).name}`);
    } else {
      const r = Number(row);
      if (!Number.isInteger(r) || r < 0 || r >= game.grid.length) fail('Ungültige Reihe.');
      const t = getPlayer(targetId);
      if (t.id === p.id) fail('Wähle einen anderen Spieler.');
      const a = game.grid[r][colOf(p)];
      const b = game.grid[r][colOf(t)];
      if (!a || !b) fail('In dieser Reihe braucht ihr beide einen Charakter.');
      game.grid[r][colOf(p)] = b;
      game.grid[r][colOf(t)] = a;
      log(`${p.name} tauscht in Reihe ${r + 1} mit ${t.name}: ${charMap.get(b.charId)?.name} ⇄ ${charMap.get(a.charId)?.name}`);
    }
    p.jokers[type] = true;
    if (type === 'block') resolveIfDone();
  });

  // ----- Gamemaster --------------------------------------------------------
  on('host:hello', ({ key }) => {
    if (!isLoopback(socket.handshake.address) && key !== HOST_KEY) {
      fail('Kein Gamemaster-Zugang. Öffne /host am Spiel-Rechner oder nutze den Link mit ?key= aus der Server-Konsole.');
    }
    socket.data.host = true;
  });

  on('host:config', ({ maxPlayers, rows, wheelValues, bgColor }) => {
    host();
    if (maxPlayers !== undefined || rows !== undefined) {
      if (game.phase !== 'lobby') fail('Spieler und Raster nur in der Lobby änderbar.');
      if (maxPlayers !== undefined) {
        const n = Math.round(Number(maxPlayers));
        if (!(n >= RULES.minPlayers && n <= RULES.maxPlayers)) fail(`Spieler: ${RULES.minPlayers}–${RULES.maxPlayers}.`);
        if (n < players.length) fail(`Es sind schon ${players.length} Spieler beigetreten.`);
        config.maxPlayers = n;
      }
      if (rows !== undefined) {
        const n = Math.round(Number(rows));
        if (!(n >= RULES.minRows && n <= RULES.maxRows)) fail(`Reihen: ${RULES.minRows}–${RULES.maxRows}.`);
        config.rows = n;
      }
    }
    if (wheelValues !== undefined) {
      const list = (Array.isArray(wheelValues) ? wheelValues : String(wheelValues).split(/[;,\n]+/))
        .map((v) => String(v).trim()).filter(Boolean);
      const values = list.map(parseAmount);
      const bad = list.filter((_, i) => !Number.isFinite(values[i]));
      if (bad.length) fail(`Unlesbare Rad-Werte: ${bad.join(', ')}`);
      if (values.length < 2) fail('Das Wert-Rad braucht mindestens 2 Felder.');
      if (values.length > 24) fail('Maximal 24 Felder auf dem Wert-Rad.');
      config.wheelValues = values;
    }
    if (bgColor !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(bgColor)) fail('Ungültige Farbe.');
      config.bgColor = bgColor;
    }
  });

  on('host:background', ({ dataUrl }) => {
    host();
    background = dataUrl ? parseDataUrl(dataUrl, 10e6) : null;
    bgVersion++;
  });

  on('host:kick', ({ playerId }) => {
    host();
    if (game.phase !== 'lobby') fail('Entfernen geht nur in der Lobby.');
    const p = getPlayer(playerId);
    players = players.filter((x) => x !== p);
    avatars.delete(p.id);
    for (const s of io.sockets.sockets.values()) {
      if (s.data.playerId === p.id) { s.data.playerId = null; s.emit('kicked'); }
    }
    log(`${p.name} wurde entfernt`);
  });

  on('host:rescan', () => {
    host();
    if (game.phase !== 'lobby') fail('Neu einlesen geht nur in der Lobby.');
    loadCharacters();
  });

  on('host:start', () => {
    host();
    if (game.phase !== 'lobby') fail('Das Spiel läuft schon.');
    if (players.length < RULES.minPlayers) fail(`Mindestens ${RULES.minPlayers} Spieler nötig.`);
    loadCharacters();
    if (!characters.length) fail('Keine Charakter gefunden – Ordner "characters" prüfen.');
    for (const p of players) {
      p.money = RULES.startMoney;
      p.jokers = { monster: false, block: false, swap: false };
    }
    game = newGame();
    game.phase = 'auction';
    game.grid = Array.from({ length: config.rows }, () => players.map(() => null));
    game.queue = shuffle(characters.map((c) => c.id));
    log(`Spiel gestartet: ${players.length} Spieler, ${config.rows} Reihen`);
    nextCharacter();
  });

  on('host:hammer', () => {
    host();
    const c = requireAuction();
    if (!c.highest) fail('Noch kein Gebot.');
    award();
  });

  on('host:skipChar', () => {
    host();
    requireAuction();
    skipCurrent('Gamemaster');
  });

  on('host:giveChar', ({ playerId }) => {
    host();
    requireAuction();
    const p = getPlayer(playerId);
    if (hasSlot(p)) fail(`${p.name} hat in dieser Reihe schon einen Charakter.`);
    assign(p, 0, 'bekommt geschenkt:');
  });

  on('host:spinPlayer', () => {
    host();
    const w = requireWheelIdle();
    if (w.selected) fail('Erst das Wert-Rad drehen.');
    if (!w.remaining.length) fail('Alle Spieler waren schon dran.');
    const ids = [...w.remaining];
    const target = crypto.randomInt(ids.length);
    const now = Date.now();
    w.spin = { kind: 'player', ids, labels: ids.map((id) => getPlayer(id).name), target, nonce: ++spinNonce, endsAt: now + RULES.spinMs };
    w.busyUntil = now + RULES.spinMs;
    setTimeout(() => {
      if (game.wheel !== w) return;
      w.busyUntil = 0;
      w.selected = ids[target];
      log(`${getPlayer(ids[target]).name} wurde gezogen`);
      broadcast();
    }, RULES.spinMs);
  });

  on('host:spinValue', () => {
    host();
    const w = requireWheelIdle();
    if (!w.selected) fail('Erst das Spieler-Rad drehen.');
    const values = [...config.wheelValues];
    const target = crypto.randomInt(values.length);
    const amount = values[target];
    const p = getPlayer(w.selected);
    const now = Date.now();
    w.spin = { kind: 'value', playerId: p.id, labels: values.map((v) => (v > 0 ? '+' : '') + fmt(v)), target, nonce: ++spinNonce, endsAt: now + RULES.spinMs };
    w.busyUntil = now + RULES.spinMs;
    setTimeout(() => {
      if (game.wheel !== w) return;
      w.busyUntil = 0;
      p.money += amount;
      w.results.push({ playerId: p.id, amount });
      w.remaining = w.remaining.filter((id) => id !== p.id);
      w.selected = null;
      log(`${p.name} bekommt ${(amount > 0 ? '+' : '') + fmt(amount)}`);
      broadcast();
    }, RULES.spinMs);
  });

  on('host:nextRound', () => {
    host();
    const w = requireWheelIdle();
    if (w.remaining.length) fail('Es waren noch nicht alle Spieler am Rad.');
    game.wheel = null;
    if (game.round + 1 >= game.grid.length) {
      game.phase = 'finished';
      log('Raster voll – Spiel vorbei!');
    } else {
      game.round++;
      game.phase = 'auction';
      log(`Reihe ${game.round + 1} beginnt`);
      nextCharacter();
    }
  });

  on('host:reset', ({ keepPlayers }) => {
    host();
    game = newGame();
    if (keepPlayers) {
      for (const p of players) { p.money = RULES.startMoney; p.jokers = { monster: false, block: false, swap: false }; }
      log('Neues Spiel mit denselben Spielern');
    } else {
      for (const s of io.sockets.sockets.values()) {
        if (s.data.playerId) { s.data.playerId = null; s.emit('kicked'); }
      }
      players = [];
      avatars.clear();
    }
  });
});

// ---------------------------------------------------------------------------
loadCharacters();
server.listen(PORT, () => {
  console.log('\n  Charakter-Auktion läuft');
  console.log(`  TV / Gamemaster (an diesem Rechner):  http://localhost:${PORT}/host`);
  console.log(`  TV auf anderem Gerät:                 ${PUBLIC_BASE}/host?key=${HOST_KEY}`);
  console.log(`  Spieler (QR-Code am TV):              ${JOIN_URL}\n`);
});

module.exports = { parseAmount };
