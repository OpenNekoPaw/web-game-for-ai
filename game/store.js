import { applyAction, chooseSimpleAction, createGame, publicState, startGame } from './ddz.js';
import { appendReplayFrame, createReplay, readReplay, updateReplayParticipants } from './replay-store.js';
import { getStrategy, listStrategies } from './strategy-store.js';

const games = new Map();
const competitions = new Map();
const DEFAULT_TURN_TIMEOUT_MS = 60_000;
const MIN_TURN_TIMEOUT_MS = 30_000;
const MAX_TURN_TIMEOUT_MS = 60_000;
const configuredTurnTimeoutMs = normalizeTurnTimeout(process.env.TURN_TIMEOUT_MS);
let lastGameTimestamp = 0;
let lastCompetitionTimestamp = 0;

export function createMatch(options = {}) {
  const game = createGame(nextGameId());
  game.agents = new Map();
  game.players = new Map();
  game.ready = new Set();
  game.decisions = [];
  game.actionHistory = [];
  game.agentStrategies = new Map();
  game.reviews = new Map();
  game.actionStats = [createActionStats(), createActionStats(), createActionStats()];
  game.competitionId = options.competitionId || null;
  game.roundNumber = options.roundNumber || 1;
  game.settlement = null;
  game.turnTimeoutMs = normalizeTurnTimeout(options.turnTimeoutMs ?? configuredTurnTimeoutMs);
  clearTurnClock(game);
  games.set(game.gameId, game);
  createReplay(game.gameId, replayState(game), {});
  return game;
}

export function createCompetition(options = {}) {
  const totalRounds = normalizeTotalRounds(options.totalRounds);
  const competitionId = nextCompetitionId();
  const competition = {
    competitionId,
    totalRounds,
    currentRound: 1,
    currentGameId: null,
    gameIds: [],
    status: 'waiting',
    scores: [0, 0, 0],
    rounds: [],
    reviews: new Map(),
    createdAt: Date.now(),
    completedAt: null,
    turnTimeoutMs: normalizeTurnTimeout(options.turnTimeoutMs ?? configuredTurnTimeoutMs)
  };
  competitions.set(competitionId, competition);
  const game = createMatch({ competitionId, roundNumber: 1, turnTimeoutMs: competition.turnTimeoutMs });
  competition.currentGameId = game.gameId;
  competition.gameIds.push(game.gameId);
  return observeCompetition(competitionId);
}

export function observeCompetition(competitionId, seatId = null, options = {}) {
  const competition = requireCompetition(competitionId);
  const normalizedSeat = seatId === null || seatId === undefined ? null : Number(seatId);
  if (normalizedSeat !== null) validateSeat(normalizedSeat);
  const currentGame = games.get(competition.currentGameId);
  const expectedSeats = currentGame ? [...currentGame.agents.keys()].sort() : [];
  const submittedSeats = [...competition.reviews.keys()].sort();
  return {
    protocol: 'agent-game.v1',
    competitionId,
    totalRounds: competition.totalRounds,
    currentRound: competition.currentRound,
    currentGameId: competition.currentGameId,
    gameIds: [...competition.gameIds],
    status: competition.status,
    scores: [...competition.scores],
    rounds: competitionRounds(competition, normalizedSeat, options.revealAll === true),
    reviewStatus: { expectedSeats, submittedSeats, complete: expectedSeats.length > 0 && expectedSeats.every((seat) => competition.reviews.has(seat)) },
    reviews: options.revealAll === true
      ? Object.fromEntries(competition.reviews)
      : normalizedSeat !== null && competition.reviews.has(normalizedSeat)
        ? { [normalizedSeat]: structuredClone(competition.reviews.get(normalizedSeat)) }
        : {},
    reviewContext: normalizedSeat === null || competition.status !== 'reviewing_competition' ? null : buildCompetitionReviewContext(competition, normalizedSeat),
    completedAt: competition.completedAt
  };
}

function nextGameId() {
  const timestamp = Math.max(Date.now(), lastGameTimestamp + 1);
  lastGameTimestamp = timestamp;
  return `ddz-${timestamp}`;
}

function nextCompetitionId() {
  const timestamp = Math.max(Date.now(), lastCompetitionTimestamp + 1);
  lastCompetitionTimestamp = timestamp;
  return `match-${timestamp}`;
}

