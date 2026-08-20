import test from 'node:test';
import assert from 'node:assert/strict';
import { ArenaDurableObject } from '../worker.js';
import { importStoreState } from '../game/store.js';

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

  for (let id = 2; id < 10; id += 1) {
    const response = await object.fetch(mcpRequest(id, 'observe_game', { gameId: firstGameId, seatId: 0 }));
    assert.equal(response.status, 200);
  }
  assert.equal(state.snapshotPutCount, 1);
  assert.equal(state.alarmCount, 1);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`]);

  const secondCreate = await object.fetch(mcpRequest(10, 'create_game'));
  const secondGameId = (await secondCreate.json()).result.structuredContent.gameId;
  assert.equal(state.snapshotPutCount, 2);
  assert.deepEqual([...state.records.keys()].filter((key) => key.startsWith('game:')), [`game:${firstGameId}`, `game:${secondGameId}`]);
  assert.deepEqual([...state.records.keys()].filter((key) => key.startsWith('replay:')), [`replay:${firstGameId}`, `replay:${secondGameId}`]);
  assert.equal(state.recordPutCounts.get(`game:${firstGameId}`), 1);
  assert.equal(state.recordPutCounts.get(`replay:${firstGameId}`), 1);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`, `replays/${secondGameId}.json`]);

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
  await callTool(object, 38, 'submit_action', {
    gameId: created.gameId,
    seatId: turn.current,
    seq: turn.seq,
    action: { type: 'bid', value: 0 }
  });
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
