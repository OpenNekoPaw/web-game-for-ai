import test from 'node:test';
import assert from 'node:assert/strict';
import { appendReplayFrame, createReplay, listReplays, readReplay } from '../game/replay-store.js';

function state(gameId, phase, winner) {
  return { gameId, game: 'ddz', phase, winner };
}

test('completed history excludes over states without a valid winner', () => {
  const interruptedId = 'ddz-9000000000001';
  const completedId = 'ddz-9000000000002';

  createReplay(interruptedId, state(interruptedId, 'waiting', null));
  appendReplayFrame(interruptedId, { type: 'review' }, state(interruptedId, 'over', null));
  createReplay(completedId, state(completedId, 'waiting', null));
  appendReplayFrame(completedId, { type: 'action' }, state(completedId, 'over', 'landlord'));

  assert.equal(readReplay(interruptedId).completedAt, null);
  assert.ok(readReplay(completedId).completedAt);
  assert.deepEqual(listReplays({ status: 'completed' }).items.map((item) => item.gameId), [completedId]);
});
