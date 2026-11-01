// Freeze: computer players for solo games.
// Bots only use what a real player could know: cards they peeked at, swapped in,
// or looked at with a 7 or 8. Easy bots forget some of what they see.
import * as G from './game.js';

export const BOTS = [
  { id: 'bot1', name: 'Frosty', icon: '⛄', color: 6 },
  { id: 'bot2', name: 'Blizzard', icon: '\u{1F43B}‍❄️', color: 1 },
  { id: 'bot3', name: 'Icicle', icon: '\u{1F427}', color: 4 },
];
export const isBot = (id) => typeof id === 'string' && id.startsWith('bot');

const UNKNOWN = 6; // what a bot assumes an unseen card is worth
const memory = new Map();
function mem(st, id) {
  const k = `${id}:${st.gameId}:${st.round}`;
  if (!memory.has(k)) memory.set(k, { own: new Set(), opp: new Set() });
  return memory.get(k);
}
function remember(st, id, set, card) {
  if (!card) return;
  if (st.solo && st.solo.level === 'easy' && Math.random() < 0.3) return; // easy bots forget
  mem(st, id)[set].add(card);
}

const rivalsWithCards = (st, id) => st.seats.filter((x) => x !== id && (st.hands[x] || []).length);
const randomOf = (a) => a[Math.floor(Math.random() * a.length)];

function knownView(st, id) {
  const m = mem(st, id);
  const hand = st.hands[id] || [];
  const vals = hand.map((c) => (m.own.has(c) ? G.value(c) : null));
  const est = vals.reduce((s, v) => s + (v === null ? UNKNOWN : v), 0);
  const unknown = vals.filter((v) => v === null).length;
  let wi = -1;
  let wv = -Infinity;
  vals.forEach((v, i) => { const e = v === null ? UNKNOWN : v; if (e > wv) { wv = e; wi = i; } });
  return { m, hand, vals, est, unknown, wi, wv };
}

// Pick the next action for a bot whose turn it is.
export function decide(st, id) {
  const hard = st.solo && st.solo.level === 'hard';
  const { m, hand, vals, est, unknown, wi, wv } = knownView(st, id);
  const top = G.topDiscard(st);
  switch (st.phase) {
    case 'choose': {
      if (!st.freezeBy && unknown === 0 && est <= (hard ? 4 : 3)) return { type: 'freeze' };
      if (!st.freezeBy && hard && unknown === 1 && est - UNKNOWN <= 0) return { type: 'freeze' };
      if (top && G.topRun(st) < G.MAX_STACK) {
        const i = hand.findIndex((c) => m.own.has(c) && G.rankOf(c) === G.rankOf(top) && G.value(c) > 0);
        if (i >= 0) return { type: 'match', idx: i };
      }
      if (top && hand.length && G.value(top) <= (hard ? 3 : 2) && G.value(top) < wv) return { type: 'take' };
      return { type: 'draw' };
    }
    case 'drawn': {
      if (st.from === 'discard' || !hand.length) return st.from === 'discard' ? { type: 'swap', idx: Math.max(0, wi) } : { type: 'discard' };
      const dv = G.value(st.drawn);
      if (dv < wv - (hard ? 0 : 1)) return { type: 'swap', idx: wi };
      const p = G.POWERS[G.rankOf(st.drawn)];
      const rivals = rivalsWithCards(st, id);
      if (p === 'p7' && unknown > 0) return { type: 'power' };
      if (p === 'p8' && rivals.length) return { type: 'power' };
      if (p === 'p10' && rivals.length && wv >= 7) return { type: 'power' };
      return { type: 'discard' };
    }
    case 'p7': {
      const i = vals.findIndex((v) => v === null);
      return { type: 'peekOwn', idx: i < 0 ? 0 : i };
    }
    case 'p8': {
      const o = randomOf(rivalsWithCards(st, id));
      const unseen = st.hands[o].map((c, i) => (m.opp.has(c) ? -1 : i)).filter((i) => i >= 0);
      return { type: 'peekOther', owner: o, idx: unseen.length ? randomOf(unseen) : 0 };
    }
    case 'p10': {
      // Grab a low card we've spotted on a rival's side, otherwise a random one.
      let target = null;
      for (const o of rivalsWithCards(st, id)) {
        st.hands[o].forEach((c, i) => {
          if (m.opp.has(c) && G.value(c) <= 2 && (!target || G.value(c) < G.value(st.hands[target.o][target.i]))) target = { o, i };
        });
      }
      if (!target) { const o = randomOf(rivalsWithCards(st, id)); target = { o, i: Math.floor(Math.random() * st.hands[o].length) }; }
      return { type: 'blindSwap', idx: Math.max(0, wi), owner: target.o, theirIdx: target.i };
    }
    case 'post': {
      // After a move: call freeze if the hand is clearly low, otherwise end the turn.
      const want = !st.freezeBy && unknown === 0 && est <= (hard ? 4 : 3);
      return want ? { type: 'freeze' } : { type: 'pass' };
    }
    case 'reveal': return { type: 'done' };
    default: return null;
  }
}

// Update a bot's memory with what it learns from its own action (call with the state before the action).
export function note(st, id, a) {
  const hand = st.hands[id] || [];
  switch (a.type) {
    case 'ready': hand.slice(0, 2).forEach((c) => remember(st, id, 'own', c)); break;
    case 'swap': remember(st, id, 'own', st.drawn); break;
    case 'peekOwn': remember(st, id, 'own', hand[a.idx]); break;
    case 'peekOther': remember(st, id, 'opp', st.hands[a.owner][a.idx]); break;
    case 'blindSwap': {
      const m = mem(st, id);
      const got = st.hands[a.owner][a.theirIdx];
      m.own.delete(hand[a.idx]);
      if (m.opp.has(got)) { m.opp.delete(got); m.own.add(got); }
      break;
    }
    default:
  }
}

// A safe move if a planned one is refused, so a bot never stalls the game.
export function fallback(st, id) {
  const hand = st.hands[id] || [];
  switch (st.phase) {
    case 'choose': return { type: 'draw' };
    case 'drawn': return st.from === 'discard' ? { type: 'swap', idx: 0 } : { type: 'discard' };
    case 'p7': return { type: 'peekOwn', idx: 0 };
    case 'p8': { const o = rivalsWithCards(st, id)[0]; return { type: 'peekOther', owner: o, idx: 0 }; }
    case 'p10': { const o = rivalsWithCards(st, id)[0]; return { type: 'blindSwap', idx: 0, owner: o, theirIdx: 0 }; }
    case 'post': return { type: 'pass' };
    case 'reveal': return { type: 'done' };
    default: return null;
  }
}
