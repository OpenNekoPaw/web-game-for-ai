import test from 'node:test';
import assert from 'node:assert/strict';
import { ArenaDurableObject } from '../worker.js';

class TestDurableObjectState {
  constructor() {
    this.snapshot = undefined;
    this.snapshotPutCount = 0;
    this.replayRecords = new Map();
    this.alarmCount = 0;
    this.storage = {
      get: async () => this.snapshot,
      list: async ({ prefix }) => new Map([...this.replayRecords].filter(([key]) => key.startsWith(prefix))),
      put: async (key, value) => {
        if (typeof key === 'object') {
          for (const [entryKey, entryValue] of Object.entries(key)) this.replayRecords.set(entryKey, entryValue);
          return;
        }
        if (key === 'snapshot') { this.snapshot = value; this.snapshotPutCount += 1; }
      },
      setAlarm: async () => { this.alarmCount += 1; }
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
  assert.deepEqual(Object.keys(JSON.parse(state.snapshot)).includes('replays'), false);
  assert.deepEqual([...state.replayRecords.keys()], [`replay:${firstGameId}`]);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`]);

  for (let id = 2; id < 10; id += 1) {
    const response = await object.fetch(mcpRequest(id, 'observe_game', { gameId: firstGameId, seatId: 0 }));
    assert.equal(response.status, 200);
  }
  assert.equal(state.snapshotPutCount, 1);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`]);

  const secondCreate = await object.fetch(mcpRequest(10, 'create_game'));
  const secondGameId = (await secondCreate.json()).result.structuredContent.gameId;
  assert.equal(state.snapshotPutCount, 2);
  assert.deepEqual([...state.replayRecords.keys()], [`replay:${firstGameId}`, `replay:${secondGameId}`]);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`, `replays/${secondGameId}.json`]);
});

test('legacy snapshots migrate embedded replays to per-game records', async () => {
  const state = new TestDurableObjectState();
  const legacy = new ArenaDurableObject(state, {});
  await state.ready;
  await legacy.fetch(mcpRequest(20, 'create_game'));
  const legacySnapshot = JSON.parse(state.snapshot);
  const storedReplay = JSON.parse(state.replayRecords.values().next().value);
  legacySnapshot.replays = [storedReplay];
  state.snapshot = JSON.stringify(legacySnapshot);
  state.replayRecords.clear();

  const restored = new ArenaDurableObject(state, {});
  await state.ready;
  assert.deepEqual([...state.replayRecords.keys()], [`replay:${storedReplay.gameId}`]);
  const response = await restored.fetch(mcpRequest(21, 'observe_game', { gameId: storedReplay.gameId, seatId: 0 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.structuredContent.gameId, storedReplay.gameId);
});
