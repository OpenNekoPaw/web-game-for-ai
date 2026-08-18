const params = new URLSearchParams(location.search);
const replayGameId = params.get('replay');
const replayMode = Boolean(replayGameId);
const replayReturn = params.get('return');
let gameId = params.get('game');
let seat = normalizeSeat(params.get('seat'));
let controlledSeat = normalizeSeat(params.get('control') ?? params.get('seat'));
let controlRequested = params.has('control') || !gameId;
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

const $ = (id) => document.getElementById(id);
const post = (path, data = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).then(async (response) => ({ response, data: await response.json() }));

function normalizeSeat(value) { const parsed = Number(value); return [0, 1, 2].includes(parsed) ? parsed : 0; }
function normalizeView(value) { return value === 'global' ? 'global' : 'player'; }
function syncUrl() { const next = new URL(location.href); next.searchParams.set('seat', seat); if (replayMode) { next.searchParams.set('replay', replayGameId); next.searchParams.delete('game'); next.searchParams.delete('control'); } else { if (controlRequested) next.searchParams.set('control', controlledSeat); else next.searchParams.delete('control'); if (gameId) next.searchParams.set('game', gameId); } if (view === 'global') next.searchParams.set('view', 'global'); else next.searchParams.delete('view'); history.replaceState(null, '', next); }
function showMessage(text, error = false) { clearTimeout(messageTimer); const element = $('message'); element.textContent = text; element.className = `message visible ${error ? 'error' : ''}`; messageTimer = setTimeout(() => { element.className = 'message'; }, 2200); }

async function create() {
  try { const { response, data } = await post('/api/games'); if (!response.ok) throw new Error(data.error || 'create_failed'); gameId = data.gameId; controlRequested = true; controlActive = false; playerJoinAttempt = null; selected.clear(); syncUrl(); await refresh(); }
  catch (error) { setConnectionError(error); }
}

async function ensurePlayerJoined() {
  if (replayMode || !controlRequested || !gameId || playerJoinAttempt === gameId) return;
  playerJoinAttempt = gameId;
  const playerId = localPlayerId(gameId, controlledSeat);
  const { response, data } = await post(`/api/games/${gameId}/join`, { seatId: controlledSeat, playerId });
  if (response.ok) { controlActive = true; return; }
  controlActive = false;
  if (data.error === 'seat_occupied') { showMessage('该座位已由其他玩家或 Agent 占用，当前为观战模式', true); return; }
  throw new Error(data.error || 'join_failed');
}

function localPlayerId(currentGameId, seatId) {
  const key = `ddz-player:${currentGameId}:${seatId}`;
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
    state = data; serverClockOffsetMs = Number(data.serverNow || Date.now()) - Date.now(); render();
  } catch (error) { setConnectionError(error); }
  finally { refreshing = false; }
  await advanceBots();
}

function setConnectionError(error) { showMessage(`无法连接服务：${error.message}`, true); }

function renderCountdown() {
  const element = $('countdown');
  if (!element) return;
  if (replayMode || !state || state.winner !== null || !state.turnDeadlineAt) { element.textContent = ''; element.classList.remove('urgent'); return; }
  const remainingMs = Math.max(0, state.turnDeadlineAt - (Date.now() + serverClockOffsetMs));
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  element.textContent = `剩余 ${minutes}:${seconds}`;
  element.classList.toggle('urgent', totalSeconds <= 10);
}

async function advanceBots() {
  if (replayMode || !state || state.phase === 'waiting' || state.winner !== null || state.current === controlledSeat || botBusy) return;
  if (state.seatControllers && Object.prototype.hasOwnProperty.call(state.seatControllers, state.current)) return;
  botBusy = true;
  try { const { response, data } = await post(`/api/games/${gameId}/bot`); if (!response.ok && data.error !== 'game_over') throw new Error(data.error); }
  catch (error) { setConnectionError(error); }
  finally { botBusy = false; }
  await refresh();
}

function render() {
  const labels = ['A', 'B', 'C'];
  const roles = (id) => state.phase === 'waiting' ? '等待' : state.landlord === id ? '地主' : '农民';
  const controllers = (id) => controllerLabel(id);
  const left = (seat + 2) % 3;
  const right = (seat + 1) % 3;
  const bidLabel = state.bidStage === 'rob' ? '抢地主' : '叫地主';
  renderCountdown();
  renderCompetition();
  setPlayer('left', left, labels, roles, controllers);
  setPlayer('right', right, labels, roles, controllers);
  $('self-avatar').textContent = labels[seat]; $('self-name').textContent = `${roles(seat)} ${labels[seat]} · ${controllers(seat)}`; $('self-count').textContent = state.phase === 'waiting' ? readyLabel(seat) : `${state.hands[seat].count} 张`;
  renderSelfHand(state.hands[seat].cards);
  renderBottomCards(state.bottom);
  renderTablePlays();
  renderLifecycle();
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
  const element = $('competition-info');
  const competition = state?.competition;
  if (!element || !competition) { if (element) element.hidden = true; return; }
  const scores = (competition.scores || []).map((score, seatId) => `${['A', 'B', 'C'][seatId]} ${score >= 0 ? '+' : ''}${score}`).join(' · ');
  element.hidden = false;
  element.textContent = `第 ${competition.currentRound}/${competition.totalRounds} 局 · ${scores}`;
}

