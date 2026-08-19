import test from 'node:test';
import assert from 'node:assert/strict';
import { getStrategy, listStrategies } from '../game/strategy-store.js';

test('default strategy is one complete replaceable plan', () => {
  const listed = listStrategies();
  assert.equal(listed.defaultStrategyId, 'default');
  assert.deepEqual(listed.strategies.map((strategy) => strategy.id), ['default']);

  const strategy = getStrategy();
  assert.equal(strategy.id, 'default');
  assert.ok(strategy.updatedAt > 0);
  assert.match(strategy.hash, /^[a-f0-9]{12}$/);
  for (const section of [
    '## 叫地主与抢地主',
    '## 手牌感知与决策流程',
    '## 地主策略',
    '## 农民协作',
    '## 地主上家策略',
    '## 地主下家策略',
    '## 一张牌与少牌残局',
    '## 复盘关注'
  ]) assert.ok(strategy.markdown.includes(section), `missing strategy section: ${section}`);
});

test('unknown strategy ids are rejected instead of composed with default', () => {
  assert.throws(() => getStrategy('missing-plan'), /strategy_not_found/);
});
