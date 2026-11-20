'use strict';

const socket = io();
const params = new URLSearchParams(location.search);
let S = null;
let isHost = false;

socket.on('connect', async () => {
  const r = await emit(socket, 'host:hello', { key: params.get('key') });
  isHost = r.ok;
  const fatal = $('#fatal');
  fatal.hidden = r.ok;
  if (!r.ok) fatal.textContent = r.error;
});
socket.on('disconnect', () => toast('Verbindung zum Server verloren …'));
socket.on('state', (s) => { S = s; render(); });

async function act(event, payload) {
  const r = await emit(socket, event, payload);
  if (!r.ok) toast(r.error);
  return r;
}

const JOKER_LABEL = { monster: 'Monster', block: 'Sperre', swap: 'Tausch' };

// ---------------------------------------------------------------------------
function render() {
  if (!S) return;
  const bg = $('#bg');
  bg.style.backgroundColor = S.config.bgColor;
  bg.style.backgroundImage = S.background ? `url("${S.background}")` : 'none';

  $('#lobby').hidden = S.phase !== 'lobby';
  $('#game').hidden = S.phase === 'lobby';
  if (S.phase === 'lobby') renderLobby();
  else renderGame();
  renderWheel();
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
function setIfIdle(el, value) {
  if (document.activeElement !== el && el.value !== String(value)) el.value = value;
}

function renderLobby() {
  const c = S.config;
  setIfIdle($('#cfgPlayers'), c.maxPlayers);
  setIfIdle($('#cfgRows'), c.rows);
  setIfIdle($('#cfgColor'), c.bgColor);
  const wheelText = c.wheelValues.map(shortAmount).join(', ');
  setIfIdle($('#cfgWheel'), wheelText);
  $('#outPlayers').textContent = c.maxPlayers;
  $('#outRows').textContent = c.rows;
  $('#gridSize').textContent = `${c.maxPlayers} × ${c.rows}`;
  $('#charCount').textContent = `${S.characterCount} Charakter im Ordner`;
  $('#joinUrl').textContent = S.joinUrl;
  $('#lobbyCount').textContent = `${S.players.length} / ${c.maxPlayers}`;

  const cards = S.players.map((p) => `
    <div class="lp">
      <button class="btn small ghost kick" data-kick="${p.id}" title="Entfernen">✕</button>
      ${avatarHtml(p, 'avatar lg')}
      <b>${esc(p.name)}</b>
    </div>`);
  for (let i = S.players.length; i < c.maxPlayers; i++) cards.push('<div class="lp empty">frei</div>');
  $('#lobbyPlayers').innerHTML = cards.join('');

  const start = $('#startBtn');
  start.disabled = S.players.length < S.rules.minPlayers || !S.characterCount;
  start.textContent = S.players.length < S.rules.minPlayers
    ? `Warte auf Spieler (min. ${S.rules.minPlayers})`
    : `Spiel starten (${S.players.length} Spieler)`;
}

function shortAmount(n) {
  const a = Math.abs(n);
  if (a >= 1e9 && a % 1e7 === 0) return `${n / 1e9}Mrd`;
  if (a >= 1e6 && a % 1e5 === 0) return `${n / 1e6}M`;
  return String(n);
}

let cfgTimer;
$('#cfgPlayers').addEventListener('input', (e) => {
  $('#outPlayers').textContent = e.target.value;
  $('#gridSize').textContent = `${e.target.value} × ${$('#cfgRows').value}`;
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => act('host:config', { maxPlayers: +e.target.value }), 200);
});
$('#cfgRows').addEventListener('input', (e) => {
  $('#outRows').textContent = e.target.value;
  $('#gridSize').textContent = `${$('#cfgPlayers').value} × ${e.target.value}`;
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => act('host:config', { rows: +e.target.value }), 200);
});
$('#cfgWheel').addEventListener('change', async (e) => {
  const r = await act('host:config', { wheelValues: e.target.value });
  if (r.ok) toast('Rad-Werte gespeichert', 'ok');
});
$('#cfgColor').addEventListener('change', (e) => act('host:config', { bgColor: e.target.value }));
$('#cfgBg').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file, 1920, false);
    await act('host:background', { dataUrl });
  } catch (err) { toast(err.message); }
});
$('#bgClear').addEventListener('click', () => act('host:background', { dataUrl: null }));
$('#rescan').addEventListener('click', async () => {
  const r = await act('host:rescan');
  if (r.ok) toast(`${S.characterCount} Charakter gefunden`, 'ok');
});
$('#startBtn').addEventListener('click', () => {
  if (S.players.length < S.config.maxPlayers &&
      !confirm(`Erst ${S.players.length} von ${S.config.maxPlayers} Spielern da. Trotzdem starten? Das Raster wird ${S.players.length} × ${S.config.rows}.`)) return;
  act('host:start');
});
$('#lobbyPlayers').addEventListener('click', (e) => {
  const id = e.target.closest('[data-kick]')?.dataset.kick;
  if (id) act('host:kick', { playerId: id });
});

