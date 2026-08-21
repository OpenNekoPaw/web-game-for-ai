import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionRecord } from '../game/store.js';

test('decision records bind the game and immutable strategy identity', () => {
  const strategy = {
    id: 'default',
    name: '默认完整策略',
    updatedAt: 1700000000000,
    hash: 'abc123def456',
    description: 'test strategy',
    markdown: '# strategy'
  };
  const game = {
    gameId: 'ddz-123',
    seq: 8,
    phase: 'play',
    strategySnapshots: new Map([[1, strategy]])
  };

  const record = createDecisionRecord(
    game,
    1,
    { type: 'pass' },
    { summary: '让牌前先判断地主能否低成本接牌', confidence: 0.7 },
    { source: 'agent', decidedAt: 1600, turnStartedAt: 1000 }
  );

  assert.equal(record.gameId, 'ddz-123');
  assert.equal(record.seatId, 1);
  assert.equal(record.durationMs, 600);
  assert.deepEqual(record.strategy, {
    id: 'default',
    name: '默认完整策略',
    updatedAt: 1700000000000,
    hash: 'abc123def456'
  });
  strategy.name = 'changed after decision';
  assert.equal(record.strategy.name, '默认完整策略');
  assert.equal(record.strategy.markdown, undefined);
});
