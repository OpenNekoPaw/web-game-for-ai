import { handleWorkerRequest } from './worker-api.js';
import { expireInterruptedMatches, exportRecoverableGameState, exportStoreState, importStoreState, listRecoverableGameIds, nextMaintenanceAt, tickMatches } from './game/store.js';
import { exportDirtyReplayState, getReplayRevision, markReplayStatePersisted } from './game/replay-runtime.js';

const apiPath = (pathname) => pathname.startsWith('/api/') || pathname.startsWith('/agent/') || pathname === '/mcp';
const readOnlyMcpTools = new Set(['list_strategies', 'observe_game', 'observe_competition']);
const persistenceCheckpointMs = 30_000;

async function persistenceContext(request) {
  const url = new URL(request.url);
  const pathGameId = url.pathname.match(/\/(?:games|replays)\/(ddz-[0-9]+)/)?.[1] || null;
  if (url.pathname !== '/mcp' && url.pathname !== '/agent/mcp') {
    return { immediate: !['GET', 'HEAD', 'OPTIONS'].includes(request.method), gameId: pathGameId };
  }
  if (request.method !== 'POST') return { immediate: false, gameId: null };
  try {
    const message = await request.clone().json();
    if (message?.method !== 'tools/call') return { immediate: false, gameId: null };
    return {
      immediate: !readOnlyMcpTools.has(message.params?.name),
      gameId: /^ddz-[0-9]+$/.test(message.params?.arguments?.gameId) ? message.params.arguments.gameId : null
    };
  } catch {
    return { immediate: false, gameId: null };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (apiPath(url.pathname)) {
      const id = env.GAME_STATE.idFromName('global');
      return env.GAME_STATE.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class ArenaDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.loaded = false;
    this.lastPersistedAt = 0;
    this.nextAlarmAt = null;
    this.state.blockConcurrencyWhile?.(() => this.load());
  }

  async load() {
    if (this.loaded) return;
    const snapshot = await this.state.storage.get('snapshot');
    if (snapshot) {
      const decoded = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
      const [storedGameEntries, storedReplayEntries] = this.state.storage.list
        ? await Promise.all([
            this.state.storage.list({ prefix: 'game:' }),
            this.state.storage.list({ prefix: 'replay:' })
          ])
        : [new Map(), new Map()];
      const storedGames = [...storedGameEntries.entries()].map(([key, value]) => [key.slice('game:'.length), typeof value === 'string' ? JSON.parse(value) : value]);
      const storedReplays = [...storedReplayEntries.values()].map((value) => typeof value === 'string' ? JSON.parse(value) : value);
      const legacyGames = Array.isArray(decoded.games) ? decoded.games : [];
      const legacyReplays = Array.isArray(decoded.replays) ? decoded.replays : [];
      const games = storedGames.length ? storedGames : legacyGames;
      const replays = storedReplays.length ? storedReplays : legacyReplays;
      if (!storedGames.length && legacyGames.length) await this.persistRawGameRecords(legacyGames);
      if (!storedReplays.length && legacyReplays.length) await this.persistReplayRecords(legacyReplays.map((replay) => ({ replay })));
      importStoreState({ ...decoded, games, replays });
      const expiredGameIds = expireInterruptedMatches();
      this.loaded = true;
      if (expiredGameIds.length) await this.persist({ gameIds: expiredGameIds, prune: true });
    }
    this.loaded = true;
    this.lastPersistedAt = Date.now();
    this.nextAlarmAt = this.state.storage.getAlarm ? await this.state.storage.getAlarm() : null;
  }

  async persistReplayRecords(entries) {
    if (!entries.length) return;
    const records = Object.fromEntries(entries.map(({ replay }) => [`replay:${replay.gameId}`, JSON.stringify(replay)]));
    await this.state.storage.put(records);
  }

  async persistRawGameRecords(entries) {
    if (!entries.length) return;
    const records = Object.fromEntries(entries.map(([gameId, game]) => [`game:${gameId}`, JSON.stringify(game)]));
    await this.state.storage.put(records);
  }

  async persistGameRecords(gameIds, now) {
    const records = {};
    const removals = [];
    for (const gameId of gameIds) {
      const game = exportRecoverableGameState(gameId, now);
      if (game) records[`game:${gameId}`] = JSON.stringify(game);
      else removals.push(`game:${gameId}`);
    }
    if (Object.keys(records).length) await this.state.storage.put(records);
    if (removals.length && this.state.storage.delete) await this.state.storage.delete(removals);
  }

  async pruneGameRecords(now) {
    if (!this.state.storage.list || !this.state.storage.delete) return;
    const recoverable = new Set(listRecoverableGameIds(now).map((gameId) => `game:${gameId}`));
    const stored = await this.state.storage.list({ prefix: 'game:' });
    const stale = [...stored.keys()].filter((key) => !recoverable.has(key));
    if (stale.length) await this.state.storage.delete(stale);
  }

  async scheduleMaintenance() {
    const next = nextMaintenanceAt();
    if (next === null) {
      if (this.nextAlarmAt !== null && this.state.storage.deleteAlarm) await this.state.storage.deleteAlarm();
      this.nextAlarmAt = null;
      return;
    }
    if (this.nextAlarmAt !== null && this.nextAlarmAt <= next) return;
    await this.state.storage.setAlarm(next);
    this.nextAlarmAt = next;
  }

  async persist(options = {}) {
    const now = Date.now();
    const dirtyReplays = exportDirtyReplayState();
    const gameIds = new Set([...dirtyReplays.map((entry) => entry.gameId), ...(options.gameIds || [])]);
    await this.persistGameRecords(gameIds, now);
    await this.persistReplayRecords(dirtyReplays);
    const snapshot = exportStoreState({ includeGames: false, includeReplays: false });
    await this.state.storage.put('snapshot', JSON.stringify(snapshot));
    if (this.env.REPLAYS) await Promise.all(dirtyReplays.map(({ replay }) => this.env.REPLAYS.put(
      `replays/${replay.gameId}.json`, JSON.stringify(replay),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    )));
    markReplayStatePersisted(dirtyReplays);
    if (options.prune === true) await this.pruneGameRecords(now);
    this.lastPersistedAt = Date.now();
  }

  async fetch(request) {
    await this.load();
    const context = await persistenceContext(request);
    const revisionBefore = getReplayRevision();
    const response = await handleWorkerRequest(request);
    const replayChanged = getReplayRevision() !== revisionBefore;
    const checkpointDue = Date.now() - this.lastPersistedAt >= persistenceCheckpointMs;
    if (context.immediate || replayChanged || (checkpointDue && context.gameId)) {
      await this.persist({ gameIds: context.gameId ? [context.gameId] : [], prune: checkpointDue });
    }
    await this.scheduleMaintenance();
    return response;
  }

  async alarm() {
    await this.load();
    this.nextAlarmAt = null;
    const revisionBefore = getReplayRevision();
    tickMatches();
    const expiredGameIds = expireInterruptedMatches();
    if (getReplayRevision() !== revisionBefore || expiredGameIds.length) {
      await this.persist({ gameIds: expiredGameIds, prune: expiredGameIds.length > 0 });
    }
    await this.scheduleMaintenance();
  }
}
