const params = new URLSearchParams(location.search);
const replayGameId = params.get('replay');
const replayMode = Boolean(replayGameId);
const replayReturn = params.get('return');
let gameId = params.get('game');
let competitionId = params.get('competition');
let seat = normalizeSeat(params.get('seat'));
let controlledSeat = normalizeSeat(params.get('control') ?? params.get('seat'));
let controlRequested = params.has('control');
let controlActive = false;
let playerJoinAttempt = null;
let view = normalizeView(params.get('view'));
let state = null;
let replay = null;
let replayIndex = 0;
let replayTimer = null;
let selected = new Set();
let botBusy = false;
let refreshing = false;
let messageTimer = null;
let serverClockOffsetMs = 0;
let strategySeat = seat;
let strategyParticipants = {};
let strategySnapshotGameId = null;
let strategyLoading = false;
let selectedRounds = 1;

const $ = (id) => document.getElementById(id);
const post = (path, data = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).then(async (response) => ({ response, data: await response.json() }));

function normalizeSeat(value) { const parsed = Number(value); return [0, 1, 2].includes(parsed) ? parsed : 0; }
function normalizeView(value) { return value === 'global' ? 'global' : 'player'; }
function syncUrl() { const next = new URL(location.href); next.searchParams.set('seat', seat); if (replayMode) { next.searchParams.set('replay', replayGameId); next.searchParams.delete('game'); next.searchParams.delete('competition'); next.searchParams.delete('control'); } else { if (controlRequested) next.searchParams.set('control', controlledSeat); else next.searchParams.delete('control'); if (gameId) next.searchParams.set('game', gameId); if (competitionId) next.searchParams.set('competition', competitionId); else next.searchParams.delete('competition'); } if (view === 'global') next.searchParams.set('view', 'global'); else next.searchParams.delete('view'); history.replaceState(null, '', next); }
function showMessage(text, error = false) { clearTimeout(messageTimer); const element = $('message'); element.textContent = text; element.className = `message visible ${error ? 'error' : ''}`; messageTimer = setTimeout(() => { element.className = 'message'; }, 2200); }

async function create(rounds = 1) {
  try { const totalRounds = [3, 5, 7].includes(Number(rounds)) ? Number(rounds) : 1; const { response, data } = totalRounds === 1 ? await post('/api/games') : await post('/api/competitions', { totalRounds }); if (!response.ok) throw new Error(data.error || 'create_failed'); gameId = totalRounds === 1 ? data.gameId : data.currentGameId; competitionId = totalRounds === 1 ? null : data.competitionId; selectedRounds = totalRounds; controlActive = false; playerJoinAttempt = null; strategyParticipants = {}; strategySnapshotGameId = null; selected.clear(); syncUrl(); await refresh(); }
  catch (error) { setConnectionError(error); }
}

async function ensurePlayerJoined() {
  if (replayMode || !controlRequested || !gameId || playerJoinAttempt === gameId) return;
  playerJoinAttempt = gameId;
  const playerId = localPlayerId(competitionId || gameId, controlledSeat);
  const displayName = String(params.get('name') || `玩家 ${['A', 'B', 'C'][controlledSeat]}`).trim().slice(0, 40);
  const { response, data } = await post(`/api/games/${gameId}/join`, { seatId: controlledSeat, playerId, displayName });
  if (response.ok) { controlActive = true; return; }
  controlActive = false;
  if (data.error === 'seat_occupied') { showMessage('该座位已由其他玩家或 Agent 占用，当前为观战模式', true); return; }
  throw new Error(data.error || 'join_failed');
}

function localPlayerId(sessionId, seatId) {
  const key = `ddz-player:${sessionId}:${seatId}`;
  let value = localStorage.getItem(key) || sessionStorage.getItem(key);
  if (!value) value = `h5-${crypto.randomUUID()}`;
  localStorage.setItem(key, value);
  sessionStorage.removeItem(key);
  return value;
}

async function start() {
  if (!gameId || !controlActive) return showMessage('请先加入一个玩家座位', true);
  if (state?.readySeats?.includes(controlledSeat)) return;
  try { const { response, data } = await post(`/api/games/${gameId}/start`, { seatId: controlledSeat }); if (!response.ok) throw new Error(data.error || 'start_failed'); selected.clear(); await refresh(); }
  catch (error) { showMessage(errorText(error.message), true); }
}

