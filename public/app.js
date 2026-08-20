const params = new URLSearchParams(location.search);
const replayGameId = params.get('replay');
const replayMode = Boolean(replayGameId);
const replayReturn = params.get('return');
const inviteToken = params.get('invite');
let gameId = params.get('game');
let competitionId = params.get('competition');
const ownsInitialRoom = Boolean(gameId && localStorage.getItem(`ddz-room-owner-token:${gameId}`));
let setupConfirmed = params.get('setup') === '1' || Boolean(competitionId) || Boolean(inviteToken) || Boolean(gameId && !ownsInitialRoom);
let selectedAccessMode = 'open';
let seatJoinInviteToken = null;
let seat = normalizeSeat(params.get('seat'));
let controlledSeat = normalizeSeat(params.get('control') ?? params.get('seat'));
let controlRequested = params.has('control');
let controlActive = false;
let playerJoinAttempt = null;
let autoJoinRequested = false;
let view = normalizeView(params.get('view'));
let state = null;
let replay = null;
let replayIndex = 0;
let replayTimer = null;
let replayCanRematch = false;
let activeInvite = null;
let selected = new Set();
let refreshing = false;
let messageTimer = null;
let serverClockOffsetMs = 0;
let strategySeat = seat;
let strategyParticipants = {};
let strategySnapshotGameId = null;
let strategyLoading = false;
let selectedRounds = 1;
let selectedAgentType = null;
let agentGuide = null;
let agentGuideLoading = false;

const $ = (id) => document.getElementById(id);
const post = (path, data = {}, headers = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) }).then(async (response) => ({ response, data: await response.json() }));

function normalizeSeat(value) { const parsed = Number(value); return [0, 1, 2].includes(parsed) ? parsed : 0; }
function normalizeView(value) { return value === 'global' ? 'global' : 'player'; }
function isRoomOwner() { return Boolean(storedRoomOwnerToken(gameId)); }
function syncUrl() {
  const next = new URL(location.href);
  next.searchParams.set('seat', seat);
  if (replayMode) {
    next.searchParams.set('replay', replayGameId);
    next.searchParams.delete('game'); next.searchParams.delete('competition'); next.searchParams.delete('control'); next.searchParams.delete('invite'); next.searchParams.delete('setup');
  } else if (activeInvite) {
    next.searchParams.set('invite', activeInvite.token);
    next.searchParams.delete('game'); next.searchParams.delete('competition'); next.searchParams.delete('control'); next.searchParams.delete('setup');
  } else {
    next.searchParams.delete('invite');
    if (controlRequested) next.searchParams.set('control', controlledSeat); else next.searchParams.delete('control');
    if (gameId) next.searchParams.set('game', gameId);
    if (competitionId) next.searchParams.set('competition', competitionId); else next.searchParams.delete('competition');
    if (setupConfirmed) next.searchParams.set('setup', '1'); else next.searchParams.delete('setup');
  }
  if (view === 'global') next.searchParams.set('view', 'global'); else next.searchParams.delete('view');
  history.replaceState(null, '', next);
}
function showMessage(text, error = false) { clearTimeout(messageTimer); const element = $('message'); element.textContent = text; element.className = `message visible ${error ? 'error' : ''}`; messageTimer = setTimeout(() => { element.className = 'message'; }, 2200); }

function setAgentTypeMenu(open) {
  if (open) setInviteMenu(false);
  const menu = $('agent-type-menu');
  const button = $('agent-connect');
  menu.hidden = !open;
  button.classList.toggle('active', open || !$('agent-panel').hidden);
  button.setAttribute('aria-expanded', String(open));
  if (!open) return;
  const rect = button.getBoundingClientRect();
  const menuWidth = 218;
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menuWidth - 8))}px`;
  menu.style.top = `${rect.bottom + 7}px`;
  menu.querySelector('button')?.focus();
}

function setInviteMenu(open) {
  const menu = $('invite-menu');
  const button = $('invite-game');
  menu.hidden = !open;
  button.classList.toggle('active', open);
  button.setAttribute('aria-expanded', String(open));
  if (!open) return;
  setAgentTypeMenu(false);
  renderInviteMenu();
  const rect = button.getBoundingClientRect();
  const menuWidth = 238;
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menuWidth - 8))}px`;
  menu.style.top = `${rect.bottom + 7}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
}

function renderInviteMenu() {
  const waiting = state?.phase === 'waiting';
  document.querySelectorAll('[data-invite-type][data-invite-seat]').forEach((button) => {
    if (button.dataset.inviteType === 'spectator') { button.disabled = !gameId; return; }
    if (button.dataset.inviteType === 'player' && button.dataset.inviteSeat === 'auto') {
      const roomFull = [0, 1, 2].every((seatId) => Boolean(state?.seatControllers?.[seatId]));
      button.disabled = !waiting || roomFull;
      button.title = roomFull ? '房间已满' : '加入时自动分配第一个空座';
      return;
    }
    const seatId = Number(button.dataset.inviteSeat);
    button.disabled = !waiting || Boolean(state?.seatControllers?.[seatId]);
    button.title = state?.seatControllers?.[seatId] ? '该座位已被占用' : '';
  });
}

async function createInvite(inviteType, seatId) {
  if (!gameId || !setupConfirmed) return showMessage('请先确认比赛局数', true);
  if (!isRoomOwner()) return showMessage('只有房主可以创建邀请', true);
  try {
    const payload = { inviteType, ...(seatId === null ? {} : { seatId }) };
    const { response, data } = await post(`/api/games/${encodeURIComponent(gameId)}/invites`, payload, { 'x-room-owner-token': storedRoomOwnerToken(gameId) });
    if (!response.ok) throw new Error(data.error || 'invite_failed');
    const url = inviteType === 'agent'
      ? new URL(`/agent/v1/invites/${encodeURIComponent(data.token)}`, location.origin)
      : new URL(`/?invite=${encodeURIComponent(data.token)}`, location.origin);
    const copied = await copyText(url.href);
    setInviteMenu(false);
    const label = inviteType === 'spectator'
      ? '观战链接'
      : inviteType === 'player' && seatId === null
        ? '玩家自动分配邀请链接'
        : `${inviteType === 'agent' ? 'Agent' : '玩家'} ${['A', 'B', 'C'][seatId]} 邀请链接`;
    showMessage(copied ? `${label}已复制` : `${label}复制失败`, !copied);
  } catch (error) {
    showMessage(`创建邀请失败：${errorText(error.message)}`, true);
  }
}

async function resolveInvite() {
  const response = await fetch(`/api/invites/${encodeURIComponent(inviteToken)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'invite_not_found');
  if (!['player', 'spectator'].includes(data.inviteType)) throw new Error('invite_type_mismatch');
  activeInvite = data;
  setupConfirmed = true;
  gameId = data.gameId;
  competitionId = data.competitionId || null;
  if (Number.isInteger(data.seatId)) seat = normalizeSeat(data.seatId);
  controlledSeat = seat;
  controlRequested = data.inviteType === 'player';
  view = data.inviteType === 'spectator' ? 'global' : 'player';
  syncUrl();
}

function setAgentPanel(open, type = selectedAgentType) {
  setAgentTypeMenu(false);
  if (open) {
    $('strategy-panel').hidden = true;
    $('decision-panel').hidden = true;
    $('review-panel').hidden = true;
    $('history-panel').hidden = true;
    selectedAgentType = type || 'mcp';
    renderAgentConnect(selectedAgentType);
    loadAgentGuide().then(() => renderAgentConnect(selectedAgentType));
  }
  $('agent-panel').hidden = !open;
  updateSidePanelLayout();
}

async function loadAgentGuide() {
  if (agentGuide || agentGuideLoading) return agentGuide;
  agentGuideLoading = true;
  try {
    const response = await fetch('/api/agent-guide');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'agent_guide_failed');
    agentGuide = data;
  } catch (error) {
    showMessage(`Agent 指南加载失败：${errorText(error.message)}`, true);
  } finally {
    agentGuideLoading = false;
  }
  return agentGuide;
}

