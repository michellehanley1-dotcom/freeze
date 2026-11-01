// Freeze: game rules. Pure functions over one plain JSON state object.
// Every action takes the current state, checks it is allowed, and changes it.

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUIT_SYMBOL = { S: '♠︎', H: '♥︎', D: '♦︎', C: '♣︎' };
export const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
export const MAX_PLAYERS = 6;
export const WIN_TOTAL = 4;
export const MAX_STACK = 2; // never 3 of the same rank stacked on the discard pile
export const POWERS = { '7': 'p7', '8': 'p8', '10': 'p10' };
export const POWER_NAMES = { '7': 'Peek at yours', '8': "Peek at a rival's", '10': 'Blind swap' };

export const rankOf = (c) => c.slice(0, -1);
export const suitOf = (c) => c.slice(-1);
export const isRed = (c) => suitOf(c) === 'H' || suitOf(c) === 'D';
export function value(c) {
  const r = rankOf(c);
  if (r === 'A') return 1;
  if (r === 'J' || r === 'Q') return 10;
  if (r === 'K') return isRed(c) ? 0 : -2;
  return Number(r);
}
export const label = (c) => rankOf(c) + SUIT_SYMBOL[suitOf(c)];
const an = (rank) => (rank === 'A' || rank === '8' ? 'an' : 'a');
export const handTotal = (h) => (h || []).reduce((s, c) => s + value(c), 0);

