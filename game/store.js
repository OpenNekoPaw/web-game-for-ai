import { applyAction, chooseSimpleAction, createDeck, createGame, publicState, startGame } from './ddz.js';
import { appendReplayFrame, bindReplayAccessToken, createReplay, exportReplayState, importReplayState, listReplays, readReplay, replayAccessMatches, updateReplayParticipants } from './replay-runtime.js';
import { getStrategy, listStrategies } from './strategy-runtime.js';

const games = new Map();
const competitions = new Map();
const invites = new Map();
const DEFAULT_TURN_TIMEOUT_MS = 60_000;
const MAX_TURN_TIMEOUT_MS = 60_000;
const INVITE_TTL_MS = 30 * 60_000;
const PLAYER_OFFLINE_MS = 10_000;
const WAITING_SEAT_RELEASE_MS = 60_000;
const COMPLETED_GAME_RECOVERY_MS = 5 * 60_000;
const ACTIVE_GAME_RECOVERY_MS = 10 * 60_000;
const ACCESS_MODES = new Set(['open', 'invite_only', 'private']);
const configuredTurnTimeoutMs = normalizeTurnTimeout(globalThis.process?.env?.TURN_TIMEOUT_MS);
let lastGameTimestamp = 0;
let lastCompetitionTimestamp = 0;
let authoritativeRevision = 0;
let dirtyMetadataRevision = 0;
const dirtyGameRevisions = new Map();

function markGameAuthoritative(gameId) {
  authoritativeRevision += 1;
  dirtyGameRevisions.set(gameId, authoritativeRevision);
}

function markMetadataAuthoritative() {
  authoritativeRevision += 1;
  dirtyMetadataRevision = authoritativeRevision;
}

export function exportDirtyAuthoritativeState() {
  return {
    revision: authoritativeRevision,
    metadataRevision: dirtyMetadataRevision,
    gameRevisions: [...dirtyGameRevisions.entries()]
  };
}

export function markAuthoritativeStatePersisted(state = {}) {
  for (const [gameId, revision] of state.gameRevisions || []) {
    if (dirtyGameRevisions.get(gameId) === revision) dirtyGameRevisions.delete(gameId);
  }
  if (dirtyMetadataRevision === state.metadataRevision) dirtyMetadataRevision = 0;
}

export function createMatch(options = {}) {
  const game = createGame(nextGameId());
  game.accessMode = normalizeAccessMode(options.accessMode);
  game.replayAccessToken = game.accessMode === 'open' ? null : normalizeReplayAccessToken(options.replayAccessToken) || createAccessToken();
  game.roomOwnerToken = normalizeAccessToken(options.roomOwnerToken) || createAccessToken();
  game.allowedAgentIds = normalizeIdentitySet(options.allowedAgentIds);
  game.allowedPlayerIds = normalizeIdentitySet(options.allowedPlayerIds);
  game.agents = new Map();
  game.players = new Map();
  game.playerSessions = new Map();
  game.displayNames = new Map();
  game.agentMetadata = new Map();
  game.ready = new Set();
  game.decisions = [];
  game.actionHistory = [];
  game.agentStrategies = new Map();
  game.localStrategySeats = new Set();
  game.reviews = new Map();
  game.actionStats = [createActionStats(), createActionStats(), createActionStats()];
  game.competitionId = options.competitionId || null;
  game.roundNumber = options.roundNumber || 1;
  game.sourceGameId = options.sourceGameId || null;
  game.presetDeal = options.presetDeal ? structuredClone(options.presetDeal) : null;
  game.settlement = null;
  game.updatedAt = Date.now();
  game.turnTimeoutMs = normalizeTurnTimeout(options.turnTimeoutMs ?? configuredTurnTimeoutMs);
  clearTurnClock(game);
  games.set(game.gameId, game);
  createReplay(game.gameId, replayState(game), {}, { replayAccessToken: game.replayAccessToken });
  markGameAuthoritative(game.gameId);
  markMetadataAuthoritative();
  return game;
}

export function createCompetition(options = {}) {
  const totalRounds = normalizeTotalRounds(options.totalRounds);
  const accessMode = normalizeAccessMode(options.accessMode);
  const allowedAgentIds = [...normalizeIdentitySet(options.allowedAgentIds)];
  const allowedPlayerIds = [...normalizeIdentitySet(options.allowedPlayerIds)];
  const competitionId = nextCompetitionId();
  const replayAccessToken = accessMode === 'open' ? null : createAccessToken();
  const roomOwnerToken = createAccessToken();
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
    accessMode,
    allowedAgentIds,
    allowedPlayerIds,
    replayAccessToken,
    roomOwnerToken,
    turnTimeoutMs: normalizeTurnTimeout(options.turnTimeoutMs ?? configuredTurnTimeoutMs)
  };
  competitions.set(competitionId, competition);
  const game = createMatch({ competitionId, roundNumber: 1, turnTimeoutMs: competition.turnTimeoutMs, accessMode, allowedAgentIds, allowedPlayerIds, replayAccessToken, roomOwnerToken });
  competition.currentGameId = game.gameId;
  competition.gameIds.push(game.gameId);
  markMetadataAuthoritative();
  return { ...observeCompetition(competitionId), roomOwnerToken, ...(replayAccessToken ? { replayAccessToken } : {}) };
}

export function createRematch(sourceGameId, replayAccessToken) {
  const replay = readReplay(sourceGameId);
  assertReplayAccess(sourceGameId, replayAccessToken, replay);
  const finalState = replay.frames.at(-1)?.state;
  if (finalState?.phase !== 'over' || !['landlord', 'farmers'].includes(finalState.winner)) throw new Error('rematch_source_not_completed');
  const presetDeal = extractReplayDeal(replay);
  const rootSourceGameId = replay.sourceGameId || finalState.sourceGameId || sourceGameId;
  const accessMode = replayAccessMode(sourceGameId, replay) === 'open' ? 'open' : 'invite_only';
  return createMatch({ sourceGameId: rootSourceGameId, presetDeal, accessMode });
}

