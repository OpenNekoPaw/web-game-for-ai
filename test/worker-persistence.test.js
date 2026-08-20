import test from 'node:test';
import assert from 'node:assert/strict';
import { ArenaDurableObject } from '../worker.js';
import { getMatch, importStoreState } from '../game/store.js';

class TestDurableObjectState {
  constructor() {
    this.snapshotPutCount = 0;
    this.records = new Map();
    this.recordPutCounts = new Map();
    this.alarmCount = 0;
    this.alarmAt = null;
    this.storage = {
      get: async (key) => this.records.get(key),
      list: async ({ prefix }) => new Map([...this.records].filter(([key]) => key.startsWith(prefix))),
      put: async (key, value) => {
        if (typeof key === 'object') {
          for (const [entryKey, entryValue] of Object.entries(key)) {
            this.records.set(entryKey, entryValue);
            this.recordPutCounts.set(entryKey, (this.recordPutCounts.get(entryKey) || 0) + 1);
          }
          return;
        }
        this.records.set(key, value);
        if (key === 'snapshot') this.snapshotPutCount += 1;
      },
      delete: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) this.records.delete(key); },
      getAlarm: async () => this.alarmAt,
      setAlarm: async (at) => { this.alarmAt = at; this.alarmCount += 1; },
      deleteAlarm: async () => { this.alarmAt = null; }
    };
  }

  blockConcurrencyWhile(callback) {
    this.ready = Promise.resolve().then(callback);
    return this.ready;
  }
}

function mcpRequest(id, name, args = {}) {
  return new Request('https://example.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  });
}

async function callTool(object, id, name, args = {}) {
  const response = await object.fetch(mcpRequest(id, name, args));
  assert.equal(response.status, 200);
  const message = await response.json();
  assert.notEqual(message.result?.isError, true, message.result?.content?.[0]?.text);
  return message.result.structuredContent;
}

function apiRequest(path, options = {}) {
  return new Request(`https://example.test${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
}

test('read-only MCP observations do not rewrite the full Durable Object snapshot or every replay', async () => {
  const state = new TestDurableObjectState();
  const replayWrites = [];
  const object = new ArenaDurableObject(state, {
    REPLAYS: { put: async (key) => { replayWrites.push(key); } }
  });
  await state.ready;

  const firstCreate = await object.fetch(mcpRequest(1, 'create_game'));
  const firstGameId = (await firstCreate.json()).result.structuredContent.gameId;
  assert.equal(state.snapshotPutCount, 1);
  const snapshot = JSON.parse(state.records.get('snapshot'));
  assert.equal(Object.hasOwn(snapshot, 'games'), false);
  assert.equal(Object.hasOwn(snapshot, 'replays'), false);
  assert.equal(state.records.has(`game:${firstGameId}`), true);
  assert.equal(state.records.has(`replay:${firstGameId}`), true);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`]);

  await callTool(object, 12, 'join_game', { gameId: firstGameId, seatId: 0, agentId: 'authority-agent' });
  assert.equal(state.snapshotPutCount, 1, 'a game-only authority change must not rewrite global metadata');
  assert.equal(state.recordPutCounts.get(`game:${firstGameId}`), 2);
  assert.equal(state.recordPutCounts.get(`replay:${firstGameId}`), 2);

  for (let id = 2; id < 10; id += 1) {
    const response = await object.fetch(mcpRequest(id, 'observe_game', { gameId: firstGameId, seatId: 0 }));
    assert.equal(response.status, 200);
  }
  assert.equal(state.snapshotPutCount, 1);
  assert.equal(state.alarmCount, 1);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`, `replays/${firstGameId}.json`]);

  const secondCreate = await object.fetch(mcpRequest(10, 'create_game'));
  const secondGameId = (await secondCreate.json()).result.structuredContent.gameId;
  assert.equal(state.snapshotPutCount, 2);
  assert.deepEqual([...state.records.keys()].filter((key) => key.startsWith('game:')), [`game:${firstGameId}`, `game:${secondGameId}`]);
  assert.deepEqual([...state.records.keys()].filter((key) => key.startsWith('replay:')), [`replay:${firstGameId}`, `replay:${secondGameId}`]);
  assert.equal(state.recordPutCounts.get(`game:${firstGameId}`), 2);
  assert.equal(state.recordPutCounts.get(`replay:${firstGameId}`), 2);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`, `replays/${firstGameId}.json`, `replays/${secondGameId}.json`]);

  importStoreState({});
  const restored = new ArenaDurableObject(state, {});
  await state.ready;
  const restoredObservation = await restored.fetch(mcpRequest(11, 'observe_game', { gameId: firstGameId, seatId: 0 }));
  assert.equal(restoredObservation.status, 200);
  assert.equal((await restoredObservation.json()).result.structuredContent.gameId, firstGameId);
});