function renderAgentConnect(type) {
  const content = $('agent-connect-content');
  const origin = location.origin;
  const presets = {
    codex: {
      title: 'Codex 接入',
      description: '安装项目自带插件，一次获得斗地主 Skill 和 MCP 工具。',
      label: '在项目目录运行',
      value: `codex plugin marketplace add .\ncodex plugin add ai-h5-game@ai-h5-game-local`,
      note: `游戏服务：${origin}`
    },
    mcp: {
      title: '通用 MCP 接入',
      description: '适用于支持远程 MCP 的 Agent。MCP Server 运行在游戏服务端，不需要安装本地连接器。',
      label: 'MCP 配置',
      value: JSON.stringify({ mcpServers:{ 'ai-h5-game':{ url:`${origin}/mcp` } } }, null, 2),
      note: '收到 Agent 邀请链接后使用 join_invite；本地策略由 Agent 自己读取，不上传游戏服务。'
    }
  };
  const preset = presets[type] || presets.mcp;
  $('agent-panel-title').textContent = preset.title;
  content.innerHTML = '';
  const description = document.createElement('p');
  description.className = 'agent-connect-description';
  description.textContent = preset.description;
  const label = document.createElement('strong');
  label.className = 'agent-connect-label';
  label.textContent = preset.label;
  const code = document.createElement('pre');
  code.className = 'agent-connect-code';
  code.textContent = preset.value;
  const copy = document.createElement('button');
  copy.className = 'agent-copy-button';
  copy.type = 'button';
  copy.textContent = '复制配置';
  copy.onclick = async () => {
    const copied = await copyText(preset.value);
    showMessage(copied ? '配置已复制' : '复制失败，请手动选择', !copied);
  };
  const guideCopy = document.createElement('button');
  guideCopy.className = 'agent-copy-button agent-guide-button';
  guideCopy.type = 'button';
  guideCopy.textContent = agentGuideLoading ? '加载 Skill…' : '复制 Skill';
  guideCopy.disabled = agentGuideLoading || !agentGuide;
  guideCopy.onclick = async () => {
    const copied = await copyText(agentGuide?.markdown || '');
    showMessage(copied ? 'Skill 已复制' : '复制失败，请手动选择', !copied);
  };
  const guideDownload = document.createElement('button');
  guideDownload.className = 'agent-copy-button agent-guide-button';
  guideDownload.type = 'button';
  guideDownload.textContent = '下载 SKILL.md';
  guideDownload.disabled = agentGuideLoading || !agentGuide;
  guideDownload.onclick = () => {
    if (!agentGuide?.markdown) return;
    const blob = new Blob([agentGuide.markdown], { type:'text/markdown;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = agentGuide.fileName || 'SKILL.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  };
  const guideStatus = document.createElement('small');
  guideStatus.className = 'agent-guide-status';
  guideStatus.textContent = agentGuide?.hash ? `Skill hash ${agentGuide.hash.slice(0, 8)}` : 'Skill 由服务端当前文件提供';
  const note = document.createElement('small');
  note.className = 'agent-connect-note';
  note.textContent = preset.note;
  const actions = document.createElement('div');
  actions.className = 'agent-connect-actions';
  actions.append(copy, guideCopy, guideDownload);
  content.append(description, label, code, actions, guideStatus, note);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    return copied;
  }
}

async function create(rounds = 1, options = {}) {
  try {
    const totalRounds = [3, 5, 7].includes(Number(rounds)) ? Number(rounds) : 1;
    const accessMode = ['open', 'invite_only', 'private'].includes(options.accessMode) ? options.accessMode : 'open';
    const { response, data } = totalRounds === 1 ? await post('/api/games', { accessMode }) : await post('/api/competitions', { totalRounds, accessMode });
    if (!response.ok) throw new Error(data.error || 'create_failed');
    activeInvite = null;
    gameId = totalRounds === 1 ? data.gameId : data.currentGameId;
    competitionId = totalRounds === 1 ? null : data.competitionId;
    rememberReplayAccess(data.replayAccessToken, gameId);
    rememberRoomOwner(data.roomOwnerToken, gameId);
    setupConfirmed = options.confirmed === true || totalRounds > 1;
    selectedRounds = totalRounds;
    selectedAccessMode = accessMode;
    controlRequested = false;
    controlActive = false;
    playerJoinAttempt = null;
    autoJoinRequested = false;
    strategyParticipants = {};
    strategySnapshotGameId = null;
    selected.clear();
    syncUrl();
    await refresh();
  } catch (error) { setConnectionError(error); }
}

async function confirmMatchSetup() {
  if (setupConfirmed) return;
  await create(selectedRounds, { confirmed: true, accessMode: selectedAccessMode, owner: true });
}

async function ensurePlayerJoined() {
  if (replayMode || !controlRequested || !gameId || playerJoinAttempt === gameId) return;
  playerJoinAttempt = gameId;
  const sessionId = competitionId || gameId;
  const joiningAutomatically = autoJoinRequested || (activeInvite?.inviteType === 'player' && activeInvite.seatMode === 'auto' && !Number.isInteger(activeInvite.seatId));
  const playerId = activeInvite?.inviteType === 'player'
    ? localInvitePlayerId(activeInvite.token)
    : joiningAutomatically ? localRoomPlayerId(sessionId) : localPlayerId(sessionId, controlledSeat);
  const requestedName = params.get('name');
  const displayName = requestedName
    ? String(requestedName).trim().slice(0, 40)
    : joiningAutomatically ? undefined : `玩家 ${['A', 'B', 'C'][controlledSeat]}`;
  const path = activeInvite?.inviteType === 'player'
    ? `/api/invites/${encodeURIComponent(activeInvite.token)}/join`
    : seatJoinInviteToken
      ? `/api/invites/${encodeURIComponent(seatJoinInviteToken)}/join`
    : `/api/games/${gameId}/join`;
  const existingSeatToken = storedSeatSession(sessionId, controlledSeat)?.token;
  const { response, data } = await post(path, { ...(joiningAutomatically ? {} : { seatId: controlledSeat }), playerId, displayName }, existingSeatToken ? { 'x-seat-session-token': existingSeatToken } : {});
  if (response.ok) {
    const joinedSeat = Number(data.invite?.seatId ?? data.you ?? controlledSeat);
    if ([0, 1, 2].includes(joinedSeat)) {
      seat = joinedSeat;
      controlledSeat = joinedSeat;
      persistPlayerId(sessionId, joinedSeat, playerId);
      rememberSeatSession(sessionId, joinedSeat, data.seatSessionToken, data.reconnectCode);
    }
    if (data.invite && activeInvite) activeInvite = { ...activeInvite, ...data.invite };
    rememberReplayAccess(data.replayAccessToken, gameId);
    controlActive = true;
    autoJoinRequested = false;
    seatJoinInviteToken = null;
    syncUrl();
    return;
  }
  controlActive = false;
  if (data.error === 'seat_session_required') {
    forgetSeatSession(sessionId, controlledSeat);
    controlRequested = false;
    autoJoinRequested = false;
    playerJoinAttempt = gameId;
    syncUrl();
    showMessage('当前设备的座位控制权已失效，可使用重连码恢复', true);
    return;
  }
  if (data.error === 'seat_occupied') { showMessage('该座位已由其他玩家或 Agent 占用，当前为观战模式', true); return; }
  throw new Error(data.error || 'join_failed');
}

function localPlayerId(sessionId, seatId) {
  const key = `ddz-player:${sessionId}:${seatId}`;
  let value = localStorage.getItem(key) || sessionStorage.getItem(key);
  if (!value) value = `h5-${crypto.randomUUID()}`;
  persistPlayerId(sessionId, seatId, value);
  return value;
}

function persistPlayerId(sessionId, seatId, playerId) {
  const key = `ddz-player:${sessionId}:${seatId}`;
  localStorage.setItem(key, playerId);
  sessionStorage.removeItem(key);
}

function localInvitePlayerId(token) {
  const key = `ddz-invite-player:${token}`;
  let value = localStorage.getItem(key);
  if (!value) {
    value = `h5-${crypto.randomUUID()}`;
    localStorage.setItem(key, value);
  }
  return value;
}

function localRoomPlayerId(sessionId) {
  const key = `ddz-room-player:${sessionId}`;
  let value = localStorage.getItem(key);
  if (!value) {
    value = `h5-${crypto.randomUUID()}`;
    localStorage.setItem(key, value);
  }
  return value;
}

function rememberSeatSession(sessionId, seatId, token, reconnectCode) {
  if (!sessionId || ![0, 1, 2].includes(Number(seatId)) || typeof token !== 'string') return;
  localStorage.setItem(`ddz-seat-session:${sessionId}:${seatId}`, JSON.stringify({ token, reconnectCode: String(reconnectCode || '') }));
}

function storedSeatSession(sessionId, seatId) {
  if (!sessionId || ![0, 1, 2].includes(Number(seatId))) return null;
  try {
    const value = JSON.parse(localStorage.getItem(`ddz-seat-session:${sessionId}:${seatId}`) || 'null');
    return value && typeof value.token === 'string' ? value : null;
  } catch { return null; }
}

function forgetSeatSession(sessionId, seatId) {
  if (sessionId && [0, 1, 2].includes(Number(seatId))) localStorage.removeItem(`ddz-seat-session:${sessionId}:${seatId}`);
}

function seatSessionHeaders(sessionId = competitionId || gameId, seatId = controlledSeat) {
  if (!controlRequested && !controlActive) return {};
  const token = storedSeatSession(sessionId, seatId)?.token;
  return token ? { 'x-seat-session-token': token, 'x-seat-session-seat': String(seatId) } : {};
}

function rememberRoomOwner(token, targetGameId = gameId) {
  if (typeof token !== 'string') return;
  if (targetGameId) localStorage.setItem(`ddz-room-owner-token:${targetGameId}`, token);
  if (competitionId) localStorage.setItem(`ddz-room-owner-token:${competitionId}`, token);
}

function storedRoomOwnerToken(targetGameId = gameId) {
  return (targetGameId && localStorage.getItem(`ddz-room-owner-token:${targetGameId}`))
    || (competitionId && localStorage.getItem(`ddz-room-owner-token:${competitionId}`))
    || null;
}

function rememberReplayAccess(token, targetGameId = gameId) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return;
  if (targetGameId) localStorage.setItem(`ddz-replay-access:${targetGameId}`, token);
  if (competitionId) localStorage.setItem(`ddz-replay-access:${competitionId}`, token);
}

