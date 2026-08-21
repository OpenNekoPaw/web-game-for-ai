import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { assertMatchRoomOwner, assertRoomOwnerById, createCompetition, createMatch, createMatchInvite, createRematch, createRematchRoom, createRoom, createRoomInvite, getAuthorizedReplay, getMatch, getMatchStrategies, getRoom, getRoomStrategies, getStrategies, joinAgentInvite, joinAvailablePlayerMatch, joinAvailableRoomPlayer, joinMatch, joinPlayerInvite, joinPlayerMatch, joinRoomAgent, listAccessibleReplays, observeCompetition, observeMatch, observeRoom, readyRoom, removeDisconnectedPlayer, removeDisconnectedRoomPlayer, resolveMatchInvite, startMatch, submitCompetitionReview, submitMatchAction, submitMatchReview, submitRoomAction, tickMatches } from './game/store.js';
import { assetsDirectory } from './game/runtime-paths.js';
import { browserPlayerResult, browserSessionCookie, browserSessionToken } from './server/browser-session.js';
import { handleMcpMessage } from './server/mcp.js';

const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const json = (res, code, body, headers = {}) => { res.writeHead(code, {'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*',...headers}); res.end(JSON.stringify(body)); };
const body = async (req) => { let data=''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; };
const replayAccess = (req) => String(req.headers['x-replay-access-token'] || '').trim();
const seatSession = (req) => browserSessionToken(req.headers.cookie);
const roomOwner = (req) => String(req.headers['x-room-owner-token'] || '').trim();
const gameInvite = (req) => String(req.headers['x-game-invite-token'] || '').trim();
const playerJson = (req, res, result) => {
  const player = browserPlayerResult(result);
  return json(res, 200, player.body, player.token ? {'set-cookie':browserSessionCookie(player.token, false)} : {});
};
const mcp = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  let message;
  try {
    message = await body(req);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json(res, 400, { jsonrpc:'2.0', id:null, error:{ code:-32700, message:'Parse error' } });
    }
    throw error;
  }
  const response = await handleMcpMessage(message);
  if (!response) { res.writeHead(202, { 'access-control-allow-origin': '*' }); return res.end(); }
  return json(res, 200, response);
};

