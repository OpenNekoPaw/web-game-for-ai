import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('server MCP endpoint exposes game tools and keeps local strategy out of results', async (t) => {
  const port = 31917;
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), REPLAY_PERSISTENCE: 'memory' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  t.after(() => child.kill());
  await waitForServer(`http://127.0.0.1:${port}/mcp`, child, stderr);

  const initialize = await callMcp(port, 'initialize', { protocolVersion: '2025-03-26' });
  assert.equal(initialize.result.serverInfo.name, 'agent-game-ddz');
  const listed = await callMcp(port, 'tools/list', {});
  assert.ok(listed.result.tools.some((tool) => tool.name === 'join_invite'));
  assert.ok(!listed.result.tools.some((tool) => tool.name === 'get_local_strategy'));

  const created = await callMcp(port, 'tools/call', { name: 'create_game', arguments: {} });
  const game = created.result.structuredContent;
  assert.match(game.gameId, /^ddz-/);

  const invite = await fetch(`http://127.0.0.1:${port}/api/games/${game.gameId}/invites`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteType: 'agent', seatId: 0 })
  }).then((response) => response.json());
  const joined = await callMcp(port, 'tools/call', { name: 'join_invite', arguments: { inviteToken: invite.token, agentId: 'mcp-agent-a' } });
  const joinedState = joined.result.structuredContent;
  assert.equal(joinedState.seatControllers[0].type, 'agent');
  assert.equal(joinedState.strategy, null);
});

test('server MCP endpoint rejects malformed JSON without crashing', async (t) => {
  const port = 31918;
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), REPLAY_PERSISTENCE: 'memory' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  t.after(() => child.kill());
  await waitForServer(`http://127.0.0.1:${port}/mcp`, child, stderr);

  const malformed = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad-json'
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' }
  });

  const malformedApi = await fetch(`http://127.0.0.1:${port}/agent/v1/games`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad-json'
  });
  assert.equal(malformedApi.status, 400);
  assert.deepEqual(await malformedApi.json(), { error: 'invalid_json' });

  const ping = await callMcp(port, 'ping', {});
  assert.deepEqual(ping.result, {});
  assert.equal(child.exitCode, null);
});

async function callMcp(port, method, params) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.random(), method, params })
  }).then((response) => response.json());
}

async function waitForServer(url, child, stderr) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
      if (response.ok) return;
    } catch {
      if (child.exitCode !== null) throw new Error(stderr || `server exited with ${child.exitCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not start: ${stderr}`);
}