export function getMatch(gameId) {
  return games.get(gameId) || null;
}

export function joinMatch(gameId, seatId, agentId, strategyId) {
  const game = requireMatch(gameId);
  validateSeat(seatId);
  if (game.players.has(seatId)) throw new Error('seat_occupied');
  const occupant = game.agents.get(seatId);
  if (occupant && occupant !== agentId) throw new Error('seat_occupied');
  game.agents.set(seatId, agentId);
  if (!game.agentStrategies.has(seatId)) game.agentStrategies.set(seatId, getStrategy(strategyId));
  else if (strategyId && game.agentStrategies.get(seatId).id !== strategyId) throw new Error('strategy_mismatch');
  updateReplayParticipants(gameId, participants(game));
  return observeMatch(gameId, seatId);
}

export function joinPlayerMatch(gameId, seatId, playerId) {
  const game = requireMatch(gameId);
  validateSeat(seatId);
  if (game.agents.has(seatId)) throw new Error('seat_occupied');
  const occupant = game.players.get(seatId);
  if (occupant && occupant !== playerId) throw new Error('seat_occupied');
  game.players.set(seatId, playerId);
  updateReplayParticipants(gameId, participants(game));
  return observeMatch(gameId, seatId);
}

export function startMatch(gameId, seatId = null) {
  const game = requireMatch(gameId);
  if (game.phase !== 'waiting') throw new Error('game_already_started');
  validateSeat(seatId);
  if (!occupiedSeats(game).includes(seatId)) throw new Error('seat_not_joined');
  const wasReady = game.ready.has(seatId);
  game.ready.add(seatId);
  if (occupiedSeats(game).length === 3 && game.ready.size === 3) {
    startGame(game);
    if (game.competitionId) requireCompetition(game.competitionId).status = 'playing';
    resetTurnClock(game);
    recordFrame(game, { type: 'started', seatId });
  } else if (!wasReady) recordFrame(game, { type: 'ready', seatId });
  return observeMatch(gameId, seatId);
}

export function observeMatch(gameId, seatId, options = {}) {
  const game = requireMatch(gameId);
  advanceTimedOutTurn(game);
  validateSeat(seatId);
  const isYourTurn = game.phase !== 'waiting' && game.current === seatId && game.winner === null;
  const allowedActions = !isYourTurn ? [] : game.phase === 'bid'
    ? [{ type: 'bid', stage: game.bidStage, values: [0, 1] }]
    : [{ type: 'play', cards: 'select from your hand' }, ...(game.lastPlay ? [{ type: 'pass' }] : [])];
  const readySeats = [...game.ready].sort();
  const reviewContext = game.phase === 'over' && game.agents.has(seatId) ? buildReviewContext(game, seatId) : null;
  return { protocol: 'agent-game.v1', ...publicState(game, seatId, options.revealAll === true), view: options.revealAll === true ? 'global' : 'player', you: seatId, isYourTurn, allowedActions, agentSeats: Object.fromEntries(game.agents), playerSeats: Object.fromEntries(game.players), seatControllers: seatControllers(game), readySeats, allReady: readySeats.length === 3, settlement: structuredClone(game.settlement), competition: game.competitionId ? competitionStateForGame(game, seatId, options.revealAll === true) : null, strategy: game.agentStrategies.has(seatId) ? structuredClone(game.agentStrategies.get(seatId)) : null, strategyAssignments: options.revealAll === true ? strategyAssignments(game) : {}, decisions: options.revealAll === true ? structuredClone(game.decisions) : [], reviews: options.revealAll === true ? reviews(game) : game.reviews.has(seatId) ? { [seatId]: structuredClone(game.reviews.get(seatId)) } : {}, reviewStatus: reviewStatus(game), reviewContext, turnTimeoutMs: game.turnTimeoutMs, turnStartedAt: game.turnStartedAt, turnDeadlineAt: game.turnDeadlineAt, serverNow: Date.now() };
}