test('legacy snapshots migrate embedded replays to per-game records', async () => {
  const state = new TestDurableObjectState();
  const legacy = new ArenaDurableObject(state, {});
  await state.ready;
  await legacy.fetch(mcpRequest(20, 'create_game'));
  const legacySnapshot = JSON.parse(state.records.get('snapshot'));
  const gameEntry = [...state.records.entries()].find(([key]) => key.startsWith('game:'));
  const storedReplay = JSON.parse([...state.records.entries()].find(([key]) => key.startsWith('replay:'))[1]);
  legacySnapshot.games = [[gameEntry[0].slice('game:'.length), JSON.parse(gameEntry[1])]];
  legacySnapshot.replays = [storedReplay];
  state.records = new Map([['snapshot', JSON.stringify(legacySnapshot)]]);
  state.recordPutCounts.clear();

  const restored = new ArenaDurableObject(state, {});
  await state.ready;
  assert.equal(state.records.has(`game:${storedReplay.gameId}`), true);
  assert.equal(state.records.has(`replay:${storedReplay.gameId}`), true);
  const response = await restored.fetch(mcpRequest(21, 'observe_game', { gameId: storedReplay.gameId, seatId: 0 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.structuredContent.gameId, storedReplay.gameId);
});

test('an accepted action restores the same active game state after interruption', async () => {
  importStoreState({});
  const state = new TestDurableObjectState();
  const object = new ArenaDurableObject(state, {});
  await state.ready;

  const created = await callTool(object, 30, 'create_game');
  for (const seatId of [0, 1, 2]) {
    await callTool(object, 31 + seatId, 'join_game', { gameId: created.gameId, seatId, agentId: `restore-agent-${seatId}` });
    await callTool(object, 34 + seatId, 'start_game', { gameId: created.gameId, seatId });
  }
  const turn = await callTool(object, 37, 'observe_game', { gameId: created.gameId, seatId: 0 });
  const snapshotWritesBeforeAction = state.snapshotPutCount;
  await callTool(object, 38, 'submit_action', {
    gameId: created.gameId,
    seatId: turn.current,
    seq: turn.seq,
    action: { type: 'bid', value: 0 }
  });
  assert.equal(state.snapshotPutCount, snapshotWritesBeforeAction, 'an accepted game action must not rewrite global metadata');
  const before = await callTool(object, 39, 'observe_game', { gameId: created.gameId, seatId: 0 });
  const compactReplay = JSON.parse(state.records.get(`replay:${created.gameId}`));
  assert.equal(compactReplay.format, 'agent-game.replay.v2');
  assert.equal(Object.hasOwn(compactReplay, 'frames'), false);

  importStoreState({});
  const restored = new ArenaDurableObject(state, {});
  await state.ready;
  const after = await callTool(restored, 40, 'observe_game', { gameId: created.gameId, seatId: 0 });
  assert.deepEqual(
    { phase: after.phase, current: after.current, seq: after.seq, bidHistory: after.bidHistory, hands: after.hands },
    { phase: before.phase, current: before.current, seq: before.seq, bidHistory: before.bidHistory, hands: before.hands }
  );
});

test('parallel observations across games do not produce cross-game storage writes', async () => {
  importStoreState({});
  const state = new TestDurableObjectState();
  const object = new ArenaDurableObject(state, {});
  await state.ready;

  const gameIds = [];
  for (let index = 0; index < 6; index += 1) {
    gameIds.push((await callTool(object, 50 + index, 'create_game')).gameId);
  }
  const snapshotWrites = state.snapshotPutCount;
  const gameWrites = new Map(gameIds.map((gameId) => [gameId, state.recordPutCounts.get(`game:${gameId}`)]));
  const replayWrites = new Map(gameIds.map((gameId) => [gameId, state.recordPutCounts.get(`replay:${gameId}`)]));

  await Promise.all(gameIds.flatMap((gameId, gameIndex) => Array.from({ length: 4 }, (_, observationIndex) => (
    callTool(object, 100 + gameIndex * 10 + observationIndex, 'observe_game', { gameId, seatId: observationIndex % 3 })
  ))));

  assert.equal(state.snapshotPutCount, snapshotWrites);
  for (const gameId of gameIds) {
    assert.equal(state.recordPutCounts.get(`game:${gameId}`), gameWrites.get(gameId));
    assert.equal(state.recordPutCounts.get(`replay:${gameId}`), replayWrites.get(gameId));
  }
});

test('rejected actions and ordinary player heartbeats do not persist', async () => {
  importStoreState({});
  const state = new TestDurableObjectState();
  const object = new ArenaDurableObject(state, {});
  await state.ready;

  const created = await callTool(object, 200, 'create_game');
  for (const seatId of [0, 1, 2]) {
    await callTool(object, 201 + seatId, 'join_game', { gameId: created.gameId, seatId, agentId: `authority-${seatId}` });
    await callTool(object, 204 + seatId, 'start_game', { gameId: created.gameId, seatId });
  }
  const beforeRejected = {
    snapshot: state.snapshotPutCount,
    game: state.recordPutCounts.get(`game:${created.gameId}`),
    replay: state.recordPutCounts.get(`replay:${created.gameId}`)
  };
  const turn = await callTool(object, 207, 'observe_game', { gameId: created.gameId, seatId: 0 });
  const rejectedResponse = await object.fetch(mcpRequest(208, 'submit_action', {
    gameId: created.gameId,
    seatId: turn.current,
    seq: turn.seq,
    action: { type: 'pass' }
  }));
  const rejected = await rejectedResponse.json();
  assert.equal(rejected.result.isError, true);
  assert.deepEqual({
    snapshot: state.snapshotPutCount,
    game: state.recordPutCounts.get(`game:${created.gameId}`),
    replay: state.recordPutCounts.get(`replay:${created.gameId}`)
  }, beforeRejected);

  const playerGame = await callTool(object, 209, 'create_game');
  const joinedResponse = await object.fetch(apiRequest(`/api/games/${playerGame.gameId}/join`, {
    method: 'POST', body: { seatId: 0, playerId: 'heartbeat-player' }
  }));
  const joined = await joinedResponse.json();
  const beforeHeartbeat = {
    snapshot: state.snapshotPutCount,
    game: state.recordPutCounts.get(`game:${playerGame.gameId}`),
    replay: state.recordPutCounts.get(`replay:${playerGame.gameId}`)
  };
  for (let index = 0; index < 5; index += 1) {
    const response = await object.fetch(apiRequest(`/api/games/${playerGame.gameId}/state?seat=0`, {
      headers: { 'x-seat-session-token': joined.seatSessionToken, 'x-seat-session-seat': '0' }
    }));
    assert.equal(response.status, 200);
  }
  assert.deepEqual({
    snapshot: state.snapshotPutCount,
    game: state.recordPutCounts.get(`game:${playerGame.gameId}`),
    replay: state.recordPutCounts.get(`replay:${playerGame.gameId}`)
  }, beforeHeartbeat);
});

test('managed-mode transitions are persisted once as authoritative changes', async () => {
  importStoreState({});
  const state = new TestDurableObjectState();
  const object = new ArenaDurableObject(state, {});
  await state.ready;

  const created = await callTool(object, 300, 'create_game');
  const joinedResponse = await object.fetch(apiRequest(`/api/games/${created.gameId}/join`, {
    method: 'POST', body: { seatId: 0, playerId: 'managed-player' }
  }));
  const joined = await joinedResponse.json();
  for (const seatId of [1, 2]) {
    await callTool(object, 301 + seatId, 'join_game', { gameId: created.gameId, seatId, agentId: `managed-agent-${seatId}` });
    await callTool(object, 304 + seatId, 'start_game', { gameId: created.gameId, seatId });
  }
  const playerStart = await object.fetch(apiRequest(`/api/games/${created.gameId}/start`, {
    method: 'POST',
    headers: { 'x-seat-session-token': joined.seatSessionToken },
    body: { seatId: 0 }
  }));
  assert.equal(playerStart.status, 200);

  const game = getMatch(created.gameId);
  game.playerSessions.get(0).lastSeenAt = Date.now() - 10_001;
  const beforeManaged = state.recordPutCounts.get(`game:${created.gameId}`);
  await object.alarm();
  assert.equal(game.playerSessions.get(0).managed, true);
  assert.equal(state.recordPutCounts.get(`game:${created.gameId}`), beforeManaged + 1);

  const beforeRecovered = state.recordPutCounts.get(`game:${created.gameId}`);
  const heartbeat = await object.fetch(apiRequest(`/api/games/${created.gameId}/state?seat=0`, {
    headers: { 'x-seat-session-token': joined.seatSessionToken, 'x-seat-session-seat': '0' }
  }));
  assert.equal(heartbeat.status, 200);
  assert.equal(game.playerSessions.get(0).managed, false);
  assert.equal(state.recordPutCounts.get(`game:${created.gameId}`), beforeRecovered + 1);
});
