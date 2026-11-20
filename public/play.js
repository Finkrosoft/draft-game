'use strict';

const TOKEN_KEY = 'charakter-auktion-token';
const socket = io();
let S = null;
let meId = null;
let photoData = null;
let jokerOpen = null;   // 'block' | 'swap' | null
let swapRow = null;
let lastBidKey = null;

socket.on('connect', async () => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    const r = await emit(socket, 'player:resume', { token });
    if (r.ok) meId = r.playerId;
    else { localStorage.removeItem(TOKEN_KEY); meId = null; }
  }
  render();
});
socket.on('disconnect', () => toast('Verbindung verloren – verbinde neu …'));
socket.on('kicked', () => {
  localStorage.removeItem(TOKEN_KEY);
  meId = null;
  toast('Du wurdest aus der Lobby entfernt.');
  render();
});
socket.on('state', (s) => { S = s; render(); });

async function act(event, payload) {
  const r = await emit(socket, event, payload);
  if (!r.ok) toast(r.error);
  return r;
}

const me = () => S?.players.find((p) => p.id === meId);

// ---------------------------------------------------------------------------
function render() {
  if (!S) return;
  const p = me();
  $('#joinView').hidden = !!p;
  $('#waitView').hidden = !p || S.phase !== 'lobby';
  $('#gameView').hidden = !p || S.phase === 'lobby';
  if (!p) return renderJoin();
  if (S.phase === 'lobby') return renderWait(p);
  renderGame(p);
}

function headerHtml(p) {
  return `${avatarHtml(p)}<div><div class="name">${esc(p.name)}</div><div class="money">${fmt(p.money)}</div></div>`;
}

function renderJoin() {
  const full = S.players.length >= S.config.maxPlayers;
  let note = `${S.players.length} / ${S.config.maxPlayers} Spieler in der Lobby`;
  if (S.phase !== 'lobby') note = 'Das Spiel läuft schon. Warte auf die nächste Runde.';
  else if (full) note = 'Die Lobby ist voll.';
  $('#joinNote').textContent = note;
}

function renderWait(p) {
  $('#meHeaderWait').innerHTML = headerHtml(p);
  $('#waitText').textContent = `${S.players.length} / ${S.config.maxPlayers} Spieler · Der Gamemaster startet gleich.`;
  $('#waitPlayers').innerHTML = S.players.map((x) => `<span class="chipP">${avatarHtml(x, 'avatar sm')}${esc(x.name)}</span>`).join('');
}

// ---------------------------------------------------------------------------
function renderGame(p) {
  $('#meHeader').innerHTML = headerHtml(p);
  const c = S.current;
  const byId = Object.fromEntries(S.players.map((x) => [x.id, x]));
  const myCell = S.grid[S.round] && S.grid[S.round][p.column];
  const box = $('#phaseBox');
  const bidBox = $('#bidBox');
  bidBox.hidden = true;

  if (S.phase === 'auction' && c) {
    const ch = c.char;
    const top = c.highest && byId[c.highest.playerId];
    const minNext = c.highest ? c.highest.amount + 1e6 : ch.value;
    let status, statusCls = '';
    let canBid = false;

    if (myCell) status = `Du hast deinen Charakter für Reihe ${S.round + 1}: <b>${esc(myCell.char?.name)}</b>. Warte, bis alle einen haben.`;
    else if (c.blocked.includes(p.id)) { status = 'Du wurdest für diesen Charakter gesperrt.'; statusCls = 'warn'; }
    else if (c.withdrawn.includes(p.id)) status = 'Du bist ausgestiegen.';
    else if (top && top.id === p.id) { status = `Du bietest am höchsten: <b>${fmt(c.highest.amount)}</b>`; statusCls = 'hot'; }
    else {
      canBid = true;
      status = top
        ? `Höchstgebot: <b>${fmt(c.highest.amount)}</b> von ${esc(top.name)}`
        : `Noch kein Gebot · Mindestens <b>${fmt(ch.value)}</b>`;
      if (minNext > p.money) { status += '<br>Du hast nicht genug Kohle zum Überbieten.'; statusCls = 'warn'; }
    }

    box.innerHTML = `
      <div class="panel">
        <div class="charcard">
          <img src="${esc(ch.image)}" alt="">
          <div>
            <div class="cname">${esc(ch.name)}</div>
            <span class="cat">${esc(ch.category)}</span>
            <div class="muted">Startwert ${fmt(ch.value)}</div>
          </div>
        </div>
        <div class="status ${statusCls}">${status}</div>
      </div>`;

    const canVote = !myCell && !c.blocked.includes(p.id);
    if (canVote) {
      bidBox.hidden = false;
      const key = `${ch.id}|${c.highest?.amount ?? 0}`;
      const input = $('#bidInput');
      if (key !== lastBidKey && document.activeElement !== input) input.value = toMio(Math.min(minNext, Math.max(p.money, minNext)));
      lastBidKey = key;
      $('#bidBtn').disabled = !canBid || minNext > p.money;
      bidBox.querySelectorAll('.quick button').forEach((b) => (b.disabled = !canBid));
      $('#withdrawBtn').disabled = !canBid;
      const voted = c.skips.includes(p.id);
      const skipBtn = $('#skipBtn');
      skipBtn.textContent = `${voted ? 'Skip zurücknehmen' : 'Skippen'} (${c.skips.length}/${c.skipNeeded})`;
      skipBtn.classList.toggle('on', voted);
    }
  } else if (S.phase === 'wheel') {
    const w = S.wheel;
    const mine = w.results.find((r) => r.playerId === p.id);
    let txt = 'Schaut auf den Fernseher – das Glücksrad dreht sich!';
    if (mine) txt = `Du hast <b>${fmtSigned(mine.amount)}</b> bekommen.`;
    else if (w.selected === p.id) txt = '<b>Du bist dran!</b> Gleich dreht das Wert-Rad …';
    box.innerHTML = `<div class="panel center"><h2>Rundenende</h2><div>${txt}</div></div>`;
  } else if (S.phase === 'finished') {
    box.innerHTML = `<div class="panel center"><h2>Raster voll!</h2><div class="muted">Jetzt wird diskutiert, wer gewonnen hat.</div></div>`;
  }

  renderJokers(p, byId);
  renderMyGrid(p);
}