// ---------------------------------------------------------------------------
// Spielansicht
// ---------------------------------------------------------------------------
function renderGame() {
  const c = S.current;
  const byId = Object.fromEntries(S.players.map((p) => [p.id, p]));
  const rowsTotal = S.grid.length;

  // ----- Spielerliste links
  $('#players').innerHTML = S.players.map((p) => {
    const hasRow = !!(S.grid[S.round] && S.grid[S.round][p.column]);
    let tag = '', cls = '';
    if (S.phase === 'auction' && c) {
      if (hasRow) { tag = 'Reihe erledigt'; cls = 'done'; }
      else if (c.highest?.playerId === p.id) { tag = 'Höchstbietend'; cls = 'top'; }
      else if (c.blocked.includes(p.id)) { tag = 'Gesperrt'; cls = 'out'; }
      else if (c.withdrawn.includes(p.id)) { tag = 'Ausgestiegen'; cls = 'out'; }
      else if (c.skips.includes(p.id)) tag = 'will skippen';
      else tag = 'bietet mit';
    }
    const jokers = Object.entries(JOKER_LABEL)
      .map(([k, label]) => `<span class="jk ${p.jokers[k] ? 'used' : ''}">${label}</span>`).join('');
    return `
      <div class="pl ${cls}">
        ${p.connected ? '' : '<span class="off" title="offline"></span>'}
        ${avatarHtml(p)}
        <div class="info">
          <div class="name">${esc(p.name)}</div>
          <div class="money">${fmt(p.money)}</div>
          <div class="tag ${cls === 'top' ? 'hot' : ''}">${tag}</div>
          <div class="jokers">${jokers}</div>
        </div>
      </div>`;
  }).join('');

  // ----- Raster in der Mitte
  const rowLabel = S.phase === 'finished' ? 'Alle Reihen voll' : `Reihe <b>${S.round + 1}</b> von ${rowsTotal}`;
  const poolInfo = S.phase === 'auction' ? `Noch ${S.queueLeft} im Stapel · ${S.skippedCount} übersprungen` : '';
  $('#roundInfo').innerHTML = `<span>${rowLabel}</span><span class="muted">${poolInfo}</span>`;

  const grid = $('#grid');
  grid.style.gridTemplateColumns = `40px repeat(${S.players.length}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `44px repeat(${rowsTotal}, minmax(0, 1fr))`;
  const fresh = S.lastAward && Date.now() - S.lastAward.t < 4000 ? S.lastAward : null;
  let html = '<div></div>' + S.players.map((p) => `<div class="gh">${avatarHtml(p, 'avatar sm')}<span>${esc(p.name)}</span></div>`).join('');
  S.grid.forEach((row, r) => {
    const cur = r === S.round && S.phase !== 'finished';
    html += `<div class="rl ${cur ? 'cur' : ''}">${r + 1}</div>`;
    row.forEach((cell) => {
      if (!cell) { html += `<div class="cell ${cur ? 'cur' : ''}"></div>`; return; }
      const ch = cell.char || { name: '?', image: '' };
      const isFresh = fresh && fresh.charId === cell.charId && r === S.round;
      html += `<div class="cell ${isFresh ? 'fresh' : ''}" title="${esc(ch.name)}">
        <img src="${esc(ch.image)}" alt="">
        <div class="cap"><b>${esc(ch.name)}</b>${fmt(cell.price)}</div>
      </div>`;
    });
  });
  grid.innerHTML = html;

  // ----- Spotlight rechts
  const spot = $('#spotlight');
  if (S.phase === 'auction' && c) {
    const ch = c.char;
    const top = c.highest && byId[c.highest.playerId];
    spot.innerHTML = `
      <div class="spot-img"><img src="${esc(ch.image)}" alt=""></div>
      <div><span class="chip">${esc(ch.category)}</span></div>
      <div class="spot-name">${esc(ch.name)}</div>
      <div class="kv"><span class="muted">Startwert</span><b>${fmt(ch.value)}</b></div>
      ${top ? `
        <div class="bidder">${avatarHtml(top)}<div><div class="muted">Höchstgebot · ${esc(top.name)}</div><div class="amt">${fmt(c.highest.amount)}</div></div></div>`
      : '<div class="bidder"><div class="muted">Noch kein Gebot – jetzt am Handy bieten!</div></div>'}
      <div class="minirow">
        <span>Skippen: ${c.skips.length} / ${c.skipNeeded} nötig</span>
        <img class="miniqr" src="/api/qr" alt="QR">
      </div>
      <div class="logbox">${S.log.slice(-3).reverse().map((l) => esc(l.msg)).join('<br>')}</div>`;
  } else if (S.phase === 'finished') {
    spot.innerHTML = `<div class="finished">
      <div class="big">Raster voll!</div>
      <div>Jetzt dürft ihr ausdiskutieren, wer das beste Team hat.</div>
    </div>`;
  } else {
    spot.innerHTML = `<div class="finished"><div class="big">Rundenende</div><div>Glücksrad läuft …</div></div>`;
  }

  // ----- Gamemaster-Leiste
  const bar = $('#gmbar');
  if (!isHost) { bar.innerHTML = '<span class="lbl">Nur Anzeige</span>'; return; }
  if (S.phase === 'auction' && c) {
    const needers = c.need.map((id) => byId[id]).filter(Boolean);
    bar.innerHTML = `
      <button class="btn primary" data-act="host:hammer" ${c.highest ? '' : 'disabled'}>Zuschlag</button>
      <button class="btn" data-act="host:skipChar">Charakter skippen</button>
      <span class="lbl">Verschenken an:</span>
      ${needers.map((p) => `<button class="btn small ghost" data-give="${p.id}">${esc(p.name)}</button>`).join('')}
      <span class="sep"></span>
      <button class="btn small danger" data-reset="keep">Neu starten</button>
      <button class="btn small danger" data-reset="all">Zur Lobby</button>`;
  } else {
    bar.innerHTML = `
      <span class="sep"></span>
      <button class="btn" data-reset="keep">Neues Spiel (gleiche Spieler)</button>
      <button class="btn danger" data-reset="all">Zurück zur Lobby</button>`;
  }
}

$('#gmbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act) act(b.dataset.act);
  if (b.dataset.give) {
    const p = S.players.find((x) => x.id === b.dataset.give);
    if (confirm(`${S.current.char.name} gratis an ${p.name} geben?`)) act('host:giveChar', { playerId: p.id });
  }
  if (b.dataset.reset === 'keep' && confirm('Spiel abbrechen und mit denselben Spielern neu in der Lobby starten?')) act('host:reset', { keepPlayers: true });
  if (b.dataset.reset === 'all' && confirm('Spiel abbrechen und alle Spieler entfernen?')) act('host:reset', { keepPlayers: false });
});

// ---------------------------------------------------------------------------
// Glücksräder
// ---------------------------------------------------------------------------
const COLORS = ['#ff6b6b', '#ffcc33', '#5be3a0', '#7ad1ff', '#b48cff', '#ff9f43', '#4dd0c8', '#ff7ac6', '#9ccc65', '#6c8cff'];
const TAU = Math.PI * 2;

class Wheel {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.rot = 0;
    this.labels = [];
    this.spinning = false;
    this.draw();
  }
  setLabels(labels) {
    if (this.spinning || JSON.stringify(labels) === JSON.stringify(this.labels)) return;
    this.labels = labels;
    this.draw();
  }
  draw() {
    const { ctx } = this;
    const W = this.c.width, cx = W / 2, cy = W / 2, r = W / 2 - 8;
    ctx.clearRect(0, 0, W, W);
    const n = this.labels.length;
    if (!n) {
      ctx.fillStyle = '#2a2d5a';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
      ctx.fillStyle = '#a3a8cc'; ctx.font = '600 24px Segoe UI, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('—', cx, cy + 8);
      return;
    }
    const seg = TAU / n;
    for (let i = 0; i < n; i++) {
      const a0 = this.rot + i * seg;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a0 + seg);
      ctx.closePath();
      ctx.fillStyle = COLORS[i % COLORS.length];
      if (n % COLORS.length === 1 && i === n - 1) ctx.fillStyle = COLORS[2];
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(a0 + seg / 2);
      ctx.fillStyle = '#16142a';
      const size = n > 12 ? 17 : n > 8 ? 20 : 24;
      ctx.font = `700 ${size}px Segoe UI, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      let label = this.labels[i];
      while (ctx.measureText(label).width > r - 70 && label.length > 3) label = label.slice(0, -2) + '…';
      ctx.fillText(label, r - 16, 0);
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(cx, cy, 34, 0, TAU);
    ctx.fillStyle = '#141633'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#ffcc33'; ctx.stroke();
  }
  // Dreht so, dass Segment `target` oben unter dem Zeiger landet
  spin(labels, target, ms) {
    this.labels = labels;
    const n = labels.length, seg = TAU / n;
    let end = -Math.PI / 2 - (target + 0.5) * seg + (Math.random() - 0.5) * seg * 0.6;
    if (ms < 300) { this.rot = end; this.draw(); return; }
    while (end < this.rot + 6 * TAU) end += TAU;
    const start = this.rot, t0 = performance.now();
    this.spinning = true;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      this.rot = start + (end - start) * (1 - Math.pow(1 - t, 4));
      this.draw();
      if (t < 1) requestAnimationFrame(step);
      else { this.rot = end % TAU; this.spinning = false; this.draw(); }
    };
    requestAnimationFrame(step);
  }
}

