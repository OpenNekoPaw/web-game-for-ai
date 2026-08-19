import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createCompetition, createMatch, createRematch, getMatch, getMatchStrategies, getReplay, getStrategies, joinMatch, joinPlayerMatch, observeCompetition, observeMatch, runBot, startMatch, submitCompetitionReview, submitMatchAction, submitMatchReview, tickMatches } from './game/store.js';
import { listReplays } from './game/replay-store.js';
import { assetsDirectory } from './game/runtime-paths.js';

const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const json = (res, code, body) => { res.writeHead(code, {'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*'}); res.end(JSON.stringify(body)); };
const body = async (req) => { let data=''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') { const data = await readFile(join(assetsDirectory, 'public/index.html')); res.writeHead(200, {'content-type': mime['.html']}); return res.end(data); }
    if (req.method === 'GET' && url.pathname.startsWith('/public/')) { const file = join(assetsDirectory, url.pathname); const data = await readFile(file); res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream'}); return res.end(data); }
    if (req.method === 'GET' && url.pathname === '/api/agent-guide') {
      const markdown = await readFile(join(assetsDirectory, '.agents', 'skills', 'play-doudizhu', 'SKILL.md'), 'utf8');
      const hash = createHash('sha256').update(markdown).digest('hex');
      return json(res, 200, { protocol:'agent-game.v1', format:'agentskills', fileName:'SKILL.md', hash, markdown });
    }
    if (req.method === 'GET' && url.pathname === '/agent/v1/strategies') return json(res, 200, { protocol:'agent-game.v1', ...getStrategies() });
    if (req.method === 'GET' && url.pathname === '/api/replays') return json(res, 200, listReplays({ limit:url.searchParams.get('limit'), offset:url.searchParams.get('offset'), status:url.searchParams.get('status') }));
    if (req.method === 'POST' && (url.pathname === '/api/competitions' || url.pathname === '/agent/v1/competitions')) return json(res, 201, createCompetition(await body(req)));
    const agentCompetition = url.pathname.match(/^\/agent\/v1\/competitions\/([^/]+)(?:\/(observe|review))?$/);
    if (agentCompetition) {
      const data = req.method === 'POST' ? await body(req) : {};
      const seatId = Number(req.method === 'GET' ? url.searchParams.get('seatId') : data.seatId);
      try {
        if ((!agentCompetition[2] || agentCompetition[2] === 'observe') && req.method === 'GET') return json(res, 200, observeCompetition(agentCompetition[1], seatId));
        if (agentCompetition[2] === 'review' && req.method === 'POST') return json(res, 200, submitCompetitionReview(agentCompetition[1], seatId, data.review));
      } catch (error) { return json(res, 400, { protocol:'agent-game.v1', ok:false, error:error.message }); }
    }
    const publicCompetition = url.pathname.match(/^\/api\/competitions\/([^/]+)$/);
    if (req.method === 'GET' && publicCompetition) {
      try { return json(res, 200, observeCompetition(publicCompetition[1], null, { revealAll: url.searchParams.get('view') === 'global' })); }
      catch (error) { return json(res, error.message === 'competition_not_found' ? 404 : 400, { error:error.message }); }
    }
    const replayMatch = url.pathname.match(/^\/api\/replays\/([^/]+)$/);
    if (req.method === 'GET' && replayMatch) { try { return json(res, 200, getReplay(replayMatch[1])); } catch (error) { return json(res, error.message === 'replay_not_found' ? 404 : 400, { error: error.message }); } }
    const replayRematch = url.pathname.match(/^\/api\/replays\/([^/]+)\/rematch$/);
    if (req.method === 'POST' && replayRematch) {
      try { await body(req); const game = createRematch(replayRematch[1]); return json(res, 201, { protocol:'agent-game.v1', gameId:game.gameId, sourceGameId:game.sourceGameId, turnTimeoutMs:game.turnTimeoutMs }); }
      catch (error) { return json(res, error.message === 'replay_not_found' ? 404 : 400, { error:error.message }); }
    }
    if (req.method === 'POST' && (url.pathname === '/api/games' || url.pathname === '/agent/v1/games')) { const data = await body(req); const game = createMatch(data); return json(res, 201, { protocol:'agent-game.v1', gameId: game.gameId, turnTimeoutMs: game.turnTimeoutMs }); }
    const agentMatch = url.pathname.match(/^\/agent\/v1\/games\/([^/]+)\/(join|observe|start|actions|review)$/);
    if (agentMatch) {
      const data = req.method === 'POST' ? await body(req) : {};
      const seatId = Number(req.method === 'GET' ? url.searchParams.get('seatId') : data.seatId);
      try {
        if (agentMatch[2] === 'join' && req.method === 'POST') return json(res, 200, joinMatch(agentMatch[1], seatId, String(data.agentId || 'anonymous'), data.strategyId, data.displayName));
        if (agentMatch[2] === 'observe' && req.method === 'GET') return json(res, 200, observeMatch(agentMatch[1], seatId));
        if (agentMatch[2] === 'start' && req.method === 'POST') return json(res, 200, startMatch(agentMatch[1], seatId));
        if (agentMatch[2] === 'actions' && req.method === 'POST') return json(res, 200, submitMatchAction(agentMatch[1], seatId, data.action, data.seq, { source:'agent', decision:data.decision }));
        if (agentMatch[2] === 'review' && req.method === 'POST') return json(res, 200, submitMatchReview(agentMatch[1], seatId, data.review));
      } catch (error) { return json(res, 400, { protocol:'agent-game.v1', ok:false, error:error.message }); }
    }
    const match = url.pathname.match(/^\/api\/games\/([^/]+)(?:\/(state|strategies|join|start|actions|bot))?$/); if (!match) return json(res, 404, { error: 'not_found' });
    const game = getMatch(match[1]); if (!game) return json(res, 404, { error: 'game_not_found' });
    if (req.method === 'GET' && match[2] === 'state') { const seat = Number(url.searchParams.get('seat')); const revealAll = url.searchParams.get('view') === 'global'; try { return json(res, 200, observeMatch(match[1], seat, { revealAll })); } catch (error) { return json(res, 400, {error:error.message}); } }
    if (req.method === 'GET' && match[2] === 'strategies') { if (url.searchParams.get('view') !== 'global') return json(res, 403, { error:'global_view_required' }); return json(res, 200, getMatchStrategies(match[1])); }
    if (req.method === 'POST' && match[2] === 'join') { const data = await body(req); try { return json(res, 200, joinPlayerMatch(match[1], Number(data.seatId), String(data.playerId || `h5-player-${data.seatId}`), data.displayName)); } catch (error) { return json(res, 400, {ok:false,error:error.message}); } }
    if (req.method === 'POST' && match[2] === 'start') { const data = await body(req); try { return json(res, 200, startMatch(match[1], Number(data.seatId))); } catch (error) { return json(res, 400, {ok:false,error:error.message}); } }
    if (req.method === 'POST' && match[2] === 'actions') { const data = await body(req); try { const state = submitMatchAction(match[1], Number(data.seatId), data.action, data.seq, { source:'player' }); return json(res, 200, { ok: true, seq: state.seq }); } catch (error) { return json(res, 400, { ok: false, error: error.message }); } }
    if (req.method === 'POST' && match[2] === 'bot') { try { return json(res, 200, {ok:true,...runBot(match[1])}); } catch (error) { return json(res, 400, {ok:false,error:error.message}); } }
    return json(res, 405, { error: 'method_not_allowed' });
  } catch (error) { json(res, 500, { error: error.message }); }
});

server.listen(process.env.PORT || 3000, () => console.log(`DDZ server running at http://localhost:${process.env.PORT || 3000}`));
const ticker = setInterval(tickMatches, 1000);
ticker.unref();
