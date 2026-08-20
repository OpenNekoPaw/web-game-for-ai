import {
  createCompetition, createMatch, createMatchInvite, createRematch, exportStoreState,
  getMatch, getMatchStrategies, getReplay, getStrategies, importStoreState,
  joinAgentInvite, joinMatch, joinPlayerInvite, joinPlayerMatch, observeCompetition,
  observeMatch, resolveMatchInvite, startMatch, submitCompetitionReview,
  submitMatchAction, submitMatchReview
} from './game/store.js';
import { listReplays } from './game/replay-runtime.js';
import { getStrategy } from './game/strategy-runtime.js';
import { handleMcpMessage } from './server/mcp.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }
});

async function body(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

export async function handleWorkerRequest(request) {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/mcp' || url.pathname === '/agent/mcp') return await mcp(request);
    if (request.method === 'GET' && url.pathname === '/api/agent-guide') {
      const strategy = getStrategy();
      return json({ protocol: 'agent-game.v1', format: 'agentskills', fileName: 'default.md', hash: strategy.hash, markdown: strategy.markdown });
    }
    if (request.method === 'GET' && url.pathname === '/agent/v1/strategies') return json({ protocol: 'agent-game.v1', ...getStrategies() });
    if (request.method === 'GET' && url.pathname === '/api/replays') return json(listReplays({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset'), status: url.searchParams.get('status') }));

    const browserInvite = url.pathname.match(/^\/api\/invites\/([^/]+)(?:\/(join))?$/);
    if (browserInvite) {
      try {
        if (request.method === 'GET' && !browserInvite[2]) return json(resolveMatchInvite(browserInvite[1]));
        if (request.method === 'POST' && browserInvite[2] === 'join') { const data = await body(request); return json(joinPlayerInvite(browserInvite[1], data.playerId, data.displayName)); }
      } catch (error) { return json({ protocol: 'agent-game.v1', ok: false, error: error.message }, error.message === 'invite_not_found' ? 404 : 400); }
    }
    const agentInvite = url.pathname.match(/^\/agent\/v1\/invites\/([^/]+)(?:\/(join))?$/);
    if (agentInvite) {
      try {
        if (request.method === 'GET' && !agentInvite[2]) return json(resolveMatchInvite(agentInvite[1]));
        if (request.method === 'POST' && agentInvite[2] === 'join') { const data = await body(request); return json(joinAgentInvite(agentInvite[1], data.agentId, data.displayName, data.agentMetadata)); }
      } catch (error) { return json({ protocol: 'agent-game.v1', ok: false, error: error.message }, error.message === 'invite_not_found' ? 404 : 400); }
    }
    if (request.method === 'POST' && (url.pathname === '/api/competitions' || url.pathname === '/agent/v1/competitions')) return json(createCompetition(await body(request)), 201);

    const agentCompetition = url.pathname.match(/^\/agent\/v1\/competitions\/([^/]+)(?:\/(observe|review))?$/);
    if (agentCompetition) {
      const data = request.method === 'POST' ? await body(request) : {};
      const seatId = Number(request.method === 'GET' ? url.searchParams.get('seatId') : data.seatId);
      try {
        if ((!agentCompetition[2] || agentCompetition[2] === 'observe') && request.method === 'GET') return json(observeCompetition(agentCompetition[1], seatId));
        if (agentCompetition[2] === 'review' && request.method === 'POST') return json(submitCompetitionReview(agentCompetition[1], seatId, data.review));
      } catch (error) { return json({ protocol: 'agent-game.v1', ok: false, error: error.message }, 400); }
    }
    const publicCompetition = url.pathname.match(/^\/api\/competitions\/([^/]+)$/);
    if (request.method === 'GET' && publicCompetition) {
      try { return json(observeCompetition(publicCompetition[1], null, { revealAll: url.searchParams.get('view') === 'global' })); }
      catch (error) { return json({ error: error.message }, error.message === 'competition_not_found' ? 404 : 400); }
    }
    const replayMatch = url.pathname.match(/^\/api\/replays\/([^/]+)$/);
    if (request.method === 'GET' && replayMatch) { try { return json(getReplay(replayMatch[1])); } catch (error) { return json({ error: error.message }, error.message === 'replay_not_found' ? 404 : 400); } }
    const replayRematch = url.pathname.match(/^\/api\/replays\/([^/]+)\/rematch$/);
    if (request.method === 'POST' && replayRematch) { try { await body(request); const game = createRematch(replayRematch[1]); return json({ protocol: 'agent-game.v1', gameId: game.gameId, sourceGameId: game.sourceGameId, turnTimeoutMs: game.turnTimeoutMs }, 201); } catch (error) { return json({ error: error.message }, error.message === 'replay_not_found' ? 404 : 400); } }
    if (request.method === 'POST' && (url.pathname === '/api/games' || url.pathname === '/agent/v1/games')) { const game = createMatch(await body(request)); return json({ protocol: 'agent-game.v1', gameId: game.gameId, accessMode: game.accessMode, turnTimeoutMs: game.turnTimeoutMs }, 201); }

    const agentMatch = url.pathname.match(/^\/agent\/v1\/games\/([^/]+)\/(join|observe|start|actions|review)$/);
    if (agentMatch) {
      const data = request.method === 'POST' ? await body(request) : {};
      const seatId = Number(request.method === 'GET' ? url.searchParams.get('seatId') : data.seatId);
      try {
        if (agentMatch[2] === 'join' && request.method === 'POST') return json(joinMatch(agentMatch[1], seatId, String(data.agentId || 'anonymous'), data.strategyId, data.displayName, { strategyMode: data.strategyMode, agentMetadata: data.agentMetadata }));
        if (agentMatch[2] === 'observe' && request.method === 'GET') return json(observeMatch(agentMatch[1], seatId));
        if (agentMatch[2] === 'start' && request.method === 'POST') return json(startMatch(agentMatch[1], seatId));
        if (agentMatch[2] === 'actions' && request.method === 'POST') return json(submitMatchAction(agentMatch[1], seatId, data.action, data.seq, { source: 'agent', decision: data.decision }));
        if (agentMatch[2] === 'review' && request.method === 'POST') return json(submitMatchReview(agentMatch[1], seatId, data.review));
      } catch (error) { return json({ protocol: 'agent-game.v1', ok: false, error: error.message }, 400); }
    }

    const match = url.pathname.match(/^\/api\/games\/([^/]+)(?:\/(state|strategies|join|start|actions|invites))?$/);
    if (!match) return json({ error: 'not_found' }, 404);
    const game = getMatch(match[1]);
    if (!game) return json({ error: 'game_not_found' }, 404);
    if (request.method === 'GET' && match[2] === 'state') { try { return json(observeMatch(match[1], Number(url.searchParams.get('seat')), { revealAll: url.searchParams.get('view') === 'global' })); } catch (error) { return json({ error: error.message }, 400); } }
    if (request.method === 'GET' && match[2] === 'strategies') { if (url.searchParams.get('view') !== 'global') return json({ error: 'global_view_required' }, 403); return json(getMatchStrategies(match[1])); }
    if (request.method === 'POST' && match[2] === 'join') { const data = await body(request); try { return json(joinPlayerMatch(match[1], Number(data.seatId), String(data.playerId || `h5-player-${data.seatId}`), data.displayName)); } catch (error) { return json({ ok: false, error: error.message }, 400); } }
    if (request.method === 'POST' && match[2] === 'start') { const data = await body(request); try { return json(startMatch(match[1], Number(data.seatId))); } catch (error) { return json({ ok: false, error: error.message }, 400); } }
    if (request.method === 'POST' && match[2] === 'actions') { const data = await body(request); try { const state = submitMatchAction(match[1], Number(data.seatId), data.action, data.seq, { source: 'player' }); return json({ ok: true, seq: state.seq }); } catch (error) { return json({ ok: false, error: error.message }, 400); } }
    if (request.method === 'POST' && match[2] === 'invites') { const data = await body(request); try { return json(createMatchInvite(match[1], data.inviteType, data.seatId), 201); } catch (error) { return json({ ok: false, error: error.message }, 400); } }
    return json({ error: 'method_not_allowed' }, 405);
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}

async function mcp(request) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const response = await handleMcpMessage(await body(request));
    return response ? json(response) : new Response(null, { status: 202, headers: { 'access-control-allow-origin': '*' } });
  } catch (error) {
    if (error instanceof SyntaxError) return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    return json({ error: error.message }, 500);
  }
}

export { exportStoreState, importStoreState };
