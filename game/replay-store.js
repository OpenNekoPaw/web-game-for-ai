import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recordsDirectory = fileURLToPath(new URL('../records/', import.meta.url));
const records = new Map();
const persistenceEnabled = process.env.REPLAY_PERSISTENCE !== 'memory';

export function createReplay(gameId, state, participants = {}) {
  const now = Date.now();
  const replay = {
    format: 'agent-game.replay.v1',
    gameId,
    game: state.game,
    sourceGameId: state.sourceGameId ?? null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    participants: structuredClone(participants),
    frames: [{ index: 0, at: now, event: { type: 'created' }, state: structuredClone(state) }]
  };
  records.set(gameId, replay);
  persistReplay(replay);
}

export function updateReplayParticipants(gameId, participants) {
  const replay = requireReplay(gameId);
  replay.participants = structuredClone(participants);
  replay.updatedAt = Date.now();
  persistReplay(replay);
}

export function appendReplayFrame(gameId, event, state, participants = {}) {
  const replay = requireReplay(gameId);
  const now = Date.now();
  replay.participants = structuredClone(participants);
  replay.frames.push({
    index: replay.frames.length,
    at: now,
    event: structuredClone(event),
    state: structuredClone(state)
  });
  replay.updatedAt = now;
  if (isCompletedState(state) && replay.completedAt === null) replay.completedAt = now;
  persistReplay(replay);
}

export function readReplay(gameId) {
  validateGameId(gameId);
  if (records.has(gameId)) return structuredClone(records.get(gameId));
  try {
    const replay = JSON.parse(readFileSync(recordPath(gameId), 'utf8'));
    records.set(gameId, replay);
    return structuredClone(replay);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('replay_not_found');
    throw error;
  }
}

export function listReplays(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  const status = options.status === 'completed' ? 'completed' : 'all';
  let gameIds = [];
  if (persistenceEnabled) {
    try {
      gameIds = readdirSync(recordsDirectory)
        .filter((name) => /^ddz-[0-9]+\.json$/.test(name))
        .map((name) => name.slice(0, -5));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  gameIds = [...new Set([...gameIds, ...records.keys()])]
    .sort((left, right) => Number(right.slice(4)) - Number(left.slice(4)));
  const summaries = gameIds.flatMap((gameId) => {
    try { return [replaySummary(readReplay(gameId))]; }
    catch { return []; }
  });
  const filtered = status === 'completed' ? summaries.filter(isCompletedSummary) : summaries;
  return { total: filtered.length, offset, limit, status, items: filtered.slice(offset, offset + limit) };
}

function requireReplay(gameId) {
  if (!records.has(gameId)) readReplay(gameId);
  return records.get(gameId);
}

function persistReplay(replay) {
  if (!persistenceEnabled) return;
  mkdirSync(recordsDirectory, { recursive: true });
  const path = recordPath(replay.gameId);
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(replay, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function isCompletedState(state) {
  return state?.phase === 'over' && ['landlord', 'farmers'].includes(state.winner);
}

function isCompletedSummary(summary) {
  return summary.completedAt !== null && isCompletedState(summary);
}

function replaySummary(replay) {
  const state = replay.frames.at(-1)?.state || {};
  return {
    gameId: replay.gameId,
    game: replay.game,
    sourceGameId: replay.sourceGameId ?? state.sourceGameId ?? null,
    createdAt: replay.createdAt,
    updatedAt: replay.updatedAt,
    completedAt: replay.completedAt,
    phase: state.phase || 'waiting',
    winner: state.winner ?? null,
    landlord: state.landlord ?? null,
    settlement: state.settlement ? {
      scoring: state.settlement.scoring,
      baseScore: state.settlement.baseScore,
      multiplier: state.settlement.multiplier,
      multiplierReasons: [...(state.settlement.multiplierReasons || [])],
      scoreDelta: [...(state.settlement.scoreDelta || [])]
    } : null,
    frameCount: replay.frames.length,
    participants: Object.fromEntries(Object.entries(replay.participants || {}).map(([seatId, participant]) => [seatId, {
      type: participant.type,
      id: participant.id,
      displayName: participant.displayName,
      strategy: participant.strategy ? {
        id: participant.strategy.id,
        name: participant.strategy.name,
        updatedAt: participant.strategy.updatedAt,
        hash: participant.strategy.hash
      } : null
    }])),
    competition: state.competition ? {
      competitionId: state.competition.competitionId,
      roundNumber: state.competition.currentRound,
      totalRounds: state.competition.totalRounds
    } : null
  };
}

function recordPath(gameId) {
  validateGameId(gameId);
  return join(recordsDirectory, `${gameId}.json`);
}

function validateGameId(gameId) {
  if (!/^ddz-[0-9]+$/.test(gameId)) throw new Error('invalid_game_id');
}