export function observeCompetition(competitionId, seatId = null, options = {}) {
  const competition = requireCompetition(competitionId);
  if (options.revealAll === true) assertRoomOwnerToken(competition.roomOwnerToken, options.roomOwnerToken);
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
    accessMode: competition.accessMode || currentGame?.accessMode || 'open',
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

// Durable Object persistence boundary. The game engine remains synchronous so
// the Node server and existing tests keep their API; the Worker serializes
// this snapshot into Durable Object SQLite storage between requests.
export function exportStoreState(options = {}) {
  const now = Number(options.now) || Date.now();
  const gameEntries = options.recoverableOnly === true
    ? [...games.entries()].filter(([, game]) => shouldPersistForRecovery(game, now))
    : [...games.entries()];
  const inviteEntries = [...invites.entries()].filter(([, invite]) => Number(invite.expiresAt) > now);
  const snapshot = {
    competitions: [...competitions.entries()],
    invites: inviteEntries, lastGameTimestamp, lastCompetitionTimestamp
  };
  if (options.includeGames !== false) snapshot.games = gameEntries;
  if (options.includeReplays !== false) snapshot.replays = exportReplayState();
  return JSON.parse(JSON.stringify(snapshot, snapshotReplacer));
}

export function exportRecoverableGameState(gameId, now = Date.now()) {
  const game = games.get(gameId);
  if (!game || !shouldPersistForRecovery(game, Number(now) || Date.now())) return null;
  return JSON.parse(JSON.stringify(game, snapshotReplacer));
}

export function listRecoverableGameIds(now = Date.now()) {
  return [...games.values()]
    .filter((game) => shouldPersistForRecovery(game, Number(now) || Date.now()))
    .map((game) => game.gameId);
}

function shouldPersistForRecovery(game, now) {
  const retention = game.phase === 'over' ? COMPLETED_GAME_RECOVERY_MS : ACTIVE_GAME_RECOVERY_MS;
  return now - lastGameActivityAt(game) < retention;
}

function lastGameActivityAt(game) {
  return Math.max(
    Number(game.gameId?.slice(4)) || 0,
    Number(game.updatedAt) || 0,
    Number(game.turnStartedAt) || 0,
    Number(game.settlement?.settledAt) || 0,
    ...game.actionHistory.map((entry) => Number(entry.at) || 0),
    ...[...game.playerSessions.values()].map((session) => Number(session.lastSeenAt) || 0)
  );
}

export function expireInterruptedMatches(now = Date.now()) {
  const expiredGameIds = [];
  for (const game of [...games.values()]) {
    if (shouldPersistForRecovery(game, now)) continue;
    if (game.phase !== 'over') {
      game.phase = 'aborted';
      game.winner = null;
      clearTurnClock(game);
      const competition = game.competitionId ? competitions.get(game.competitionId) : null;
      if (competition?.currentGameId === game.gameId) {
        competition.status = 'aborted';
        competition.completedAt = now;
      }
      recordFrame(game, { type: 'aborted', reason: 'recovery_expired' }, now);
    } else {
      const competition = game.competitionId ? competitions.get(game.competitionId) : null;
      if (competition?.currentGameId === game.gameId && competition.status !== 'over') {
        competition.status = 'over';
        competition.completedAt ||= now;
      }
    }
    games.delete(game.gameId);
    markGameAuthoritative(game.gameId);
    markMetadataAuthoritative();
    expiredGameIds.push(game.gameId);
  }
  for (const [token, invite] of invites) {
    if (expiredGameIds.includes(invite.gameId)) {
      invites.delete(token);
      markMetadataAuthoritative();
    }
  }
  return expiredGameIds;
}

export function importStoreState(snapshot = {}) {
  const decoded = JSON.parse(JSON.stringify(snapshot), snapshotReviver);
  games.clear(); competitions.clear(); invites.clear();
  for (const [id, game] of decoded.games || []) games.set(id, hydrateGame(game));
  for (const [id, competition] of decoded.competitions || []) {
    competition.roomOwnerToken = normalizeAccessToken(competition.roomOwnerToken)
      || games.get(competition.currentGameId)?.roomOwnerToken
      || createAccessToken();
    for (const gameId of competition.gameIds || []) {
      const game = games.get(gameId);
      if (game) game.roomOwnerToken = competition.roomOwnerToken;
    }
    competitions.set(id, competition);
  }
  for (const [id, invite] of decoded.invites || []) invites.set(id, invite);
  lastGameTimestamp = decoded.lastGameTimestamp || 0;
  lastCompetitionTimestamp = decoded.lastCompetitionTimestamp || 0;
  dirtyGameRevisions.clear();
  dirtyMetadataRevision = 0;
  importReplayState(decoded.replays || []);
  for (const game of games.values()) bindReplayAccessToken(game.gameId, game.replayAccessToken);
}

function snapshotReplacer(key, value) {
  if (value instanceof Map) return { __ddzType: 'Map', value: [...value.entries()] };
  if (value instanceof Set) return { __ddzType: 'Set', value: [...value.values()] };
  return value;
}

function snapshotReviver(key, value) {
  if (value?.__ddzType === 'Map') return new Map(value.value);
  if (value?.__ddzType === 'Set') return new Set(value.value);
  return value;
}

export function joinMatch(gameId, seatId, agentId, strategyId, displayName, options = {}) {
  const game = requireMatch(gameId);
  validateSeat(seatId);
  assertSeatAdmission(game, 'agent', agentId, options.viaInvite === true);
  if (game.players.has(seatId)) throw new Error('seat_occupied');
  const occupant = game.agents.get(seatId);
  if (occupant && occupant !== agentId) throw new Error('seat_occupied');
  const metadata = options.agentMetadata === undefined
    ? game.agentMetadata.get(seatId)
    : normalizeAgentMetadata(options.agentMetadata);
  if ((game.ready.has(seatId) || game.phase !== 'waiting') && options.agentMetadata !== undefined && !sameMetadata(game.agentMetadata.get(seatId), metadata)) {
    throw new Error('agent_metadata_locked');
  }
  const resolvedDisplayName = game.displayNames.has(seatId) && displayName === undefined
    ? game.displayNames.get(seatId)
    : normalizeDisplayName(displayName, agentId);
  game.agents.set(seatId, agentId);
  game.displayNames.set(seatId, resolvedDisplayName);
  if (options.agentMetadata !== undefined) {
    if (metadata) game.agentMetadata.set(seatId, metadata);
    else game.agentMetadata.delete(seatId);
  }
  if (options.strategyMode === 'local') {
    if (game.agentStrategies.has(seatId)) throw new Error('strategy_mismatch');
    game.localStrategySeats.add(seatId);
  } else if (game.localStrategySeats.has(seatId)) {
    if (strategyId) throw new Error('strategy_mismatch');
  } else if (!game.agentStrategies.has(seatId)) game.agentStrategies.set(seatId, getStrategy(strategyId));
  else if (strategyId && game.agentStrategies.get(seatId).id !== strategyId) throw new Error('strategy_mismatch');
  game.updatedAt = Date.now();
  updateReplayParticipants(gameId, participants(game));
  markGameAuthoritative(gameId);
  return withReplayAccess(game, observeMatch(gameId, seatId));
}

export function createMatchInvite(gameId, inviteType, seatId, roomOwnerToken) {
  const game = requireMatch(gameId);
  assertRoomOwner(game, roomOwnerToken);
  if (!['player', 'agent', 'spectator'].includes(inviteType)) throw new Error('invalid_invite_type');
  const autoAssign = inviteType === 'player' && (seatId === undefined || seatId === null || seatId === 'auto');
  const normalizedSeat = autoAssign ? null : Number(seatId ?? (inviteType === 'spectator' ? 0 : Number.NaN));
  if (normalizedSeat !== null) validateSeat(normalizedSeat);
  if (inviteType !== 'spectator') {
    if (game.phase !== 'waiting') throw new Error('game_already_started');
    if (normalizedSeat !== null && occupiedSeats(game).includes(normalizedSeat)) throw new Error('seat_occupied');
    if (normalizedSeat === null && occupiedSeats(game).length === 3) throw new Error('room_full');
  }
  const now = Date.now();
  game.updatedAt = now;
  pruneExpiredInvites(now);
  const invite = {
    token: crypto.randomUUID().replaceAll('-', ''),
    inviteType,
    gameId,
    seatId: normalizedSeat,
    assignedSeat: null,
    competitionId: game.competitionId,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    usedBy: null
  };
  invites.set(invite.token, invite);
  markGameAuthoritative(gameId);
  markMetadataAuthoritative();
  return publicInvite(invite);
}

export function resolveMatchInvite(token) {
  return publicInvite(requireInvite(token));
}

export function joinAgentInvite(token, agentId, displayName, agentMetadata) {
  const invite = requireInvite(token, 'agent');
  const identity = normalizeInviteIdentity(agentId, 'anonymous');
  assertInviteIdentity(invite, identity);
  const result = joinMatch(invite.gameId, invite.seatId, identity, undefined, displayName, { strategyMode: 'local', viaInvite: true, agentMetadata });
  if (!invite.usedBy) {
    invite.usedBy = identity;
    markMetadataAuthoritative();
  }
  return { invite: publicInvite(invite), ...result };
}

export function joinPlayerInvite(token, playerId, displayName, seatSessionToken) {
  const invite = requireInvite(token, 'player');
  const identity = normalizeInviteIdentity(playerId, 'h5-player-auto');
  assertInviteIdentity(invite, identity);
  const game = requireMatch(invite.gameId);
  const targetSeat = invite.assignedSeat ?? invite.seatId ?? [0, 1, 2].find((seatId) => !occupiedSeats(game).includes(seatId));
  if (targetSeat === undefined) throw new Error('room_full');
  const result = joinPlayerMatch(invite.gameId, targetSeat, identity, displayName, { viaInvite: !game.playerSessions.has(targetSeat), seatSessionToken });
  if (!invite.usedBy) {
    invite.usedBy = identity;
    markMetadataAuthoritative();
  }
  if (invite.assignedSeat === null || invite.assignedSeat === undefined) {
    invite.assignedSeat = targetSeat;
    markMetadataAuthoritative();
  }
  return { invite: publicInvite(invite), ...result };
}

export function joinPlayerMatch(gameId, seatId, playerId, displayName, options = {}) {
  const game = requireMatch(gameId);
  validateSeat(seatId);
  if (game.agents.has(seatId)) throw new Error('seat_occupied');
  const occupant = game.players.get(seatId);
  if (occupant && occupant !== playerId) throw new Error('seat_occupied');
  // Rejoining an already claimed seat is idempotent. This lets the same browser
  // recover after a refresh without requiring the original short-lived invite.
  if (!occupant) assertSeatAdmission(game, 'player', playerId, options.viaInvite === true);
  const existingSession = game.playerSessions.get(seatId);
  const wasManaged = existingSession?.managed === true;
  if (occupant && existingSession && !existingSession.legacy && !options.viaInvite) {
    assertSeatSession(game, seatId, options.seatSessionToken);
  }
  const resolvedDisplayName = game.displayNames.has(seatId) && displayName === undefined
    ? game.displayNames.get(seatId)
    : normalizeDisplayName(displayName, `玩家 ${['A', 'B', 'C'][seatId]}`);
  game.players.set(seatId, playerId);
  game.displayNames.set(seatId, resolvedDisplayName);
  const session = ensurePlayerSession(game, seatId);
  session.lastSeenAt = Date.now();
  session.managed = false;
  game.updatedAt = session.lastSeenAt;
  updateReplayParticipants(gameId, participants(game));
  if (wasManaged) recordFrame(game, { type: 'managed_ended', seatId }, session.lastSeenAt);
  else markGameAuthoritative(gameId);
  return withPlayerSession(game, seatId, withReplayAccess(game, observeMatch(gameId, seatId, { seatSessionToken: session.token })));
}

export function joinAvailablePlayerMatch(gameId, playerId, displayName, options = {}) {
  const game = requireMatch(gameId);
  const identity = normalizeInviteIdentity(playerId, 'h5-player-auto');
  const existingSeat = [...game.players.entries()].find(([, occupant]) => occupant === identity)?.[0];
  if (existingSeat !== undefined) return joinPlayerMatch(gameId, existingSeat, identity, displayName, options);
  const targetSeat = [0, 1, 2].find((seatId) => !occupiedSeats(game).includes(seatId));
  if (targetSeat === undefined) throw new Error('room_full');
  return joinPlayerMatch(gameId, targetSeat, identity, displayName, options);
}

export function reconnectPlayerMatch(gameId, reconnectCode) {
  const game = requireMatch(gameId);
  maintainPlayerPresence(game);
  const normalizedCode = normalizeReconnectCode(reconnectCode);
  const entry = [...game.playerSessions.entries()].find(([, session]) => session.reconnectCode === normalizedCode);
  if (!entry) throw new Error('invalid_reconnect_code');
  const [seatId, session] = entry;
  if (!game.players.has(seatId)) throw new Error('seat_not_joined');
  session.token = createAccessToken();
  session.reconnectCode = createReconnectCode(game);
  session.lastSeenAt = Date.now();
  session.managed = false;
  recordFrame(game, { type: 'player_reconnected', seatId }, session.lastSeenAt);
  return withPlayerSession(game, seatId, withReplayAccess(game, observeMatch(gameId, seatId, { seatSessionToken: session.token })));
}

export function removeDisconnectedPlayer(gameId, seatId, roomOwnerToken, now = Date.now()) {
  const game = requireMatch(gameId);
  validateSeat(seatId);
  assertRoomOwner(game, roomOwnerToken);
  if (game.phase !== 'waiting') throw new Error('game_already_started');
  if (!game.players.has(seatId)) throw new Error('player_not_joined');
  if (!isPlayerOffline(game, seatId, now)) throw new Error('player_still_online');
  releasePlayerSeat(game, seatId, 'owner_removed', now);
  return observeMatch(gameId, seatId);
}

export function startMatch(gameId, seatId = null, options = {}) {
  const game = requireMatch(gameId);
  maintainPlayerPresence(game);
  if (game.phase !== 'waiting') throw new Error('game_already_started');
  validateSeat(seatId);
  if (!occupiedSeats(game).includes(seatId)) throw new Error('seat_not_joined');
  assertControllerSession(game, seatId, options.seatSessionToken);
  const wasReady = game.ready.has(seatId);
  game.ready.add(seatId);
  if (occupiedSeats(game).length === 3 && game.ready.size === 3) {
    startGame(game, game.presetDeal);
    if (game.competitionId) {
      requireCompetition(game.competitionId).status = 'playing';
      markMetadataAuthoritative();
    }
    resetTurnClock(game);
    recordFrame(game, { type: 'started', seatId });
  } else if (!wasReady) recordFrame(game, { type: 'ready', seatId });
  return observeMatch(gameId, seatId);
}

export function observeMatch(gameId, seatId, options = {}) {
  const game = requireMatch(gameId);
  maintainPlayerPresence(game);
  const authorizationRequired = options.requireAuthorization === true;
  const requestedSeat = Number(seatId);
  validateSeat(requestedSeat);
  const controlSeat = options.controlSeatId === undefined ? seatId : Number(options.controlSeatId);
  const controlAuthorized = touchAuthorizedPlayer(game, controlSeat, options.seatSessionToken);
  const ownerAuthorized = roomOwnerTokenMatches(game.roomOwnerToken, options.roomOwnerToken);
  const inviteAuthorized = spectatorInviteMatches(gameId, options.inviteToken);
  if (authorizationRequired && game.accessMode !== 'open' && !controlAuthorized && !ownerAuthorized && !inviteAuthorized) {
    throw new Error('access_denied');
  }
  if (authorizationRequired && options.revealAll === true && !ownerAuthorized) throw new Error('room_owner_required');
  advanceTimedOutTurn(game);
  const revealAll = options.revealAll === true && (!authorizationRequired || ownerAuthorized);
  const privateSeat = authorizationRequired ? (controlAuthorized ? Number(controlSeat) : null) : requestedSeat;
  const viewSeat = privateSeat ?? requestedSeat;
  const isYourTurn = game.phase !== 'waiting' && game.current === viewSeat && game.winner === null && (!authorizationRequired || controlAuthorized);
  const allowedActions = !isYourTurn ? [] : game.phase === 'bid'
    ? [{ type: 'bid', stage: game.bidStage, values: [0, 1] }]
    : [{ type: 'play', cards: 'select from your hand' }, ...(game.lastPlay ? [{ type: 'pass' }] : [])];
  const readySeats = [...game.ready].sort();
  const reviewContext = game.phase === 'over' && privateSeat !== null && game.agents.has(privateSeat) ? buildReviewContext(game, privateSeat) : null;
  return { protocol: 'agent-game.v1', ...publicState(game, privateSeat, revealAll), accessMode: game.accessMode, view: revealAll ? 'global' : privateSeat === null ? 'public' : 'player', you: viewSeat, controlAuthorized, controlledSeat: controlAuthorized ? Number(controlSeat) : null, roleContext: roleContext(game, viewSeat), isYourTurn, allowedActions, agentSeats: Object.fromEntries(game.agents), playerSeats: Object.fromEntries(game.players), seatControllers: seatControllers(game), seatPresence: seatPresence(game), readySeats, allReady: readySeats.length === 3, settlement: structuredClone(game.settlement), competition: game.competitionId ? competitionStateForGame(game, viewSeat, revealAll) : null, strategy: privateSeat !== null && game.agentStrategies.has(privateSeat) ? structuredClone(game.agentStrategies.get(privateSeat)) : null, strategyAssignments: revealAll ? strategyAssignments(game) : {}, decisions: revealAll ? structuredClone(game.decisions) : [], reviews: revealAll ? reviews(game) : privateSeat !== null && game.reviews.has(privateSeat) ? { [privateSeat]: structuredClone(game.reviews.get(privateSeat)) } : {}, reviewStatus: reviewStatus(game), reviewContext, turnTimeoutMs: game.turnTimeoutMs, turnStartedAt: game.turnStartedAt, turnDeadlineAt: game.turnDeadlineAt, serverNow: Date.now() };
}

export function assertMatchRoomOwner(gameId, roomOwnerToken) {
  assertRoomOwner(requireMatch(gameId), roomOwnerToken);
}

export function getMatchStrategies(gameId) {
  const game = requireMatch(gameId);
  return {
    protocol: 'agent-game.v1',
    gameId,
    participants: structuredClone(participants(game))
  };
}

export function submitMatchAction(gameId, seatId, action, expectedSeq, options = {}) {
  const game = requireMatch(gameId);
  maintainPlayerPresence(game);
  validateSeat(seatId);
  assertControllerSession(game, seatId, options.seatSessionToken);
  advanceTimedOutTurn(game);
  if (expectedSeq !== undefined && expectedSeq !== game.seq) throw new Error('stale_state');
  const decision = normalizeDecision(options.decision);
  const phase = game.phase;
  const turnStartedAt = game.turnStartedAt;
  try {
    applyAction(game, seatId, action);
  } catch (error) {
    game.actionStats[seatId].rejectedActions += 1;
    throw error;
  }
  settleGame(game);
  const decidedAt = Date.now();
  const decisionRecord = createDecisionRecord(game, seatId, action, decision, {
    source: options.source || 'player',
    phase,
    decidedAt,
    turnStartedAt
  });
  game.actionHistory.push({ seq: game.seq, at: decidedAt, seatId, source: options.source || 'player', phase, action: structuredClone(action) });
  if (decisionRecord) game.decisions.push(decisionRecord);
  updateAcceptedStats(game.actionStats[seatId], action, decisionRecord?.durationMs);
  resetTurnClock(game);
  recordFrame(game, { type: 'action', source: options.source || 'player', seatId, action, ...(decisionRecord ? { decision: decisionRecord } : {}) });
  return observeMatch(gameId, seatId);
}

export function createDecisionRecord(game, seatId, action, decision, options = {}) {
  if (!decision) return null;
  const decidedAt = options.decidedAt ?? Date.now();
  const assignedStrategy = game.agentStrategies?.has(seatId)
    ? game.agentStrategies.get(seatId)
    : null;
  const strategy = assignedStrategy ? {
    id: assignedStrategy.id,
    name: assignedStrategy.name,
    updatedAt: assignedStrategy.updatedAt,
    hash: assignedStrategy.hash
  } : null;
  return {
    gameId: game.gameId,
    seq: game.seq,
    at: decidedAt,
    seatId,
    source: options.source || 'player',
    phase: options.phase ?? game.phase,
    action: structuredClone(action),
    strategy,
    ...decision,
    durationMs: options.turnStartedAt === null || options.turnStartedAt === undefined
      ? null
      : Math.max(0, decidedAt - options.turnStartedAt)
  };
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
  markMetadataAuthoritative();
  recordFrame(currentGame, { type: 'competition_review', seatId, review: record });
  return observeCompetition(competitionId, seatId);
}

export function getReplay(gameId) {
  return readReplay(gameId);
}

export function getAuthorizedReplay(gameId, replayAccessToken) {
  const replay = readReplay(gameId);
  assertReplayAccess(gameId, replayAccessToken, replay);
  return replay;
}

export function listAccessibleReplays(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  const status = options.status === 'completed' ? 'completed' : 'all';
  const token = normalizeReplayAccessToken(options.replayAccessToken);
  const all = listReplays({ limit: 100, offset: 0, status, accessMode: 'all' }).items;
  const items = all.filter((item) => item.accessMode === 'open' || replayAccessGranted(item.gameId, token));
  return { total: items.length, offset, limit, status, accessMode: token ? 'authorized' : 'open', items: items.slice(offset, offset + limit) };
}

export function tickMatches(now = Date.now()) {
  for (const game of games.values()) {
    maintainPlayerPresence(game, now);
    advanceTimedOutTurn(game, now);
  }
}

export function nextMaintenanceAt(now = Date.now()) {
  const candidates = [];
  for (const game of games.values()) {
    const retention = game.phase === 'over' ? COMPLETED_GAME_RECOVERY_MS : ACTIVE_GAME_RECOVERY_MS;
    candidates.push(lastGameActivityAt(game) + retention);
    if (game.phase === 'waiting') {
      for (const seatId of game.players.keys()) {
        const lastSeenAt = Number(game.playerSessions.get(seatId)?.lastSeenAt) || 0;
        candidates.push(lastSeenAt + WAITING_SEAT_RELEASE_MS);
      }
      continue;
    }
    if (game.winner !== null) continue;
    if (Number.isFinite(game.turnDeadlineAt)) candidates.push(game.turnDeadlineAt);
    for (const seatId of game.players.keys()) {
      const session = game.playerSessions.get(seatId);
      if (!session?.managed) candidates.push((Number(session?.lastSeenAt) || 0) + PLAYER_OFFLINE_MS);
    }
  }
  if (!candidates.length) return null;
  return Math.max(Number(now), Math.min(...candidates.filter(Number.isFinite)));
}

export function advanceMatchTimeout(gameId, now = Date.now()) {
  return advanceTimedOutTurn(requireMatch(gameId), now);
}

function advanceTimedOutTurn(game, now = Date.now()) {
  if (game.phase === 'waiting') { clearTurnClock(game); return null; }
  ensureTurnClock(game, now);
  const managed = game.playerSessions.get(game.current)?.managed === true || isPlayerOffline(game, game.current, now);
  if (game.winner !== null || game.turnDeadlineAt === null || (!managed && now < game.turnDeadlineAt)) return null;
  const seatId = game.current;
  const bidStage = game.bidStage;
  const action = game.phase === 'bid'
    ? { type: 'bid', value: 0 }
    : game.lastPlay
      ? { type: 'pass' }
      : chooseSimpleAction(game, seatId);
  applyAction(game, seatId, action);
  settleGame(game);
  const source = managed ? 'managed' : 'timeout';
  game.actionHistory.push({ seq: game.seq, at: now, seatId, source, phase: game.phase, action: structuredClone(action) });
  game.log.push(`座位${seatId} ${managed ? '掉线托管' : '回合超时'}，自动${action.type === 'pass' ? '不要' : action.type === 'bid' ? bidStage === 'rob' ? '不抢' : '不叫' : '出牌'}`);
  resetTurnClock(game, now);
  recordFrame(game, { type: 'action', source, seatId, action }, now);
  return { seatId, seq: game.seq, timedOut: !managed, managed };
}

function recordFrame(game, event, now = Date.now()) {
  game.updatedAt = now;
  appendReplayFrame(game.gameId, event, replayState(game, now), participants(game));
  markGameAuthoritative(game.gameId);
}

function replayState(game, now = Date.now()) {
  return {
    protocol: 'agent-game.v1',
    ...publicState(game, null, true),
    accessMode: game.accessMode,
    view: 'global',
    you: null,
    roleContext: null,
    isYourTurn: false,
    allowedActions: [],
    agentSeats: Object.fromEntries(game.agents),
    playerSeats: Object.fromEntries(game.players),
    seatControllers: seatControllers(game),
    seatPresence: seatPresence(game, now),
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

function extractReplayDeal(replay) {
  const frame = replay.frames.find((entry) => entry.event?.type === 'started' && entry.state?.phase === 'bid');
  const state = frame?.state;
  const hands = state?.hands?.map((hand) => hand.cards?.map(replayCardId));
  const bottom = state?.bottom?.map(replayCardId);
  const cards = [...(hands?.flat() || []), ...(bottom || [])];
  const expectedDeck = createDeck();
  const valid = Array.isArray(hands)
    && hands.length === 3
    && hands.every((hand) => Array.isArray(hand) && hand.length === 17)
    && Array.isArray(bottom)
    && bottom.length === 3
    && [0, 1, 2].includes(state.firstBidder)
    && cards.length === expectedDeck.length
    && new Set(cards).size === expectedDeck.length
    && expectedDeck.every((card) => cards.includes(card));
  if (!valid) throw new Error('rematch_source_invalid');
  return { hands, bottom, firstBidder: state.firstBidder };
}

function replayCardId(card) { return typeof card === 'string' ? card : card?.id; }

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
    ? {
        type: 'agent',
        id: game.agents.get(seatId),
        displayName: game.displayNames?.get(seatId) || game.agents.get(seatId),
        ...(game.agentMetadata?.has(seatId) ? { agentMetadata: structuredClone(game.agentMetadata.get(seatId)) } : {})
      }
    : { type: 'player', id: game.players.get(seatId), displayName: game.displayNames?.get(seatId) || `玩家 ${['A', 'B', 'C'][seatId]}` }]));
}

