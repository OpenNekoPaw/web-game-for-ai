const params = new URLSearchParams(location.search);
let gameId = params.get('game');
let seat = normalizeSeat(params.get('seat'));
let controlledSeat = normalizeSeat(params.get('control') ?? params.get('seat'));
let view = normalizeView(params.get('view'));
let state = null;
let selected = new Set();
let botBusy = false;
let refreshing = false;
let messageTimer = null;
let serverClockOffsetMs = 0;

const $ = (id) => document.getElementById(id);
const post = (path, data = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).then(async (response) => ({ response, data: await response.json() }));

function normalizeSeat(value) { const parsed = Number(value); return [0, 1, 2].includes(parsed) ? parsed : 0; }
function normalizeView(value) { return value === 'global' ? 'global' : 'player'; }
function syncUrl() { const next = new URL(location.href); next.searchParams.set('seat', seat); next.searchParams.set('control', controlledSeat); if (gameId) next.searchParams.set('game', gameId); if (view === 'global') next.searchParams.set('view', 'global'); else next.searchParams.delete('view'); history.replaceState(null, '', next); }
function showMessage(text, error = false) { clearTimeout(messageTimer); const element = $('message'); element.textContent = text; element.className = `message visible ${error ? 'error' : ''}`; messageTimer = setTimeout(() => { element.className = 'message'; }, 2200); }

async function create() {
  try { const { response, data } = await post('/api/games'); if (!response.ok) throw new Error(data.error || 'create_failed'); gameId = data.gameId; selected.clear(); syncUrl(); await refresh(); }
  catch (error) { setConnectionError(error); }
}

async function refresh() {
  if (!gameId || refreshing) return;
  refreshing = true;
  try {
    const stateUrl = new URL(`/api/games/${gameId}/state`, location.origin); stateUrl.searchParams.set('seat', seat); if (view === 'global') stateUrl.searchParams.set('view', 'global');
    const response = await fetch(stateUrl);
    const data = await response.json();
    if (!response.ok) { if (data.error === 'game_not_found') return create(); throw new Error(data.error || 'state_failed'); }
    state = data; serverClockOffsetMs = Number(data.serverNow || Date.now()) - Date.now(); render();
  } catch (error) { setConnectionError(error); }
  finally { refreshing = false; }
  await advanceBots();
}

function setConnectionError(error) { $('turn').textContent = '连接失败'; showMessage(`无法连接服务：${error.message}`, true); }

function renderCountdown() {
  const element = $('countdown');
  if (!element) return;
  if (!state || state.winner !== null || !state.turnDeadlineAt) { element.textContent = ''; element.classList.remove('urgent'); return; }
  const remainingMs = Math.max(0, state.turnDeadlineAt - (Date.now() + serverClockOffsetMs));
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  element.textContent = `剩余 ${minutes}:${seconds}`;
  element.classList.toggle('urgent', totalSeconds <= 10);
}

async function advanceBots() {
  if (!state || state.winner !== null || state.current === controlledSeat || botBusy) return;
  if (state.agentSeats && Object.prototype.hasOwnProperty.call(state.agentSeats, state.current)) return;
  botBusy = true;
  try { const { response, data } = await post(`/api/games/${gameId}/bot`); if (!response.ok && data.error !== 'game_over') throw new Error(data.error); }
  catch (error) { setConnectionError(error); }
  finally { botBusy = false; }
  await refresh();
}

function render() {
  const labels = ['A', 'B', 'C'];
  const roles = (id) => state.landlord === id ? '地主' : '农民';
  const controllers = (id) => controllerLabel(id);
  const left = (seat + 2) % 3;
  const right = (seat + 1) % 3;
  const bidLabel = state.bidStage === 'rob' ? '抢地主' : '叫地主';
  $('phase').textContent = state.phase === 'bid' ? bidLabel : state.phase === 'over' ? '对局结束' : '出牌阶段';
  $('turn').textContent = state.winner ? (state.winner === 'landlord' ? '地主获胜' : '农民获胜') : state.current === controlledSeat ? '轮到玩家' : `等待 ${controllers(state.current)} ${labels[state.current]}`;
  renderCountdown();
  setPlayer('left', left, labels, roles, controllers);
  setPlayer('right', right, labels, roles, controllers);
  $('self-avatar').textContent = labels[seat]; $('self-name').textContent = `${roles(seat)} ${labels[seat]} · ${controllers(seat)}`; $('self-count').textContent = `${state.hands[seat].count} 张`;
  renderSelfHand(state.hands[seat].cards);
  renderBottomCards(state.bottom);
  renderTablePlays();
  document.querySelectorAll('.perspectives button').forEach((button) => button.classList.toggle('active', Number(button.dataset.seat) === seat));
  $('global-view').classList.toggle('active', view === 'global'); $('global-view').setAttribute('aria-pressed', String(view === 'global'));
  $('bid').textContent = bidLabel;
  $('decline').textContent = state.bidStage === 'rob' ? '不抢' : '不叫';
  const myTurn = seat === controlledSeat && state.current === controlledSeat && state.winner === null;
  toggle('bid', myTurn && state.phase === 'bid'); toggle('decline', myTurn && state.phase === 'bid'); toggle('pass', myTurn && state.phase === 'play' && Boolean(state.lastPlay)); toggle('play', myTurn && state.phase === 'play');
}