function storedReplayAccess(targetGameId = gameId) {
  return (targetGameId && localStorage.getItem(`ddz-replay-access:${targetGameId}`))
    || (competitionId && localStorage.getItem(`ddz-replay-access:${competitionId}`))
    || null;
}

function replayAccessHeaders(targetGameId = gameId) {
  const token = storedReplayAccess(targetGameId);
  return token ? { 'x-replay-access-token': token } : {};
}

function storedPlayerId(sessionId, seatId) {
  const key = `ddz-player:${sessionId}:${seatId}`;
  return localStorage.getItem(key) || sessionStorage.getItem(key);
}

function restoreLocalPlayerControl(matchState) {
  if (controlActive || controlRequested || !matchState?.seatControllers) return false;
  const sessionId = competitionId || gameId;
  const recoveredSeat = Number(matchState.controlledSeat);
  if (!matchState.controlAuthorized || ![0, 1, 2].includes(recoveredSeat) || !storedSeatSession(sessionId, recoveredSeat)) return false;
  seat = recoveredSeat;
  controlledSeat = recoveredSeat;
  controlRequested = true;
  controlActive = true;
  playerJoinAttempt = gameId;
  return true;
}

async function start() {
  if (!gameId || !controlActive) return showMessage('请先加入一个玩家座位', true);
  if (state?.readySeats?.includes(controlledSeat)) return;
  try { const { response, data } = await post(`/api/games/${gameId}/start`, { seatId: controlledSeat }, seatSessionHeaders()); if (!response.ok) throw new Error(data.error || 'start_failed'); selected.clear(); await refresh(); }
  catch (error) { showMessage(errorText(error.message), true); }
}

async function joinPlayerGame() {
  if (!gameId || state?.phase !== 'waiting') return;
  controlRequested = true;
  controlActive = false;
  playerJoinAttempt = null;
  autoJoinRequested = true;
  selected.clear();
  syncUrl();
  try {
    if (state.accessMode !== 'open' && !activeInvite) {
      if (!isRoomOwner()) return showMessage('该房间需要玩家邀请链接', true);
      const { response, data } = await post(`/api/games/${encodeURIComponent(gameId)}/invites`, { inviteType: 'player' }, { 'x-room-owner-token': storedRoomOwnerToken(gameId) });
      if (!response.ok) throw new Error(data.error || 'invite_failed');
      seatJoinInviteToken = data.token;
    }
    await ensurePlayerJoined();
    if (!controlActive) return await refresh();
    await start();
  } catch (error) {
    showMessage(errorText(error.message), true);
    await refresh();
  }
}

async function reconnectPlayerGame() {
  if (!gameId) return;
  const reconnectCode = $('reconnect-code').value.trim();
  if (!reconnectCode) return showMessage('请输入重连码', true);
  try {
    const { response, data } = await post(`/api/games/${encodeURIComponent(gameId)}/reconnect`, { reconnectCode });
    if (!response.ok) throw new Error(data.error || 'invalid_reconnect_code');
    const joinedSeat = Number(data.you);
    const sessionId = data.competition?.competitionId || competitionId || gameId;
    competitionId = data.competition?.competitionId || competitionId;
    seat = joinedSeat;
    controlledSeat = joinedSeat;
    controlRequested = true;
    controlActive = true;
    playerJoinAttempt = gameId;
    persistPlayerId(sessionId, joinedSeat, data.seatControllers?.[joinedSeat]?.id || localPlayerId(sessionId, joinedSeat));
    rememberSeatSession(sessionId, joinedSeat, data.seatSessionToken, data.reconnectCode);
    rememberReplayAccess(data.replayAccessToken, gameId);
    $('reconnect-code').value = '';
    syncUrl();
    showMessage(`已恢复玩家 ${['A', 'B', 'C'][joinedSeat]} 的座位`);
    await refresh();
  } catch (error) { showMessage(errorText(error.message), true); }
}