export function submitMatchAction(gameId, seatId, action, expectedSeq, options = {}) {
  const game = requireMatch(gameId);
  advanceTimedOutTurn(game);
  validateSeat(seatId);
  if (expectedSeq !== undefined && expectedSeq !== game.seq) throw new Error('stale_state');
  const decision = normalizeDecision(options.decision);
  const phase = game.phase;
  const turnStartedAt = game.turnStartedAt;
  try {
    applyAction(game, seatId, action);
  } catch (error) {
    game.actionStats[seatId].rejectedActions += 1;
    recordFrame(game, { type: 'action_rejected', source: options.source || 'player', seatId, action, error: error.message });
    throw error;
  }
  settleGame(game);
  const decidedAt = Date.now();
  const decisionRecord = decision ? {
    seq: game.seq,
    at: decidedAt,
    seatId,
    source: options.source || 'player',
    phase,
    action: structuredClone(action),
    ...decision,
    durationMs: turnStartedAt === null ? null : Math.max(0, decidedAt - turnStartedAt)
  } : null;
  game.actionHistory.push({ seq: game.seq, at: decidedAt, seatId, source: options.source || 'player', phase, action: structuredClone(action) });
  if (decisionRecord) game.decisions.push(decisionRecord);
  updateAcceptedStats(game.actionStats[seatId], action, decisionRecord?.durationMs);
  resetTurnClock(game);
  recordFrame(game, { type: 'action', source: options.source || 'player', seatId, action, ...(decisionRecord ? { decision: decisionRecord } : {}) });
  return observeMatch(gameId, seatId);
}

export function getStrategies() {
  return listStrategies();
}

export function submitMatchReview(gameId, seatId, review) {
  const game = requireMatch(gameId);
  validateSeat(seatId);
  if (game.phase !== 'over') throw new Error('game_not_over');
  if (!game.agents.has(seatId)) throw new Error('agent_not_joined');
  const normalized = normalizeReview(review);
  const record = {
    seatId,
    agentId: game.agents.get(seatId),
    strategy: strategySummary(game.agentStrategies.get(seatId)),
    submittedAt: Date.now(),
    ...normalized
  };
  const wasSubmitted = game.reviews.has(seatId);
  game.reviews.set(seatId, record);
  recordFrame(game, { type: 'review', seatId, review: record });
  if (!wasSubmitted && reviewStatus(game).complete) advanceCompetitionAfterRound(game);
  return { protocol: 'agent-game.v1', gameId, review: structuredClone(record), reviewStatus: reviewStatus(game), competition: game.competitionId ? competitionStateForGame(game, seatId) : null };
}

export function submitCompetitionReview(competitionId, seatId, review) {
  const competition = requireCompetition(competitionId);
  validateSeat(seatId);
  if (competition.status !== 'reviewing_competition' && competition.status !== 'over') throw new Error('competition_not_finished');
  const currentGame = requireMatch(competition.currentGameId);
  if (!currentGame.agents.has(seatId)) throw new Error('agent_not_joined');
  const normalized = normalizeCompetitionReview(review);
  const record = { seatId, agentId: currentGame.agents.get(seatId), submittedAt: Date.now(), ...normalized };
  competition.reviews.set(seatId, record);
  const expectedSeats = [...currentGame.agents.keys()];
  if (expectedSeats.length && expectedSeats.every((seat) => competition.reviews.has(seat))) {
    competition.status = 'over';
    competition.completedAt = Date.now();
  }
  recordFrame(currentGame, { type: 'competition_review', seatId, review: record });
  return observeCompetition(competitionId, seatId);
}

export function runBot(gameId) {
  const game = requireMatch(gameId);
  const timeoutResult = advanceTimedOutTurn(game);
  if (timeoutResult) return timeoutResult;
  if (game.winner !== null) throw new Error('game_over');
  if (game.phase === 'waiting') throw new Error('game_not_started');
  if (game.agents.has(game.current) || game.players.has(game.current)) throw new Error('occupied_turn');
  const seatId = game.current;
  const action = chooseSimpleAction(game, seatId);
  applyAction(game, seatId, action);
  settleGame(game);
  game.actionHistory.push({ seq: game.seq, at: Date.now(), seatId, source: 'bot', phase: game.phase, action: structuredClone(action) });
  resetTurnClock(game);
  recordFrame(game, { type: 'action', source: 'bot', seatId, action });
  return { seatId, seq: game.seq, timedOut: false };
}

export function getReplay(gameId) {
  return readReplay(gameId);
}

export function tickMatches() {
  for (const game of games.values()) advanceTimedOutTurn(game);
}

export function advanceMatchTimeout(gameId, now = Date.now()) {
  return advanceTimedOutTurn(requireMatch(gameId), now);
}