const toMio = (n) => +(n / 1e6).toFixed(1);

// ---------------------------------------------------------------------------
function renderJokers(p, byId) {
  const box = $('#jokerBox');
  if (S.phase === 'finished') { box.hidden = true; return; }
  box.hidden = false;
  const c = S.current;
  const inAuction = S.phase === 'auction' && c;

  // Sperre: Ziele = Spieler, die noch mitbieten können
  const blockTargets = inAuction
    ? S.players.filter((x) => x.id !== p.id && c.need.includes(x.id) && !c.blocked.includes(x.id) && c.highest?.playerId !== x.id)
    : [];

  // Tausch: Reihen, in denen ich und mindestens ein anderer einen Charakter haben
  const swapRows = S.grid
    .map((row, r) => ({ r, mine: row[p.column], others: S.players.filter((x) => x.id !== p.id && row[x.column]) }))
    .filter((x) => x.mine && x.others.length);

  const card = (type, title, desc, enabled, extra = '') => `
    <div class="joker ${p.jokers[type] ? 'used' : ''}">
      <div><div class="t">${title}</div><div class="d">${p.jokers[type] ? 'verbraucht' : desc}</div></div>
      <button class="btn small ${jokerOpen === type ? 'on' : ''}" data-joker="${type}" ${p.jokers[type] || !enabled ? 'disabled' : ''}>
        ${type === 'monster' ? 'Einsetzen' : jokerOpen === type ? 'Abbrechen' : 'Wählen'}
      </button>
    </div>${extra}`;

  let blockPicker = '';
  if (jokerOpen === 'block') {
    blockPicker = `<div class="picker">${blockTargets.map((x) => `<button class="btn" data-block="${x.id}">${esc(x.name)}</button>`).join('') || '<span class="muted">Niemand sperrbar</span>'}</div>`;
  }
  let swapPicker = '';
  if (jokerOpen === 'swap') {
    const sel = swapRows.find((x) => x.r === swapRow);
    swapPicker = `<div class="picker">${swapRows.map((x) => `<button class="btn ${x.r === swapRow ? 'on' : ''}" data-row="${x.r}">Reihe ${x.r + 1}</button>`).join('')}</div>`;
    if (sel) {
      swapPicker += `<div class="picker">${sel.others.map((x) => {
        const cell = S.grid[sel.r][x.column];
        return `<button class="btn" data-swap="${x.id}">${esc(x.name)}: ${esc(cell.char?.name)}</button>`;
      }).join('')}</div>`;
    }
  }

  box.innerHTML = `<h3>Joker <span class="muted">(je 1× pro Spiel)</span></h3>` +
    card('monster', 'Weißes Monster', `+${fmt(S.rules.monsterBonus)} zum Bieten`, true) +
    card('block', 'Sperre', 'Einen Spieler für diesen Charakter sperren', blockTargets.length > 0, blockPicker) +
    card('swap', 'Tausch', 'Charakter in derselben Reihe tauschen', swapRows.length > 0, swapPicker);
}

