import test from 'node:test';
import assert from 'node:assert/strict';
import { cardView, createDeck } from '../game/ddz.js';
import { appendReplayFrame, createReplay, listReplays, readReplay } from '../game/replay-store.js';
import { createRematch, getMatch, joinPlayerMatch, observeMatch, startMatch } from '../game/store.js';

function replayState(gameId, phase, winner, deal = null) {
  return {
    gameId,
    game: 'ddz',
    phase,
    winner,
    firstBidder: deal?.firstBidder ?? null,
    hands: deal
      ? deal.hands.map((cards, seatId) => ({ seatId, count: cards.length, cards: cards.map(cardView) }))
      : [0, 1, 2].map((seatId) => ({ seatId, count: 0, cards: [] })),
    bottom: deal ? deal.bottom.map(cardView) : []
  };
}

test('rematch waits for three ready seats then restores the same deal and first bidder', () => {
  const sourceGameId = 'ddz-9200000000001';
  const deck = createDeck();
  const deal = {
    hands: [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)],
    bottom: deck.slice(51),
    firstBidder: 2
  };
  createReplay(sourceGameId, replayState(sourceGameId, 'waiting', null));
  appendReplayFrame(sourceGameId, { type: 'started' }, replayState(sourceGameId, 'bid', null, deal));
  appendReplayFrame(sourceGameId, { type: 'action' }, replayState(sourceGameId, 'over', 'farmers', deal));

  const rematch = createRematch(sourceGameId);
  assert.notEqual(rematch.gameId, sourceGameId);
  assert.equal(rematch.sourceGameId, sourceGameId);
  assert.equal(rematch.phase, 'waiting');
  assert.deepEqual(rematch.hands, [[], [], []]);
  assert.equal(rematch.agents.size, 0);
  assert.equal(rematch.players.size, 0);
  assert.equal(rematch.agentStrategies.size, 0);
  assert.equal(rematch.competitionId, null);
  assert.equal(readReplay(rematch.gameId).sourceGameId, sourceGameId);
  assert.equal(listReplays().items.find((item) => item.gameId === rematch.gameId)?.sourceGameId, sourceGameId);

  for (const seatId of [0, 1, 2]) joinPlayerMatch(rematch.gameId, seatId, `rematch-player-${seatId}`);
  startMatch(rematch.gameId, 0);
  startMatch(rematch.gameId, 1);
  assert.equal(getMatch(rematch.gameId).phase, 'waiting');
  startMatch(rematch.gameId, 2);

  const started = getMatch(rematch.gameId);
  assert.equal(started.phase, 'bid');
  assert.equal(started.firstBidder, deal.firstBidder);
  assert.equal(started.current, deal.firstBidder);
  assert.deepEqual(started.hands.map((hand) => new Set(hand)), deal.hands.map((hand) => new Set(hand)));
  assert.deepEqual(started.bottom, deal.bottom);
  assert.equal(observeMatch(rematch.gameId, 0).sourceGameId, sourceGameId);
});

test('rematch rejects a source game that has not completed', () => {
  const sourceGameId = 'ddz-9200000000002';
  createReplay(sourceGameId, replayState(sourceGameId, 'waiting', null));
  assert.throws(() => createRematch(sourceGameId), /rematch_source_not_completed/);
});