async function loadReplay() {
  try {
    const response = await fetch(`/api/replays/${encodeURIComponent(replayGameId)}`);
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
  const source = { agent:'Agent', bot:'Bot', player:'玩家', timeout:'超时' }[event.source] || event.source || '玩家';
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
    const response = await fetch(stateUrl);
    const data = await response.json();
    if (!response.ok) { if (data.error === 'game_not_found') return create(); throw new Error(data.error || 'state_failed'); }
    if (data.competition?.competitionId) competitionId = data.competition.competitionId;
    if (data.competition?.currentGameId && data.competition.currentGameId !== gameId) {
      gameId = data.competition.currentGameId; controlActive = false; playerJoinAttempt = null; strategyParticipants = {}; strategySnapshotGameId = null; selected.clear(); syncUrl(); refreshing = false; return refresh();
    }
    state = data; serverClockOffsetMs = Number(data.serverNow || Date.now()) - Date.now(); syncUrl();
    if (!$('strategy-panel').hidden && view === 'global') await loadStrategyDetails(state.phase === 'waiting');
    render();
  } catch (error) { setConnectionError(error); }
  finally { refreshing = false; }
  await advanceBots();
}

function setConnectionError(error) { showMessage(`无法连接服务：${error.message}`, true); }

function renderCountdown() {
  const element = $('countdown');
  if (!element) return;
  const visible = !replayMode && Boolean(state) && state.phase !== 'waiting' && state.winner === null && Boolean(state.turnDeadlineAt);
  element.hidden = !visible;
  if (!visible) { element.textContent = ''; element.classList.remove('urgent'); return; }
  const remainingMs = Math.max(0, state.turnDeadlineAt - (Date.now() + serverClockOffsetMs));
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  element.textContent = `剩余 ${minutes}:${seconds}`;
  element.classList.toggle('urgent', totalSeconds <= 10);
}

async function advanceBots() {
  if (replayMode || !state || state.phase === 'waiting' || state.winner !== null || (controlActive && state.current === controlledSeat) || botBusy) return;
  if (state.seatControllers && Object.prototype.hasOwnProperty.call(state.seatControllers, state.current)) return;
  botBusy = true;
  try { const { response, data } = await post(`/api/games/${gameId}/bot`); if (!response.ok && data.error !== 'game_over') throw new Error(data.error); }
  catch (error) { setConnectionError(error); }
  finally { botBusy = false; }
  await refresh();
}

