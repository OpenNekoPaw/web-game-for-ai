import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, startGame } from '../game/ddz.js';

function startCalledGame() {
  const game = createGame('ddz-1');
  startGame(game);
  const caller = game.current;
  applyAction(game, caller, { type: 'bid', value: 1 });
  return { game, caller, next: (caller + 1) % 3, last: (caller + 2) % 3 };
}

test('first caller becomes landlord immediately when neither later seat robs', () => {
  const { game, caller, next, last } = startCalledGame();

  applyAction(game, next, { type: 'bid', value: 0 });
  applyAction(game, last, { type: 'bid', value: 0 });

  assert.equal(game.phase, 'play');
  assert.equal(game.landlord, caller);
  assert.equal(game.current, caller);
  assert.equal(game.bidHistory.length, 3);
});

test('first caller receives a final counter-rob after a later seat robs', () => {
  const { game, caller, next, last } = startCalledGame();

  applyAction(game, next, { type: 'bid', value: 1 });
  applyAction(game, last, { type: 'bid', value: 0 });

  assert.equal(game.phase, 'bid');
  assert.equal(game.bidStage, 'rob');
  assert.equal(game.current, caller);
  assert.equal(game.landlordCandidate, next);
  assert.equal(game.robTurnsRemaining, 1);

  applyAction(game, caller, { type: 'bid', value: 1 });

  assert.equal(game.phase, 'play');
  assert.equal(game.landlord, caller);
  assert.equal(game.bidHistory.length, 4);
  assert.deepEqual(game.bidHistory.at(-1), { seatId: caller, stage: 'rob', value: 1 });
});

test('later robber remains landlord when first caller declines the counter-rob', () => {
  const { game, caller, next, last } = startCalledGame();

  applyAction(game, next, { type: 'bid', value: 1 });
  applyAction(game, last, { type: 'bid', value: 0 });
  applyAction(game, caller, { type: 'bid', value: 0 });

  assert.equal(game.phase, 'play');
  assert.equal(game.landlord, next);
  assert.equal(game.current, next);
});

test('a seat that declined calling is not eligible to rob a later caller', () => {
  const game = createGame('ddz-2');
  startGame(game);
  const first = game.current;
  const caller = (first + 1) % 3;
  const remaining = (caller + 1) % 3;

  applyAction(game, first, { type: 'bid', value: 0 });
  applyAction(game, caller, { type: 'bid', value: 1 });

  assert.equal(game.phase, 'bid');
  assert.equal(game.current, remaining);
  assert.equal(game.robTurnsRemaining, 1);

  applyAction(game, remaining, { type: 'bid', value: 0 });

  assert.equal(game.phase, 'play');
  assert.equal(game.landlord, caller);
  assert.equal(game.bidHistory.some((entry) => entry.seatId === first && entry.stage === 'rob'), false);
});

test('the last caller becomes landlord when both earlier seats declined', () => {
  const game = createGame('ddz-3');
  startGame(game);
  const first = game.current;
  const second = (first + 1) % 3;
  const caller = (first + 2) % 3;

  applyAction(game, first, { type: 'bid', value: 0 });
  applyAction(game, second, { type: 'bid', value: 0 });
  applyAction(game, caller, { type: 'bid', value: 1 });

  assert.equal(game.phase, 'play');
  assert.equal(game.landlord, caller);
  assert.equal(game.current, caller);
  assert.equal(game.bidHistory.length, 3);
});

test('only the caller counter-robs after the remaining eligible seat robs', () => {
  const game = createGame('ddz-4');
  startGame(game);
  const declined = game.current;
  const caller = (declined + 1) % 3;
  const robber = (caller + 1) % 3;

  applyAction(game, declined, { type: 'bid', value: 0 });
  applyAction(game, caller, { type: 'bid', value: 1 });
  applyAction(game, robber, { type: 'bid', value: 1 });

  assert.equal(game.phase, 'bid');
  assert.equal(game.current, caller);
  assert.equal(game.robTurnsRemaining, 1);

  applyAction(game, caller, { type: 'bid', value: 0 });

  assert.equal(game.phase, 'play');
  assert.equal(game.landlord, robber);
  assert.equal(game.bidHistory.some((entry) => entry.seatId === declined && entry.stage === 'rob'), false);
});