function renderMyGrid(p) {
  const rows = S.grid.map((row, r) => {
    const cell = row[p.column];
    return `<div class="mrow"><span class="n">${r + 1}</span>${cell
      ? `<img src="${esc(cell.char?.image)}" alt=""><span>${esc(cell.char?.name)} <span class="muted">· ${fmt(cell.price)}</span></span>`
      : '<span class="empty"></span>'}</div>`;
  }).join('');
  $('#myGrid').innerHTML = `<h3>Dein Raster</h3><div class="rows">${rows}</div>`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
$('#photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    photoData = await resizeImage(file, 320, true);
    const img = $('#photoPreview');
    img.src = photoData;
    img.hidden = false;
    $('#photoHint').hidden = true;
  } catch (err) { toast(err.message); }
});

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await act('player:join', { name: $('#nameInput').value, avatar: photoData });
  if (r.ok) {
    localStorage.setItem(TOKEN_KEY, r.token);
    meId = r.playerId;
    render();
  }
});

$('#leaveBtn').addEventListener('click', async () => {
  const r = await act('player:leave');
  if (r.ok) { localStorage.removeItem(TOKEN_KEY); meId = null; render(); }
});

$('#bidBox').addEventListener('click', (e) => {
  const q = e.target.closest('[data-q]')?.dataset.q;
  if (!q) return;
  const p = me(), c = S.current;
  const minNext = c.highest ? c.highest.amount + 1e6 : c.char.value;
  const input = $('#bidInput');
  const cur = Math.max(Math.round(parseFloat(input.value) * 1e6) || 0, minNext);
  let val = cur;
  if (q === 'min') val = minNext;
  else if (q === 'all') val = p.money;
  else val = cur + Number(q) * 1e6;
  input.value = toMio(Math.min(val, p.money));
});

$('#bidBtn').addEventListener('click', async () => {
  const amount = Math.round(parseFloat($('#bidInput').value.replace(',', '.')) * 1e6);
  if (!Number.isFinite(amount)) return toast('Bitte einen Betrag eingeben.');
  const r = await act('bid', { amount });
  if (r.ok) { $('#bidInput').blur(); toast(`Geboten: ${fmt(amount)}`, 'ok'); }
});

$('#withdrawBtn').addEventListener('click', () => {
  if (confirm('Bei diesem Charakter aussteigen?')) act('withdraw');
});
$('#skipBtn').addEventListener('click', () => act('skip'));

$('#jokerBox').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const p = me();
  if (b.dataset.joker === 'monster') {
    if (confirm(`Weißes Monster einsetzen? +${fmt(S.rules.monsterBonus)}`)) {
      const r = await act('joker', { type: 'monster' });
      if (r.ok) toast(`+${fmt(S.rules.monsterBonus)}!`, 'ok');
    }
    return;
  }
  if (b.dataset.joker) {
    jokerOpen = jokerOpen === b.dataset.joker ? null : b.dataset.joker;
    swapRow = null;
    return render();
  }
  if (b.dataset.block) {
    const t = S.players.find((x) => x.id === b.dataset.block);
    if (!confirm(`${t.name} für ${S.current.char.name} sperren?`)) return;
    const r = await act('joker', { type: 'block', targetId: t.id });
    if (r.ok) { jokerOpen = null; toast(`${t.name} gesperrt`, 'ok'); }
    return render();
  }
  if (b.dataset.row !== undefined) { swapRow = Number(b.dataset.row); return render(); }
  if (b.dataset.swap) {
    const t = S.players.find((x) => x.id === b.dataset.swap);
    const mine = S.grid[swapRow][p.column], theirs = S.grid[swapRow][t.column];
    if (!confirm(`${mine.char?.name} gegen ${theirs.char?.name} von ${t.name} tauschen?`)) return;
    const r = await act('joker', { type: 'swap', targetId: t.id, row: swapRow });
    if (r.ok) { jokerOpen = null; swapRow = null; toast('Getauscht!', 'ok'); }
    render();
  }
});