async function removeOfflinePlayer(seatId) {
  const ownerToken = storedRoomOwnerToken(gameId);
  if (!ownerToken) return showMessage('只有房主可以移除掉线玩家', true);
  try {
    const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/players/${seatId}`, { method: 'DELETE', headers: { 'x-room-owner-token': ownerToken } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'remove_failed');
    showMessage(`已移除掉线玩家 ${['A', 'B', 'C'][seatId]}`);
    await refresh();
  } catch (error) { showMessage(errorText(error.message), true); }
}

async function loadReplay() {
  try {
    const response = await fetch(`/api/replays/${encodeURIComponent(replayGameId)}`, { headers: replayAccessHeaders(replayGameId) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'replay_failed');
    if (!Array.isArray(data.frames) || !data.frames.length) throw new Error('empty_replay');
    replay = data;
    gameId = data.gameId;
    strategyParticipants = data.participants || {};
    strategySnapshotGameId = data.gameId;
    $('replay-controls').hidden = false;
    $('new-game').hidden = false;
    $('new-game').textContent = '退出回放';
    const finalState = data.frames.at(-1)?.state;
    replayCanRematch = finalState?.phase === 'over' && ['landlord', 'farmers'].includes(finalState.winner);
    showReplayFrame(0);
  } catch (error) { setConnectionError(error); }
}

function showReplayFrame(index) {
  if (!replay?.frames.length) return;
  replayIndex = Math.max(0, Math.min(Number(index) || 0, replay.frames.length - 1));
  const frame = replay.frames[replayIndex];
  state = frame.state;
  selected.clear();
  stopReplay();
  render();
  $('replay-progress').max = String(replay.frames.length - 1);
  $('replay-progress').value = String(replayIndex);
  $('replay-position').textContent = `${replayIndex + 1} / ${replay.frames.length}`;
  $('replay-event').textContent = replayEventLabel(frame, replay.frames[replayIndex - 1]);
  $('replay-prev').disabled = replayIndex === 0;
  $('replay-next').disabled = replayIndex === replay.frames.length - 1;
}

function stepReplay(offset) { showReplayFrame(replayIndex + offset); }

function toggleReplay() {
  if (replayTimer) return stopReplay();
  if (replayIndex >= replay.frames.length - 1) showReplayFrame(0);
  $('replay-toggle').textContent = '暂停';
  replayTimer = setInterval(() => {
    if (replayIndex >= replay.frames.length - 1) return stopReplay();
    replayIndex += 1;
    const frame = replay.frames[replayIndex];
    state = frame.state;
    selected.clear();
    render();
    $('replay-progress').value = String(replayIndex);
    $('replay-position').textContent = `${replayIndex + 1} / ${replay.frames.length}`;
    $('replay-event').textContent = replayEventLabel(frame, replay.frames[replayIndex - 1]);
    $('replay-prev').disabled = false;
    $('replay-next').disabled = replayIndex === replay.frames.length - 1;
  }, 900);
}

function stopReplay() {
  if (replayTimer) clearInterval(replayTimer);
  replayTimer = null;
  if ($('replay-toggle')) $('replay-toggle').textContent = '播放';
}

function replayEventLabel(frame, previousFrame) {
  const event = frame.event || {};
  if (event.type === 'created') return '对局创建';
  if (event.type === 'started') return '对局开始';
  if (event.type !== 'action') return event.type || '状态更新';
  const labels = ['A', 'B', 'C'];
  const source = { agent:'Agent', bot:'Bot', player:'玩家', timeout:'超时', managed:'托管' }[event.source] || event.source || '玩家';
  const action = event.action || {};
  let actionLabel = action.type;
  if (action.type === 'bid') {
    const stage = previousFrame?.state?.bidStage;
    actionLabel = action.value ? (stage === 'rob' ? '抢地主' : '叫地主') : (stage === 'rob' ? '不抢' : '不叫');
  } else if (action.type === 'pass') actionLabel = '不要';
  else if (action.type === 'play') actionLabel = `出 ${action.cards?.length || 0} 张`;
  return `${source} ${labels[event.seatId] ?? event.seatId} · ${actionLabel}`;
}

async function refresh() {
  if (replayMode || !gameId || refreshing) return;
  refreshing = true;
  try {
    await ensurePlayerJoined();
    const stateUrl = new URL(`/api/games/${gameId}/state`, location.origin); stateUrl.searchParams.set('seat', seat); if (view === 'global') stateUrl.searchParams.set('view', 'global');
    const response = await fetch(stateUrl, { headers: seatSessionHeaders(competitionId || gameId, seat) });
    const data = await response.json();
    if (!response.ok) { if (data.error === 'game_not_found') return create(1, { confirmed: false, owner: true }); throw new Error(data.error || 'state_failed'); }
    if (data.competition?.competitionId) competitionId = data.competition.competitionId;
    if (data.competition?.currentGameId && data.competition.currentGameId !== gameId) {
      const replayToken = storedReplayAccess(gameId);
      const ownerToken = storedRoomOwnerToken(gameId);
      gameId = data.competition.currentGameId;
      rememberReplayAccess(replayToken, gameId);
      rememberRoomOwner(ownerToken, gameId);
      controlActive = controlActive || activeInvite?.inviteType === 'player'; playerJoinAttempt = controlActive ? gameId : null; strategyParticipants = {}; strategySnapshotGameId = null; selected.clear(); syncUrl(); refreshing = false; return refresh();
    }
    state = data;
    if (controlActive && data.controlAuthorized === false) {
      controlActive = false;
      controlRequested = false;
      playerJoinAttempt = null;
      showMessage('当前设备的座位控制权已失效，可使用重连码恢复', true);
    }
    restoreLocalPlayerControl(data);
    serverClockOffsetMs = Number(data.serverNow || Date.now()) - Date.now(); syncUrl();
    if (!$('strategy-panel').hidden && view === 'global') await loadStrategyDetails(state.phase === 'waiting');
    render();
  } catch (error) { setConnectionError(error); }
  finally { refreshing = false; }
}

function setConnectionError(error) { showMessage(`无法连接服务：${error.message}`, true); }

function playerPosition(id) { return id === seat ? 'self' : id === (seat + 2) % 3 ? 'left' : 'right'; }

function renderCountdown() {
  ['left', 'right', 'self'].forEach((position) => {
    const timer = $(`${position}-countdown`);
    timer.hidden = true;
    timer.textContent = '';
    timer.classList.remove('urgent');
    $(`${position}-seat`).classList.remove('current-turn');
  });
  const visible = !replayMode && Boolean(state) && state.phase !== 'waiting' && state.winner === null && Boolean(state.turnDeadlineAt);
  if (!visible) return;
  const remainingMs = Math.max(0, state.turnDeadlineAt - (Date.now() + serverClockOffsetMs));
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const position = playerPosition(state.current);
  const element = $(`${position}-countdown`);
  const remaining = `${minutes}:${seconds}`;
  element.hidden = false;
  element.textContent = `剩余 ${remaining}`;
  element.setAttribute('aria-label', `玩家 ${['A', 'B', 'C'][state.current]} 剩余时间 ${remaining}`);
  element.classList.toggle('urgent', totalSeconds <= 10);
  $(`${position}-seat`).classList.add('current-turn');
}

function render() {
  const labels = ['A', 'B', 'C'];
  const roles = (id) => state.phase === 'waiting' ? '等待' : state.phase === 'bid' ? '竞叫' : state.landlord === id ? '地主' : '农民';
  const controllers = (id) => controllerLabel(id);
  const left = (seat + 2) % 3;
  const right = (seat + 1) % 3;
  const bidLabel = state.bidStage === 'rob' ? '抢地主' : '叫地主';
  $('invite-game').hidden = replayMode || !gameId || !setupConfirmed || !isRoomOwner();
  $('agent-connect').hidden = replayMode || !setupConfirmed || !isRoomOwner();
  const activeSession = controlActive ? storedSeatSession(competitionId || gameId, controlledSeat) : null;
  $('session-code-header').hidden = !activeSession?.reconnectCode || replayMode;
  $('session-code-header').textContent = activeSession?.reconnectCode ? `重连码 ${activeSession.reconnectCode}` : '重连码';
  renderCountdown();
  renderCompetition();
  setPlayer('left', left, labels, roles, controllers);
  setPlayer('right', right, labels, roles, controllers);
  renderAvatar($('self-avatar'), seat, labels[seat]); $('self-name').textContent = `${roles(seat)} ${labels[seat]} · ${controllers(seat)}`; $('self-name').title = state.seatControllers?.[seat]?.id || ''; $('self-count').textContent = state.phase === 'waiting' ? readyLabel(seat) : `${state.hands[seat].count} 张`;
  renderSelfHand(state.hands[seat].cards);
  renderBottomCards(state.bottom);
  renderTablePlays();
  renderLifecycle();
  renderInviteMenu();
  renderStrategies();
  renderDecisions();
  renderReviews();
  $('rematch-game').hidden = replayMode ? !replayCanRematch : state.phase !== 'over' || !['landlord', 'farmers'].includes(state.winner);
  document.querySelectorAll('.perspectives button').forEach((button) => button.classList.toggle('active', Number(button.dataset.seat) === seat));
  $('global-view').classList.toggle('active', view === 'global'); $('global-view').setAttribute('aria-pressed', String(view === 'global'));
  $('bid').textContent = bidLabel;
  $('decline').textContent = state.bidStage === 'rob' ? '不抢' : '不叫';
  const myTurn = !replayMode && controlActive && seat === controlledSeat && state.current === controlledSeat && state.winner === null;
  toggle('bid', myTurn && state.phase === 'bid'); toggle('decline', myTurn && state.phase === 'bid'); toggle('pass', myTurn && state.phase === 'play' && Boolean(state.lastPlay)); toggle('play', myTurn && state.phase === 'play');
}

function renderCompetition() {
  const roundElement = $('competition-info');
  const scoreElement = $('score-info');
  const competition = state?.competition;
  if (!competition) {
    if (roundElement) roundElement.hidden = true;
    if (scoreElement) scoreElement.hidden = true;
    return;
  }
  const scores = (competition.scores || []).map((score, seatId) => `${['A', 'B', 'C'][seatId]} ${score >= 0 ? '+' : ''}${score}`).join(' · ');
  roundElement.hidden = false;
  roundElement.textContent = `第 ${competition.currentRound}/${competition.totalRounds} 局`;
  scoreElement.hidden = false;
  scoreElement.textContent = scores;
}

function renderDecisions() {
  const available = replayMode || view === 'global';
  const button = $('decision-record');
  button.hidden = !available;
  if (!available) setDecisionPanel(false);
  const decisions = state.decisions || [];
  button.textContent = decisions.length ? `决策记录 ${decisions.length}` : '决策记录';
  const list = $('decision-list');
  list.innerHTML = '';
  if (!decisions.length) {
    const empty = document.createElement('p');
    empty.className = 'decision-empty';
    empty.textContent = 'Agent 尚未提交决策摘要';
    list.appendChild(empty);
    return;
  }
  [...decisions].reverse().forEach((decision) => list.appendChild(createDecisionItem(decision)));
}

function renderStrategies() {
  const replayStrategies = Object.values(replay?.participants || {}).some((participant) => participant?.strategy);
  const liveStrategies = Object.keys(state?.strategyAssignments || {}).length > 0;
  const available = (replayMode && replayStrategies) || (view === 'global' && liveStrategies);
  const button = $('strategy-record');
  button.hidden = !available;
  if (!available) setStrategyPanel(false);
  if (!$('strategy-panel').hidden) renderStrategyDocument();
}

function controllerForSeat(seatId) {
  return strategyParticipants?.[seatId] || state.seatControllers?.[seatId] || replay?.participants?.[seatId] || null;
}

function strategyForSeat(seatId) {
  return strategyParticipants?.[seatId]?.strategy || state.strategyAssignments?.[seatId] || replay?.participants?.[seatId]?.strategy || null;
}

async function loadStrategyDetails(force = false) {
  if (replayMode) {
    strategyParticipants = replay?.participants || {};
    strategySnapshotGameId = gameId;
    return;
  }
  if (!gameId || strategyLoading || (!force && strategySnapshotGameId === gameId)) return;
  strategyLoading = true;
  renderStrategyDocument();
  try {
    const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/strategies?view=global`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'strategy_load_failed');
    strategyParticipants = data.participants || {};
    strategySnapshotGameId = data.gameId;
  } catch (error) {
    showMessage(`策略加载失败：${errorText(error.message)}`, true);
  } finally {
    strategyLoading = false;
  }
}

