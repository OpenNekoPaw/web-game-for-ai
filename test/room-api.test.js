import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkerRequest } from '../worker-api.js';

function request(path, options = {}) {
  return new Request(`https://example.test${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
}

async function json(path, options) {
  const response = await handleWorkerRequest(request(path, options));
  return { response, data: await response.json() };
}

test('browser room API creates a lobby before creating a game', async () => {
  const created = await json('/api/rooms', { method: 'POST', body: { totalRounds: 3, accessMode: 'open' } });
  assert.equal(created.response.status, 201);
  assert.match(created.data.roomId, /^room-[a-f0-9]{32}$/);
  assert.equal(created.data.gameId, null);
  assert.equal(created.data.room.currentGameId, null);

  const observed = await json(`/api/rooms/${created.data.roomId}/state?seat=0`);
  assert.equal(observed.response.status, 200);
  assert.equal(observed.data.roomId, created.data.roomId);
  assert.equal(observed.data.view, 'public');
});

test('agent room API keeps room id stable when readiness creates the first game', async () => {
  const created = await json('/agent/v1/rooms', { method: 'POST', body: { totalRounds: 1 } });
  const roomId = created.data.roomId;
  for (const seatId of [0, 1, 2]) {
    const joined = await json(`/agent/v1/rooms/${roomId}/join`, {
      method: 'POST', body: { seatId, agentId: `agent-${seatId}` }
    });
    assert.equal(joined.response.status, 200);
  }
  for (const seatId of [0, 1]) {
    const ready = await json(`/agent/v1/rooms/${roomId}/ready`, { method: 'POST', body: { seatId } });
    assert.equal(ready.data.gameId, null);
  }
  const started = await json(`/agent/v1/rooms/${roomId}/ready`, { method: 'POST', body: { seatId: 2 } });
  assert.match(started.data.gameId, /^ddz-\d+$/);
  assert.equal(started.data.roomId, roomId);
  assert.equal(started.data.room.currentGameId, started.data.gameId);

  const legacy = await json(`/api/games/${started.data.gameId}/state?seat=0`);
  assert.equal(legacy.data.roomId, roomId);
});

test('private room id is a locator rather than an admission credential', async () => {
  const created = await json('/api/rooms', { method: 'POST', body: { totalRounds: 1, accessMode: 'private' } });
  const denied = await json(`/api/rooms/${created.data.roomId}/state?seat=0`);
  assert.equal(denied.response.status, 403);
  assert.equal(denied.data.error, 'access_denied');

  const allowed = await json(`/api/rooms/${created.data.roomId}/state?seat=0`, {
    headers: { 'x-room-owner-token': created.data.roomOwnerToken }
  });
  assert.equal(allowed.response.status, 200);
});

test('MCP advertises room-first tools while retaining legacy game tools', async () => {
  const listed = await json('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  });
  const names = listed.data.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('create_room'));
  assert.ok(names.includes('submit_room_action'));
  assert.ok(names.includes('get_strategy'));
  assert.ok(names.includes('create_game'));
});

test('worker strategy catalog is query-only and returns managed Markdown explicitly', async () => {
  const listed = await json('/agent/v1/strategies');
  assert.deepEqual(listed.data.strategies.map(({ id }) => id), ['default']);
  assert.equal(listed.data.strategies[0].markdown, undefined);

  const strategy = await json('/agent/v1/strategies/default');
  assert.equal(strategy.response.status, 200);
  assert.equal(strategy.data.strategy.id, 'default');
  assert.match(strategy.data.strategy.markdown, /^---\n/);

  const missing = await json('/agent/v1/strategies/missing');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.data.error, 'strategy_not_found');
});