function render() {
  const labels = ['A', 'B', 'C'];
  const roles = (id) => state.phase === 'waiting' ? '等待' : state.phase === 'bid' ? '竞叫' : state.landlord === id ? '地主' : '农民';
  const controllers = (id) => controllerLabel(id);
  const left = (seat + 2) % 3;
  const right = (seat + 1) % 3;
  const bidLabel = state.bidStage === 'rob' ? '抢地主' : '叫地主';
  renderCountdown();
  renderCompetition();
  setPlayer('left', left, labels, roles, controllers);
  setPlayer('right', right, labels, roles, controllers);
  $('self-avatar').textContent = labels[seat]; $('self-name').textContent = `${roles(seat)} ${labels[seat]} · ${controllers(seat)}`; $('self-name').title = state.seatControllers?.[seat]?.id || ''; $('self-count').textContent = state.phase === 'waiting' ? readyLabel(seat) : `${state.hands[seat].count} 张`;
  renderSelfHand(state.hands[seat].cards);
  renderBottomCards(state.bottom);
  renderTablePlays();
  renderLifecycle();
  renderStrategies();
  renderDecisions();
  renderReviews();
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
  const available = replayMode || view === 'global';
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
  if (!strategy) {
    const empty = document.createElement('p');
    empty.className = 'decision-empty';
    empty.textContent = participant?.type === 'player' ? '人工玩家未绑定 Agent 策略' : participant?.type === 'agent' ? '本局策略快照缺失' : '该席位尚未接入';
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
  if (open) { $('strategy-panel').hidden = true; $('review-panel').hidden = true; $('history-panel').hidden = true; }
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
  if (open) { $('strategy-panel').hidden = true; $('decision-panel').hidden = true; $('history-panel').hidden = true; }
  $('review-panel').hidden = !open;
  updateSidePanelLayout();
  $('review-record').classList.toggle('active', open);
  $('review-record').setAttribute('aria-expanded', String(open));
}

function updateSidePanelLayout() {
  const open = !$('strategy-panel').hidden || !$('decision-panel').hidden || !$('review-panel').hidden || !$('history-panel').hidden;
  $('game-table').classList.toggle('decisions-open', open);
  $('strategy-record').classList.toggle('active', !$('strategy-panel').hidden);
  $('decision-record').classList.toggle('active', !$('decision-panel').hidden);
  $('review-record').classList.toggle('active', !$('review-panel').hidden);
  $('game-record').classList.toggle('active', !$('history-panel').hidden);
  $('strategy-record').setAttribute('aria-expanded', String(!$('strategy-panel').hidden));
  $('decision-record').setAttribute('aria-expanded', String(!$('decision-panel').hidden));
  $('review-record').setAttribute('aria-expanded', String(!$('review-panel').hidden));
}

async function setHistoryPanel(open) {
  if (open) {
    $('strategy-panel').hidden = true;
    $('decision-panel').hidden = true;
    $('review-panel').hidden = true;
  }
  $('history-panel').hidden = !open;
  updateSidePanelLayout();
  if (open) await loadHistory();
}

async function loadHistory() {
  const list = $('history-list');
  list.innerHTML = '<p class="decision-empty">正在加载历史对局…</p>';
  try {
    const response = await fetch('/api/replays?limit=50&status=completed');
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
    if (participant.type === 'agent') return `${label} ${participant.displayName || participant.id || 'Agent'} · ${participant.strategy?.name || '默认策略'}`;
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
  metadata.textContent = `${formatRecordTime(record.createdAt)} · ${record.frameCount} 帧`;
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
  const setup = $('match-setup');
  if (replayMode || !['waiting', 'over'].includes(state.phase)) { container.hidden = true; return; }
  container.hidden = false;
  if (state.phase === 'waiting') {
    selectedRounds = state.competition?.totalRounds || 1;
    setup.hidden = false;
    const canConfigure = Object.keys(state.seatControllers || {}).length === 0;
    document.querySelectorAll('[data-rounds]').forEach((roundButton) => { const rounds = Number(roundButton.dataset.rounds); roundButton.classList.toggle('active', rounds === selectedRounds); roundButton.disabled = !canConfigure; });
    const readyCount = state.readySeats?.length || 0;
    const selfReady = state.readySeats?.includes(controlledSeat);
    $('game-status').textContent = selfReady ? '等待其他玩家' : '等待玩家准备';
    $('ready-status').textContent = `${readyCount} / 3 已就绪`;
    button.textContent = '开始对局';
    button.hidden = !controlActive || selfReady;
    button.disabled = false;
    return;
  }
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
  if (controller?.displayName) return controller.displayName;
  if (controller?.type === 'agent') return controller.id || 'Agent';
  if (controller?.type === 'player') return '玩家';
  if (state.phase === 'waiting') return '待接入';
  if (replayMode) return 'Bot';
  return controlActive && id === controlledSeat ? '玩家' : 'Bot';
}
function setPlayer(position, id, labels, roles, controllers) { $(`${position}-avatar`).textContent = labels[id]; $(`${position}-name`).textContent = `${roles(id)} ${labels[id]} · ${controllers(id)}`; $(`${position}-name`).title = state.seatControllers?.[id]?.id || ''; $(`${position}-count`).textContent = state.phase === 'waiting' ? readyLabel(id) : `${state.hands[id].count} 张`; renderOpponentHand(position, id); }
function readyLabel(id) { return state.readySeats?.includes(id) ? '已就绪' : state.seatControllers?.[id] ? '等待开始' : '等待加入'; }
function toggle(id, visible) { $(id).hidden = !visible; }

function renderOpponentHand(position, id) { const container = $(`${position}-cards`); const cards = state.hands[id].cards || []; if (view !== 'global' || !cards.length) { container.className = 'opponent-cards cards-back vertical'; container.innerHTML = ''; return; } container.className = `opponent-cards opponent-face ${position}`; container.innerHTML = ''; container.appendChild(createStaticCardGroup(cards, 'opponent-playing-cards')); }
function renderSelfHand(cards) { renderHand(cards); }

function renderBottomCards(cards) {
  const container = $('bottom-cards'); container.innerHTML = '';
  if (!cards.length) return;
  container.appendChild(createStaticCardGroup(cards, 'bottom-playing-cards'));
}

function createStaticCardGroup(cards, className = '') { const wrapper = document.createElement('div'); wrapper.className = `playingCards ${className}`.trim(); const list = document.createElement('ul'); list.className = 'hand'; cards.forEach((card) => { const item = document.createElement('li'); const element = document.createElement('span'); const face = cardFace(card); element.className = `card ${face.className}`; element.innerHTML = `<span class="rank">${face.rank}</span><span class="suit">${face.suit}</span>`; item.appendChild(element); list.appendChild(item); }); wrapper.appendChild(list); return wrapper; }

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
    (state.bidHistory || []).forEach((entry) => bidsBySeat.set(entry.seatId, [...(bidsBySeat.get(entry.seatId) || []), entry]));
    bidsBySeat.forEach((entries, seatId) => {
      const slot = seatId === seat ? 'self-play' : seatId === (seat + 2) % 3 ? 'left-play' : 'right-play';
      const hint = document.createElement('span');
      hint.className = `bid-hint ${entries.at(-1).value ? 'accepted' : 'declined'}`;
      hint.textContent = entries.map((entry) => entry.stage === 'rob' ? entry.value ? '抢地主' : '不抢' : entry.value ? '叫地主' : '不叫').join(' → ');
      $(slot).appendChild(hint);
    });
    return;
  }
  const tablePlays = state.tablePlays || [null, null, null];
  tablePlays.forEach((cards, seatId) => {
    if (!cards?.length) return;
    const slot = seatId === seat ? 'self-play' : seatId === (seat + 2) % 3 ? 'left-play' : 'right-play';
    $(slot).appendChild(createStaticCardGroup(cards, 'compact'));
  });
  (state.tablePasses || []).forEach((passed, seatId) => {
    if (!passed) return;
    const slot = seatId === seat ? 'self-play' : seatId === (seat + 2) % 3 ? 'left-play' : 'right-play';
    const hint = document.createElement('span'); hint.className = 'pass-hint'; hint.textContent = '不要'; $(slot).replaceChildren(hint);
  });
}