function seatPresence(game, now = Date.now()) {
  return Object.fromEntries(occupiedSeats(game).map((seatId) => {
    if (game.agents.has(seatId)) return [seatId, { status: 'online', controllerType: 'agent' }];
    const offline = game.playerSessions.get(seatId)?.managed === true || isPlayerOffline(game, seatId, now);
    return [seatId, {
      status: offline ? (game.phase === 'waiting' ? 'offline' : 'managed') : 'online',
      controllerType: 'player'
    }];
  }));
}

function ensurePlayerSession(game, seatId) {
  let session = game.playerSessions.get(seatId);
  if (!session || session.legacy || !normalizeAccessToken(session.token)) {
    session = { token: createAccessToken(), reconnectCode: createReconnectCode(game), lastSeenAt: Date.now(), managed: false };
    game.playerSessions.set(seatId, session);
  }
  session.managed = session.managed === true;
  return session;
}

function withPlayerSession(game, seatId, result) {
  const session = ensurePlayerSession(game, seatId);
  return { ...result, seatSessionToken: session.token, reconnectCode: session.reconnectCode };
}

function normalizeAccessToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
}

function normalizeReconnectCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{8}$/.test(code)) throw new Error('invalid_reconnect_code');
  return code;
}

function createReconnectCode(game) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    code = [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
  } while ([...game.playerSessions.values()].some((session) => session.reconnectCode === code));
  return code;
}

