import { applyAction, chooseSimpleAction, createGame, publicState } from './ddz.js';

const games = new Map();
const DEFAULT_TURN_TIMEOUT_MS = 60_000;
const MIN_TURN_TIMEOUT_MS = 30_000;
const MAX_TURN_TIMEOUT_MS = 60_000;
const configuredTurnTimeoutMs = normalizeTurnTimeout(process.env.TURN_TIMEOUT_MS);

export function createMatch(options = {}) {
  const game = createGame();
  game.agents = new Map();
  game.turnTimeoutMs = normalizeTurnTimeout(options.turnTimeoutMs ?? configuredTurnTimeoutMs);
  resetTurnClock(game);
  games.set(game.gameId, game);
  return game;
}

export function getMatch(gameId) {
  return games.get(gameId) || null;
}

export function joinMatch(gameId, seatId, agentId) {
  const game = requireMatch(gameId);
  validateSeat(seatId);
  const occupant = game.agents.get(seatId);
  if (occupant && occupant !== agentId) throw new Error('seat_occupied');
  game.agents.set(seatId, agentId);
  return observeMatch(gameId, seatId);
}

export function observeMatch(gameId, seatId, options = {}) {
  const game = requireMatch(gameId);
  advanceTimedOutTurn(game);
  validateSeat(seatId);
  const isYourTurn = game.current === seatId && game.winner === null;
  const allowedActions = !isYourTurn ? [] : game.phase === 'bid'
    ? [{ type: 'bid', stage: game.bidStage, values: [0, 1] }]
    : [{ type: 'play', cards: 'select from your hand' }, ...(game.lastPlay ? [{ type: 'pass' }] : [])];
  return { protocol: 'agent-game.v1', ...publicState(game, seatId, options.revealAll === true), view: options.revealAll === true ? 'global' : 'player', you: seatId, isYourTurn, allowedActions, agentSeats: Object.fromEntries(game.agents), turnTimeoutMs: game.turnTimeoutMs, turnStartedAt: game.turnStartedAt, turnDeadlineAt: game.turnDeadlineAt, serverNow: Date.now() };
}

export function submitMatchAction(gameId, seatId, action, expectedSeq) {
  const game = requireMatch(gameId);
  advanceTimedOutTurn(game);
  validateSeat(seatId);
  if (expectedSeq !== undefined && expectedSeq !== game.seq) throw new Error('stale_state');
  applyAction(game, seatId, action);
  resetTurnClock(game);
  return observeMatch(gameId, seatId);
}

export function runBot(gameId) {
  const game = requireMatch(gameId);
  const timeoutResult = advanceTimedOutTurn(game);
  if (timeoutResult) return timeoutResult;
  if (game.winner !== null) throw new Error('game_over');
  if (game.agents.has(game.current)) throw new Error('agent_turn');
  const seatId = game.current;
  applyAction(game, seatId, chooseSimpleAction(game, seatId));
  resetTurnClock(game);
  return { seatId, seq: game.seq, timedOut: false };
}

export function tickMatches() {
  for (const game of games.values()) advanceTimedOutTurn(game);
}

export function advanceMatchTimeout(gameId, now = Date.now()) {
  return advanceTimedOutTurn(requireMatch(gameId), now);
}

function advanceTimedOutTurn(game, now = Date.now()) {
  ensureTurnClock(game, now);
  if (game.winner !== null || game.turnDeadlineAt === null || now < game.turnDeadlineAt) return null;
  const seatId = game.current;
  const bidStage = game.bidStage;
  const action = game.phase === 'bid'
    ? { type: 'bid', value: 0 }
    : game.lastPlay
      ? { type: 'pass' }
      : chooseSimpleAction(game, seatId);
  applyAction(game, seatId, action);
  game.log.push(`座位${seatId} 回合超时，自动${action.type === 'pass' ? '不要' : action.type === 'bid' ? bidStage === 'rob' ? '不抢' : '不叫' : '出牌'}`);
  resetTurnClock(game, now);
  return { seatId, seq: game.seq, timedOut: true };
}

function ensureTurnClock(game, now = Date.now()) {
  if (!game.turnTimeoutMs) game.turnTimeoutMs = configuredTurnTimeoutMs;
  if (game.turnStartedAt === undefined || game.turnDeadlineAt === undefined) resetTurnClock(game, now);
}

function resetTurnClock(game, now = Date.now()) {
  if (game.winner !== null) {
    game.turnStartedAt = null;
    game.turnDeadlineAt = null;
    return;
  }
  game.turnStartedAt = now;
  game.turnDeadlineAt = now + game.turnTimeoutMs;
}

function normalizeTurnTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TURN_TIMEOUT_MS;
  return Math.min(MAX_TURN_TIMEOUT_MS, Math.max(MIN_TURN_TIMEOUT_MS, Math.round(parsed)));
}

function requireMatch(gameId) {
  const game = games.get(gameId);
  if (!game) throw new Error('game_not_found');
  return game;
}

function validateSeat(seatId) {
  if (![0, 1, 2].includes(Number(seatId))) throw new Error('invalid_seat');
}