function advanceTimedOutTurn(game, now = Date.now()) {
  if (game.phase === 'waiting') { clearTurnClock(game); return null; }
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
  settleGame(game);
  game.actionHistory.push({ seq: game.seq, at: now, seatId, source: 'timeout', phase: game.phase, action: structuredClone(action) });
  game.log.push(`座位${seatId} 回合超时，自动${action.type === 'pass' ? '不要' : action.type === 'bid' ? bidStage === 'rob' ? '不抢' : '不叫' : '出牌'}`);
  resetTurnClock(game, now);
  recordFrame(game, { type: 'action', source: 'timeout', seatId, action }, now);
  return { seatId, seq: game.seq, timedOut: true };
}

function recordFrame(game, event, now = Date.now()) {
  appendReplayFrame(game.gameId, event, replayState(game, now), participants(game));
}

function replayState(game, now = Date.now()) {
  return {
    protocol: 'agent-game.v1',
    ...publicState(game, null, true),
    view: 'global',
    you: null,
    isYourTurn: false,
    allowedActions: [],
    agentSeats: Object.fromEntries(game.agents),
    playerSeats: Object.fromEntries(game.players),
    seatControllers: seatControllers(game),
    readySeats: [...game.ready].sort(),
    allReady: game.ready.size === 3,
    settlement: structuredClone(game.settlement),
    competition: game.competitionId ? competitionStateForGame(game, null, true) : null,
    strategyAssignments: strategyAssignments(game),
    decisions: structuredClone(game.decisions),
    reviews: reviews(game),
    reviewStatus: reviewStatus(game),
    turnTimeoutMs: game.turnTimeoutMs,
    turnStartedAt: game.turnStartedAt,
    turnDeadlineAt: game.turnDeadlineAt,
    serverNow: now
  };
}

function ensureTurnClock(game, now = Date.now()) {
  if (!game.turnTimeoutMs) game.turnTimeoutMs = configuredTurnTimeoutMs;
  if (game.turnStartedAt === undefined || game.turnDeadlineAt === undefined) resetTurnClock(game, now);
}

function resetTurnClock(game, now = Date.now()) {
  if (game.winner !== null || game.phase === 'waiting') return clearTurnClock(game);
  game.turnStartedAt = now;
  game.turnDeadlineAt = now + game.turnTimeoutMs;
}

function clearTurnClock(game) {
  game.turnStartedAt = null;
  game.turnDeadlineAt = null;
}

function occupiedSeats(game) {
  return [...new Set([...game.agents.keys(), ...game.players.keys()])].sort();
}

function seatControllers(game) {
  return Object.fromEntries(occupiedSeats(game).map((seatId) => [seatId, game.agents.has(seatId)
    ? { type: 'agent', id: game.agents.get(seatId) }
    : { type: 'player', id: game.players.get(seatId) }]));
}

function participants(game) {
  return Object.fromEntries(Object.entries(seatControllers(game)).map(([seatId, controller]) => [seatId, {
    ...controller,
    ...(game.agentStrategies.has(Number(seatId)) ? { strategy: structuredClone(game.agentStrategies.get(Number(seatId))) } : {})
  }]));
}

function strategyAssignments(game) {
  return Object.fromEntries([...game.agentStrategies].map(([seatId, strategy]) => [seatId, strategySummary(strategy)]));
}

function strategySummary(strategy) {
  if (!strategy) return null;
  return { id: strategy.id, name: strategy.name, version: strategy.version, hash: strategy.hash, description: strategy.description };
}

function reviews(game) {
  return Object.fromEntries([...game.reviews].map(([seatId, review]) => [seatId, structuredClone(review)]));
}

function reviewStatus(game) {
  const expectedSeats = [...game.agents.keys()].sort();
  const submittedSeats = [...game.reviews.keys()].sort();
  return { expectedSeats, submittedSeats, complete: expectedSeats.length > 0 && expectedSeats.every((seatId) => game.reviews.has(seatId)) };
}

