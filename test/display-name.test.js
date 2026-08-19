import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompetition, createMatch, getMatch, joinMatch, joinPlayerMatch, observeMatch, submitMatchReview } from '../game/store.js';

test('seat controllers expose display names without replacing stable ids', () => {
  const game = createMatch();

  joinMatch(game.gameId, 0, 'codex-seat-a', 'default', '策略 Agent A');
  joinMatch(game.gameId, 1, 'codex-seat-b', 'default');
  joinPlayerMatch(game.gameId, 2, 'local-player-id', '本地玩家 C');

  const state = observeMatch(game.gameId, 0);
  assert.deepEqual(state.seatControllers[0], { type: 'agent', id: 'codex-seat-a', displayName: '策略 Agent A' });
  assert.deepEqual(state.seatControllers[1], { type: 'agent', id: 'codex-seat-b', displayName: 'codex-seat-b' });
  assert.deepEqual(state.seatControllers[2], { type: 'player', id: 'local-player-id', displayName: '本地玩家 C' });
});

test('display names reject empty or oversized values', () => {
  const game = createMatch();
  assert.throws(() => joinMatch(game.gameId, 0, 'agent-a', 'default', '   '), /invalid_display_name/);
  assert.throws(() => joinPlayerMatch(game.gameId, 1, 'player-b', 'x'.repeat(41)), /invalid_display_name/);
});

test('display names survive a competition round transition', () => {
  const competition = createCompetition({ totalRounds: 3 });
  const game = getMatch(competition.currentGameId);
  joinMatch(game.gameId, 0, 'agent-a', 'default', 'Codex A');
  joinMatch(game.gameId, 1, 'agent-b', 'default', 'Codex B');
  joinMatch(game.gameId, 2, 'agent-c', 'default', 'Codex C');
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
  const nextState = observeMatch(result.competition.currentGameId, 0);

  assert.equal(nextState.seatControllers[0].displayName, 'Codex A');
  assert.equal(nextState.seatControllers[1].displayName, 'Codex B');
  assert.equal(nextState.seatControllers[2].displayName, 'Codex C');
});
