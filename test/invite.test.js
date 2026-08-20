import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMatch,
  createMatchInvite,
  getMatchStrategies,
  joinAgentInvite,
  joinAvailablePlayerMatch,
  joinPlayerInvite,
  joinPlayerMatch,
  resolveMatchInvite
} from '../game/store.js';

test('player invite claims one seat and permits same-player retry', () => {
  const game = createMatch();
  const invite = createMatchInvite(game.gameId, 'player', 0, game.roomOwnerToken);

  assert.equal(invite.inviteType, 'player');
  assert.equal(invite.singleUse, true);
  assert.equal(resolveMatchInvite(invite.token).available, true);

  const joined = joinPlayerInvite(invite.token, 'browser-a', '玩家 A');
  assert.equal(joined.seatControllers[0].id, 'browser-a');
  assert.equal(resolveMatchInvite(invite.token).available, false);
  assert.equal(joinPlayerInvite(invite.token, 'browser-a', '玩家 A', joined.seatSessionToken).seatControllers[0].id, 'browser-a');
  assert.throws(() => joinPlayerInvite(invite.token, 'browser-b', '玩家 B'), /invite_used/);
});

test('seatless player invite assigns the first open seat and remembers it', () => {
  const game = createMatch({ accessMode: 'invite_only' });
  joinPlayerMatch(game.gameId, 0, 'owner-a', '房主 A', { viaInvite: true });
  const invite = createMatchInvite(game.gameId, 'player', undefined, game.roomOwnerToken);

  assert.equal(invite.seatMode, 'auto');
  assert.equal(invite.seatId, null);
  assert.equal(invite.available, true);

  const joined = joinPlayerInvite(invite.token, 'browser-b');
  assert.equal(joined.you, 1);
  assert.equal(joined.seatControllers[1].displayName, '玩家 B');
  assert.equal(joined.invite.seatMode, 'auto');
  assert.equal(joined.invite.seatId, 1);
  assert.equal(joinPlayerInvite(invite.token, 'browser-b', undefined, joined.seatSessionToken).you, 1);
  assert.throws(() => joinPlayerInvite(invite.token, 'browser-c'), /invite_used/);
});

test('competing automatic invites cannot claim the same final seat', () => {
  const game = createMatch();
  joinPlayerMatch(game.gameId, 0, 'player-a');
  joinPlayerMatch(game.gameId, 1, 'player-b');
  const first = createMatchInvite(game.gameId, 'player', undefined, game.roomOwnerToken);
  const second = createMatchInvite(game.gameId, 'player', undefined, game.roomOwnerToken);

  assert.equal(joinPlayerInvite(first.token, 'player-c').you, 2);
  assert.throws(() => joinPlayerInvite(second.token, 'player-d'), /room_full/);
  assert.equal(resolveMatchInvite(second.token).available, false);
  assert.throws(() => createMatchInvite(game.gameId, 'player', undefined, game.roomOwnerToken), /room_full/);
});

test('public direct join automatically assigns a seat and reconnects idempotently', () => {
  const game = createMatch();
  joinPlayerMatch(game.gameId, 0, 'player-a');

  const joined = joinAvailablePlayerMatch(game.gameId, 'player-b');
  assert.equal(joined.you, 1);
  assert.equal(joined.seatControllers[1].displayName, '玩家 B');
  assert.equal(joinAvailablePlayerMatch(game.gameId, 'player-b', undefined, { seatSessionToken: joined.seatSessionToken }).you, 1);
});

test('private-room direct automatic join still requires an invitation', () => {
  const game = createMatch({ accessMode: 'invite_only' });
  assert.throws(() => joinAvailablePlayerMatch(game.gameId, 'visitor'), /invite_required/);
});

test('claimed player can reconnect to a restricted room without reusing the invite', () => {
  const game = createMatch({ accessMode: 'invite_only' });
  const invite = createMatchInvite(game.gameId, 'player', 0, game.roomOwnerToken);
  const joined = joinPlayerInvite(invite.token, 'browser-a', '玩家 A');

  assert.equal(joinPlayerMatch(game.gameId, 0, 'browser-a', undefined, { seatSessionToken: joined.seatSessionToken }).seatControllers[0].id, 'browser-a');
  assert.throws(() => joinPlayerMatch(game.gameId, 1, 'browser-b'), /invite_required/);
  assert.throws(() => joinPlayerMatch(game.gameId, 0, 'browser-b'), /seat_occupied/);
});

test('agent invite keeps local strategy outside the game server', () => {
  const game = createMatch();
  const invite = createMatchInvite(game.gameId, 'agent', 1, game.roomOwnerToken);
  const joined = joinAgentInvite(invite.token, 'local-agent-b', '本地 Agent B');

  assert.equal(joined.seatControllers[1].type, 'agent');
  assert.equal(joined.strategy, null);
  assert.equal(getMatchStrategies(game.gameId).participants[1].strategy, undefined);
  assert.throws(() => joinPlayerInvite(invite.token, 'browser-b'), /invite_type_mismatch/);
  assert.throws(() => createMatchInvite(game.gameId, 'agent', undefined, game.roomOwnerToken), /invalid_seat/);
});

test('spectator invite is reusable and does not reserve a seat', () => {
  const game = createMatch();
  const invite = createMatchInvite(game.gameId, 'spectator', 2, game.roomOwnerToken);

  assert.equal(invite.view, 'global');
  assert.equal(invite.singleUse, false);
  assert.deepEqual(resolveMatchInvite(invite.token), resolveMatchInvite(invite.token));
  assert.throws(() => joinAgentInvite(invite.token, 'agent-c'), /invite_type_mismatch/);
});
