const SUITS = ['S', 'H', 'C', 'D'];
const SUIT_SYMBOLS = ['♠', '♥', '♣', '♦'];
const SUIT_NAMES = ['spades', 'hearts', 'clubs', 'diamonds'];
const RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const rankLabel = (rank) => ({11:'J',12:'Q',13:'K',14:'A',15:'2',16:'BJ',17:'RJ'}[rank] || String(rank));

export const CARD_ENCODING = Object.freeze({
  ranks: Object.freeze({ 3:'3', 4:'4', 5:'5', 6:'6', 7:'7', 8:'8', 9:'9', 10:'10', 11:'J', 12:'Q', 13:'K', 14:'A', 15:'2', 16:'小王', 17:'大王' }),
  suits: Object.freeze({ 0:'♠', 1:'♥', 2:'♣', 3:'♦' }),
  rankOrder: Object.freeze(['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '小王', '大王'])
});

export function cardLabel(card) {
  const [rank, suit] = card.split(':').map(Number);
  return rank >= 16 ? rankLabel(rank) : `${rankLabel(rank)}${SUITS[suit]}`;
}

export function cardDisplayLabel(card) {
  const [rank, suit] = card.split(':').map(Number);
  return rank === 16 ? '小王' : rank === 17 ? '大王' : `${rankLabel(rank)}${SUIT_SYMBOLS[suit]}`;
}

export function cardView(card) {
  const [strength, suitIndex] = card.split(':').map(Number);
  return {
    id: card,
    rank: strength === 16 ? 'small_joker' : strength === 17 ? 'big_joker' : rankLabel(strength),
    suit: strength >= 16 ? null : SUIT_NAMES[suitIndex],
    label: cardDisplayLabel(card),
    strength
  };
}

export function createDeck() {
  const cards = [];
  for (const rank of RANKS) for (let suit = 0; suit < 4; suit++) cards.push(`${rank}:${suit}`);
  cards.push('16:0', '17:0');
  return cards;
}

const sortCards = (cards) => [...cards].sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]));
const counts = (cards) => cards.reduce((m, c) => m.set(Number(c.split(':')[0]), (m.get(Number(c.split(':')[0])) || 0) + 1), new Map());
const ranks = (cards) => [...counts(cards).keys()].sort((a, b) => a - b);
const isConsecutive = (values) => values.length > 1 && values.every((v, i) => i === 0 || v === values[i - 1] + 1) && values.at(-1) <= 14;

export function describePlay(cards) {
  if (!cards?.length) return { type: 'pass', weight: 0, count: 0 };
  const sorted = sortCards(cards), rs = ranks(sorted), cm = counts(sorted), n = sorted.length;
  const freq = [...cm.values()].sort((a, b) => b - a);
  if (n === 2 && rs.includes(16) && rs.includes(17)) return { type: 'rocket', weight: 17, count: 2 };
  if (freq[0] === 4 && n === 4) return { type: 'bomb', weight: rs[0], count: 4 };
  if (n === 1) return { type: 'single', weight: rs[0], count: 1 };
  if (n === 2 && freq[0] === 2) return { type: 'pair', weight: rs[0], count: 2 };
  if (n === 3 && freq[0] === 3) return { type: 'triple', weight: rs[0], count: 3 };
  if (n === 4 && freq[0] === 3) return { type: 'triple1', weight: rs.find(r => cm.get(r) === 3), count: 4 };
  if (n === 5 && freq[0] === 3 && freq[1] === 2) return { type: 'triple2', weight: rs.find(r => cm.get(r) === 3), count: 5 };
  if (n >= 5 && rs.length === n && isConsecutive(rs)) return { type: 'straight', weight: rs.at(-1), count: n };
  if (n >= 6 && n % 2 === 0 && rs.length === n / 2 && isConsecutive(rs) && [...cm.values()].every(v => v === 2)) return { type: 'pairs', weight: rs.at(-1), count: n };
  if (n >= 6 && n % 3 === 0 && rs.length === n / 3 && isConsecutive(rs) && [...cm.values()].every(v => v === 3)) return { type: 'plane', weight: rs.at(-1), count: n };
  return { type: 'invalid', weight: 0, count: n };
}

export function canBeat(candidate, previous) {
  if (candidate.type === 'invalid' || candidate.type === 'pass') return false;
  if (!previous || previous.type === 'pass') return true;
  if (candidate.type === 'rocket') return true;
  if (previous.type === 'rocket') return false;
  if (candidate.type === 'bomb') return previous.type !== 'bomb' || candidate.weight > previous.weight;
  if (previous.type === 'bomb') return false;
  return candidate.type === previous.type && candidate.count === previous.count && candidate.weight > previous.weight;
}