export function shuffle(a, rng = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function newDeck(rng = Math.random) {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return shuffle(d, rng);
}

export class RuleError extends Error {}
const fail = (msg) => { throw new RuleError(msg); };

const playerOf = (st, id) => st.players.find((p) => p.id === id);
export const nameOf = (st, id) => (playerOf(st, id) || {}).name || 'Someone';
export const activeIds = (st) => st.players.filter((p) => !(st.out || {})[p.id]).map((p) => p.id);
export const currentId = (st) => (st.seats || [])[st.turn];
export const roundsToWin = (st) => Math.ceil(st.settings.bestOf / 2);
export const topDiscard = (st) => (st.discard || [])[(st.discard || []).length - 1] || null;

// ---------- Lobby ----------

export function cleanProfile(p) {
  const name = String(p.name || '').trim().slice(0, 14) || 'Player';
  const icon = String(p.icon || '').slice(0, 8) || '❄️';
  const color = Math.max(0, Math.min(7, Math.round(Number(p.color) || 0)));
  return { name, icon, color };
}

export function createRoom(code, host, now = Date.now()) {
  return {
    code,
    hostId: host.id,
    status: 'lobby',
    settings: { mode: 'rounds', bestOf: 3, limit: 100 },
    players: [{ id: host.id, ...cleanProfile(host) }],
    round: 0, wins: {}, scores: {}, out: {},
    last: { text: 'Room created', t: now },
  };
}

export function join(st, p, now = Date.now()) {
  const prof = cleanProfile(p);
  const existing = playerOf(st, p.id);
  if (existing) { Object.assign(existing, prof); return st; }
  if (st.status !== 'lobby') fail('This game already started');
  if (st.players.length >= MAX_PLAYERS) fail('This room is full');
  st.players.push({ id: p.id, ...prof });
  st.last = { text: `${prof.name} joined`, t: now };
  return st;
}

export function leave(st, id, now = Date.now()) {
  if (st.status !== 'lobby') return st;
  st.players = st.players.filter((p) => p.id !== id);
  if (st.hostId === id && st.players.length) st.hostId = st.players[0].id;
  st.last = { text: 'A player left', t: now };
  return st;
}

export function setSettings(st, by, s) {
  if (by !== st.hostId) fail('Only the host can change the game');
  if (st.status !== 'lobby') fail('The game already started');
  st.settings = {
    mode: s.mode === 'points' ? 'points' : 'rounds',
    bestOf: Number(s.bestOf) === 5 ? 5 : 3,
    limit: Math.max(25, Math.min(500, Math.round(Number(s.limit) || 100))),
  };
  return st;
}

// ---------- Rounds ----------

export function startGame(st, by, rng, now = Date.now()) {
  if (by !== st.hostId) fail('Only the host can start');
  if (st.status !== 'lobby') fail('The game already started');
  if (st.players.length < 2) fail('You need at least 2 players');
  st.round = 0; st.wins = {}; st.scores = {}; st.out = {};
  st.gameId = st.code + '-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  return startRound(st, rng, now);
}

export function startRound(st, rng = Math.random, now = Date.now()) {
  const seats = activeIds(st);
  const deck = newDeck(rng);
  const hands = {};
  for (const id of seats) hands[id] = [deck.pop(), deck.pop(), deck.pop(), deck.pop()];
  st.round += 1;
  Object.assign(st, {
    status: 'peek', seats, deck, hands, discard: [], ready: {},
    turn: (st.round - 1) % seats.length, phase: 'choose',
    drawn: null, from: null, freezeBy: null, finalLeft: 0,
    reveal: null, results: null, champions: null,
  });
  st.last = { text: `Round ${st.round}: peek at 2 cards`, t: now };
  return st;
}

export function markReady(st, id, now = Date.now()) {
  if (st.status !== 'peek') fail('Not peeking right now');
  if (!st.seats.includes(id)) fail("You're not in this round");
  st.ready[id] = true;
  if (st.seats.every((s) => st.ready[s])) {
    st.status = 'playing';
    st.phase = 'choose';
    st.last = { text: `${nameOf(st, currentId(st))} goes first`, t: now };
  }
  return st;
}

export function nextRound(st, by, rng, now = Date.now()) {
  if (by !== st.hostId) fail('Only the host can deal');
  if (st.status !== 'roundEnd') fail('The round is still going');
  return startRound(st, rng, now);
}

export function newGame(st, by, now = Date.now()) {
  if (by !== st.hostId) fail('Only the host can start a new game');
  if (st.status !== 'over') fail('The game is still going');
  Object.assign(st, {
    status: 'lobby', round: 0, wins: {}, scores: {}, out: {},
    seats: null, hands: null, deck: null, discard: null, results: null, champions: null,
  });
  st.last = { text: 'New game', t: now };
  return st;
}

// ---------- Turns ----------

function requireTurn(st, id, phases) {
  if (st.status !== 'playing') fail('The game is not in play');
  if (currentId(st) !== id) fail("It's not your turn");
  if (phases && ![].concat(phases).includes(st.phase)) fail("You can't do that right now");
}

function pickIndex(hand, i) {
  if (!Number.isInteger(i) || i < 0 || i >= hand.length) fail('Pick one of the cards');
}

function drawFromDeck(st) {
  if (!st.deck.length) {
    const top = st.discard.pop();
    st.deck = shuffle(st.discard);
    st.discard = top ? [top] : [];
  }
  return st.deck.length ? st.deck.pop() : null;
}

function advance(st) {
  st.turn = (st.turn + 1) % st.seats.length;
  st.phase = 'choose';
  st.drawn = null; st.from = null; st.reveal = null;
}

function endTurn(st, now) {
  st.drawn = null; st.from = null; st.reveal = null;
  if (st.freezeBy) {
    st.finalLeft -= 1;
    if (st.finalLeft <= 0) return endRound(st, now);
  }
  advance(st);
  return st;
}

export function draw(st, id, now = Date.now()) {
  requireTurn(st, id, 'choose');
  const c = drawFromDeck(st);
  if (!c) { st.last = { text: 'The deck ran out', t: now }; return endRound(st, now); }
  st.drawn = c; st.from = 'deck'; st.phase = 'drawn';
  st.last = { text: `${nameOf(st, id)} drew a card`, t: now };
  return st;
}

export function takeDiscard(st, id, now = Date.now()) {
  requireTurn(st, id, 'choose');
  if (!st.discard.length) fail('The discard pile is empty');
  if (!st.hands[id].length) fail('You have no cards to swap with');
  st.drawn = st.discard.pop(); st.from = 'discard'; st.phase = 'drawn';
  st.last = { text: `${nameOf(st, id)} took the ${label(st.drawn)}`, t: now };
  return st;
}

export function swapIn(st, id, idx, now = Date.now()) {
  requireTurn(st, id, 'drawn');
  const h = st.hands[id];
  pickIndex(h, idx);
  const old = h[idx];
  h[idx] = st.drawn;
  st.discard.push(old);
  st.last = { text: `${nameOf(st, id)} swapped a card, threw ${label(old)}`, t: now, flash: { id, i: idx } };
  return endTurn(st, now);
}

export function discardDrawn(st, id, now = Date.now()) {
  requireTurn(st, id, 'drawn');
  if (st.from !== 'deck') fail('A card taken from the discard pile has to be swapped in');
  st.discard.push(st.drawn);
  st.last = { text: `${nameOf(st, id)} threw ${label(st.drawn)}`, t: now };
  return endTurn(st, now);
}

export function usePower(st, id, now = Date.now()) {
  requireTurn(st, id, 'drawn');
  const r = rankOf(st.drawn);
  const p = st.from === 'deck' && POWERS[r];
  if (!p) fail('That card has no power');
  const rivalsHaveCards = st.seats.some((x) => x !== id && st.hands[x].length);
  if ((p === 'p7' || p === 'p10') && !st.hands[id].length) fail('You have no cards to use that on');
  if ((p === 'p8' || p === 'p10') && !rivalsHaveCards) fail('No rival has cards to use that on');
  st.discard.push(st.drawn);
  st.last = { text: `${nameOf(st, id)} played ${an(r)} ${r}: ${POWER_NAMES[r]}`, t: now };
  st.drawn = null; st.from = null; st.phase = p;
  return st;
}

export function peekOwn(st, id, idx, now = Date.now()) {
  requireTurn(st, id, 'p7');
  pickIndex(st.hands[id], idx);
  st.reveal = { by: id, owner: id, idx };
  st.phase = 'reveal';
  st.last = { text: `${nameOf(st, id)} is peeking at one of their cards`, t: now };
  return st;
}

export function peekOther(st, id, owner, idx, now = Date.now()) {
  requireTurn(st, id, 'p8');
  if (owner === id || !st.hands[owner]) fail("Pick a rival's card");
  pickIndex(st.hands[owner], idx);
  st.reveal = { by: id, owner, idx };
  st.phase = 'reveal';
  st.last = { text: `${nameOf(st, id)} is peeking at ${nameOf(st, owner)}'s card`, t: now, flash: { id: owner, i: idx } };
  return st;
}

export function doneReveal(st, id, now = Date.now()) {
  requireTurn(st, id, 'reveal');
  return endTurn(st, now);
}

export function blindSwap(st, id, myIdx, owner, theirIdx, now = Date.now()) {
  requireTurn(st, id, 'p10');
  if (owner === id || !st.hands[owner]) fail("Pick a rival's card");
  const a = st.hands[id], b = st.hands[owner];
  pickIndex(a, myIdx); pickIndex(b, theirIdx);
  [a[myIdx], b[theirIdx]] = [b[theirIdx], a[myIdx]];
  st.last = {
    text: `${nameOf(st, id)} swapped a card with ${nameOf(st, owner)}`, t: now,
    flash: { id: owner, i: theirIdx }, flash2: { id, i: myIdx },
  };
  return endTurn(st, now);
}

export function match(st, id, idx, now = Date.now()) {
  requireTurn(st, id, 'choose');
  const top = topDiscard(st);
  if (!top) fail('Nothing to match yet');
  const h = st.hands[id];
  pickIndex(h, idx);
  const c = h[idx];
  const sameRank = rankOf(c) === rankOf(top);
  if (sameRank && topRun(st) < MAX_STACK) {
    h.splice(idx, 1);
    st.discard.push(c);
    st.last = { text: `${nameOf(st, id)} matched the ${rankOf(top)}! Down to ${h.length} card${h.length === 1 ? '' : 's'}`, t: now };
  } else {
    // Penalty: the card goes back where it was, and they draw one.
    const x = drawFromDeck(st);
    if (x) h.push(x);
    st.last = {
      text: sameRank
        ? `${nameOf(st, id)} tried a third ${rankOf(top)}. Not allowed! Draws 1`
        : `${nameOf(st, id)} tried ${an(rankOf(c))} ${label(c)} on the ${rankOf(top)}. Wrong! Draws 1`,
      t: now,
    };
  }
  return endTurn(st, now);
}

// How many cards of the same rank sit on top of the discard pile.
export function topRun(st) {
  const d = st.discard || [];
  if (!d.length) return 0;
  const r = rankOf(d[d.length - 1]);
  let n = 0;
  for (let i = d.length - 1; i >= 0 && rankOf(d[i]) === r; i--) n++;
  return n;
}

export function callFreeze(st, id, now = Date.now()) {
  requireTurn(st, id, 'choose');
  if (st.freezeBy) fail('Freeze was already called');
  st.freezeBy = id;
  st.finalLeft = st.seats.length - 1;
  st.last = { text: `${nameOf(st, id)} called FREEZE! One last turn each`, t: now, freeze: true };
  if (st.finalLeft <= 0) return endRound(st, now);
  advance(st);
  return st;
}

// ---------- Scoring ----------

export function endRound(st, now = Date.now()) {
  const totals = {};
  for (const id of st.seats) totals[id] = handTotal(st.hands[id]);
  let winners = [];
  if (st.settings.mode === 'rounds') {
    const eligible = st.seats.filter((id) => totals[id] <= WIN_TOTAL);
    if (eligible.length) {
      const m = Math.min(...eligible.map((id) => totals[id]));
      winners = eligible.filter((id) => totals[id] === m);
      for (const id of winners) st.wins[id] = (st.wins[id] || 0) + 1;
    }
    const need = roundsToWin(st);
    const champs = st.players.filter((p) => (st.wins[p.id] || 0) >= need).map((p) => p.id);
    if (champs.length) st.champions = champs;
  } else {
    const m = Math.min(...st.seats.map((id) => totals[id]));
    winners = st.seats.filter((id) => totals[id] === m);
    for (const id of st.seats) {
      st.scores[id] = (st.scores[id] || 0) + totals[id];
      if (st.scores[id] >= st.settings.limit) st.out[id] = true;
    }
    const alive = st.players.filter((p) => !st.out[p.id]).map((p) => p.id);
    if (alive.length === 1) st.champions = alive;
    else if (alive.length === 0) {
      const best = Math.min(...st.seats.map((id) => st.scores[id]));
      st.champions = st.seats.filter((id) => st.scores[id] === best);
    }
  }
  st.results = { totals, winners, freezeBy: st.freezeBy };
  st.status = st.champions ? 'over' : 'roundEnd';
  st.phase = null; st.drawn = null; st.from = null; st.reveal = null;
  st.last = {
    text: winners.length
      ? `${winners.map((id) => nameOf(st, id)).join(' & ')} won round ${st.round}`
      : `Nobody got to ${WIN_TOTAL} or less in round ${st.round}`,
    t: now,
  };
  return st;
}

// ---------- One entry point for every action ----------

export function apply(st, a, by, now = Date.now(), rng = Math.random) {
  switch (a.type) {
    case 'join': return join(st, { id: by, name: a.name, icon: a.icon, color: a.color }, now);
    case 'leave': return leave(st, by, now);
    case 'settings': return setSettings(st, by, a.settings);
    case 'start': return startGame(st, by, rng, now);
    case 'ready': return markReady(st, by, now);
    case 'draw': return draw(st, by, now);
    case 'take': return takeDiscard(st, by, now);
    case 'swap': return swapIn(st, by, a.idx, now);
    case 'discard': return discardDrawn(st, by, now);
    case 'power': return usePower(st, by, now);
    case 'peekOwn': return peekOwn(st, by, a.idx, now);
    case 'peekOther': return peekOther(st, by, a.owner, a.idx, now);
    case 'done': return doneReveal(st, by, now);
    case 'blindSwap': return blindSwap(st, by, a.idx, a.owner, a.theirIdx, now);
    case 'match': return match(st, by, a.idx, now);
    case 'freeze': return callFreeze(st, by, now);
    case 'next': return nextRound(st, by, rng, now);
    case 'newGame': return newGame(st, by, now);
    default: fail('Unknown action');
  }
}