function assertSeatSession(game, seatId, token) {
  const session = game.playerSessions.get(seatId);
  if (!session || !normalizeAccessToken(token) || session.token !== token) throw new Error('seat_session_required');
  return session;
}

function assertControllerSession(game, seatId, token) {
  if (!game.players.has(seatId)) return;
  const session = assertSeatSession(game, seatId, token);
  const now = Date.now();
  session.lastSeenAt = now;
  setPlayerManaged(game, seatId, false, now);
}

function touchAuthorizedPlayer(game, seatId, token) {
  const normalizedSeat = Number(seatId);
  if (![0, 1, 2].includes(normalizedSeat) || !game.players.has(normalizedSeat)) return false;
  const session = game.playerSessions.get(normalizedSeat);
  if (!session || session.token !== normalizeAccessToken(token)) return false;
  const now = Date.now();
  session.lastSeenAt = now;
  setPlayerManaged(game, normalizedSeat, false, now);
  return true;
}

function isPlayerOffline(game, seatId, now = Date.now()) {
  if (!game.players.has(seatId)) return false;
  const session = game.playerSessions.get(seatId);
  return !session || now - Number(session.lastSeenAt || 0) >= PLAYER_OFFLINE_MS;
}

function maintainPlayerPresence(game, now = Date.now()) {
  if (game.phase !== 'waiting') {
    if (game.winner !== null) return;
    for (const seatId of game.players.keys()) {
      if (isPlayerOffline(game, seatId, now)) setPlayerManaged(game, seatId, true, now);
    }
    return;
  }
  for (const seatId of [...game.players.keys()]) {
    const session = game.playerSessions.get(seatId);
    if (!session || now - Number(session.lastSeenAt || 0) >= WAITING_SEAT_RELEASE_MS) {
      releasePlayerSeat(game, seatId, 'disconnect_timeout', now);
    }
  }
}