const wheelP = new Wheel($('#wheelPlayers'));
const wheelV = new Wheel($('#wheelValues'));
let lastNonce = null;

function renderWheel() {
  const overlay = $('#wheelOverlay');
  const w = S.wheel;
  overlay.hidden = S.phase !== 'wheel' || !w;
  if (overlay.hidden) return;
  const byId = Object.fromEntries(S.players.map((p) => [p.id, p]));

  if (w.spin && w.spin.nonce !== lastNonce) {
    lastNonce = w.spin.nonce;
    const target = w.spin.kind === 'player' ? wheelP : wheelV;
    target.spin(w.spin.labels, w.spin.target, w.spin.remainingMs);
  }
  wheelP.setLabels(w.remaining.map((id) => byId[id]?.name || '?'));
  wheelV.setLabels(S.config.wheelValues.map(fmtSigned));

  let status;
  if (w.busy && w.spin?.kind === 'player') status = 'Das Rad sucht einen Spieler aus …';
  else if (w.busy) status = `Wie viel bekommt ${esc(byId[w.spin.playerId]?.name)}?`;
  else if (w.selected) status = `${esc(byId[w.selected]?.name)} ist dran – jetzt das Wert-Rad!`;
  else if (w.remaining.length) status = `Noch ${w.remaining.length} Spieler am Rad`;
  else status = 'Alle waren dran!';
  $('#wheelStatus').innerHTML = status;

  $('#wheelResults').innerHTML = w.results.map((r) => {
    const p = byId[r.playerId];
    return `<div class="res">${avatarHtml(p, 'avatar sm')} ${esc(p?.name)} <b class="${r.amount < 0 ? 'neg' : 'pos'}">${fmtSigned(r.amount)}</b></div>`;
  }).join('');

  const isLast = S.round + 1 >= S.grid.length;
  $('#spinPlayerBtn').disabled = !isHost || w.busy || !!w.selected || !w.remaining.length;
  $('#spinValueBtn').disabled = !isHost || w.busy || !w.selected;
  const next = $('#nextRoundBtn');
  next.hidden = w.remaining.length > 0 || w.busy;
  next.disabled = !isHost;
  next.textContent = isLast ? 'Spiel beenden' : `Weiter mit Reihe ${S.round + 2}`;
}

$('#spinPlayerBtn').addEventListener('click', () => act('host:spinPlayer'));
$('#spinValueBtn').addEventListener('click', () => act('host:spinValue'));
$('#nextRoundBtn').addEventListener('click', () => act('host:nextRound'));
