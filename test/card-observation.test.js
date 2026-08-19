import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, publicState } from '../game/ddz.js';

test('private observation cards bind ids to the same semantic faces as the H5 table', () => {
  const game = createGame('ddz-card-labels');
  game.phase = 'play';
  game.hands = [
    ['14:0', '14:1', '15:0', '16:0'],
    ['17:0'],
    ['3:0']
  ];
  game.bottom = ['15:3', '16:0', '17:0'];
  game.lastPlay = { type: 'pair', weight: 14, count: 2, seatId: 0, cards: ['14:0', '14:1'] };
  game.tablePlays = [['14:0', '14:1'], null, null];

  const state = publicState(game, 0);

  assert.equal(state.cardEncoding.ranks[14], 'A');
  assert.equal(state.cardEncoding.ranks[15], '2');
  assert.deepEqual(state.hands[0].cards, [
    { id: '14:0', rank: 'A', suit: 'spades', label: 'A♠', strength: 14 },
    { id: '14:1', rank: 'A', suit: 'hearts', label: 'A♥', strength: 14 },
    { id: '15:0', rank: '2', suit: 'spades', label: '2♠', strength: 15 },
    { id: '16:0', rank: 'small_joker', suit: null, label: '小王', strength: 16 }
  ]);
  assert.deepEqual(state.lastPlay.cards.map((card) => card.label), ['A♠', 'A♥']);
  assert.deepEqual(state.tablePlays[0].map((card) => card.label), ['A♠', 'A♥']);
  assert.deepEqual(state.bottom.map((card) => card.label), ['2♦', '小王', '大王']);
});

test('card labels do not reveal another seat private hand', () => {
  const game = createGame('ddz-card-privacy');
  game.phase = 'play';
  game.hands = [['14:0'], ['15:0', '16:0'], ['17:0']];

  const state = publicState(game, 0);

  assert.deepEqual(state.hands[0], {
    seatId: 0,
    count: 1,
    cards: [{ id: '14:0', rank: 'A', suit: 'spades', label: 'A♠', strength: 14 }]
  });
  assert.deepEqual(state.hands[1], { seatId: 1, count: 2, cards: [] });
  assert.deepEqual(state.hands[2], { seatId: 2, count: 1, cards: [] });
});