function setPlayerManaged(game, seatId, managed, now = Date.now()) {
  const session = game.playerSessions.get(seatId);
  if (!session || session.managed === managed) return false;
  session.managed = managed;
  recordFrame(game, { type: managed ? 'managed_started' : 'managed_ended', seatId }, now);
  return true;
}

function releasePlayerSeat(game, seatId, reason, now = Date.now()) {
  const playerId = game.players.get(seatId);
  game.players.delete(seatId);
  game.playerSessions.delete(seatId);
  game.displayNames.delete(seatId);
  game.ready.delete(seatId);
  updateReplayParticipants(game.gameId, participants(game));
  recordFrame(game, { type: 'seat_released', seatId, playerId, reason }, now);
}

function assertRoomOwner(game, token) {
  assertRoomOwnerToken(game.roomOwnerToken, token);
}

function assertRoomOwnerToken(expected, token) {
  if (!roomOwnerTokenMatches(expected, token)) throw new Error('room_owner_required');
}

function roomOwnerTokenMatches(expected, token) {
  return Boolean(normalizeAccessToken(token) && token === expected);
}

function spectatorInviteMatches(gameId, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return false;
  const invite = invites.get(token);
  const game = games.get(gameId);
  const sameRoom = invite?.gameId === gameId || Boolean(invite?.competitionId && game?.competitionId === invite.competitionId);
  if (!invite || !sameRoom || invite.inviteType !== 'spectator') return false;
  if (Date.now() < invite.expiresAt) return true;
  invites.delete(token);
  markMetadataAuthoritative();
  return false;
}

