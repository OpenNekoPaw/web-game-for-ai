// Platform-neutral replay store used by both the Node server and the Worker.
// The Worker persists the exported records to R2 after each state-changing
// request; the Durable Object storage keeps the hot working set available.
const records = new Map();
const dirtyRecords = new Map();
let revision = 0;

function markDirty(gameId) {
  revision += 1;
  dirtyRecords.set(gameId, revision);
}

export function createReplay(gameId, state, participants = {}) {
  const now = Date.now();
  records.set(gameId, {
    format: 'agent-game.replay.v1', gameId, game: state.game,
    sourceGameId: state.sourceGameId ?? null, createdAt: now, updatedAt: now,
    completedAt: null, participants: structuredClone(participants),
    frames: [{ index: 0, at: now, event: { type: 'created' }, state: structuredClone(state) }]
  });
  markDirty(gameId);
}

export function updateReplayParticipants(gameId, participants) {
  const replay = requireReplay(gameId);
  replay.participants = structuredClone(participants);
  replay.updatedAt = Date.now();
  markDirty(gameId);
}

export function appendReplayFrame(gameId, event, state, participants = {}) {
  const replay = requireReplay(gameId);
  const now = Date.now();
  replay.participants = structuredClone(participants);
  replay.frames.push({ index: replay.frames.length, at: now, event: structuredClone(event), state: structuredClone(state) });
  replay.updatedAt = now;
  if (isCompletedState(state) && replay.completedAt === null) replay.completedAt = now;
  markDirty(gameId);
}

export function readReplay(gameId) {
  validateGameId(gameId);
  return structuredClone(requireReplay(gameId));
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
  dirtyRecords.clear();
  revision += 1;
}

function requireReplay(gameId) {
  validateGameId(gameId);
  const replay = records.get(gameId);
  if (!replay) throw new Error('replay_not_found');
  return replay;
}

function validateGameId(gameId) {
  if (!/^ddz-[0-9]+$/.test(gameId)) throw new Error('invalid_game_id');
}

function isCompletedState(state) { return state?.phase === 'over' && ['landlord', 'farmers'].includes(state.winner); }
function isCompletedSummary(summary) { return summary.completedAt !== null && isCompletedState(summary); }

function replaySummary(replay) {
  const state = replay.frames.at(-1)?.state || {};
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
    frameCount: replay.frames.length,
    participants: Object.fromEntries(Object.entries(replay.participants || {}).map(([seatId, participant]) => [seatId, {
      type: participant.type, id: participant.id, displayName: participant.displayName,
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