function cardId(card) { return typeof card === 'string' ? card : card?.id; }
function cardFace(card) { const [rank, suit] = cardId(card).split(':').map(Number); if (rank === 16) return { className:'joker', rank:'小', suit:'王', label:card?.label || '小王' }; if (rank === 17) return { className:'joker', rank:'大', suit:'王', label:card?.label || '大王' }; const rankText = typeof card === 'object' && card.rank ? card.rank : ({11:'J',12:'Q',13:'K',14:'A',15:'2'}[rank] || String(rank)); const suits = [{name:'spades',symbol:'♠'},{name:'hearts',symbol:'♥'},{name:'clubs',symbol:'♣'},{name:'diams',symbol:'♦'}]; const face = suits[suit] || suits[0]; return { className:`rank-${String(rankText).toLowerCase()} ${face.name}`, rank:rankText, suit:face.symbol, label:card?.label || `${rankText}${face.symbol}` }; }

async function action(payload) {
  if (!controlActive || seat !== controlledSeat) return showMessage('当前仅为观察视角，请切回已加入的玩家座位', true);
  if (!gameId || !state || state.current !== controlledSeat) return showMessage('还没有轮到当前玩家', true);
  try { const { response, data } = await post(`/api/games/${gameId}/actions`, { seatId: controlledSeat, action: payload }); if (!response.ok) return showMessage(errorText(data.error), true); selected.clear(); await refresh(); }
  catch (error) { setConnectionError(error); }
}

function errorText(error) { return ({ invalid_action:'动作格式错误', illegal_play:'这组牌不能出', cannot_pass_first:'你需要先出牌', cards_not_in_hand:'手牌状态已变化', not_your_turn:'还没轮到你', invalid_bid:'叫地主动作无效', game_not_started:'对局还未开始', players_not_ready:'请等待三家全部准备就绪', game_already_started:'对局已经开始', seat_occupied:'座位已被占用', seat_not_joined:'请先加入一个座位' }[error] || error || '动作未接受'); }
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

$('new-game').onclick = () => { if (replayMode) location.href = replayReturn?.startsWith('/?') ? replayReturn : '/?seat=0'; };
$('start-game').onclick = () => state?.phase === 'over' ? create(selectedRounds) : start();
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
document.querySelectorAll('[data-rounds]').forEach((button) => button.onclick = () => { const rounds = Number(button.dataset.rounds); if (rounds !== selectedRounds) create(rounds); });
document.querySelectorAll('[data-strategy-seat]').forEach((button) => button.onclick = () => { strategySeat = normalizeSeat(button.dataset.strategySeat); renderStrategyDocument(); });
$('replay-prev').onclick = () => stepReplay(-1);
$('replay-toggle').onclick = toggleReplay;
$('replay-next').onclick = () => stepReplay(1);
$('replay-progress').oninput = (event) => showReplayFrame(event.target.value);

if (replayMode) loadReplay(); else if (gameId) refresh(); else create();
setInterval(() => { if (!replayMode) refresh(); }, 1200);
setInterval(renderCountdown, 250);
