import test from 'node:test';
import assert from 'node:assert/strict';
import { getStrategy as getFileStrategy, listStrategies } from '../server/strategy-catalog-node.js';
import { getStrategy as getRuntimeStrategy } from '../server/strategy-catalog-runtime.js';
import { createMatch, getMatchStrategies, joinMatch, startMatch } from '../game/store.js';

test('default strategy is one complete replaceable plan', () => {
  const listed = listStrategies();
  assert.equal(listed.defaultStrategyId, 'default');
  assert.deepEqual(listed.strategies.map((strategy) => strategy.id), ['default']);

  const strategy = getFileStrategy();
  assert.equal(strategy.id, 'default');
  assert.ok(strategy.updatedAt > 0);
  assert.match(strategy.hash, /^[a-f0-9]{12}$/);
  for (const section of [
    '## 叫地主与抢地主',
    '## 手牌感知与决策流程',
    '## 牌权与出完手数',
    '## 地主策略',
    '## 农民协作',
    '## 地主上家策略',
    '## 地主下家策略',
    '## 一张牌与少牌残局',
    '## 复盘关注'
  ]) assert.ok(strategy.markdown.includes(section), `missing strategy section: ${section}`);
  assert.match(strategy.markdown, /新一墩开始且轮到本席.*实际领牌权/);
  assert.match(strategy.markdown, /第一家不要/);
  assert.match(strategy.markdown, /第二家不要/);
  assert.match(strategy.markdown, /还需 N 手/);
  assert.match(strategy.markdown, /当前动作 -> 剩余合法组合 -> 每次继续出牌的牌权来源/);
  assert.match(strategy.markdown, /本席剩两张/);
  assert.match(strategy.markdown, /枚举所有合法单牌响应/);
  assert.match(strategy.markdown, /剩余 N 手、确定\/非确定、下一次牌权来源/);
});

test('unknown strategy ids are rejected instead of composed with default', () => {
  assert.throws(() => getFileStrategy('missing-plan'), /strategy_not_found/);
});

test('generated worker catalog stays synchronized with the editable management source', () => {
  assert.equal(getRuntimeStrategy().markdown, getFileStrategy().markdown);
});

test('managed strategy binding is explicit, read-only, and absent from ordinary observations', () => {
  const unboundGame = createMatch();
  const unbound = joinMatch(unboundGame.gameId, 0, 'unbound-agent');
  assert.equal(unbound.strategy, undefined);
  assert.deepEqual(getMatchStrategies(unboundGame.gameId).participants[0].strategy, undefined);

  const game = createMatch();
  const snapshot = getFileStrategy('default');
  const joined = joinMatch(game.gameId, 0, 'managed-agent', 'Managed Agent', { strategySnapshot: snapshot });
  assert.equal(joined.strategy, undefined);
  assert.equal(getMatchStrategies(game.gameId).participants[0].strategy.markdown, snapshot.markdown);

  startMatch(game.gameId, 0);
  assert.throws(() => joinMatch(game.gameId, 0, 'managed-agent', undefined, {
    strategySnapshot: { ...snapshot, hash: 'changed-after-ready' }
  }), /strategy_snapshot_locked/);
});