async function setStrategyPanel(open) {
  if (open) {
    $('decision-panel').hidden = true;
    $('review-panel').hidden = true;
    $('history-panel').hidden = true;
    $('agent-panel').hidden = true;
    strategySeat = seat;
  }
  $('strategy-panel').hidden = !open;
  updateSidePanelLayout();
  $('strategy-record').classList.toggle('active', open);
  $('strategy-record').setAttribute('aria-expanded', String(open));
  if (!open) return;
  renderStrategyDocument();
  await loadStrategyDetails(true);
  renderStrategyDocument();
}

function renderStrategyDocument() {
  const content = $('strategy-content');
  document.querySelectorAll('[data-strategy-seat]').forEach((button) => {
    const active = Number(button.dataset.strategySeat) === strategySeat;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  content.innerHTML = '';
  if (strategyLoading) {
    const loading = document.createElement('p');
    loading.className = 'decision-empty';
    loading.textContent = '正在加载本局策略…';
    content.appendChild(loading);
    return;
  }
  const participant = controllerForSeat(strategySeat);
  const strategy = strategyForSeat(strategySeat);
  const label = ['A', 'B', 'C'][strategySeat];
  const heading = document.createElement('h2');
  heading.className = 'strategy-heading';
  heading.textContent = `${label} · ${participant?.displayName || participant?.id || (participant?.type === 'player' ? '玩家' : participant?.type === 'agent' ? 'Agent' : '未接入')}`;
  heading.title = participant?.id || '';
  content.appendChild(heading);
  const context = document.createElement('span');
  context.className = 'strategy-context';
  context.textContent = strategyRoleLabel(strategySeat);
  content.appendChild(context);
  const agentDetails = formatAgentMetadata(participant?.agentMetadata);
  if (agentDetails) {
    const agentMetadata = document.createElement('small');
    agentMetadata.className = 'strategy-metadata';
    agentMetadata.textContent = `Agent 声明 · ${agentDetails}`;
    content.appendChild(agentMetadata);
  }
  if (!strategy) {
    const empty = document.createElement('p');
    empty.className = 'decision-empty';
    empty.textContent = participant?.type === 'player' ? '人工玩家未绑定 Agent 策略' : participant?.type === 'agent' ? '本地 Agent 未向服务端公开策略' : '该席位尚未接入';
    content.appendChild(empty);
    return;
  }
  const metadata = document.createElement('small');
  metadata.className = 'strategy-metadata';
  metadata.textContent = `${strategy.name} · ${strategy.id}${strategy.updatedAt ? ` · ${new Date(strategy.updatedAt).toLocaleString('zh-CN')}` : ''}${strategy.hash ? ` · ${strategy.hash.slice(0, 8)}` : ''}`;
  content.appendChild(metadata);
  if (!strategy.markdown) {
    const unavailable = document.createElement('p');
    unavailable.className = 'decision-empty';
    unavailable.textContent = '完整策略正文未加载';
    content.appendChild(unavailable);
    return;
  }
  renderStrategyMarkdown(content, strategy.markdown);
}

function strategyRoleLabel(seatId) {
  if (!Number.isInteger(state?.landlord) || !['play', 'over'].includes(state.phase)) return '当前身份：待定';
  if (seatId === state.landlord) return '当前身份：地主';
  return seatId === (state.landlord + 2) % 3 ? '当前身份：地主上家' : '当前身份：地主下家';
}

function renderStrategyMarkdown(container, markdown) {
  const documentElement = document.createElement('section');
  documentElement.className = 'strategy-document';
  const lines = strategyBody(markdown).split('\n');
  let list = null;
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) { list = null; return; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      list = null;
      const level = heading[1].length === 1 ? 'h2' : heading[1].length === 2 ? 'h3' : 'h4';
      const element = document.createElement(level);
      element.textContent = heading[2];
      documentElement.appendChild(element);
      return;
    }
    if (line.startsWith('- ')) {
      if (!list) { list = document.createElement('ul'); documentElement.appendChild(list); }
      const item = document.createElement('li');
      item.textContent = line.slice(2);
      list.appendChild(item);
      return;
    }
    list = null;
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    documentElement.appendChild(paragraph);
  });
  container.appendChild(documentElement);
}

function strategyBody(markdown) {
  const value = String(markdown || '').replace(/\r/g, '');
  if (!value.startsWith('---\n')) return value.trim();
  const end = value.indexOf('\n---\n', 4);
  return end === -1 ? value.trim() : value.slice(end + 5).trim();
}

function setDecisionPanel(open) {
  if (open) { $('strategy-panel').hidden = true; $('review-panel').hidden = true; $('history-panel').hidden = true; $('agent-panel').hidden = true; }
  $('decision-panel').hidden = !open;
  updateSidePanelLayout();
  $('decision-record').classList.toggle('active', open);
  $('decision-record').setAttribute('aria-expanded', String(open));
}

function renderReviews() {
  const available = (replayMode || view === 'global') && (state.phase === 'over' || state.competition?.status === 'reviewing_competition' || state.competition?.status === 'over');
  const button = $('review-record');
  button.hidden = !available;
  if (!available) setReviewPanel(false);
  const reviews = Object.values(state.reviews || {});
  const expected = state.reviewStatus?.expectedSeats?.length || 0;
  button.textContent = expected ? `复盘总结 ${reviews.length}/${expected}` : '复盘总结';
  const list = $('review-list');
  list.innerHTML = '';
  if (state.competition?.status === 'over' && state.competition?.reviews) {
    Object.values(state.competition.reviews).forEach((review) => list.appendChild(createCompetitionReviewItem(review)));
  }
  if (!reviews.length && !(state.competition?.status === 'over' && Object.keys(state.competition?.reviews || {}).length)) {
    const empty = document.createElement('p');
    empty.className = 'decision-empty';
    empty.textContent = '等待 Agent 提交赛后复盘';
    list.appendChild(empty);
    return;
  }
  reviews.sort((a, b) => a.seatId - b.seatId).forEach((review) => list.appendChild(createReviewItem(review)));
}

function createCompetitionReviewItem(review) {
  const labels = ['A', 'B', 'C'];
  const item = document.createElement('article');
  item.className = 'decision-item review-item';
  const heading = document.createElement('strong');
  heading.textContent = `${labels[review.seatId] || review.seatId} · 比赛总结`;
  const assessment = document.createElement('p');
  assessment.textContent = review.assessment;
  item.append(heading, assessment);
  appendReviewList(item, '重复问题', review.recurringProblems);
  appendReviewList(item, '验证改进', review.validatedImprovements);
  appendReviewList(item, '最终策略建议', review.finalStrategySuggestions);
  return item;
}

function setReviewPanel(open) {
  if (open) { $('strategy-panel').hidden = true; $('decision-panel').hidden = true; $('history-panel').hidden = true; $('agent-panel').hidden = true; }
  $('review-panel').hidden = !open;
  updateSidePanelLayout();
  $('review-record').classList.toggle('active', open);
  $('review-record').setAttribute('aria-expanded', String(open));
}

function updateSidePanelLayout() {
  const open = !$('strategy-panel').hidden || !$('decision-panel').hidden || !$('review-panel').hidden || !$('history-panel').hidden || !$('agent-panel').hidden;
  $('game-table').classList.toggle('decisions-open', open);
  $('strategy-record').classList.toggle('active', !$('strategy-panel').hidden);
  $('decision-record').classList.toggle('active', !$('decision-panel').hidden);
  $('review-record').classList.toggle('active', !$('review-panel').hidden);
  $('game-record').classList.toggle('active', !$('history-panel').hidden);
  $('agent-connect').classList.toggle('active', !$('agent-panel').hidden || !$('agent-type-menu').hidden);
  $('strategy-record').setAttribute('aria-expanded', String(!$('strategy-panel').hidden));
  $('decision-record').setAttribute('aria-expanded', String(!$('decision-panel').hidden));
  $('review-record').setAttribute('aria-expanded', String(!$('review-panel').hidden));
}

async function setHistoryPanel(open) {
  if (open) {
    $('strategy-panel').hidden = true;
    $('decision-panel').hidden = true;
    $('review-panel').hidden = true;
    $('agent-panel').hidden = true;
  }
  $('history-panel').hidden = !open;
  updateSidePanelLayout();
  if (open) await loadHistory();
}

