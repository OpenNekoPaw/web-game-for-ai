import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMatch, getMatch, joinMatch, observeMatch, runBot, submitMatchAction, tickMatches } from './game/store.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const json = (res, code, body) => { res.writeHead(code, {'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*'}); res.end(JSON.stringify(body)); };
const body = async (req) => { let data=''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') { const data = await readFile(join(root, 'public/index.html')); res.writeHead(200, {'content-type': mime['.html']}); return res.end(data); }
    if (req.method === 'GET' && url.pathname.startsWith('/public/')) { const file = join(root, url.pathname); const data = await readFile(file); res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream'}); return res.end(data); }
    if (req.method === 'POST' && (url.pathname === '/api/games' || url.pathname === '/agent/v1/games')) { const data = await body(req); const game = createMatch(data); return json(res, 201, { protocol:'agent-game.v1', gameId: game.gameId, turnTimeoutMs: game.turnTimeoutMs }); }
    const agentMatch = url.pathname.match(/^\/agent\/v1\/games\/([^/]+)\/(join|observe|actions)$/);
    if (agentMatch) {
      const data = req.method === 'POST' ? await body(req) : {};
      const seatId = Number(req.method === 'GET' ? url.searchParams.get('seatId') : data.seatId);
      try {
        if (agentMatch[2] === 'join' && req.method === 'POST') return json(res, 200, joinMatch(agentMatch[1], seatId, String(data.agentId || 'anonymous')));
        if (agentMatch[2] === 'observe' && req.method === 'GET') return json(res, 200, observeMatch(agentMatch[1], seatId));
        if (agentMatch[2] === 'actions' && req.method === 'POST') return json(res, 200, submitMatchAction(agentMatch[1], seatId, data.action, data.seq));
      } catch (error) { return json(res, 400, { protocol:'agent-game.v1', ok:false, error:error.message }); }
    }
    const match = url.pathname.match(/^\/api\/games\/([^/]+)(?:\/(state|actions|bot))?$/); if (!match) return json(res, 404, { error: 'not_found' });
    const game = getMatch(match[1]); if (!game) return json(res, 404, { error: 'game_not_found' });
    if (req.method === 'GET' && match[2] === 'state') { const seat = Number(url.searchParams.get('seat')); const revealAll = url.searchParams.get('view') === 'global'; try { return json(res, 200, observeMatch(match[1], seat, { revealAll })); } catch (error) { return json(res, 400, {error:error.message}); } }
    if (req.method === 'POST' && match[2] === 'actions') { const data = await body(req); try { const state = submitMatchAction(match[1], Number(data.seatId), data.action, data.seq); return json(res, 200, { ok: true, seq: state.seq }); } catch (error) { return json(res, 400, { ok: false, error: error.message }); } }
    if (req.method === 'POST' && match[2] === 'bot') { try { return json(res, 200, {ok:true,...runBot(match[1])}); } catch (error) { return json(res, 400, {ok:false,error:error.message}); } }
    return json(res, 405, { error: 'method_not_allowed' });
  } catch (error) { json(res, 500, { error: error.message }); }
});

server.listen(process.env.PORT || 3000, () => console.log(`DDZ server running at http://localhost:${process.env.PORT || 3000}`));
const ticker = setInterval(tickMatches, 1000);
ticker.unref();
