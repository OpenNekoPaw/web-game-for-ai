import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom,
  exportStoreState,
  getMatch,
  importStoreState,
  joinRoomAgent,
  joinRoomPlayer,
  observeRoom,
  readyRoom,
  submitRoomAction
} from '../game/store.js';

test('room exists before its first game and creates the game only after all seats are ready', () => {
  const room = createRoom({ totalRounds: 1, accessMode: 'open' });

  assert.match(room.roomId, /^room-[a-f0-9]{32}$/);
  assert.equal(room.gameId, null);
  assert.equal(room.room.currentGameId, null);

  const a = joinRoomPlayer(room.roomId, 0, 'player-a');
  joinRoomAgent(room.roomId, 1, 'agent-b', 'Agent B');
  joinRoomAgent(room.roomId, 2, 'agent-c', 'Agent C');
  readyRoom(room.roomId, 0, { seatSessionToken: a.seatSessionToken });
  readyRoom(room.roomId, 1);
  const started = readyRoom(room.roomId, 2);

  assert.match(started.gameId, /^ddz-\d+$/);
  assert.equal(started.roomId, room.roomId);
  assert.equal(started.room.currentGameId, started.gameId);
  assert.equal(started.phase, 'bid');
  assert.equal(getMatch(started.gameId).roomId, room.roomId);
});

test('room is the access authority and competition and game receive immutable access snapshots', () => {
  const room = createRoom({ totalRounds: 3, accessMode: 'private' });
  joinRoomAgent(room.roomId, 0, 'agent-a', undefined, { viaInvite: true });
  joinRoomAgent(room.roomId, 1, 'agent-b', undefined, { viaInvite: true });
  joinRoomAgent(room.roomId, 2, 'agent-c', undefined, { viaInvite: true });
  readyRoom(room.roomId, 0);
  readyRoom(room.roomId, 1);
  const started = readyRoom(room.roomId, 2);
  const game = getMatch(started.gameId);

  assert.equal(started.accessMode, 'private');
  assert.equal(started.competition.accessMode, 'private');
  assert.equal(game.accessMode, 'private');
  assert.equal(game.roomId, room.roomId);
  assert.equal(started.competition.roomId, room.roomId);
});

test('private room cannot be opened by room id alone', () => {
  const room = createRoom({ accessMode: 'private' });
  assert.throws(() => observeRoom(room.roomId, 0, { requireAuthorization: true }), /access_denied/);
  assert.equal(observeRoom(room.roomId, 0, {
    requireAuthorization: true,
    roomOwnerToken: room.roomOwnerToken
  }).roomId, room.roomId);
});

test('legacy invite-only input migrates to the private room type', () => {
  const room = createRoom({ accessMode: 'invite_only' });
  assert.equal(room.accessMode, 'private');
});

test('room actions reject a stale historical game id', () => {
  const room = createRoom();
  joinRoomAgent(room.roomId, 0, 'agent-a');
  joinRoomAgent(room.roomId, 1, 'agent-b');
  joinRoomAgent(room.roomId, 2, 'agent-c');
  readyRoom(room.roomId, 0);
  readyRoom(room.roomId, 1);
  const started = readyRoom(room.roomId, 2);

  assert.throws(() => submitRoomAction(room.roomId, 'ddz-historical', started.current, { type: 'bid', value: 0 }, started.seq), /stale_game/);
});

test('room metadata is persisted separately from recoverable game records', () => {
  const room = createRoom({ totalRounds: 5 });
  const snapshot = exportStoreState({ includeGames: false, includeReplays: false });
  const stored = snapshot.rooms.find(([roomId]) => roomId === room.roomId)?.[1];

  assert.equal(stored.currentGameId, null);
  assert.equal(stored.totalRounds, 5);
  assert.equal(stored.accessMode, 'open');
});

test('room restores its stable identity and current game after interruption', () => {
  const room = createRoom();
  for (const seatId of [0, 1, 2]) joinRoomAgent(room.roomId, seatId, `restore-agent-${seatId}`);
  readyRoom(room.roomId, 0);
  readyRoom(room.roomId, 1);
  const started = readyRoom(room.roomId, 2);
  const snapshot = exportStoreState();

  importStoreState(snapshot);
  const restored = observeRoom(room.roomId, 0);
  assert.equal(restored.roomId, room.roomId);
  assert.equal(restored.gameId, started.gameId);
  assert.equal(restored.phase, 'bid');
  assert.equal(restored.room.currentGameId, started.gameId);
});