export function roleContext(game, seatId) {
  const you = Number(seatId);
  const previousSeat = (you + 2) % 3;
  const nextSeat = (you + 1) % 3;
  const landlordSeat = (game.phase === 'play' || game.phase === 'over') && Number.isInteger(game.landlord)
    ? game.landlord
    : null;
  const role = landlordSeat === null ? null : landlordSeat === you ? 'landlord' : 'farmer';
  const teammateSeat = role === 'farmer'
    ? [0, 1, 2].find((candidate) => candidate !== you && candidate !== landlordSeat) ?? null
    : null;
  const landlordUpstreamSeat = landlordSeat === null ? null : (landlordSeat + 2) % 3;
  const landlordDownstreamSeat = landlordSeat === null ? null : (landlordSeat + 1) % 3;
  return {
    role,
    landlordSeat,
    teammateSeat,
    previousSeat,
    nextSeat,
    farmerPosition: role === 'farmer'
      ? you === landlordUpstreamSeat ? 'landlord_upstream' : 'landlord_downstream'
      : null,
    landlordUpstreamSeat,
    landlordDownstreamSeat,
    // Backward-compatible aliases. Strategy selection must use farmerPosition.
    upstreamSeat: previousSeat,
    downstreamSeat: nextSeat
  };
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
  return { id: strategy.id, name: strategy.name, updatedAt: strategy.updatedAt, hash: strategy.hash, description: strategy.description };
}

