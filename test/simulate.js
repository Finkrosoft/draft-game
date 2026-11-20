'use strict';
// Spielt ein komplettes Spiel automatisch durch: node test/simulate.js
// Erwartet einen laufenden Server mit SPIN_MS=60 auf PORT (Standard 3999).
const { io } = require('socket.io-client');
const assert = require('assert');

const URL = `http://localhost:${process.env.PORT || 3999}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () => new Promise((res) => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => res(s)); });
const emit = (s, ev, p) => new Promise((res) => s.emit(ev, p || {}, res));
let state;

(async () => {
  const host = await connect();
  host.on('state', (s) => (state = s));
  assert((await emit(host, 'host:hello')).ok, 'host hello');
  await emit(host, 'host:reset', { keepPlayers: false });
  assert((await emit(host, 'host:config', { maxPlayers: 3, rows: 5, wheelValues: '0, 50M, -20M, 1Mrd' })).ok);
  assert(!(await emit(host, 'host:config', { rows: 11 })).ok, 'rows limit');

  const names = ['Soso', 'Mia', 'Tom'];
  const ps = [];
  for (const name of names) {
    const s = await connect();
    const r = await emit(s, 'player:join', { name });
    assert(r.ok, r.error);
    ps.push({ s, id: r.playerId, name });
  }
  const extra = await connect();
  assert(!(await emit(extra, 'player:join', { name: 'Zu viel' })).ok, 'lobby full');

  // Nicht-Host darf nicht starten
  assert(!(await emit(ps[0].s, 'host:start')).ok, 'player cannot start');
  assert((await emit(host, 'host:start')).ok);
  await sleep(50);
  assert.equal(state.phase, 'auction');
  assert.equal(state.grid.length, 5);
  assert.equal(state.grid[0].length, 3);

  const P = (i) => ps[i];
  const money = (id) => state.players.find((p) => p.id === id).money;

  // --- Validierungen
  const ch = state.current.char;
  let r = await emit(P(0).s, 'bid', { amount: ch.value - 1 });
  assert(!r.ok, 'below start value');
  r = await emit(P(0).s, 'bid', { amount: 2e9 });
  assert(!r.ok, 'more than money');

  // --- Monster-Joker
  r = await emit(P(1).s, 'joker', { type: 'monster' });
  assert(r.ok); await sleep(30);
  assert.equal(money(P(1).id), 1.1e9);
  assert(!(await emit(P(1).s, 'joker', { type: 'monster' })).ok, 'joker only once');

  // --- Sperre: P0 sperrt P2, P1 bietet, P0 bietet höher, P1 steigt aus -> P0 gewinnt
  assert((await emit(P(0).s, 'joker', { type: 'block', targetId: P(2).id })).ok);
  assert(!(await emit(P(2).s, 'bid', { amount: ch.value })).ok, 'blocked cannot bid');
  assert((await emit(P(1).s, 'bid', { amount: ch.value })).ok);
  assert(!(await emit(P(1).s, 'withdraw')).ok, 'highest cannot withdraw');
  assert((await emit(P(0).s, 'bid', { amount: ch.value + 5e6 })).ok);
  assert((await emit(P(1).s, 'withdraw')).ok);
  await sleep(30);
  assert.equal(state.grid[0][0].charId, ch.id, 'P0 got char');
  assert.equal(money(P(0).id), 1e9 - ch.value - 5e6);

  // --- Skip per Mehrheit (2 von 2 verbleibenden)
  const before = state.current.char.id;
  await emit(P(1).s, 'skip'); await emit(P(2).s, 'skip');
  await sleep(30);
  assert.notEqual(state.current.char.id, before, 'skipped');
  assert.equal(state.skippedCount, 1);

  // --- Restliches Spiel: jeweils erster Bedürftiger bietet Startwert, Rest steigt aus
  let guard = 0;
  while (state.phase !== 'finished' && guard++ < 500) {
    if (state.phase === 'auction') {
      const c = state.current;
      const need = c.need.map((id) => ps.find((p) => p.id === id));
      const rich = need.find((p) => money(p.id) >= c.char.value);
      if (!rich) { assert((await emit(host, 'host:giveChar', { playerId: need[0].id })).ok); await sleep(20); continue; }
      assert((await emit(rich.s, 'bid', { amount: c.char.value })).ok);
      for (const p of need) if (p !== rich) await emit(p.s, 'withdraw');
      await sleep(20);
    } else if (state.phase === 'wheel') {
      if (state.wheel.busy) { await sleep(40); continue; }
      if (state.wheel.selected) assert((await emit(host, 'host:spinValue')).ok);
      else if (state.wheel.remaining.length) assert((await emit(host, 'host:spinPlayer')).ok);
      else {
        // Tausch-Joker einmal testen
        if (!state.players[2].jokers.swap) {
          const row = 0;
          assert((await emit(P(2).s, 'joker', { type: 'swap', targetId: P(0).id, row })).ok);
          await sleep(20);
        }
        assert((await emit(host, 'host:nextRound')).ok);
      }
      await sleep(30);
      // Während das Rad dreht, muss ein zweiter Spin abgelehnt werden
      if (state.wheel?.busy) assert(!(await emit(host, 'host:spinPlayer')).ok, 'busy guard');
      await sleep(90);
    }
  }
  assert.equal(state.phase, 'finished');
  assert(state.grid.every((row) => row.every(Boolean)), 'grid full');
  const ids = state.grid.flat().map((c) => c.charId);
  console.log('Raster:', state.grid.map((row) => row.map((c) => c.char.name.padEnd(14)).join(' ')).join('\n        '));
  console.log('Geld:', state.players.map((p) => `${p.name}: ${(p.money / 1e6).toFixed(0)} Mio`).join(', '));
  console.log('Log (Ende):', state.log.map((l) => l.msg).join(' | '));
  console.log(`\nOK – Spiel komplett durchgelaufen (${ids.length} Felder, ${new Set(ids).size} verschiedene Charakter).`);
  process.exit(0);
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
