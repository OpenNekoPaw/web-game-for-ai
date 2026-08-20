import test from 'node:test';
import assert from 'node:assert/strict';
import { ArenaDurableObject } from '../worker.js';

class TestDurableObjectState {
  constructor() {
    this.snapshot = undefined;
    this.putCount = 0;
    this.alarmCount = 0;
    this.storage = {
      get: async () => this.snapshot,
      put: async (_key, value) => { this.snapshot = value; this.putCount += 1; },
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
  assert.equal(state.putCount, 1);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`]);

  for (let id = 2; id < 10; id += 1) {
    const response = await object.fetch(mcpRequest(id, 'observe_game', { gameId: firstGameId, seatId: 0 }));
    assert.equal(response.status, 200);
  }
  assert.equal(state.putCount, 1);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`]);

  const secondCreate = await object.fetch(mcpRequest(10, 'create_game'));
  const secondGameId = (await secondCreate.json()).result.structuredContent.gameId;
  assert.equal(state.putCount, 2);
  assert.deepEqual(replayWrites, [`replays/${firstGameId}.json`, `replays/${secondGameId}.json`]);
});
