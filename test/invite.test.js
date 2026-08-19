import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMatch,
  createMatchInvite,
  getMatchStrategies,
  joinAgentInvite,
  joinPlayerInvite,
  resolveMatchInvite
} from '../game/store.js';

test('player invite claims one seat and permits same-player retry', () => {
  const game = createMatch();
  const invite = createMatchInvite(game.gameId, 'player', 0);

  assert.equal(invite.inviteType, 'player');
  assert.equal(invite.singleUse, true);
  assert.equal(resolveMatchInvite(invite.token).available, true);

  const joined = joinPlayerInvite(invite.token, 'browser-a', '玩家 A');
  assert.equal(joined.seatControllers[0].id, 'browser-a');
  assert.equal(resolveMatchInvite(invite.token).available, false);
  assert.equal(joinPlayerInvite(invite.token, 'browser-a', '玩家 A').seatControllers[0].id, 'browser-a');
  assert.throws(() => joinPlayerInvite(invite.token, 'browser-b', '玩家 B'), /invite_used/);
});

test('agent invite keeps local strategy outside the game server', () => {
  const game = createMatch();
  const invite = createMatchInvite(game.gameId, 'agent', 1);
  const joined = joinAgentInvite(invite.token, 'local-agent-b', '本地 Agent B');

  assert.equal(joined.seatControllers[1].type, 'agent');
  assert.equal(joined.strategy, null);
  assert.equal(getMatchStrategies(game.gameId).participants[1].strategy, undefined);
  assert.throws(() => joinPlayerInvite(invite.token, 'browser-b'), /invite_type_mismatch/);
});

test('spectator invite is reusable and does not reserve a seat', () => {
  const game = createMatch();
  const invite = createMatchInvite(game.gameId, 'spectator', 2);

  assert.equal(invite.view, 'global');
  assert.equal(invite.singleUse, false);
  assert.deepEqual(resolveMatchInvite(invite.token), resolveMatchInvite(invite.token));
  assert.throws(() => joinAgentInvite(invite.token, 'agent-c'), /invite_type_mismatch/);
});