function shuffle(cards) { const a = [...cards]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function randomSeat() { return Math.floor(Math.random() * 3); }

function startBidding(state, message, presetDeal = null) {
  const deck = presetDeal ? null : shuffle(createDeck());
  state.phase = 'bid';
  state.hands = presetDeal
    ? presetDeal.hands.map((hand) => sortCards(hand))
    : [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)].map(sortCards);
  state.bottom = presetDeal ? [...presetDeal.bottom] : deck.slice(51);
  state.landlord = null;
  state.firstBidder = presetDeal ? presetDeal.firstBidder : randomSeat();
  state.firstCaller = null;
  state.current = state.firstBidder;
  state.bidStage = 'call';
  state.bidRound = 0;
  state.landlordCandidate = null;
  state.robTurnsRemaining = 0;
  state.bidHistory = [];
  state.lastPlay = null;
  state.tablePlays = [null, null, null];
  state.tablePasses = [false, false, false];
  state.passCount = 0;
  state.playsBySeat = [0, 0, 0];
  state.bombCount = 0;
  state.rocketCount = 0;
  state.winner = null;
  state.log.push(`${message}，座位${state.firstBidder}开始叫地主`);
}

function finalizeLandlord(state) {
  state.landlord = state.landlordCandidate;
  state.hands[state.landlord].push(...state.bottom);
  state.hands[state.landlord] = sortCards(state.hands[state.landlord]);
  state.phase = 'play';
  state.bidStage = 'complete';
  state.current = state.landlord;
  state.log.push(`座位${state.landlord} 成为地主`);
}

export function createGame(gameId = `ddz-${Date.now()}`) {
  return {
    gameId,
    game: 'ddz',
    phase: 'waiting',
    hands: [[], [], []],
    bottom: [],
    landlord: null,
    firstBidder: null,
    firstCaller: null,
    current: null,
    bidStage: null,
    bidRound: 0,
    landlordCandidate: null,
    robTurnsRemaining: 0,
    bidHistory: [],
    lastPlay: null,
    tablePlays: [null, null, null],
    tablePasses: [false, false, false],
    passCount: 0,
    playsBySeat: [0, 0, 0],
    bombCount: 0,
    rocketCount: 0,
    winner: null,
    seq: 0,
    log: ['牌局创建，等待三家准备']
  };
}

export function startGame(state, presetDeal = null) {
  if (state.phase !== 'waiting') throw new Error('game_already_started');
  startBidding(state, presetDeal ? '同牌复战开始' : '对局开始', presetDeal);
  state.seq++;
}

export function publicState(state, seatId = null, debug = false) {
  const revealBottom = state.phase === 'play' || state.phase === 'over' || debug;
  const bottom = revealBottom ? state.bottom : [];
  const tablePlays = state.tablePlays || [null, null, null];
  const lastPlay = state.lastPlay
    ? { ...state.lastPlay, cards: (state.lastPlay.cards || []).map(cardView) }
    : null;

  return {
    gameId: state.gameId,
    game: state.game,
    sourceGameId: state.sourceGameId ?? null,
    phase: state.phase,
    landlord: state.landlord,
    firstBidder: state.firstBidder,
    firstCaller: state.firstCaller,
    current: state.current,
    bidStage: state.bidStage,
    bidRound: state.bidRound,
    landlordCandidate: state.landlordCandidate,
    robTurnsRemaining: state.robTurnsRemaining,
    bidHistory: state.bidHistory,
    cardEncoding: CARD_ENCODING,
    lastPlay,
    tablePlays: tablePlays.map((cards) => cards?.map(cardView) || null),
    tablePasses: state.tablePasses,
    passCount: state.passCount,
    playsBySeat: state.playsBySeat || [0, 0, 0],
    bombCount: state.bombCount || 0,
    rocketCount: state.rocketCount || 0,
    winner: state.winner,
    seq: state.seq,
    bottom: bottom.map(cardView),
    hands: state.hands.map((hand, index) => {
      const cards = debug || index === seatId ? hand : [];
      return { seatId: index, count: hand.length, cards: cards.map(cardView) };
    }),
    log: state.log.slice(-12)
  };
}