async function loadHistory() {
  const list = $('history-list');
  list.innerHTML = '<p class="decision-empty">正在加载历史对局…</p>';
  try {
    const response = await fetch('/api/replays?limit=50&status=completed', { headers: replayAccessHeaders() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'history_failed');
    $('game-record').textContent = data.total ? `对局记录 ${data.total}` : '对局记录';
    list.innerHTML = '';
    if (!data.items?.length) {
      list.innerHTML = '<p class="decision-empty">暂无已完成的历史对局</p>';
      return;
    }
    data.items.forEach((record) => list.appendChild(createHistoryItem(record)));
  } catch (error) {
    list.innerHTML = '<p class="decision-empty">历史对局加载失败</p>';
    showMessage(errorText(error.message), true);
  }
}

function createHistoryItem(record) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'history-item';
  const labels = ['A', 'B', 'C'];
  const participants = labels.map((label, seatId) => {
    const participant = record.participants?.[seatId];
    if (!participant) return `${label} 空位`;
    if (participant.type === 'agent') {
      const agentDetails = formatAgentMetadata(participant.agentMetadata);
      return `${label} ${participant.displayName || participant.id || 'Agent'} · ${agentDetails || participant.strategy?.name || '默认策略'}`;
    }
    return `${label} ${participant.displayName || participant.id || '玩家'} · 人工玩家`;
  });
  const status = record.phase === 'over'
    ? record.winner === 'landlord' ? '地主获胜' : record.winner === 'farmers' ? '农民获胜' : '对局中断'
    : record.phase === 'waiting' ? '等待开始' : '进行中';
  const competition = record.competition ? ` · 第 ${record.competition.roundNumber}/${record.competition.totalRounds} 局` : '';
  const multiplier = record.settlement?.multiplier > 1 ? ` · ×${record.settlement.multiplier}` : '';
  const heading = document.createElement('strong');
  if (record.gameId === gameId) {
    const current = document.createElement('span');
    current.className = 'current-record';
    current.textContent = '当前';
    heading.appendChild(current);
  }
  heading.append(`${status}${competition}${multiplier}`);
  const metadata = document.createElement('span');
  metadata.textContent = `${formatRecordTime(record.createdAt)} · ${record.frameCount} 帧${record.sourceGameId ? ' · 同牌复战' : ''}`;
  if (record.sourceGameId) metadata.title = `来源对局 ${record.sourceGameId}`;
  const participantList = document.createElement('small');
  participants.forEach((participant) => {
    const line = document.createElement('span');
    line.className = 'history-participant';
    line.textContent = participant;
    participantList.appendChild(line);
  });
  item.append(heading, metadata, participantList);
  item.onclick = () => openReplay(record.gameId);
  return item;
}

function formatRecordTime(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(new Date(timestamp));
}

function createReviewItem(review) {
  const labels = ['A', 'B', 'C'];
  const item = document.createElement('article');
  item.className = 'decision-item review-item';
  const heading = document.createElement('strong');
  heading.textContent = `${labels[review.seatId] || review.seatId} · ${review.strategy?.name || '默认策略'}`;
  const assessment = document.createElement('p');
  assessment.textContent = review.assessment;
  item.append(heading, assessment);
  appendReviewList(item, '发现问题', review.problems);
  appendReviewList(item, '改进动作', review.improvements);
  appendReviewList(item, '策略修改建议', review.strategySuggestions);
  return item;
}

function appendReviewList(container, title, values = []) {
  const heading = document.createElement('small');
  heading.className = 'review-heading';
  heading.textContent = title;
  const list = document.createElement('ul');
  values.forEach((value) => { const item = document.createElement('li'); item.textContent = value; list.appendChild(item); });
  container.append(heading, list);
}

function createDecisionItem(decision) {
  const labels = ['A', 'B', 'C'];
  const item = document.createElement('article');
  item.className = 'decision-item';
  const heading = document.createElement('strong');
  const duration = decision.durationMs === null || decision.durationMs === undefined ? '' : ` · ${(decision.durationMs / 1000).toFixed(1)} 秒`;
  heading.textContent = `${labels[decision.seatId] || decision.seatId} · ${decision.source === 'agent' ? 'Agent' : '玩家'}${duration}`;
  const summary = document.createElement('p');
  summary.textContent = decision.summary;
  item.append(heading, summary);
  const details = [];
  if (decision.intent) details.push(`意图：${decision.intent}`);
  if (decision.confidence !== undefined) details.push(`置信度：${Math.round(decision.confidence * 100)}%`);
  if (decision.gameId && decision.gameId !== state.gameId) details.push(`记录异常：${decision.gameId}`);
  if (details.length) {
    const meta = document.createElement('small');
    meta.textContent = details.join(' · ');
    item.appendChild(meta);
  }
  return item;
}

function renderLifecycle() {
  const container = $('game-lifecycle');
  const button = $('start-game');
  const confirmButton = $('confirm-setup');
  const setup = $('match-setup');
  const playerJoin = $('player-join');
  const reconnectTools = $('reconnect-tools');
  const sessionInfo = $('session-info');
  const ownerControls = $('owner-seat-controls');
  reconnectTools.hidden = true;
  sessionInfo.hidden = true;
  ownerControls.hidden = true;
  ownerControls.replaceChildren();
  if (replayMode || !['waiting', 'over'].includes(state.phase)) { container.hidden = true; return; }
  container.hidden = false;
  if (state.phase === 'waiting') {
    const rematch = Boolean(state.sourceGameId);
    const participantCount = Object.keys(state.seatControllers || {}).length;
    if (!setupConfirmed && (participantCount > 0 || rematch || state.competition)) {
      setupConfirmed = true;
      syncUrl();
    }
    if (state.competition?.totalRounds) selectedRounds = state.competition.totalRounds;
    if (setupConfirmed) selectedAccessMode = state.accessMode || selectedAccessMode;
    document.querySelectorAll('[data-rounds]').forEach((roundButton) => {
      const rounds = Number(roundButton.dataset.rounds);
      roundButton.classList.toggle('active', rounds === selectedRounds);
      roundButton.disabled = setupConfirmed;
    });
    document.querySelectorAll('[data-access-mode]').forEach((accessButton) => {
      const mode = accessButton.dataset.accessMode;
      accessButton.classList.toggle('active', mode === selectedAccessMode);
      accessButton.disabled = setupConfirmed;
    });
    if (!setupConfirmed) {
      setup.hidden = false;
      playerJoin.hidden = true;
      reconnectTools.hidden = true;
      confirmButton.hidden = false;
      confirmButton.textContent = `确认 ${selectedRounds} 局 · ${accessModeLabel(selectedAccessMode)}`;
      button.hidden = true;
      $('game-status').textContent = '选择比赛局数';
      $('ready-status').textContent = '确认后可添加玩家或 Agent';
      return;
    }
    setup.hidden = true;
    confirmButton.hidden = true;
    const readyCount = state.readySeats?.length || 0;
    const selfReady = state.readySeats?.includes(controlledSeat);
    const canDirectJoin = !controlActive && (state.accessMode === 'open' || isRoomOwner() || activeInvite?.inviteType === 'player');
    const emptySeats = [0, 1, 2].filter((seatId) => !state.seatControllers?.[seatId]);
    playerJoin.hidden = !canDirectJoin || emptySeats.length === 0;
    reconnectTools.hidden = controlActive || !Object.values(state.seatControllers || {}).some((controller) => controller.type === 'player');
    const localSession = controlActive ? storedSeatSession(competitionId || gameId, controlledSeat) : null;
    sessionInfo.hidden = !localSession?.reconnectCode;
    $('session-reconnect-code').textContent = localSession?.reconnectCode || '';
    const removableSeats = isRoomOwner() ? [0, 1, 2].filter((seatId) => state.seatControllers?.[seatId]?.type === 'player' && state.seatPresence?.[seatId]?.status === 'offline') : [];
    ownerControls.hidden = removableSeats.length === 0;
    removableSeats.forEach((seatId) => {
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.textContent = `移除掉线玩家 ${['A', 'B', 'C'][seatId]}`;
      removeButton.onclick = () => removeOfflinePlayer(seatId);
      ownerControls.appendChild(removeButton);
    });
    $('join-game').disabled = emptySeats.length === 0;
    $('join-game').textContent = emptySeats.length === 0 ? '房间已满' : '加入对局';
    $('game-status').textContent = !controlActive
      ? canDirectJoin ? '加入对局' : '请通过邀请链接加入'
      : rematch ? selfReady ? '同牌复战，等待其他玩家' : '同牌复战，等待玩家准备'
        : selfReady ? '等待其他玩家' : '等待玩家准备';
    $('ready-status').textContent = `${rematch ? `来源 ${state.sourceGameId} · ` : ''}${readyCount} / 3 已就绪${accessModeLabel(state.accessMode) ? ` · ${accessModeLabel(state.accessMode)}` : ''}`;
    button.textContent = '开始对局';
    button.hidden = !controlActive || selfReady;
    button.disabled = false;
    return;
  }
  playerJoin.hidden = true;
  reconnectTools.hidden = true;
  sessionInfo.hidden = true;
  ownerControls.hidden = true;
  confirmButton.hidden = true;
  setup.hidden = true;
  const competitionStatus = state.competition?.status;
  if (competitionStatus === 'reviewing_round' || competitionStatus === 'reviewing_competition') {
    button.hidden = true;
    $('game-status').textContent = competitionStatus === 'reviewing_round' ? '本局已结束' : '比赛已完成';
    $('ready-status').textContent = competitionStatus === 'reviewing_round' ? '等待三席提交本局复盘' : '等待三席提交比赛总结';
    return;
  }
  button.hidden = false;
  $('game-status').textContent = state.competition ? '比赛结束' : state.winner === 'landlord' ? '地主获胜' : state.winner === 'farmers' ? '农民获胜' : '对局中断';
  const settlementText = formatSettlement(state.settlement);
  $('ready-status').textContent = state.competition
    ? `总比分 ${(state.competition.scores || []).map((score, id) => `${['A', 'B', 'C'][id]} ${score >= 0 ? '+' : ''}${score}`).join(' · ')}${settlementText ? ` · ${settlementText}` : ''}`
    : settlementText || '本局已结束，可查看记录或开始新局';
  button.textContent = state.competition ? '新比赛' : '新一局';
  button.disabled = false;
}