function settleGame(game) {
  if (game.phase !== 'over' || game.settlement) return;
  const scoreDelta = game.winner === 'landlord'
    ? [0, 1, 2].map((seatId) => seatId === game.landlord ? 2 : -1)
    : [0, 1, 2].map((seatId) => seatId === game.landlord ? -2 : 1);
  game.settlement = {
    scoring: 'fixed-zero-sum-v1',
    multiplier: 1,
    winner: game.winner,
    landlord: game.landlord,
    scoreDelta,
    finalCardCounts: game.hands.map((cards) => cards.length),
    settledAt: Date.now()
  };
  if (!game.competitionId) return;
  const competition = requireCompetition(game.competitionId);
  competition.scores = competition.scores.map((score, seatId) => score + scoreDelta[seatId]);
  competition.rounds.push({
    roundNumber: game.roundNumber,
    gameId: game.gameId,
    winner: game.winner,
    landlord: game.landlord,
    scoreDelta: [...scoreDelta],
    cumulativeScores: [...competition.scores],
    finalCardCounts: game.hands.map((cards) => cards.length),
    settledAt: game.settlement.settledAt,
    reviews: {}
  });
  competition.status = 'reviewing_round';
  if (game.agents.size === 0) advanceCompetitionAfterRound(game);
}

function advanceCompetitionAfterRound(game) {
  if (!game.competitionId) return;
  const competition = requireCompetition(game.competitionId);
  const round = competition.rounds.find((item) => item.gameId === game.gameId);
  if (round) round.reviews = reviews(game);
  if (game.roundNumber >= competition.totalRounds) {
    if (game.agents.size === 0) {
      competition.status = 'over';
      competition.completedAt = Date.now();
    } else competition.status = 'reviewing_competition';
    return;
  }
  const nextRound = game.roundNumber + 1;
  const nextGame = createMatch({ competitionId: competition.competitionId, roundNumber: nextRound, turnTimeoutMs: competition.turnTimeoutMs });
  nextGame.agents = new Map(game.agents);
  nextGame.players = new Map(game.players);
  nextGame.agentStrategies = new Map([...game.agentStrategies].map(([seatId, strategy]) => [seatId, structuredClone(strategy)]));
  updateReplayParticipants(nextGame.gameId, participants(nextGame));
  competition.currentRound = nextRound;
  competition.currentGameId = nextGame.gameId;
  competition.gameIds.push(nextGame.gameId);
  competition.status = 'waiting';
}

function competitionStateForGame(game, seatId = null, revealAll = false) {
  const competition = requireCompetition(game.competitionId);
  return {
    competitionId: competition.competitionId,
    totalRounds: competition.totalRounds,
    currentRound: competition.currentRound,
    currentGameId: competition.currentGameId,
    status: competition.status,
    scores: [...competition.scores],
    rounds: competitionRounds(competition, seatId, revealAll),
    reviews: revealAll
      ? Object.fromEntries(competition.reviews)
      : seatId !== null && seatId !== undefined && competition.reviews.has(seatId)
        ? { [seatId]: structuredClone(competition.reviews.get(seatId)) }
        : {}
  };
}

function competitionRounds(competition, seatId, revealAll) {
  return competition.rounds.map((round) => ({
    ...structuredClone(round),
    reviews: revealAll
      ? structuredClone(round.reviews || {})
      : seatId !== null && seatId !== undefined && round.reviews?.[seatId]
        ? { [seatId]: structuredClone(round.reviews[seatId]) }
        : {}
  }));
}

function buildCompetitionReviewContext(competition, seatId) {
  const currentGame = requireMatch(competition.currentGameId);
  const ownRoundReviews = competition.rounds.map((round) => ({
    roundNumber: round.roundNumber,
    gameId: round.gameId,
    winner: round.winner,
    landlord: round.landlord,
    scoreDelta: round.scoreDelta[seatId],
    cumulativeScore: round.cumulativeScores[seatId],
    finalCardCounts: round.finalCardCounts,
    review: round.reviews?.[seatId] || null
  }));
  return {
    seatId,
    agentId: currentGame.agents.get(seatId),
    totalRounds: competition.totalRounds,
    scores: [...competition.scores],
    rank: competition.scores.filter((score) => score > competition.scores[seatId]).length + 1,
    rounds: ownRoundReviews,
    strategy: structuredClone(currentGame.agentStrategies.get(seatId)),
    guidance: [
      '区分偶发单局问题与多局重复出现的策略问题',
      '结合地主和农民两种身份比较策略表现',
      '只把有多局证据支持的规则列为最终 Markdown 修改建议'
    ]
  };
}