function reviews(game) {
  return Object.fromEntries([...game.reviews].map(([seatId, review]) => [seatId, structuredClone(review)]));
}

function reviewStatus(game) {
  const expectedSeats = [...game.agents.keys()].sort();
  const submittedSeats = [...game.reviews.keys()].sort();
  return { expectedSeats, submittedSeats, complete: expectedSeats.length > 0 && expectedSeats.every((seatId) => game.reviews.has(seatId)) };
}

export function calculateSettlement(game) {
  const playsBySeat = Array.isArray(game.playsBySeat) && game.playsBySeat.length === 3
    ? game.playsBySeat.map((count) => Math.max(0, Number(count) || 0))
    : [0, 0, 0];
  const bombCount = Math.max(0, Number(game.bombCount) || 0);
  const rocketCount = Math.max(0, Number(game.rocketCount) || 0);
  const farmerSeats = [0, 1, 2].filter((seatId) => seatId !== game.landlord);
  const spring = game.winner === 'landlord' && farmerSeats.every((seatId) => playsBySeat[seatId] === 0);
  const antiSpring = game.winner === 'farmers' && playsBySeat[game.landlord] > 0 && farmerSeats.some((seatId) => playsBySeat[seatId] === 0);
  const multiplierReasons = [
    ...Array.from({ length: bombCount }, () => 'bomb'),
    ...Array.from({ length: rocketCount }, () => 'rocket'),
    ...(spring ? ['spring'] : []),
    ...(antiSpring ? ['anti-spring'] : [])
  ];
  const multiplier = 2 ** multiplierReasons.length;
  const baseScoreDelta = game.winner === 'landlord'
    ? [0, 1, 2].map((seatId) => seatId === game.landlord ? 2 : -1)
    : [0, 1, 2].map((seatId) => seatId === game.landlord ? -2 : 1);
  return {
    scoring: 'ddz-standard-v1',
    baseScore: 1,
    multiplier,
    multiplierReasons,
    bombCount,
    rocketCount,
    spring,
    antiSpring,
    playsBySeat,
    scoreDelta: baseScoreDelta.map((score) => score * multiplier)
  };
}

function settleGame(game) {
  if (game.phase !== 'over' || game.settlement) return;
  const scoring = calculateSettlement(game);
  game.settlement = {
    ...scoring,
    winner: game.winner,
    landlord: game.landlord,
    finalCardCounts: game.hands.map((cards) => cards.length),
    settledAt: Date.now()
  };
  if (!game.competitionId) return;
  const competition = requireCompetition(game.competitionId);
  competition.scores = competition.scores.map((score, seatId) => score + scoring.scoreDelta[seatId]);
  competition.rounds.push({
    roundNumber: game.roundNumber,
    gameId: game.gameId,
    winner: game.winner,
    landlord: game.landlord,
    scoreDelta: [...scoring.scoreDelta],
    multiplier: scoring.multiplier,
    multiplierReasons: [...scoring.multiplierReasons],
    cumulativeScores: [...competition.scores],
    finalCardCounts: game.hands.map((cards) => cards.length),
    settledAt: game.settlement.settledAt,
    reviews: {}
  });
  competition.status = 'reviewing_round';
  markMetadataAuthoritative();
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
    markMetadataAuthoritative();
    return;
  }
  const nextRound = game.roundNumber + 1;
  const nextGame = createMatch({
    competitionId: competition.competitionId,
    roundNumber: nextRound,
    turnTimeoutMs: competition.turnTimeoutMs,
    accessMode: competition.accessMode,
    allowedAgentIds: competition.allowedAgentIds,
    allowedPlayerIds: competition.allowedPlayerIds,
    replayAccessToken: competition.replayAccessToken,
    roomOwnerToken: competition.roomOwnerToken
  });
  nextGame.agents = new Map(game.agents);
  nextGame.players = new Map(game.players);
  nextGame.playerSessions = new Map([...game.playerSessions].map(([seatId, session]) => [seatId, structuredClone(session)]));
  nextGame.displayNames = new Map(game.displayNames);
  nextGame.agentMetadata = new Map([...game.agentMetadata].map(([seatId, metadata]) => [seatId, structuredClone(metadata)]));
  nextGame.agentStrategies = new Map([...game.agentStrategies].map(([seatId, strategy]) => [seatId, structuredClone(strategy)]));
  nextGame.localStrategySeats = new Set(game.localStrategySeats);
  updateReplayParticipants(nextGame.gameId, participants(nextGame));
  competition.currentRound = nextRound;
  competition.currentGameId = nextGame.gameId;
  competition.gameIds.push(nextGame.gameId);
  competition.status = 'waiting';
  markMetadataAuthoritative();
}

function competitionStateForGame(game, seatId = null, revealAll = false) {
  const competition = requireCompetition(game.competitionId);
  return {
    competitionId: competition.competitionId,
    totalRounds: competition.totalRounds,
    currentRound: competition.currentRound,
    currentGameId: competition.currentGameId,
    accessMode: competition.accessMode || game.accessMode || 'open',
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
    multiplier: round.multiplier ?? 1,
    multiplierReasons: [...(round.multiplierReasons || [])],
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
    settlement: structuredClone(game.settlement),
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
  return DEFAULT_TURN_TIMEOUT_MS;
}

function normalizeTotalRounds(value) {
  const rounds = Number(value ?? 3);
  if (![3, 5, 7].includes(rounds)) throw new Error('invalid_total_rounds');
  return rounds;
}

function normalizeAccessMode(value) {
  const mode = value === undefined || value === null ? 'open' : String(value).trim();
  if (!ACCESS_MODES.has(mode)) throw new Error('invalid_access_mode');
  return mode;
}

function normalizeIdentitySet(value) {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value) || value.length > 100) throw new Error('invalid_access_list');
  return new Set(value.map((identity) => normalizeInviteIdentity(identity, '')));
}

