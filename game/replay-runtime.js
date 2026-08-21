// Platform-neutral replay store used by both the Node server and the Worker.
// The Worker persists the exported records to R2 after each state-changing
// request; the Durable Object storage keeps the hot working set available.
const records = new Map();
const dirtyRecords = new Map();
const latestStates = new Map();
let revision = 0;

function markDirty(gameId) {
  revision += 1;
  dirtyRecords.set(gameId, revision);
}

export function createReplay(gameId, state, participants = {}, options = {}) {
  const now = Date.now();
  records.set(gameId, {
    format: 'agent-game.replay.v2', gameId, game: state.game,
    sourceGameId: state.sourceGameId ?? null, createdAt: now, updatedAt: now,
    completedAt: null, participants: structuredClone(participants),
    replayAccessToken: options.replayAccessToken || null,
    initialState: structuredClone(state),
    entries: [{ index: 0, at: now, event: { type: 'created' }, patch: null }]
  });
  latestStates.set(gameId, structuredClone(state));
  markDirty(gameId);
}

export function updateReplayParticipants(gameId, participants) {
  const replay = ensureCompact(requireReplay(gameId));
  replay.participants = structuredClone(participants);
  replay.updatedAt = Date.now();
  markDirty(gameId);
}

export function appendReplayFrame(gameId, event, state, participants = {}) {
  const replay = ensureCompact(requireReplay(gameId));
  const now = Date.now();
  const previousState = latestReplayState(replay);
  replay.participants = structuredClone(participants);
  replay.entries.push({
    index: replay.entries.length,
    at: now,
    event: structuredClone(event),
    patch: createPatch(previousState, state)
  });
  latestStates.set(gameId, structuredClone(state));
  replay.updatedAt = now;
  if (isCompletedState(state) && replay.completedAt === null) replay.completedAt = now;
  markDirty(gameId);
}

export function readReplay(gameId) {
  validateGameId(gameId);
  return materializeReplay(requireReplay(gameId));
}

export function replayAccessMatches(gameId, token) {
  const replay = requireReplay(gameId);
  return Boolean(replay.replayAccessToken && token === replay.replayAccessToken);
}

export function bindReplayAccessToken(gameId, token) {
  if (!token) return;
  const replay = requireReplay(gameId);
  if (replay.replayAccessToken === token) return;
  if (replay.replayAccessToken) throw new Error('replay_access_token_mismatch');
  replay.replayAccessToken = token;
  markDirty(gameId);
}

export function listReplays(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  const status = options.status === 'completed' ? 'completed' : 'all';
  const accessMode = options.accessMode === 'all' ? 'all' : 'open';
  const summaries = [...records.values()]
    .sort((left, right) => Number(right.gameId.slice(4)) - Number(left.gameId.slice(4)))
    .map(replaySummary)
    .filter((item) => accessMode === 'all' || item.accessMode === 'open')
    .filter((item) => status !== 'completed' || isCompletedSummary(item));
  return { total: summaries.length, offset, limit, status, accessMode, items: summaries.slice(offset, offset + limit) };
}

export function exportReplayState() {
  return [...records.values()].map((replay) => structuredClone(replay));
}

export function getReplayRevision() {
  return revision;
}

export function exportDirtyReplayState() {
  return [...dirtyRecords.entries()].map(([gameId, dirtyRevision]) => ({
    gameId,
    revision: dirtyRevision,
    replay: structuredClone(records.get(gameId))
  }));
}

export function markReplayStatePersisted(entries = []) {
  for (const entry of entries) {
    if (dirtyRecords.get(entry.gameId) === entry.revision) dirtyRecords.delete(entry.gameId);
  }
}

export function importReplayState(replays = []) {
  records.clear();
  for (const replay of replays) records.set(replay.gameId, structuredClone(replay));
  latestStates.clear();
  dirtyRecords.clear();
  revision += 1;
}

function requireReplay(gameId) {
  validateGameId(gameId);
  const replay = records.get(gameId);
  if (!replay) throw new Error('replay_not_found');
  return replay;
}

