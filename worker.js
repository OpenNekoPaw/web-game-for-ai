import { handleWorkerRequest } from './worker-api.js';
import { exportStoreState, importStoreState, tickMatches } from './game/store.js';
import { exportReplayState } from './game/replay-runtime.js';

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
  constructor(state, env) { this.state = state; this.env = env; this.loaded = false; }

  async load() {
    if (this.loaded) return;
    const snapshot = await this.state.storage.get('snapshot');
    if (snapshot) importStoreState(JSON.parse(snapshot));
    this.loaded = true;
  }

  async persist() {
    const snapshot = exportStoreState();
    await this.state.storage.put('snapshot', JSON.stringify(snapshot));
    if (this.env.REPLAYS) await Promise.all(exportReplayState().map((replay) => this.env.REPLAYS.put(
      `replays/${replay.gameId}.json`, JSON.stringify(replay),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    )));
  }

  async fetch(request) {
    await this.load();
    const response = await handleWorkerRequest(request);
    await this.persist();
    await this.state.storage.setAlarm(Date.now() + 1000);
    return response;
  }

  async alarm() {
    await this.load();
    tickMatches();
    await this.persist();
    await this.state.storage.setAlarm(Date.now() + 1000);
  }
}