const handleRequest = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/mcp' || url.pathname === '/agent/mcp') return await mcp(req, res);
    if (req.method === 'GET' && url.pathname === '/') { const data = await readFile(join(assetsDirectory, 'public/index.html')); res.writeHead(200, {'content-type': mime['.html']}); return res.end(data); }
    if (req.method === 'GET' && url.pathname.startsWith('/public/')) { const file = join(assetsDirectory, url.pathname); const data = await readFile(file); res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream'}); return res.end(data); }
    if (req.method === 'GET' && ['/app.js', '/cards.css', '/styles.css', '/header.css', '/lifecycle.css', '/cards-adapter.css'].includes(url.pathname)) { const file = join(assetsDirectory, 'public', url.pathname.slice(1)); const data = await readFile(file); res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream'}); return res.end(data); }
    if (req.method === 'GET' && url.pathname === '/api/agent-guide') {
      const markdown = await readFile(join(assetsDirectory, '.agents', 'skills', 'play-doudizhu', 'SKILL.md'), 'utf8');
      const hash = createHash('sha256').update(markdown).digest('hex');
      return json(res, 200, { protocol:'agent-game.v1', format:'agentskills', fileName:'SKILL.md', hash, markdown });
    }
    if (req.method === 'GET' && url.pathname === '/agent/v1/strategies') return json(res, 200, { protocol:'agent-game.v1', ...getStrategies() });
    if (req.method === 'GET' && url.pathname === '/api/replays') return json(res, 200, listAccessibleReplays({ limit:url.searchParams.get('limit'), offset:url.searchParams.get('offset'), status:url.searchParams.get('status'), replayAccessToken:replayAccess(req) }));
    if (req.method === 'POST' && (url.pathname === '/api/rooms' || url.pathname === '/agent/v1/rooms')) return json(res, 201, createRoom(await body(req)));
    const agentRoom = url.pathname.match(/^\/agent\/v1\/rooms\/([^/]+)\/(join|observe|ready|actions|review)$/);
    if (agentRoom) {
      const data = req.method === 'POST' ? await body(req) : {};
      const seatId = Number(req.method === 'GET' ? url.searchParams.get('seatId') : data.seatId);
      try {
        if (agentRoom[2] === 'join' && req.method === 'POST') return json(res, 200, joinRoomAgent(agentRoom[1], seatId, String(data.agentId || 'anonymous'), data.strategyId, data.displayName, { strategyMode:data.strategyMode, agentMetadata:data.agentMetadata }));
        if (agentRoom[2] === 'observe' && req.method === 'GET') return json(res, 200, observeRoom(agentRoom[1], seatId));
        if (agentRoom[2] === 'ready' && req.method === 'POST') return json(res, 200, readyRoom(agentRoom[1], seatId));
        if (agentRoom[2] === 'actions' && req.method === 'POST') return json(res, 200, submitRoomAction(agentRoom[1], data.gameId, seatId, data.action, data.seq, {source:'agent',decision:data.decision}));
        if (agentRoom[2] === 'review' && req.method === 'POST') return json(res, 200, submitMatchReview(getRoom(agentRoom[1])?.currentGameId, seatId, data.review));
      } catch (error) { return json(res, error.message === 'room_not_found' ? 404 : 400, {protocol:'agent-game.v1',ok:false,error:error.message}); }
    }
    const roomPlayer = url.pathname.match(/^\/api\/rooms\/([^/]+)\/players\/([0-2])$/);
    if (req.method === 'DELETE' && roomPlayer) { try { return json(res, 200, removeDisconnectedRoomPlayer(roomPlayer[1], Number(roomPlayer[2]), roomOwner(req))); } catch (error) { return json(res, error.message === 'room_owner_required' ? 403 : error.message === 'room_not_found' ? 404 : 400, {ok:false,error:error.message}); } }
    const browserRoom = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(state|strategies|join|ready|actions|invites))?$/);
    if (browserRoom) {
      if (!getRoom(browserRoom[1])) return json(res, 404, {error:'room_not_found'});
      try {
        if (req.method === 'GET' && browserRoom[2] === 'state') return json(res, 200, observeRoom(browserRoom[1], Number(url.searchParams.get('seat')), {requireAuthorization:true,revealAll:url.searchParams.get('view') === 'global',seatSessionToken:seatSession(req),roomOwnerToken:roomOwner(req),inviteToken:gameInvite(req)}));
        if (req.method === 'GET' && browserRoom[2] === 'strategies') { if (url.searchParams.get('view') !== 'global') return json(res, 403, {error:'global_view_required'}); assertRoomOwnerById(browserRoom[1], roomOwner(req)); return json(res, 200, getRoomStrategies(browserRoom[1])); }
        if (req.method === 'POST' && browserRoom[2] === 'join') { const data = await body(req); return playerJson(req, res, joinAvailableRoomPlayer(browserRoom[1], String(data.playerId || 'h5-player-auto'), data.displayName, {seatSessionToken:seatSession(req)})); }
        if (req.method === 'POST' && browserRoom[2] === 'ready') { const data = await body(req); return json(res, 200, readyRoom(browserRoom[1], Number(data.seatId), {seatSessionToken:seatSession(req)})); }
        if (req.method === 'POST' && browserRoom[2] === 'actions') { const data = await body(req); const state = submitRoomAction(browserRoom[1], data.gameId, Number(data.seatId), data.action, data.seq, {source:'player',seatSessionToken:seatSession(req)}); return json(res, 200, {ok:true,gameId:state.gameId,seq:state.seq}); }
        if (req.method === 'POST' && browserRoom[2] === 'invites') { const data = await body(req); return json(res, 201, createRoomInvite(browserRoom[1], data.inviteType, data.seatId, roomOwner(req))); }
      } catch (error) { return json(res, ['room_owner_required','access_denied'].includes(error.message) ? 403 : 400, {ok:false,error:error.message}); }
      return json(res, 405, {error:'method_not_allowed'});
    }
    const browserInvite = url.pathname.match(/^\/api\/invites\/([^/]+)(?:\/(join))?$/);
    if (browserInvite) {
      try {
        if (req.method === 'GET' && !browserInvite[2]) return json(res, 200, resolveMatchInvite(browserInvite[1]));
        if (req.method === 'POST' && browserInvite[2] === 'join') { const data = await body(req); return playerJson(req, res, joinPlayerInvite(browserInvite[1], data.playerId, data.displayName, seatSession(req))); }
      } catch (error) { return json(res, error.message === 'invite_not_found' ? 404 : 400, { protocol:'agent-game.v1', ok:false, error:error.message }); }
    }
    const agentInvite = url.pathname.match(/^\/agent\/v1\/invites\/([^/]+)(?:\/(join))?$/);
    if (agentInvite) {
      try {
        if (req.method === 'GET' && !agentInvite[2]) return json(res, 200, resolveMatchInvite(agentInvite[1]));
        if (req.method === 'POST' && agentInvite[2] === 'join') { const data = await body(req); return json(res, 200, joinAgentInvite(agentInvite[1], data.agentId, data.displayName, data.agentMetadata)); }
      } catch (error) { return json(res, error.message === 'invite_not_found' ? 404 : 400, { protocol:'agent-game.v1', ok:false, error:error.message }); }
    }
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
      try { return json(res, 200, observeCompetition(publicCompetition[1], null, { revealAll:url.searchParams.get('view') === 'global', roomOwnerToken:roomOwner(req) })); }
      catch (error) { return json(res, error.message === 'competition_not_found' ? 404 : error.message === 'room_owner_required' ? 403 : 400, { error:error.message }); }
    }
    const replayMatch = url.pathname.match(/^\/api\/replays\/([^/]+)$/);
    if (req.method === 'GET' && replayMatch) { try { return json(res, 200, getAuthorizedReplay(replayMatch[1], replayAccess(req))); } catch (error) { return json(res, error.message === 'replay_not_found' ? 404 : error.message === 'replay_access_denied' ? 403 : 400, { error: error.message }); } }
    const replayRoomRematch = url.pathname.match(/^\/api\/replays\/([^/]+)\/rematch-room$/);
    if (req.method === 'POST' && replayRoomRematch) { try { await body(req); return json(res, 201, createRematchRoom(replayRoomRematch[1], replayAccess(req))); } catch (error) { return json(res, error.message === 'replay_not_found' ? 404 : error.message === 'replay_access_denied' ? 403 : 400, {error:error.message}); } }
    const replayRematch = url.pathname.match(/^\/api\/replays\/([^/]+)\/rematch$/);
    if (req.method === 'POST' && replayRematch) {
      try { await body(req); const game = createRematch(replayRematch[1], replayAccess(req)); return json(res, 201, { protocol:'agent-game.v1', gameId:game.gameId, sourceGameId:game.sourceGameId, accessMode:game.accessMode, replayAccessToken:game.replayAccessToken || undefined, roomOwnerToken:game.roomOwnerToken, turnTimeoutMs:game.turnTimeoutMs }); }
      catch (error) { return json(res, error.message === 'replay_not_found' ? 404 : error.message === 'replay_access_denied' ? 403 : 400, { error:error.message }); }
    }
    if (req.method === 'POST' && (url.pathname === '/api/games' || url.pathname === '/agent/v1/games')) { const data = await body(req); const game = createMatch(data); return json(res, 201, { protocol:'agent-game.v1', gameId: game.gameId, accessMode: game.accessMode, replayAccessToken:game.replayAccessToken || undefined, roomOwnerToken:game.roomOwnerToken, turnTimeoutMs: game.turnTimeoutMs }); }
    const agentMatch = url.pathname.match(/^\/agent\/v1\/games\/([^/]+)\/(join|observe|start|actions|review)$/);
    if (agentMatch) {
      const data = req.method === 'POST' ? await body(req) : {};
      const seatId = Number(req.method === 'GET' ? url.searchParams.get('seatId') : data.seatId);
      try {
        if (agentMatch[2] === 'join' && req.method === 'POST') return json(res, 200, joinMatch(agentMatch[1], seatId, String(data.agentId || 'anonymous'), data.strategyId, data.displayName, { strategyMode:data.strategyMode, agentMetadata:data.agentMetadata }));
        if (agentMatch[2] === 'observe' && req.method === 'GET') return json(res, 200, observeMatch(agentMatch[1], seatId));
        if (agentMatch[2] === 'start' && req.method === 'POST') return json(res, 200, startMatch(agentMatch[1], seatId));
        if (agentMatch[2] === 'actions' && req.method === 'POST') return json(res, 200, submitMatchAction(agentMatch[1], seatId, data.action, data.seq, { source:'agent', decision:data.decision }));
        if (agentMatch[2] === 'review' && req.method === 'POST') return json(res, 200, submitMatchReview(agentMatch[1], seatId, data.review));
      } catch (error) { return json(res, 400, { protocol:'agent-game.v1', ok:false, error:error.message }); }
    }
    const removePlayer = url.pathname.match(/^\/api\/games\/([^/]+)\/players\/([0-2])$/);
    if (req.method === 'DELETE' && removePlayer) { try { return json(res, 200, removeDisconnectedPlayer(removePlayer[1], Number(removePlayer[2]), roomOwner(req))); } catch (error) { return json(res, error.message === 'room_owner_required' ? 403 : 400, {ok:false,error:error.message}); } }
    const match = url.pathname.match(/^\/api\/games\/([^/]+)(?:\/(state|strategies|join|start|actions|invites))?$/); if (!match) return json(res, 404, { error: 'not_found' });
    const game = getMatch(match[1]); if (!game) return json(res, 404, { error: 'game_not_found' });
    if (req.method === 'GET' && match[2] === 'state') { const seat = Number(url.searchParams.get('seat')); const revealAll = url.searchParams.get('view') === 'global'; try { return json(res, 200, observeMatch(match[1], seat, { requireAuthorization:true, revealAll, seatSessionToken:seatSession(req), roomOwnerToken:roomOwner(req), inviteToken:gameInvite(req) })); } catch (error) { return json(res, ['room_owner_required', 'access_denied'].includes(error.message) ? 403 : 400, {error:error.message}); } }
    if (req.method === 'GET' && match[2] === 'strategies') { if (url.searchParams.get('view') !== 'global') return json(res, 403, { error:'global_view_required' }); try { assertMatchRoomOwner(match[1], roomOwner(req)); return json(res, 200, getMatchStrategies(match[1])); } catch (error) { return json(res, 403, { error:error.message }); } }
    if (req.method === 'POST' && match[2] === 'join') { const data = await body(req); try { const automatic = data.seatId === undefined || data.seatId === null || data.seatId === 'auto'; const options = { seatSessionToken:seatSession(req) }; const result = automatic ? joinAvailablePlayerMatch(match[1], String(data.playerId || 'h5-player-auto'), data.displayName, options) : joinPlayerMatch(match[1], Number(data.seatId), String(data.playerId || `h5-player-${data.seatId}`), data.displayName, options); return playerJson(req, res, result); } catch (error) { return json(res, 400, {ok:false,error:error.message}); } }
    if (req.method === 'POST' && match[2] === 'start') { const data = await body(req); try { return json(res, 200, startMatch(match[1], Number(data.seatId), { seatSessionToken:seatSession(req) })); } catch (error) { return json(res, 400, {ok:false,error:error.message}); } }
    if (req.method === 'POST' && match[2] === 'actions') { const data = await body(req); try { const state = submitMatchAction(match[1], Number(data.seatId), data.action, data.seq, { source:'player', seatSessionToken:seatSession(req) }); return json(res, 200, { ok: true, seq: state.seq }); } catch (error) { return json(res, 400, { ok: false, error: error.message }); } }
    if (req.method === 'POST' && match[2] === 'invites') { const data = await body(req); try { return json(res, 201, createMatchInvite(match[1], data.inviteType, data.seatId, roomOwner(req))); } catch (error) { return json(res, error.message === 'room_owner_required' ? 403 : 400, {ok:false,error:error.message}); } }
    return json(res, 405, { error: 'method_not_allowed' });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 500;
    const payload = error instanceof SyntaxError ? { error:'invalid_json' } : { error:error.message };
    if (!res.headersSent && !res.writableEnded) return json(res, status, payload);
    console.error('Request failed after the response started:', error);
    if (!res.destroyed) res.destroy();
  }
};

const server = http.createServer((req, res) => {
  res.on('error', (error) => console.error('Response stream error:', error));
  void handleRequest(req, res).catch((error) => {
    console.error('Unhandled request error:', error);
    if (!res.headersSent && !res.writableEnded) {
      try { json(res, 500, { error:'internal_server_error' }); }
      catch (responseError) { console.error('Failed to send error response:', responseError); }
    }
    if (!res.writableEnded && !res.destroyed) res.destroy();
  });
});

server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

server.listen(process.env.PORT || 3000, () => console.log(`DDZ server running at http://localhost:${process.env.PORT || 3000}`));
const ticker = setInterval(() => {
  try { tickMatches(); }
  catch (error) { console.error('Match ticker error:', error); }
}, 1000);
ticker.unref();