function renderDecisions() {
  const available = replayMode || view === 'global';
  const button = $('decision-record');
  const panel = $('decision-panel');
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

function setDecisionPanel(open) {
  if (open) { $('review-panel').hidden = true; $('history-panel').hidden = true; }
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
  if (open) { $('decision-panel').hidden = true; $('history-panel').hidden = true; }
  $('review-panel').hidden = !open;
  updateSidePanelLayout();
  $('review-record').classList.toggle('active', open);
  $('review-record').setAttribute('aria-expanded', String(open));
}

function updateSidePanelLayout() {
  const open = !$('decision-panel').hidden || !$('review-panel').hidden || !$('history-panel').hidden;
  $('game-table').classList.toggle('decisions-open', open);
  $('decision-record').classList.toggle('active', !$('decision-panel').hidden);
  $('review-record').classList.toggle('active', !$('review-panel').hidden);
  $('game-record').classList.toggle('active', !$('history-panel').hidden);
}

async function setHistoryPanel(open) {
  if (open) {
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
    return `${label} ${participant.type === 'agent' ? 'Agent' : '玩家'}`;
  }).join(' · ');
  const status = record.phase === 'over' ? record.winner === 'landlord' ? '地主获胜' : '农民获胜' : record.phase === 'waiting' ? '等待开始' : '进行中';
  const competition = record.competition ? ` · 第 ${record.competition.roundNumber}/${record.competition.totalRounds} 局` : '';
  item.innerHTML = `<strong>${record.gameId === gameId ? '<span class="current-record">当前</span>' : ''}${status}${competition}</strong><span>${formatRecordTime(record.createdAt)} · ${record.frameCount} 帧</span><small>${participants}</small>`;
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
  if (replayMode || !['waiting', 'over'].includes(state.phase)) { container.hidden = true; return; }
  container.hidden = false;
  if (state.phase === 'waiting') {
    const readyCount = state.readySeats?.length || 0;
    const selfReady = state.readySeats?.includes(controlledSeat);
    $('game-status').textContent = selfReady ? '等待其他玩家' : '等待玩家准备';
    $('ready-status').textContent = `${readyCount} / 3 已就绪`;
    button.textContent = '开始对局';
    button.hidden = !controlActive || selfReady;
    button.disabled = false;
    return;
  }
  button.hidden = false;
  $('game-status').textContent = state.winner === 'landlord' ? '地主获胜' : '农民获胜';
  $('ready-status').textContent = '本局已结束，可查看记录或开始新局';
  button.textContent = '新一局';
  button.disabled = false;
}

function controllerLabel(id) {
  const type = state.seatControllers?.[id]?.type;
  if (type === 'agent') return 'Agent';
  if (type === 'player') return '玩家';
  if (state.phase === 'waiting') return '待接入';
  if (replayMode) return 'Bot';
  return id === controlledSeat ? '玩家' : 'Bot';
}
function setPlayer(position, id, labels, roles, controllers) { $(`${position}-avatar`).textContent = labels[id]; $(`${position}-name`).textContent = `${roles(id)} ${labels[id]} · ${controllers(id)}`; $(`${position}-count`).textContent = state.phase === 'waiting' ? readyLabel(id) : `${state.hands[id].count} 张`; renderOpponentHand(position, id); }
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
  cards.forEach((card) => { const item = document.createElement('li'); const element = document.createElement('button'); const face = cardFace(card); element.type = 'button'; element.className = `card ${face.className} ${selected.has(card) ? 'selected' : ''}`; element.innerHTML = `<span class="rank">${face.rank}</span><span class="suit">${face.suit}</span>`; element.title = face.label; element.disabled = replayMode; element.onclick = () => { selected.has(card) ? selected.delete(card) : selected.add(card); renderHand(cards); }; item.appendChild(element); list.appendChild(item); });
  wrapper.appendChild(list); hand.appendChild(wrapper);
}

function renderTablePlays() {
  ['left-play','right-play','self-play'].forEach((id) => { $(id).innerHTML = ''; });
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

function cardFace(card) { const [rank, suit] = card.split(':').map(Number); if (rank === 16) return { className:'joker', rank:'小', suit:'王', label:'小王' }; if (rank === 17) return { className:'joker', rank:'大', suit:'王', label:'大王' }; const rankText = ({11:'J',12:'Q',13:'K',14:'A',15:'2'}[rank] || String(rank)); const suits = [{name:'spades',symbol:'♠'},{name:'hearts',symbol:'♥'},{name:'clubs',symbol:'♣'},{name:'diams',symbol:'♦'}]; const face = suits[suit] || suits[0]; return { className:`rank-${rankText.toLowerCase()} ${face.name}`, rank:rankText, suit:face.symbol, label:`${rankText}${face.symbol}` }; }

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
$('start-game').onclick = () => state?.phase === 'over' ? create() : start();
$('game-record').onclick = openGameRecord;
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
$('replay-prev').onclick = () => stepReplay(-1);
$('replay-toggle').onclick = toggleReplay;
$('replay-next').onclick = () => stepReplay(1);
$('replay-progress').oninput = (event) => showReplayFrame(event.target.value);

if (replayMode) loadReplay(); else if (gameId) refresh(); else create();
setInterval(() => { if (!replayMode) refresh(); }, 1200);
setInterval(renderCountdown, 250);