function assertSeatAdmission(game, controllerType, identity, viaInvite) {
  if (viaInvite || game.accessMode === 'open' || game.accessMode === undefined) return;
  if (game.accessMode === 'invite_only') throw new Error('invite_required');
  const allowed = controllerType === 'agent' ? game.allowedAgentIds : game.allowedPlayerIds;
  if (!allowed?.has(String(identity))) throw new Error('access_denied');
}

function normalizeAgentMetadata(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_agent_metadata');
  const fields = {
    modelId: normalizeOptionalMetadataText(value.modelId, 120),
    reasoningEffort: normalizeOptionalMetadataText(value.reasoningEffort, 40),
    provider: normalizeOptionalMetadataText(value.provider, 80),
    clientVersion: normalizeOptionalMetadataText(value.clientVersion, 80),
    strategyId: normalizeOptionalMetadataText(value.strategyId, 120),
    strategyVersion: normalizeOptionalMetadataText(value.strategyVersion, 120),
    strategyHash: normalizeOptionalMetadataText(value.strategyHash, 128)
  };
  const metadata = Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== null));
  if (!Object.keys(metadata).length) throw new Error('invalid_agent_metadata');
  return { source: 'declared', ...metadata };
}

function normalizeOptionalMetadataText(value, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('invalid_agent_metadata');
  const text = value.trim();
  if (!text || text.length > maxLength) throw new Error('invalid_agent_metadata');
  return text;
}

function sameMetadata(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function hydrateGame(game) {
  game.accessMode = normalizeAccessMode(game.accessMode);
  game.replayAccessToken = game.accessMode === 'open' ? null : normalizeReplayAccessToken(game.replayAccessToken) || createAccessToken();
  game.roomOwnerToken = normalizeAccessToken(game.roomOwnerToken) || createAccessToken();
  game.allowedAgentIds = game.allowedAgentIds instanceof Set ? game.allowedAgentIds : normalizeIdentitySet(game.allowedAgentIds);
  game.allowedPlayerIds = game.allowedPlayerIds instanceof Set ? game.allowedPlayerIds : normalizeIdentitySet(game.allowedPlayerIds);
  game.agentMetadata = game.agentMetadata instanceof Map ? game.agentMetadata : new Map();
  game.playerSessions = game.playerSessions instanceof Map ? game.playerSessions : new Map();
  game.updatedAt = Number(game.updatedAt) || Number(game.gameId?.slice(4)) || Date.now();
  for (const seatId of game.players?.keys?.() || []) {
    if (!game.playerSessions.has(seatId)) game.playerSessions.set(seatId, { token: null, reconnectCode: null, lastSeenAt: Date.now(), managed: false, legacy: true });
    else game.playerSessions.get(seatId).managed = game.playerSessions.get(seatId).managed === true;
  }
  return game;
}

function withReplayAccess(game, result) {
  return { ...result, ...(game.replayAccessToken ? { replayAccessToken: game.replayAccessToken } : {}) };
}

function createAccessToken() {
  return crypto.randomUUID().replaceAll('-', '');
}

function normalizeReplayAccessToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
}

function replayAccessMode(gameId, replay = null) {
  const game = games.get(gameId);
  if (game) return game.accessMode || 'open';
  const finalState = (replay || readReplay(gameId)).frames.at(-1)?.state;
  return finalState?.accessMode || 'open';
}

function replayAccessGranted(gameId, replayAccessToken) {
  if (replayAccessMode(gameId) === 'open') return true;
  const game = games.get(gameId);
  return Boolean(
    (game?.replayAccessToken && replayAccessToken === game.replayAccessToken)
    || replayAccessMatches(gameId, replayAccessToken)
  );
}

function assertReplayAccess(gameId, replayAccessToken, replay = null) {
  if (replayAccessMode(gameId, replay) === 'open') return;
  if (!replayAccessGranted(gameId, normalizeReplayAccessToken(replayAccessToken))) throw new Error('replay_access_denied');
}

function normalizeDisplayName(value, fallback) {
  if (value === undefined || value === null) return String(fallback).trim().slice(0, 40);
  if (typeof value !== 'string') throw new Error('invalid_display_name');
  const displayName = value.trim();
  if (!displayName || displayName.length > 40) throw new Error('invalid_display_name');
  return displayName;
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

function requireInvite(token, expectedType = null) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('invite_not_found');
  const invite = invites.get(token);
  if (!invite) throw new Error('invite_not_found');
  if (Date.now() >= invite.expiresAt) {
    invites.delete(token);
    markMetadataAuthoritative();
    throw new Error('invite_expired');
  }
  if (expectedType && invite.inviteType !== expectedType) throw new Error('invite_type_mismatch');
  requireMatch(invite.gameId);
  return invite;
}

function pruneExpiredInvites(now) {
  for (const [token, invite] of invites) {
    if (now >= invite.expiresAt) {
      invites.delete(token);
      markMetadataAuthoritative();
    }
  }
}

function publicInvite(invite) {
  const game = requireMatch(invite.gameId);
  const resolvedSeat = invite.assignedSeat ?? invite.seatId;
  const occupied = invite.inviteType === 'spectator' || resolvedSeat === null
    ? false
    : occupiedSeats(game).includes(resolvedSeat);
  const roomHasSpace = occupiedSeats(game).length < 3;
  const autoAssign = invite.inviteType === 'player' && invite.seatId === null;
  return {
    protocol: 'agent-game.invite.v1',
    token: invite.token,
    inviteType: invite.inviteType,
    gameId: invite.gameId,
    seatId: resolvedSeat,
    seatMode: autoAssign ? 'auto' : 'fixed',
    competitionId: invite.competitionId,
    view: invite.inviteType === 'spectator' ? 'global' : 'player',
    expiresAt: invite.expiresAt,
    singleUse: invite.inviteType !== 'spectator',
    available: invite.inviteType === 'spectator' || (!invite.usedBy && (autoAssign ? roomHasSpace : !occupied))
  };
}

function assertInviteIdentity(invite, identity) {
  if (invite.usedBy && invite.usedBy !== identity) throw new Error('invite_used');
}

function normalizeInviteIdentity(value, fallback) {
  const identity = String(value || fallback).trim();
  if (!identity || identity.length > 120) throw new Error('invalid_identity');
  return identity;
}

function requireCompetition(competitionId) {
  const competition = competitions.get(competitionId);
  if (!competition) throw new Error('competition_not_found');
  return competition;
}

function validateSeat(seatId) {
  if (![0, 1, 2].includes(Number(seatId))) throw new Error('invalid_seat');
}
