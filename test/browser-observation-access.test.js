import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkerRequest } from '../worker-api.js';
import {
  createMatch, createMatchInvite, importStoreState, joinMatch, joinPlayerMatch, startMatch
} from '../game/store.js';

async function readState(gameId, options = {}) {
  const url = new URL(`https://example.test/api/games/${gameId}/state`);
  url.searchParams.set('seat', String(options.seat ?? 0));
  if (options.global) url.searchParams.set('view', 'global');
  const response = await handleWorkerRequest(new Request(url, { headers: options.headers || {} }));
  return { response, body: await response.json() };
}

function startWithAgents(game, player = null) {
  if (player) {
    joinMatch(game.gameId, 1, 'agent-b');
    joinMatch(game.gameId, 2, 'agent-c');
    startMatch(game.gameId, 0, { seatSessionToken: player.seatSessionToken });
    startMatch(game.gameId, 1);
    startMatch(game.gameId, 2);
    return;
  }
  for (const seatId of [0, 1, 2]) {
    joinMatch(game.gameId, seatId, `agent-${seatId}`);
    startMatch(game.gameId, seatId);
  }
}

test('browser seat query is only a public perspective without a seat token', async () => {
  importStoreState({});
  const game = createMatch();
  startWithAgents(game);

  const { response, body } = await readState(game.gameId, { seat: 2 });
  assert.equal(response.status, 200);
  assert.equal(body.view, 'public');
  assert.equal(body.controlAuthorized, false);
  assert.deepEqual(body.hands.map((hand) => hand.cards.length), [0, 0, 0]);
});

test('browser seat token determines the private seat instead of the URL query', async () => {
  importStoreState({});
  const game = createMatch();
  const player = joinPlayerMatch(game.gameId, 0, 'player-a');
  startWithAgents(game, player);

  const { response, body } = await readState(game.gameId, {
    seat: 2,
    headers: {
      'x-seat-session-token': player.seatSessionToken,
      'x-seat-session-seat': '0'
    }
  });
  assert.equal(response.status, 200);
  assert.equal(body.view, 'player');
  assert.equal(body.you, 0);
  assert.equal(body.controlAuthorized, true);
  assert.equal(body.hands[0].cards.length > 0, true);
  assert.deepEqual(body.hands.slice(1).map((hand) => hand.cards.length), [0, 0]);
});

test('global browser view requires the room owner credential', async () => {
  importStoreState({});
  const game = createMatch();
  startWithAgents(game);

  const denied = await readState(game.gameId, { global: true });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error, 'room_owner_required');

  const allowed = await readState(game.gameId, {
    global: true,
    headers: { 'x-room-owner-token': game.roomOwnerToken }
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.body.view, 'global');
  assert.equal(allowed.body.hands.every((hand) => hand.cards.length > 0), true);
});

test('private browser observation requires a seat, owner, or spectator credential', async () => {
  importStoreState({});
  const game = createMatch({ accessMode: 'invite_only' });
  const spectator = createMatchInvite(game.gameId, 'spectator', 0, game.roomOwnerToken);

  const denied = await readState(game.gameId);
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error, 'access_denied');

  const allowed = await readState(game.gameId, {
    headers: { 'x-game-invite-token': spectator.token }
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.body.view, 'public');
  assert.deepEqual(allowed.body.hands.map((hand) => hand.cards.length), [0, 0, 0]);
});
