import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, startGame } from '../game/ddz.js';
import { calculateSettlement } from '../game/store.js';

test('play statistics record bombs and rockets for settlement', () => {
  const game = createGame('ddz-scoring-actions');
  startGame(game);
  game.phase = 'play';
  game.landlord = 0;
  game.current = 0;
  game.hands = [['3:0', '3:1', '3:2', '3:3', '4:0'], ['5:0'], ['6:0']];

  applyAction(game, 0, { type: 'play', cards: ['3:0', '3:1', '3:2', '3:3'] });
  game.current = 1;
  game.lastPlay = null;
  game.tablePlays = [null, null, null];
  game.hands[1] = ['16:0', '17:0', '5:0'];
  applyAction(game, 1, { type: 'play', cards: ['16:0', '17:0'] });

  assert.deepEqual(game.playsBySeat, [1, 1, 0]);
  assert.equal(game.bombCount, 1);
  assert.equal(game.rocketCount, 1);
  assert.equal(game.phase, 'play');
});

test('landlord spring doubles the zero-sum base score', () => {
  const settlement = calculateSettlement({
    winner: 'landlord',
    landlord: 0,
    playsBySeat: [1, 0, 0],
    bombCount: 0,
    rocketCount: 0
  });

  assert.equal(settlement.multiplier, 2);
  assert.deepEqual(settlement.multiplierReasons, ['spring']);
  assert.deepEqual(settlement.scoreDelta, [4, -2, -2]);
  assert.equal(settlement.spring, true);
  assert.equal(settlement.antiSpring, false);
});

test('farmer anti-spring doubles when landlord played and one farmer did not', () => {
  const settlement = calculateSettlement({
    winner: 'farmers',
    landlord: 0,
    playsBySeat: [1, 3, 0],
    bombCount: 0,
    rocketCount: 0
  });

  assert.equal(settlement.multiplier, 2);
  assert.deepEqual(settlement.multiplierReasons, ['anti-spring']);
  assert.deepEqual(settlement.scoreDelta, [-4, 2, 2]);
  assert.equal(settlement.spring, false);
  assert.equal(settlement.antiSpring, true);
});

test('bombs and rocket compose with spring multipliers', () => {
  const settlement = calculateSettlement({
    winner: 'landlord',
    landlord: 2,
    playsBySeat: [0, 0, 1],
    bombCount: 2,
    rocketCount: 1
  });

  assert.equal(settlement.multiplier, 16);
  assert.deepEqual(settlement.multiplierReasons, ['bomb', 'bomb', 'rocket', 'spring']);
  assert.deepEqual(settlement.scoreDelta, [-16, -16, 32]);
});