export function applyAction(state, seatId, action) {
  if (state.phase === 'waiting') throw new Error('game_not_started');
  if (state.winner !== null || state.current !== seatId) throw new Error('not_your_turn');
  state.tablePlays ||= [null, null, null];
  state.tablePasses ||= [false, false, false];
  if (state.phase === 'bid') {
    if (action.type !== 'bid' || ![0, 1].includes(action.value)) throw new Error('invalid_bid');
    state.bidStage ||= 'call';
    state.bidHistory ||= [];
    state.bidRound++;
    state.bidHistory.push({ seatId, stage: state.bidStage, value: action.value });
    if (state.bidStage === 'call') {
      state.log.push(`座位${seatId} ${action.value === 1 ? '叫地主' : '不叫'}`);
      if (action.value === 1) {
        state.firstCaller = seatId;
        state.landlordCandidate = seatId;
        state.bidStage = 'rob';
        state.robTurnsRemaining = 2;
        state.current = (seatId + 1) % 3;
      } else if (state.bidRound >= 3) {
        startBidding(state, '三家都不叫，重新发牌');
      } else state.current = (seatId + 1) % 3;
    } else if (state.bidStage === 'rob') {
      state.log.push(`座位${seatId} ${action.value === 1 ? '抢地主' : '不抢'}`);
      if (action.value === 1) state.landlordCandidate = seatId;
      state.robTurnsRemaining--;
      const completedCounterRob = seatId === state.firstCaller;
      if (state.robTurnsRemaining <= 0 && !completedCounterRob && state.landlordCandidate !== state.firstCaller) {
        state.robTurnsRemaining = 1;
        state.current = state.firstCaller;
        state.log.push(`座位${state.firstCaller} 获得最终抢地主机会`);
      } else if (state.robTurnsRemaining <= 0) finalizeLandlord(state);
      else state.current = (seatId + 1) % 3;
    } else throw new Error('invalid_bid_stage');
    state.seq++; return;
  }
  if (action.type === 'pass') {
    if (!state.lastPlay) throw new Error('cannot_pass_first');
    state.tablePasses[seatId] = true; state.passCount++; state.log.push(`座位${seatId} 不要`); if (state.passCount >= 2) { state.lastPlay = null; state.tablePlays = [null, null, null]; state.passCount = 0; } state.current = (seatId + 1) % 3; state.seq++; return;
  }
  if (state.phase !== 'play') throw new Error('invalid_action');
  if (action.type !== 'play' || !Array.isArray(action.cards)) throw new Error('invalid_action');
  const hand = state.hands[seatId]; if (new Set(action.cards).size !== action.cards.length || action.cards.some(c => !hand.includes(c))) throw new Error('cards_not_in_hand');
  const play = describePlay(action.cards); if (!canBeat(play, state.lastPlay)) throw new Error('illegal_play');
  const playedCards = sortCards(action.cards);
  if (!state.lastPlay) { state.tablePlays = [null, null, null]; state.tablePasses = [false, false, false]; }
  state.tablePasses[seatId] = false; state.hands[seatId] = hand.filter(c => !action.cards.includes(c)); state.lastPlay = { ...play, seatId, cards: playedCards }; state.tablePlays[seatId] = playedCards; state.passCount = 0; state.log.push(`座位${seatId} 出牌 ${action.cards.map(cardLabel).join(' ')}`);
  state.playsBySeat ||= [0, 0, 0]; state.playsBySeat[seatId] += 1;
  if (play.type === 'bomb') state.bombCount = (state.bombCount || 0) + 1;
  if (play.type === 'rocket') state.rocketCount = (state.rocketCount || 0) + 1;
  if (state.hands[seatId].length === 0) { state.winner = state.landlord === seatId ? 'landlord' : 'farmers'; state.phase = 'over'; state.log.push(state.winner === 'landlord' ? '地主获胜' : '农民获胜'); } else state.current = (seatId + 1) % 3;
  state.seq++;
}

export function chooseSimpleAction(state, seatId) {
  if (state.phase === 'bid') return { type: 'bid', value: state.bidStage === 'call' ? 1 : 0 };
  const hand = state.hands[seatId]; const previous = state.lastPlay; const candidates = hand.map(card => [card]);
  if (previous?.type === 'pair') for (const r of ranks(hand)) { const same = hand.filter(c => Number(c.split(':')[0]) === r); if (same.length >= 2) candidates.push(same.slice(0, 2)); }
  if (previous?.type === 'triple') for (const r of ranks(hand)) { const same = hand.filter(c => Number(c.split(':')[0]) === r); if (same.length >= 3) candidates.push(same.slice(0, 3)); }
  const play = candidates.find(c => canBeat(describePlay(c), previous)); return play ? { type: 'play', cards: play } : { type: 'pass' };
}
