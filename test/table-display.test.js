import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame } from '../game/ddz.js';

function playableGame() {
  const game = createGame('ddz-table-display');
  game.phase = 'play';
  game.landlord = 0;
  game.current = 0;
  game.hands = [
    ['3:0', '6:0'],
    ['7:0'],
    ['4:0', '5:0']
  ];
  return game;
}

test('passes remain visible with the current high play until another play replaces the table', () => {
  const game = playableGame();

  applyAction(game, 0, { type: 'play', cards: ['3:0'] });
  applyAction(game, 1, { type: 'pass' });

  assert.deepEqual(game.tablePlays, [['3:0'], null, null]);
  assert.deepEqual(game.tablePasses, [false, true, false]);

  applyAction(game, 2, { type: 'play', cards: ['4:0'] });

  assert.deepEqual(game.tablePlays, [null, null, ['4:0']]);
  assert.deepEqual(game.tablePasses, [false, false, false]);

  applyAction(game, 0, { type: 'pass' });
  applyAction(game, 1, { type: 'pass' });

  assert.equal(game.lastPlay, null);
  assert.deepEqual(game.tablePlays, [null, null, ['4:0']]);
  assert.deepEqual(game.tablePasses, [true, true, false]);

  applyAction(game, 2, { type: 'play', cards: ['5:0'] });

  assert.deepEqual(game.tablePlays, [null, null, ['5:0']]);
  assert.deepEqual(game.tablePasses, [false, false, false]);
});
