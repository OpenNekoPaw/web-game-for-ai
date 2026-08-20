import { handleWorkerRequest } from './worker-api.js';
import { exportStoreState, importStoreState, tickMatches } from './game/store.js';
import { exportDirtyReplayState, getReplayRevision, markReplayStatePersisted } from './game/replay-runtime.js';

const apiPath = (pathname) => pathname.startsWith('/api/') || pathname.startsWith('/agent/') || pathname === '/mcp';
const readOnlyMcpTools = new Set(['list_strategies', 'observe_game', 'observe_competition']);
const persistenceCheckpointMs = 30_000;

async function shouldPersistImmediately(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/mcp' && url.pathname !== '/agent/mcp') return !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (request.method !== 'POST') return false;
  try {
    const message = await request.clone().json();
    if (message?.method !== 'tools/call') return false;
    return !readOnlyMcpTools.has(message.params?.name);
  } catch {
    return false;
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
    this.state.blockConcurrencyWhile?.(() => this.load());
  }

  async load() {
    if (this.loaded) return;
    const snapshot = await this.state.storage.get('snapshot');
    if (snapshot) {
      const decoded = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
      const storedReplayEntries = this.state.storage.list
        ? await this.state.storage.list({ prefix: 'replay:' })
        : new Map();
      const storedReplays = [...storedReplayEntries.values()].map((value) => typeof value === 'string' ? JSON.parse(value) : value);
      const legacyReplays = Array.isArray(decoded.replays) ? decoded.replays : [];
      const replays = storedReplays.length ? storedReplays : legacyReplays;
      if (!storedReplays.length && legacyReplays.length) await this.persistReplayRecords(legacyReplays.map((replay) => ({ replay })));
      importStoreState({ ...decoded, replays });
    }
    this.loaded = true;
    this.lastPersistedAt = Date.now();
  }

  async persistReplayRecords(entries) {
    if (!entries.length) return;
    const records = Object.fromEntries(entries.map(({ replay }) => [`replay:${replay.gameId}`, JSON.stringify(replay)]));
    await this.state.storage.put(records);
  }

  async persist() {
    const dirtyReplays = exportDirtyReplayState();
    await this.persistReplayRecords(dirtyReplays);
    const snapshot = exportStoreState({ includeReplays: false, recoverableOnly: true });
    await this.state.storage.put('snapshot', JSON.stringify(snapshot));
    if (this.env.REPLAYS) await Promise.all(dirtyReplays.map(({ replay }) => this.env.REPLAYS.put(
      `replays/${replay.gameId}.json`, JSON.stringify(replay),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    )));
    markReplayStatePersisted(dirtyReplays);
    this.lastPersistedAt = Date.now();
  }

  async fetch(request) {
    await this.load();
    const persistImmediately = await shouldPersistImmediately(request);
    const revisionBefore = getReplayRevision();
    const response = await handleWorkerRequest(request);
    const replayChanged = getReplayRevision() !== revisionBefore;
    const checkpointDue = Date.now() - this.lastPersistedAt >= persistenceCheckpointMs;
    if (persistImmediately || replayChanged || checkpointDue) await this.persist();
    await this.state.storage.setAlarm(Date.now() + 1000);
    return response;
  }

  async alarm() {
    await this.load();
    const revisionBefore = getReplayRevision();
    tickMatches();
    if (getReplayRevision() !== revisionBefore) await this.persist();
    await this.state.storage.setAlarm(Date.now() + 1000);
  }
}
