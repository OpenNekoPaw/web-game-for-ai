import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMatch,
  createMatchInvite,
  expireInterruptedMatches,
  getAuthorizedReplay,
  getMatch,
  joinPlayerInvite,
  listAccessibleReplays
} from '../game/store.js';

test('private replays stay out of public history and require the room credential', () => {
  const publicGame = createMatch({ accessMode: 'open' });
  const privateGame = createMatch({ accessMode: 'invite_only' });

  assert.equal(publicGame.replayAccessToken, null);
  assert.match(privateGame.replayAccessToken, /^[A-Za-z0-9_-]{32,128}$/);

  const publicHistory = listAccessibleReplays({ status: 'all' });
  assert.ok(publicHistory.items.some((item) => item.gameId === publicGame.gameId));
  assert.ok(!publicHistory.items.some((item) => item.gameId === privateGame.gameId));
  assert.throws(() => getAuthorizedReplay(privateGame.gameId), /replay_access_denied/);
  assert.throws(() => getAuthorizedReplay(privateGame.gameId, 'x'.repeat(32)), /replay_access_denied/);
  assert.equal(getAuthorizedReplay(privateGame.gameId, privateGame.replayAccessToken).gameId, privateGame.gameId);

  const privateHistory = listAccessibleReplays({ status: 'all', replayAccessToken: privateGame.replayAccessToken });
  assert.ok(privateHistory.items.some((item) => item.gameId === privateGame.gameId));
});

test('an invited player receives the private replay credential', () => {
  const game = createMatch({ accessMode: 'invite_only' });
  const invite = createMatchInvite(game.gameId, 'player', undefined, game.roomOwnerToken);
  const joined = joinPlayerInvite(invite.token, 'private-player');

  assert.equal(joined.replayAccessToken, game.replayAccessToken);
  assert.equal(getAuthorizedReplay(game.gameId, joined.replayAccessToken).gameId, game.gameId);
});

test('private replay authorization survives expired activity-state removal', () => {
  const game = createMatch({ accessMode: 'private' });
  const token = game.replayAccessToken;
  const expiredAt = Number(game.gameId.slice(4)) + 10 * 60_000 + 1;

  assert.equal(expireInterruptedMatches(expiredAt).includes(game.gameId), true);
  assert.equal(getMatch(game.gameId), null);
  assert.throws(() => getAuthorizedReplay(game.gameId), /replay_access_denied/);
  const replay = getAuthorizedReplay(game.gameId, token);
  assert.equal(replay.frames.at(-1).state.phase, 'aborted');
  assert.equal(Object.hasOwn(replay, 'replayAccessToken'), false);
});