function formatSettlement(settlement) {
  if (!settlement || !Number.isFinite(Number(settlement.multiplier))) return '';
  const labels = { bomb: '炸弹', rocket: '火箭', spring: '春天', 'anti-spring': '反春' };
  const reasons = [...new Set((settlement.multiplierReasons || []).map((reason) => labels[reason] || reason))];
  return `本局 ×${settlement.multiplier}${reasons.length ? `（${reasons.join('、')}）` : ''}`;
}

function controllerLabel(id) {
  const controller = state.seatControllers?.[id];
  const presence = state.seatPresence?.[id]?.status;
  const suffix = presence === 'managed' ? '（托管中）' : presence === 'offline' ? '（已掉线）' : '';
  if (controller?.displayName) return `${controller.displayName}${suffix}`;
  if (controller?.type === 'agent') return controller.id || 'Agent';
  if (controller?.type === 'player') return '玩家';
  if (state.phase === 'waiting') return '待接入';
  if (replayMode) return 'Bot';
  return controlActive && id === controlledSeat ? '玩家' : '未接入';
}
function formatAgentMetadata(metadata) {
  if (!metadata) return '';
  return [metadata.modelId, metadata.reasoningEffort ? `推理 ${metadata.reasoningEffort}` : '', metadata.strategyId ? `策略 ${metadata.strategyId}` : '', metadata.clientVersion ? `客户端 ${metadata.clientVersion}` : ''].filter(Boolean).join(' · ');
}
function accessModeLabel(mode) { return ({ open:'公开房间', invite_only:'私人房间', private:'私人房间' })[mode] || ''; }
function setPlayer(position, id, labels, roles, controllers) { renderAvatar($(`${position}-avatar`), id, labels[id]); $(`${position}-name`).textContent = `${roles(id)} ${labels[id]} · ${controllers(id)}`; $(`${position}-name`).title = [state.seatControllers?.[id]?.id, formatAgentMetadata(state.seatControllers?.[id]?.agentMetadata)].filter(Boolean).join(' · '); $(`${position}-count`).textContent = state.phase === 'waiting' ? readyLabel(id) : `${state.hands[id].count} 张`; renderOpponentHand(position, id); }
function renderAvatar(element, id, label) {
  const role = ['play', 'over'].includes(state.phase) ? (state.landlord === id ? 'landlord' : 'farmer') : 'neutral';
  const roleLabel = role === 'landlord' ? '地主' : role === 'farmer' ? '农民' : '身份待定';
  element.textContent = label;
  element.className = `avatar role-${role}`;
  element.dataset.role = role;
  element.setAttribute('aria-label', `${label}，${roleLabel}`);
}
function readyLabel(id) { return state.readySeats?.includes(id) ? '已就绪' : state.seatControllers?.[id] ? '等待开始' : '等待加入'; }
function toggle(id, visible) { $(id).hidden = !visible; }

function renderOpponentHand(position, id) {
  const container = $(`${position}-cards`);
  const hand = state.hands[id];
  const cards = hand.cards || [];
  container.innerHTML = '';
  if (view === 'global' && cards.length) {
    container.className = `opponent-cards opponent-face ${position}`;
    container.appendChild(createStaticCardGroup(cards, 'opponent-playing-cards'));
    return;
  }
  container.className = `opponent-cards opponent-back-stack ${position}`;
  if (hand.count > 0) container.appendChild(createCardBackGroup(hand.count));
}
function renderSelfHand(cards) { renderHand(cards); }

function renderBottomCards(cards) {
  const container = $('bottom-cards'); container.innerHTML = '';
  if (!cards.length) return;
  container.appendChild(createStaticCardGroup(cards, 'bottom-playing-cards'));
}

function createStaticCardGroup(cards, className = '') { const wrapper = document.createElement('div'); wrapper.className = `playingCards ${className}`.trim(); const list = document.createElement('ul'); list.className = 'hand'; cards.forEach((card) => { const item = document.createElement('li'); const element = document.createElement('span'); const face = cardFace(card); element.className = `card ${face.className}`; element.innerHTML = `<span class="rank">${face.rank}</span><span class="suit">${face.suit}</span>`; item.appendChild(element); list.appendChild(item); }); wrapper.appendChild(list); return wrapper; }

function createCardBackGroup(count) {
  const wrapper = document.createElement('div'); wrapper.className = 'playingCards opponent-card-backs'; wrapper.setAttribute('aria-label', `${count} 张未公开手牌`);
  const list = document.createElement('ul'); list.className = 'hand';
  for (let index = 0; index < count; index++) {
    const item = document.createElement('li');
    const card = document.createElement('span'); card.className = 'card card-back'; card.setAttribute('aria-hidden', 'true');
    item.appendChild(card); list.appendChild(item);
  }
  wrapper.appendChild(list); return wrapper;
}

function renderHand(cards) {
  const hand = $('my-hand'); hand.innerHTML = '';
  const wrapper = document.createElement('div'); wrapper.className = 'playingCards loose';
  const list = document.createElement('ul'); list.className = 'hand';
  cards.forEach((card) => { const item = document.createElement('li'); const element = document.createElement('button'); const face = cardFace(card); const id = cardId(card); element.type = 'button'; element.className = `card ${face.className} ${selected.has(id) ? 'selected' : ''}`; element.innerHTML = `<span class="rank">${face.rank}</span><span class="suit">${face.suit}</span>`; element.title = face.label; element.disabled = replayMode; element.onclick = () => { selected.has(id) ? selected.delete(id) : selected.add(id); renderHand(cards); }; item.appendChild(element); list.appendChild(item); });
  wrapper.appendChild(list); hand.appendChild(wrapper);
}

function renderTablePlays() {
  ['left-play','right-play','self-play'].forEach((id) => { $(id).innerHTML = ''; });
  const showBidProcess = state.phase === 'bid' && ['call', 'rob'].includes(state.bidStage);
  if (showBidProcess && state.bidHistory?.length) {
    const bidsBySeat = new Map();
    (state.bidHistory || []).forEach((entry) => bidsBySeat.set(entry.seatId, entry));
    bidsBySeat.forEach((entry, seatId) => {
      const slot = `${playerPosition(seatId)}-play`;
      const hint = document.createElement('span');
      hint.className = `bid-hint ${entry.value ? 'accepted' : 'declined'}`;
      hint.textContent = entry.stage === 'rob' ? entry.value ? '抢地主' : '不抢' : entry.value ? '叫地主' : '不叫';
      $(slot).appendChild(hint);
    });
    return;
  }
  const displayedPlaySeat = Number.isInteger(state.lastPlay?.seatId)
    ? state.lastPlay.seatId
    : state.tablePlays?.findIndex((cards) => cards?.length);
  [0, 1, 2].forEach((seatId) => {
    const slot = `${playerPosition(seatId)}-play`;
    if (state.tablePasses?.[seatId]) {
      const hint = document.createElement('span'); hint.className = 'pass-hint'; hint.textContent = '不要'; $(slot).appendChild(hint);
      return;
    }
    const cards = seatId === displayedPlaySeat ? state.tablePlays?.[seatId] : null;
    if (cards?.length) $(slot).appendChild(createStaticCardGroup(cards, 'compact'));
  });
}

function cardId(card) { return typeof card === 'string' ? card : card?.id; }
function cardFace(card) { const [rank, suit] = cardId(card).split(':').map(Number); if (rank === 16) return { className:'joker', rank:'小', suit:'王', label:card?.label || '小王' }; if (rank === 17) return { className:'joker', rank:'大', suit:'王', label:card?.label || '大王' }; const rankText = typeof card === 'object' && card.rank ? card.rank : ({11:'J',12:'Q',13:'K',14:'A',15:'2'}[rank] || String(rank)); const suits = [{name:'spades',symbol:'♠'},{name:'hearts',symbol:'♥'},{name:'clubs',symbol:'♣'},{name:'diams',symbol:'♦'}]; const face = suits[suit] || suits[0]; return { className:`rank-${String(rankText).toLowerCase()} ${face.name}`, rank:rankText, suit:face.symbol, label:card?.label || `${rankText}${face.symbol}` }; }