function controllerLabel(id) {
  if (state.agentSeats && Object.prototype.hasOwnProperty.call(state.agentSeats, id)) return 'Agent';
  return id === controlledSeat ? '玩家' : 'Bot';
}
function setPlayer(position, id, labels, roles, controllers) { $(`${position}-avatar`).textContent = labels[id]; $(`${position}-name`).textContent = `${roles(id)} ${labels[id]} · ${controllers(id)}`; $(`${position}-count`).textContent = `${state.hands[id].count} 张`; renderOpponentHand(position, id); }
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
  cards.forEach((card) => { const item = document.createElement('li'); const element = document.createElement('button'); const face = cardFace(card); element.type = 'button'; element.className = `card ${face.className} ${selected.has(card) ? 'selected' : ''}`; element.innerHTML = `<span class="rank">${face.rank}</span><span class="suit">${face.suit}</span>`; element.title = face.label; element.onclick = () => { selected.has(card) ? selected.delete(card) : selected.add(card); renderHand(cards); }; item.appendChild(element); list.appendChild(item); });
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
}

function cardFace(card) { const [rank, suit] = card.split(':').map(Number); if (rank === 16) return { className:'joker', rank:'小', suit:'王', label:'小王' }; if (rank === 17) return { className:'joker', rank:'大', suit:'王', label:'大王' }; const rankText = ({11:'J',12:'Q',13:'K',14:'A',15:'2'}[rank] || String(rank)); const suits = [{name:'spades',symbol:'♠'},{name:'hearts',symbol:'♥'},{name:'clubs',symbol:'♣'},{name:'diams',symbol:'♦'}]; const face = suits[suit] || suits[0]; return { className:`rank-${rankText.toLowerCase()} ${face.name}`, rank:rankText, suit:face.symbol, label:`${rankText}${face.symbol}` }; }

async function action(payload) {
  if (seat !== controlledSeat) return showMessage('当前仅为观察视角，请切回控制座位', true);
  if (!gameId || !state || state.current !== controlledSeat) return showMessage('还没有轮到当前玩家', true);
  try { const { response, data } = await post(`/api/games/${gameId}/actions`, { seatId: controlledSeat, action: payload }); if (!response.ok) return showMessage(errorText(data.error), true); selected.clear(); await refresh(); }
  catch (error) { setConnectionError(error); }
}

function errorText(error) { return ({ invalid_action:'动作格式错误', illegal_play:'这组牌不能出', cannot_pass_first:'你需要先出牌', cards_not_in_hand:'手牌状态已变化', not_your_turn:'还没轮到你', invalid_bid:'叫地主动作无效' }[error] || error || '动作未接受'); }
function switchSeat(nextSeat) { seat = normalizeSeat(nextSeat); selected.clear(); syncUrl(); refresh(); }
function switchView(nextView) { view = normalizeView(nextView); selected.clear(); syncUrl(); refresh(); }

$('new-game').onclick = create;
$('global-view').onclick = () => switchView(view === 'global' ? 'player' : 'global');
$('bid').onclick = () => action({ type:'bid', value:1 });
$('decline').onclick = () => action({ type:'bid', value:0 });
$('pass').onclick = () => action({ type:'pass' });
$('play').onclick = () => selected.size ? action({ type:'play', cards:[...selected] }) : showMessage('请先选择要出的牌', true);
document.querySelectorAll('.perspectives button').forEach((button) => button.onclick = () => switchSeat(button.dataset.seat));

if (gameId) refresh(); else create();
setInterval(refresh, 1200);
setInterval(renderCountdown, 250);
