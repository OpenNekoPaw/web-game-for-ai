import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCompetition,
  createMatch,
  createMatchInvite,
  getMatch,
  getReplay,
  joinAgentInvite,
  joinMatch,
  joinPlayerMatch,
  observeMatch,
  startMatch,
  submitMatchReview
} from '../game/store.js';

test('access modes distinguish open, invite-only, and private admission', () => {
  const open = createMatch();
  assert.equal(observeMatch(open.gameId, 0).accessMode, 'open');
  assert.equal(joinMatch(open.gameId, 0, 'open-agent').seatControllers[0].id, 'open-agent');

  const inviteOnly = createMatch({ accessMode: 'invite_only' });
  assert.throws(() => joinMatch(inviteOnly.gameId, 0, 'direct-agent'), /invite_required/);
  assert.throws(() => joinPlayerMatch(inviteOnly.gameId, 1, 'direct-player'), /invite_required/);
  const invite = createMatchInvite(inviteOnly.gameId, 'agent', 0, inviteOnly.roomOwnerToken);
  assert.equal(joinAgentInvite(invite.token, 'invited-agent').seatControllers[0].id, 'invited-agent');

  const privateGame = createMatch({
    accessMode: 'private',
    allowedAgentIds: ['allowed-agent'],
    allowedPlayerIds: ['allowed-player']
  });
  assert.equal(joinMatch(privateGame.gameId, 0, 'allowed-agent').seatControllers[0].id, 'allowed-agent');
  assert.equal(joinPlayerMatch(privateGame.gameId, 1, 'allowed-player').seatControllers[1].id, 'allowed-player');
  assert.throws(() => joinMatch(privateGame.gameId, 2, 'unknown-agent'), /access_denied/);
});

test('agent metadata is normalized, replayed, and locked when the seat is ready', () => {
  const game = createMatch();
  const initial = joinMatch(game.gameId, 0, 'agent-a', undefined, 'Agent A', {
    strategyMode: 'local',
    agentMetadata: {
      modelId: 'gpt-5.6',
      reasoningEffort: 'high',
      provider: 'openai',
      clientVersion: 'arena-0.3.0',
      strategyId: 'local-default',
      strategyHash: 'sha256:abc'
    }
  });
  assert.deepEqual(initial.seatControllers[0].agentMetadata, {
    source: 'declared',
    modelId: 'gpt-5.6',
    reasoningEffort: 'high',
    provider: 'openai',
    clientVersion: 'arena-0.3.0',
    strategyId: 'local-default',
    strategyHash: 'sha256:abc'
  });

  joinMatch(game.gameId, 0, 'agent-a', undefined, undefined, {
    strategyMode: 'local',
    agentMetadata: { modelId: 'gpt-5.6', reasoningEffort: 'xhigh' }
  });
  startMatch(game.gameId, 0);
  assert.throws(() => joinMatch(game.gameId, 0, 'agent-a', undefined, undefined, {
    strategyMode: 'local',
    agentMetadata: { modelId: 'gpt-5.6', reasoningEffort: 'low' }
  }), /agent_metadata_locked/);

  const replay = getReplay(game.gameId);
  assert.equal(replay.participants[0].agentMetadata.reasoningEffort, 'xhigh');
  assert.equal(replay.frames.at(-1).state.accessMode, 'open');
});

test('competition preserves access mode and agent metadata across rounds', () => {
  const competition = createCompetition({ totalRounds: 3, accessMode: 'private', allowedAgentIds: ['a', 'b', 'c'] });
  const game = getMatch(competition.currentGameId);
  assert.match(competition.replayAccessToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(game.replayAccessToken, competition.replayAccessToken);
  for (const [seatId, agentId] of ['a', 'b', 'c'].entries()) {
    joinMatch(game.gameId, seatId, agentId, undefined, agentId.toUpperCase(), {
      strategyMode: 'local',
      agentMetadata: { modelId: `model-${agentId}`, reasoningEffort: 'medium' }
    });
  }
  game.phase = 'over';
  const review = {
    assessment: '测试复盘',
    problems: ['测试问题'],
    improvements: ['测试改进'],
    strategySuggestions: ['测试建议']
  };
  submitMatchReview(game.gameId, 0, review);
  submitMatchReview(game.gameId, 1, review);
  const result = submitMatchReview(game.gameId, 2, review);
  const next = observeMatch(result.competition.currentGameId, 0);

  assert.equal(next.accessMode, 'private');
  assert.equal(getMatch(result.competition.currentGameId).replayAccessToken, competition.replayAccessToken);
  assert.equal(next.seatControllers[0].agentMetadata.modelId, 'model-a');
  assert.equal(next.seatControllers[2].agentMetadata.reasoningEffort, 'medium');
});

test('invalid access and metadata inputs are rejected', () => {
  assert.throws(() => createMatch({ accessMode: 'public' }), /invalid_access_mode/);
  assert.throws(() => createMatch({ allowedAgentIds: 'agent-a' }), /invalid_access_list/);
  const game = createMatch();
  assert.throws(() => joinMatch(game.gameId, 0, 'agent-a', undefined, undefined, {
    agentMetadata: {}
  }), /invalid_agent_metadata/);
});