async function action(payload) {
  if (!controlActive || seat !== controlledSeat) return showMessage('当前仅为观察视角，请切回已加入的玩家座位', true);
  if (!gameId || !state || state.current !== controlledSeat) return showMessage('还没有轮到当前玩家', true);
  try { const { response, data } = await post(`/api/games/${gameId}/actions`, { seatId: controlledSeat, action: payload }, seatSessionHeaders()); if (!response.ok) return showMessage(errorText(data.error), true); selected.clear(); await refresh(); }
  catch (error) { setConnectionError(error); }
}

function errorText(error) { return ({ invalid_action:'动作格式错误', illegal_play:'这组牌不能出', cannot_pass_first:'你需要先出牌', cards_not_in_hand:'手牌状态已变化', not_your_turn:'还没轮到你', invalid_bid:'叫地主动作无效', game_not_started:'对局还未开始', players_not_ready:'请等待三家全部准备就绪', game_already_started:'对局已经开始', seat_occupied:'座位已被占用', room_full:'房间已满', seat_not_joined:'请先加入一个座位', player_not_joined:'该座位不是玩家座位', player_still_online:'玩家仍在线，不能移除', seat_session_required:'座位凭证无效，请使用重连码恢复', invalid_reconnect_code:'重连码无效或座位已释放', room_owner_required:'只有房主可以执行该操作', invite_required:'该对局仅允许通过邀请加入', invite_used:'邀请已被其他玩家使用', invite_expired:'邀请已过期', replay_access_denied:'无权查看该私人对局记录', access_denied:'当前身份无权加入该私有对局', invalid_access_mode:'接入模式无效', invalid_agent_metadata:'Agent 信息格式无效', agent_metadata_locked:'座位准备后不能修改 Agent 信息', rematch_source_not_completed:'只能复战已完成的对局', rematch_source_invalid:'来源对局缺少有效初始牌局' }[error] || error || '动作未接受'); }
function switchSeat(nextSeat) { seat = normalizeSeat(nextSeat); selected.clear(); syncUrl(); replayMode ? render() : refresh(); }
function switchView(nextView) { view = normalizeView(nextView); selected.clear(); syncUrl(); replayMode ? render() : refresh(); }
function openReplay(targetGameId) {
  const target = new URL('/', location.origin);
  target.searchParams.set('replay', targetGameId);
  target.searchParams.set('seat', seat);
  if (view === 'global') target.searchParams.set('view', 'global');
  target.searchParams.set('return', replayMode ? replayReturn || '/?seat=0' : `${location.pathname}${location.search}`);
  location.href = target;
}

function openGameRecord() { setHistoryPanel($('history-panel').hidden); }

async function createReplayRematch() {
  const sourceGameId = replayMode ? replayGameId : gameId;
  if (!sourceGameId) return;
  const button = $('rematch-game');
  button.disabled = true;
  button.textContent = '创建中…';
  try {
    const response = await fetch(`/api/replays/${encodeURIComponent(sourceGameId)}/rematch`, { method: 'POST', headers: replayAccessHeaders(sourceGameId) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'rematch_failed');
    const target = new URL('/', location.origin);
    target.searchParams.set('game', data.gameId);
    rememberReplayAccess(data.replayAccessToken, data.gameId);
    rememberRoomOwner(data.roomOwnerToken, data.gameId);
    target.searchParams.set('seat', seat);
    if (view === 'global') target.searchParams.set('view', 'global');
    location.assign(target.href);
  } catch (error) {
    button.disabled = false;
    button.textContent = '同牌复战';
    showMessage(errorText(error.message), true);
  }
}

$('new-game').onclick = () => { if (replayMode) location.href = replayReturn?.startsWith('/?') ? replayReturn : '/?seat=0'; };
$('rematch-game').onclick = createReplayRematch;
$('start-game').onclick = () => state?.phase === 'over' ? create(1, { confirmed: false, owner: true }) : start();
$('confirm-setup').onclick = confirmMatchSetup;
$('agent-connect').onclick = () => setAgentTypeMenu($('agent-type-menu').hidden);
$('invite-game').onclick = () => setInviteMenu($('invite-menu').hidden);
$('close-agent-panel').onclick = () => setAgentPanel(false);
$('game-record').onclick = openGameRecord;
$('strategy-record').onclick = () => setStrategyPanel($('strategy-panel').hidden);
$('close-strategies').onclick = () => setStrategyPanel(false);
$('decision-record').onclick = () => setDecisionPanel($('decision-panel').hidden);
$('close-decisions').onclick = () => setDecisionPanel(false);
$('review-record').onclick = () => setReviewPanel($('review-panel').hidden);
$('close-reviews').onclick = () => setReviewPanel(false);
$('close-history').onclick = () => setHistoryPanel(false);
$('global-view').onclick = () => switchView(view === 'global' ? 'player' : 'global');
$('bid').onclick = () => action({ type:'bid', value:1 });
$('decline').onclick = () => action({ type:'bid', value:0 });
$('pass').onclick = () => action({ type:'pass' });
$('play').onclick = () => selected.size ? action({ type:'play', cards:[...selected] }) : showMessage('请先选择要出的牌', true);
document.querySelectorAll('.perspectives button').forEach((button) => button.onclick = () => switchSeat(button.dataset.seat));
document.querySelectorAll('[data-rounds]').forEach((button) => button.onclick = () => {
  if (setupConfirmed) return;
  selectedRounds = Number(button.dataset.rounds);
  renderLifecycle();
});
document.querySelectorAll('[data-access-mode]').forEach((button) => button.onclick = () => {
  if (setupConfirmed) return;
  selectedAccessMode = button.dataset.accessMode;
  renderLifecycle();
});
$('join-game').onclick = joinPlayerGame;
$('reconnect-game').onclick = reconnectPlayerGame;
$('reconnect-code').onkeydown = (event) => { if (event.key === 'Enter') reconnectPlayerGame(); };
$('copy-reconnect-code').onclick = async () => {
  const code = $('session-reconnect-code').textContent;
  if (!code) return;
  try { await navigator.clipboard.writeText(code); showMessage('重连码已复制'); }
  catch { showMessage('复制失败，请手动记录重连码', true); }
};
$('session-code-header').onclick = async () => {
  const code = storedSeatSession(competitionId || gameId, controlledSeat)?.reconnectCode;
  if (!code) return;
  try { await navigator.clipboard.writeText(code); showMessage('重连码已复制'); }
  catch { showMessage(`重连码：${code}`); }
};
document.querySelectorAll('[data-strategy-seat]').forEach((button) => button.onclick = () => { strategySeat = normalizeSeat(button.dataset.strategySeat); renderStrategyDocument(); });
document.querySelectorAll('[data-agent-type]').forEach((button) => button.onclick = () => setAgentPanel(true, button.dataset.agentType));
document.querySelectorAll('[data-invite-type][data-invite-seat]').forEach((button) => button.onclick = () => createInvite(
  button.dataset.inviteType,
  button.dataset.inviteSeat === 'auto' ? null : Number(button.dataset.inviteSeat)
));
$('replay-prev').onclick = () => stepReplay(-1);
$('replay-toggle').onclick = toggleReplay;
$('replay-next').onclick = () => stepReplay(1);
$('replay-progress').oninput = (event) => showReplayFrame(event.target.value);
document.addEventListener('click', (event) => {
  if (!$('agent-type-menu').hidden && !event.target.closest('#agent-type-menu') && !event.target.closest('#agent-connect')) setAgentTypeMenu(false);
  if (!$('invite-menu').hidden && !event.target.closest('#invite-menu') && !event.target.closest('#invite-game')) setInviteMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('agent-type-menu').hidden) { setAgentTypeMenu(false); $('agent-connect').focus(); }
  if (event.key === 'Escape' && !$('invite-menu').hidden) { setInviteMenu(false); $('invite-game').focus(); }
});
window.addEventListener('resize', () => { setAgentTypeMenu(false); setInviteMenu(false); });

async function initialize() {
  try {
    if (inviteToken) await resolveInvite();
    if (replayMode) await loadReplay();
    else if (gameId) await refresh();
    else await create(1, { confirmed: false, owner: true });
  } catch (error) {
    setConnectionError(error);
  }
}

initialize();
setInterval(() => { if (!replayMode) refresh(); }, 1200);
setInterval(renderCountdown, 250);
