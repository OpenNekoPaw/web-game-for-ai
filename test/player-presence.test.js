import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceMatchTimeout,
  createMatch,
  joinAvailablePlayerMatch,
  joinPlayerMatch,
  observeMatch,
  reconnectPlayerMatch,
  removeDisconnectedPlayer,
  startMatch,
  submitMatchAction,
  tickMatches
} from '../game/store.js';

test('seat session token prevents another client from impersonating the same player id', () => {
  const game = createMatch();
  const joined = joinAvailablePlayerMatch(game.gameId, 'public-player');

  assert.match(joined.seatSessionToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.match(joined.reconnectCode, /^[A-Z0-9]{8}$/);
  assert.throws(() => joinAvailablePlayerMatch(game.gameId, 'public-player'), /seat_session_required/);
  assert.equal(joinAvailablePlayerMatch(game.gameId, 'public-player', undefined, { seatSessionToken: joined.seatSessionToken }).you, joined.you);
  assert.throws(() => startMatch(game.gameId, joined.you), /seat_session_required/);
  assert.equal(startMatch(game.gameId, joined.you, { seatSessionToken: joined.seatSessionToken }).readySeats.includes(joined.you), true);
});

test('reconnect code rotates the seat token and restores control on another device', () => {
  const game = createMatch();
  const joined = joinPlayerMatch(game.gameId, 1, 'player-b');
  const reconnected = reconnectPlayerMatch(game.gameId, joined.reconnectCode);

  assert.equal(reconnected.you, 1);
  assert.notEqual(reconnected.seatSessionToken, joined.seatSessionToken);
  assert.notEqual(reconnected.reconnectCode, joined.reconnectCode);
  assert.throws(() => joinPlayerMatch(game.gameId, 1, 'player-b', undefined, { seatSessionToken: joined.seatSessionToken }), /seat_session_required/);
  assert.equal(joinPlayerMatch(game.gameId, 1, 'player-b', undefined, { seatSessionToken: reconnected.seatSessionToken }).controlAuthorized, true);
});

test('waiting player is released after 60 seconds offline', () => {
  const game = createMatch();
  const joined = joinPlayerMatch(game.gameId, 0, 'waiting-player');
  const lastSeenAt = game.playerSessions.get(0).lastSeenAt;

  tickMatches(lastSeenAt + 59_999);
  assert.equal(game.players.get(0), 'waiting-player');
  tickMatches(lastSeenAt + 60_000);
  assert.equal(game.players.has(0), false);
  assert.equal(game.playerSessions.has(0), false);
  assert.throws(() => reconnectPlayerMatch(game.gameId, joined.reconnectCode), /invalid_reconnect_code/);
});

test('room owner can remove an offline waiting player but not an online one', () => {
  const game = createMatch();
  joinPlayerMatch(game.gameId, 2, 'waiting-player-c');
  const lastSeenAt = game.playerSessions.get(2).lastSeenAt;

  assert.throws(() => removeDisconnectedPlayer(game.gameId, 2, 'wrong-token', lastSeenAt + 10_000), /room_owner_required/);
  assert.throws(() => removeDisconnectedPlayer(game.gameId, 2, game.roomOwnerToken, lastSeenAt + 9_999), /player_still_online/);
  removeDisconnectedPlayer(game.gameId, 2, game.roomOwnerToken, lastSeenAt + 10_000);
  assert.equal(game.players.has(2), false);
});

test('offline player remains seated after start and the managed strategy acts for it', () => {
  const game = createMatch();
  const joined = [0, 1, 2].map((seatId) => joinPlayerMatch(game.gameId, seatId, `player-${seatId}`));
  for (const seatId of [0, 1, 2]) startMatch(game.gameId, seatId, { seatSessionToken: joined[seatId].seatSessionToken });
  const managedSeat = game.current;
  const session = game.playerSessions.get(managedSeat);
  const managedAt = session.lastSeenAt + 10_000;

  session.lastSeenAt = managedAt - 10_000;
  const result = advanceMatchTimeout(game.gameId, managedAt);

  assert.equal(result.managed, true);
  assert.equal(game.players.get(managedSeat), `player-${managedSeat}`);
  assert.equal(game.actionHistory.at(-1).source, 'managed');
  session.lastSeenAt = Date.now() - 10_001;
  assert.equal(observeMatch(game.gameId, managedSeat).seatPresence[managedSeat].status, 'managed');
  assert.throws(() => submitMatchAction(game.gameId, game.current, { type: 'bid', value: 0 }, game.seq), /seat_session_required/);
});