function buildReviewContext(game, seatId) {
  const role = game.landlord === seatId ? 'landlord' : 'farmer';
  const won = game.winner === (role === 'farmer' ? 'farmers' : 'landlord');
  const stats = game.actionStats[seatId];
  return {
    role,
    result: won ? 'win' : 'loss',
    winner: game.winner,
    landlord: game.landlord,
    finalCardCounts: game.hands.map((cards) => cards.length),
    strategy: structuredClone(game.agentStrategies.get(seatId)),
    stats: {
      ...structuredClone(stats),
      averageDecisionMs: stats.decisionCount ? Math.round(stats.totalDecisionMs / stats.decisionCount) : null
    },
    decisions: game.decisions.filter((decision) => decision.seatId === seatId).map((decision) => structuredClone(decision)),
    publicActions: structuredClone(game.actionHistory),
    reviewGuidance: [
      '识别导致胜负的具体出牌或不要决策',
      '检查是否让对手一次打出大量牌或在少牌阶段未及时拦截',
      '把改进建议写成可更新到当前 Markdown 策略的明确规则'
    ]
  };
}

function createActionStats() {
  return { acceptedActions: 0, rejectedActions: 0, bids: 0, plays: 0, passes: 0, cardsPlayed: 0, decisionCount: 0, totalDecisionMs: 0 };
}

function updateAcceptedStats(stats, action, durationMs) {
  stats.acceptedActions += 1;
  if (action.type === 'bid') stats.bids += 1;
  if (action.type === 'play') { stats.plays += 1; stats.cardsPlayed += action.cards?.length || 0; }
  if (action.type === 'pass') stats.passes += 1;
  if (Number.isFinite(durationMs)) { stats.decisionCount += 1; stats.totalDecisionMs += durationMs; }
}

function normalizeTurnTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TURN_TIMEOUT_MS;
  return Math.min(MAX_TURN_TIMEOUT_MS, Math.max(MIN_TURN_TIMEOUT_MS, Math.round(parsed)));
}

function normalizeTotalRounds(value) {
  const rounds = Number(value ?? 3);
  if (![3, 5, 7].includes(rounds)) throw new Error('invalid_total_rounds');
  return rounds;
}

function normalizeDecision(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_decision');
  const summary = normalizeDecisionText(value.summary, 160, true);
  const intent = normalizeDecisionText(value.intent, 80, false);
  let confidence;
  if (value.confidence !== undefined) {
    confidence = Number(value.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('invalid_decision');
  }
  return { summary, ...(intent ? { intent } : {}), ...(confidence !== undefined ? { confidence } : {}) };
}

function normalizeDecisionText(value, maxLength, required) {
  if (value === undefined || value === null) {
    if (required) throw new Error('invalid_decision');
    return '';
  }
  if (typeof value !== 'string') throw new Error('invalid_decision');
  const text = value.trim();
  if ((required && !text) || text.length > maxLength) throw new Error('invalid_decision');
  return text;
}

function normalizeReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_review');
  return {
    assessment: normalizeDecisionText(value.assessment, 500, true),
    problems: normalizeTextList(value.problems, 5, 180),
    improvements: normalizeTextList(value.improvements, 5, 180),
    strategySuggestions: normalizeTextList(value.strategySuggestions, 5, 220)
  };
}

function normalizeCompetitionReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_competition_review');
  return {
    assessment: normalizeDecisionText(value.assessment, 800, true),
    recurringProblems: normalizeTextList(value.recurringProblems, 6, 220),
    validatedImprovements: normalizeTextList(value.validatedImprovements, 6, 220),
    finalStrategySuggestions: normalizeTextList(value.finalStrategySuggestions, 6, 260)
  };
}

function normalizeTextList(value, maxItems, maxLength) {
  if (!Array.isArray(value) || !value.length || value.length > maxItems) throw new Error('invalid_review');
  return value.map((item) => normalizeDecisionText(item, maxLength, true));
}

function requireMatch(gameId) {
  const game = games.get(gameId);
  if (!game) throw new Error('game_not_found');
  return game;
}

function requireCompetition(competitionId) {
  const competition = competitions.get(competitionId);
  if (!competition) throw new Error('competition_not_found');
  return competition;
}

function validateSeat(seatId) {
  if (![0, 1, 2].includes(Number(seatId))) throw new Error('invalid_seat');
}