function ensureCompact(replay) {
  if (replay.format === 'agent-game.replay.v2' && Array.isArray(replay.entries)) return replay;
  const frames = Array.isArray(replay.frames) ? replay.frames : [];
  const initialState = structuredClone(frames[0]?.state || {});
  let previousState = initialState;
  replay.format = 'agent-game.replay.v2';
  replay.initialState = initialState;
  replay.entries = frames.map((frame, index) => {
    const state = structuredClone(frame.state || previousState);
    const entry = {
      index,
      at: frame.at,
      event: structuredClone(frame.event || {}),
      patch: index === 0 ? null : createPatch(previousState, state)
    };
    previousState = state;
    return entry;
  });
  delete replay.frames;
  latestStates.set(replay.gameId, structuredClone(previousState));
  return replay;
}

function materializeReplay(replay) {
  if (Array.isArray(replay.frames)) {
    const { replayAccessToken, ...publicReplay } = structuredClone(replay);
    return publicReplay;
  }
  let state = structuredClone(replay.initialState || {});
  const frames = (replay.entries || []).map((entry, index) => {
    if (index > 0 && entry.patch) state = applyPatch(state, entry.patch);
    return { index: entry.index ?? index, at: entry.at, event: structuredClone(entry.event || {}), state: structuredClone(state) };
  });
  const { initialState, entries, replayAccessToken, ...metadata } = replay;
  return { ...structuredClone(metadata), format: 'agent-game.replay.v1', frames };
}

function latestReplayState(replay) {
  const cached = latestStates.get(replay.gameId);
  if (cached) return structuredClone(cached);
  const materialized = materializeReplay(replay).frames.at(-1)?.state || {};
  latestStates.set(replay.gameId, structuredClone(materialized));
  return materialized;
}

function createPatch(previous, next) {
  if (Object.is(previous, next)) return null;
  if (Array.isArray(previous) && Array.isArray(next)) {
    return JSON.stringify(previous) === JSON.stringify(next) ? null : { value: structuredClone(next) };
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const fields = {};
    const removed = [];
    for (const key of Object.keys(previous)) {
      if (!(key in next)) removed.push(key);
    }
    for (const [key, value] of Object.entries(next)) {
      const patch = createPatch(previous[key], value);
      if (patch) fields[key] = patch;
    }
    return Object.keys(fields).length || removed.length ? { fields, removed } : null;
  }
  return { value: structuredClone(next) };
}

function applyPatch(previous, patch) {
  if (Object.hasOwn(patch, 'value')) return structuredClone(patch.value);
  const next = isPlainObject(previous) ? structuredClone(previous) : {};
  for (const key of patch.removed || []) delete next[key];
  for (const [key, childPatch] of Object.entries(patch.fields || {})) next[key] = applyPatch(next[key], childPatch);
  return next;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateGameId(gameId) {
  if (!/^ddz-[0-9]+$/.test(gameId)) throw new Error('invalid_game_id');
}

function isCompletedState(state) { return state?.phase === 'over' && ['landlord', 'farmers'].includes(state.winner); }
function isCompletedSummary(summary) { return summary.completedAt !== null && isCompletedState(summary); }

function replaySummary(replay) {
  const state = latestReplayState(replay);
  return {
    gameId: replay.gameId, game: replay.game,
    sourceGameId: replay.sourceGameId ?? state.sourceGameId ?? null,
    createdAt: replay.createdAt, updatedAt: replay.updatedAt, completedAt: replay.completedAt,
    accessMode: state.accessMode || 'open',
    phase: state.phase || 'waiting', winner: state.winner ?? null,
    landlord: state.landlord ?? null,
    settlement: state.settlement ? {
      scoring: state.settlement.scoring, baseScore: state.settlement.baseScore,
      multiplier: state.settlement.multiplier,
      multiplierReasons: [...(state.settlement.multiplierReasons || [])],
      scoreDelta: [...(state.settlement.scoreDelta || [])]
    } : null,
    frameCount: Array.isArray(replay.entries) ? replay.entries.length : replay.frames.length,
    participants: Object.fromEntries(Object.entries(replay.participants || {}).map(([seatId, participant]) => [seatId, {
      type: participant.type, id: participant.id, displayName: participant.displayName,
      strategyMode: participant.strategyMode,
      agentMetadata: participant.agentMetadata ? structuredClone(participant.agentMetadata) : undefined,
      strategy: participant.strategy ? {
        id: participant.strategy.id, name: participant.strategy.name,
        updatedAt: participant.strategy.updatedAt, hash: participant.strategy.hash
      } : null
    }])),
    competition: state.competition ? {
      competitionId: state.competition.competitionId,
      roundNumber: state.competition.currentRound, totalRounds: state.competition.totalRounds
    } : null
  };
}
