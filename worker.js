import { handleWorkerRequest } from './worker-api.js';
import {
  expireInterruptedMatches, exportDirtyAuthoritativeState, exportRecoverableGameState, exportStoreState,
  importStoreState, listRecoverableGameIds, markAuthoritativeStatePersisted, nextMaintenanceAt, tickMatches
} from './game/store.js';
import { exportDirtyReplayState, markReplayStatePersisted } from './game/replay-runtime.js';

const apiPath = (pathname) => pathname.startsWith('/api/') || pathname.startsWith('/agent/') || pathname === '/mcp';

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
    const authoritative = options.authoritative || exportDirtyAuthoritativeState();
    const dirtyReplays = exportDirtyReplayState();
    const gameIds = new Set([
      ...authoritative.gameRevisions.map(([gameId]) => gameId),
      ...dirtyReplays.map((entry) => entry.gameId),
      ...(options.gameIds || [])
    ]);
    await this.persistGameRecords(gameIds, now);
    await this.persistReplayRecords(dirtyReplays);
    if (authoritative.metadataRevision) {
      const snapshot = exportStoreState({ includeGames: false, includeReplays: false });
      await this.state.storage.put('snapshot', JSON.stringify(snapshot));
    }
    if (this.env.REPLAYS) await Promise.all(dirtyReplays.map(({ replay }) => this.env.REPLAYS.put(
      `replays/${replay.gameId}.json`, JSON.stringify(replay),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    )));
    markReplayStatePersisted(dirtyReplays);
    markAuthoritativeStatePersisted(authoritative);
    if (options.prune === true) await this.pruneGameRecords(now);
  }

  async fetch(request) {
    await this.load();
    const response = await handleWorkerRequest(request);
    const authoritative = exportDirtyAuthoritativeState();
    if (authoritative.metadataRevision || authoritative.gameRevisions.length || exportDirtyReplayState().length) {
      await this.persist({ authoritative });
    }
    await this.scheduleMaintenance();
    return response;
  }

  async alarm() {
    await this.load();
    this.nextAlarmAt = null;
    tickMatches();
    const expiredGameIds = expireInterruptedMatches();
    const authoritative = exportDirtyAuthoritativeState();
    if (authoritative.metadataRevision || authoritative.gameRevisions.length || exportDirtyReplayState().length) {
      await this.persist({ authoritative, gameIds: expiredGameIds, prune: expiredGameIds.length > 0 });
    }
    await this.scheduleMaintenance();
  }
}
