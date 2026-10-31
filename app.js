import * as G from './game.js';

// ---------- Backends: Firebase for real play, browser storage for demo mode ----------

async function makeBackend() {
  const cfg = window.FREEZE_FIREBASE;
  if (cfg && cfg.apiKey && !cfg.apiKey.startsWith('PASTE') && cfg.databaseURL) {
    try { return await firebaseBackend(cfg); }
    catch (e) { console.error(e); ui.err = 'Could not reach Firebase. Running in demo mode.'; }
  }
  return localBackend();
}

async function firebaseBackend(cfg) {
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const [appM, authM, dbM] = await Promise.all([
    import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-database.js'),
  ]);
  const app = appM.initializeApp(cfg);
  const auth = authM.getAuth(app);
  const uid = await new Promise((resolve, reject) => {
    const off = authM.onAuthStateChanged(auth, (u) => { if (u) { off(); resolve(u.uid); } });
    authM.signInAnonymously(auth).catch(reject);
  });
  const db = dbM.getDatabase(app);
  const roomRef = (code) => dbM.ref(db, 'rooms/' + code);
  return {
    uid, demo: false,
    subscribe(code, cb) {
      return dbM.onValue(roomRef(code), (snap) => { const v = snap.val(); cb(v && v.s ? JSON.parse(v.s) : null); });
    },
    async transact(code, fn) {
      let err = null;
      await dbM.runTransaction(roomRef(code), (cur) => {
        try {
          const st = cur && cur.s ? JSON.parse(cur.s) : null;
          return { s: JSON.stringify(fn(st)), t: Date.now() };
        } catch (e) { err = e; return undefined; }
      }, { applyLocally: false });
      if (err) throw err;
    },
  };
}

function localBackend() {
  let uid = sessionStorage.getItem('freeze:uid');
  if (!uid) { uid = 'p' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('freeze:uid', uid); }
  const key = (c) => 'freeze:room:' + c;
  const subs = new Map();
  const read = (c) => { const v = localStorage.getItem(key(c)); return v ? JSON.parse(v) : null; };
  const notify = (c) => (subs.get(c) || []).forEach((cb) => cb(read(c)));
  addEventListener('storage', (e) => { if (e.key && e.key.startsWith('freeze:room:')) notify(e.key.slice(12)); });
  return {
    uid, demo: true,
    subscribe(code, cb) {
      subs.set(code, (subs.get(code) || []).concat(cb));
      setTimeout(() => cb(read(code)));
      return () => subs.set(code, (subs.get(code) || []).filter((x) => x !== cb));
    },
    async transact(code, fn) {
      localStorage.setItem(key(code), JSON.stringify(fn(read(code))));
      notify(code);
    },
  };
}

// ---------- App state ----------

const $app = document.getElementById('app');
const COLORS = ['#F2B544', '#6EA8FE', '#F27BA0', '#8FD3A8', '#C49BFF', '#F2734A'];
const ui = {
  backend: null, me: null, code: null, st: null, unsub: null,
  name: localStorage.getItem('freeze:name') || '',
  mode: null, sel: null, opening: [], phaseKey: '', toastT: 0,
  err: null, errTimer: null, rules: false, busy: false,
};

const SNOW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 3l3 3 3-3M9 21l3-3 3 3"/></svg>';
const ICON = {
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  help: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17.5h.01"/></svg>',
  chat: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  copy: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const player = (st, id) => st.players.find((p) => p.id === id);
const nm = (st, id) => (id === ui.me ? 'You' : esc(G.nameOf(st, id)));
const isHost = (st) => st.hostId === ui.me;

function showError(msg) {
  ui.err = msg;
  clearTimeout(ui.errTimer);
  ui.errTimer = setTimeout(() => { ui.err = null; render(); }, 2800);
  render();
}

// ---------- Card + avatar markup ----------

function cardName(c) { return `${G.rankOf(c)} of ${G.SUIT_NAME[G.suitOf(c)]}`; }

function card(c, o = {}) {
  const up = o.up && c;
  const cls = ['card', o.size || 'md', up ? 'up' : 'down', up && G.isRed(c) ? 'red' : '',
    o.act ? 'tap' : '', o.sel ? 'sel' : '', o.glow ? 'glow' : '', o.flash ? 'flash' : '', o.cls || ''].join(' ');
  const inner = up
    ? `<span class="cr">${esc(G.rankOf(c))}<i>${G.SUIT_SYMBOL[G.suitOf(c)]}</i></span><span class="cs">${G.SUIT_SYMBOL[G.suitOf(c)]}</span><span class="cv">${G.value(c)}</span>`
    : `<span class="bk">${SNOW}</span>`;
  const aria = up ? cardName(c) : (o.aria || 'Face-down card');
  if (!o.act) return `<div class="${cls}" role="img" aria-label="${esc(aria)}">${inner}</div>`;
  const data = Object.entries(o.data || {}).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<button type="button" class="${cls}" data-act="${o.act}" ${data} aria-label="${esc(aria)}">${inner}</button>`;
}

function avatar(st, id, size = 32) {
  const p = player(st, id) || { name: '?', color: 0 };
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:${COLORS[p.color % COLORS.length]}">${esc((p.name || '?')[0].toUpperCase())}</span>`;
}

// ---------- Screens ----------

function renderHome() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') || '').toUpperCase();
  return `<section class="screen">
    <div style="display:flex;flex-direction:column;gap:6px;margin-top:12px">
      <p class="eyebrow">A memory card game</p>
      <h1 class="wordmark">FREEZE</h1>
      <p class="sub">Get your hand to 4 or less. Remember what you saw.</p>
    </div>
    <div class="fan" aria-hidden="true">
      ${card('KS', { up: true, size: 'lg', cls: 'c1' })}${card('KH', { up: true, size: 'lg', cls: 'c2' })}${card('AC', { up: true, size: 'lg', cls: 'c3' })}
    </div>
    <div class="panel">
      <label class="lbl" for="name">Your name</label>
      <input id="name" class="field" maxlength="14" autocomplete="nickname" placeholder="Name" value="${esc(ui.name)}">
      ${code ? `<p class="sub" style="font-size:14px">Joining room <b>${esc(code)}</b></p>
        <button type="button" class="btn primary wide" data-act="join" data-code="${esc(code)}">Join the table</button>`
      : `<button type="button" class="btn primary wide" data-act="create">Start a new game</button>
        <div class="row"><input id="code" class="field code grow" maxlength="4" placeholder="CODE" autocapitalize="characters" aria-label="Room code"><button type="button" class="btn" data-act="join">Join</button></div>`}
    </div>
    ${ui.backend && ui.backend.demo ? `<p class="banner">Demo mode: open this page in a few browser tabs to test as different players. Add your Firebase keys to play on separate phones.</p>` : ''}
  </section>`;
}

function renderLobby(st) {
  const host = isHost(st);
  const s = st.settings;
  const players = st.players.map((p) => `<li>${avatar(st, p.id)}<span class="nm">${p.id === ui.me ? 'You' : esc(p.name)}</span>${p.id === st.hostId ? '<span class="pill host">Host</span>' : '<span class="pill ok">Ready</span>'}</li>`).join('');
  const modes = `
    <div class="mode ${s.mode === 'rounds' ? 'on' : ''}">
      <button type="button" class="head" data-act="mode" data-mode="rounds" ${host ? '' : 'disabled'} aria-pressed="${s.mode === 'rounds'}"><span class="radio"></span><span><span class="mt">Rounds</span><span class="md">Win the most rounds to take the game.</span></span></button>
      <div class="body seg">
        <button type="button" class="btn small ${s.bestOf === 3 ? 'on' : ''}" data-act="bestof" data-n="3" ${host ? '' : 'disabled'} aria-pressed="${s.bestOf === 3}">Best of 3</button>
        <button type="button" class="btn small ${s.bestOf === 5 ? 'on' : ''}" data-act="bestof" data-n="5" ${host ? '' : 'disabled'} aria-pressed="${s.bestOf === 5}">Best of 5</button>
      </div>
    </div>
    <div class="mode ${s.mode === 'points' ? 'on' : ''}">
      <button type="button" class="head" data-act="mode" data-mode="points" ${host ? '' : 'disabled'} aria-pressed="${s.mode === 'points'}"><span class="radio"></span><span><span class="mt">Points</span><span class="md">Hand totals add up. Hit the limit and you're out.</span></span></button>
      <div class="body stepper">
        <span class="grow" style="font-size:14px;color:var(--muted)">Play to</span>
        <button type="button" class="icon-btn" data-act="limit" data-d="-25" aria-label="Lower limit" ${host ? '' : 'disabled'}>−</button>
        <span class="val">${s.limit}</span>
        <button type="button" class="icon-btn" data-act="limit" data-d="25" aria-label="Raise limit" ${host ? '' : 'disabled'}>+</button>
      </div>
    </div>`;
  return `<section class="screen">
    <div class="row"><button type="button" class="icon-btn" data-act="home" aria-label="Leave room">${ICON.back}</button><span class="grow"></span><button type="button" class="icon-btn" data-act="rules" aria-label="Rules">${ICON.help}</button></div>
    <h1 class="wordmark" style="font-size:56px">FREEZE</h1>
    <div class="panel">
      <div class="row">
        <div class="grow" style="display:flex;flex-direction:column;gap:2px"><span class="eyebrow">Room code</span><span class="codebig">${esc(st.code)}</span></div>
        <button type="button" class="icon-btn" data-act="copy" aria-label="Copy invite link">${ICON.copy}</button>
      </div>
      <ul class="plist">${players}</ul>
    </div>
    <div class="panel">
      <span class="eyebrow">${host ? 'How are we playing?' : 'Game settings (host picks)'}</span>
      ${modes}
    </div>
    ${ui.backend.demo ? `<p class="banner">Demo mode: open this link in another tab to add a player.</p>` : ''}
    <div style="margin-top:auto;display:flex;flex-direction:column;gap:10px">
      <button type="button" class="btn primary wide" data-act="invite">${ICON.chat} Invite via iMessage</button>
      ${host ? `<button type="button" class="btn wide" data-act="start" ${st.players.length < 2 ? 'disabled' : ''}>${st.players.length < 2 ? 'Waiting for players…' : `Deal the cards · ${st.players.length} players`}</button>`
      : `<p class="waiting">Waiting for <b>${esc(G.nameOf(st, st.hostId))}</b> to deal…</p>`}
    </div>
  </section>`;
}

function renderPeek(st) {
  const hand = st.hands[ui.me];
  if (!hand) return renderSpectator(st, 'Round in progress. You\'ll join the next game.');
  const ready = st.ready[ui.me];
  const need = Math.min(2, hand.length);
  const cards = hand.map((c, i) => {
    const seen = !ready && ui.opening.includes(i);
    const canTap = !ready && !seen && ui.opening.length < need;
    return card(c, { size: 'xl', up: seen, act: canTap ? 'openPeek' : null, data: { i }, cls: seen ? 'mine-seen' : '' });
  }).join('');
  const waitingFor = st.seats.filter((id) => !st.ready[id]).map((id) => nm(st, id));
  return `<section class="screen">
    <div class="row"><span class="eyebrow grow">Round ${st.round}</span><span class="pill" style="border:1px solid #2C3A33;color:var(--soft)">${st.seats.length} players</span></div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <h1 class="title" style="font-size:40px">${ready ? 'Locked in.' : 'Memorize<br>two cards.'}</h1>
      <p class="sub">${ready ? 'Your cards are face down again. Good luck.' : `Tap ${need === 2 ? 'two cards' : 'a card'} to look. Once you hit the button, they flip back for good.`}</p>
    </div>
    <div class="peekgrid">${cards}</div>
    <div style="margin-top:auto;display:flex;flex-direction:column;gap:10px">
      ${ready ? `<p class="waiting">Waiting for ${waitingFor.join(', ')}…</p>`
      : `<p class="waiting">Peeked ${ui.opening.length} of ${need}</p>
        <button type="button" class="btn primary wide" data-act="ready" ${ui.opening.length < need ? 'disabled' : ''}>Got it, I'll remember</button>`}
    </div>
  </section>`;
}

function renderSpectator(st, msg) {
  return `<section class="screen"><div class="row"><button type="button" class="icon-btn" data-act="home" aria-label="Leave">${ICON.back}</button></div>
    <h1 class="title" style="font-size:36px">Hang tight</h1><p class="sub">${esc(msg)}</p></section>`;
}

function seatPos(i, k) {
  if (k === 1) return [50, 2];
  const [from, to] = k === 2 ? [145, 35] : k === 3 ? [160, 20] : [168, 12];
  const a = ((from - ((from - to) * i) / (k - 1)) * Math.PI) / 180;
  return [50 + 40 * Math.cos(a), 2 + 46 * (1 - Math.sin(a))];
}

function renderTable(st) {
  const me = ui.me;
  const cur = G.currentId(st);
  const seated = st.seats.includes(me);
  const myTurn = st.status === 'playing' && cur === me;
  const ph = st.phase;
  const top = G.topDiscard(st);
  const mi = st.seats.indexOf(me);
  const others = mi >= 0 ? st.seats.slice(mi + 1).concat(st.seats.slice(0, mi)) : st.seats.slice();
  const rv = st.reveal;
  const fl = [st.last && st.last.flash, st.last && st.last.flash2].filter(Boolean);
  const isFlash = (id, i) => st.last && st.last.t > Date.now() - 4000 && fl.some((f) => f.id === id && f.i === i);

  const pickTheirs = myTurn && (ph === 'p8' || (ph === 'p10' && ui.sel !== null));
  const seats = others.map((id, k) => {
    const [x, y] = seatPos(k, others.length);
    const h = st.hands[id] || [];
    const minis = h.map((c, i) => card(c, {
      size: 'sm',
      up: rv && rv.by === me && rv.owner === id && rv.idx === i,
      act: pickTheirs && 'theirs', data: { o: id, i },
      flash: isFlash(id, i), aria: `${G.nameOf(st, id)}'s card ${i + 1}`,
    })).join('');
    const tags = [];
    if (st.freezeBy === id) tags.push(`<span class="tag">${SNOW.replace('<svg', '<svg width="11" height="11"')}Froze</span>`);
    return `<div class="seat ${cur === id ? 'active' : ''}" style="left:${x}%;top:${y}%">
      <div class="minis ${h.length > 4 ? 'wide' : ''}">${minis}</div>
      <div class="who">${avatar(st, id, 26)}<span class="nm">${esc(G.nameOf(st, id))}</span></div>${tags.join('')}
    </div>`;
  }).join('');

  const lastNew = st.last && st.last.t !== ui.toastT;
  if (lastNew) ui.toastT = st.last.t;
  const toast = st.last ? `<div class="toast ${lastNew ? 'new' : ''} ${st.freezeBy ? 'freeze' : ''}"><span class="dot"></span>${esc(st.last.text)}</div>` : '';

  const canChoose = myTurn && ph === 'choose' && !ui.mode;
  const drawPile = `<button type="button" class="pile" data-act="${canChoose ? 'draw' : ''}" ${canChoose ? '' : 'disabled'} aria-label="Draw pile, ${st.deck.length} cards">
      <div class="stack">${card(null, { glow: canChoose })}</div><span class="plbl">Draw · ${st.deck.length}</span></button>`;
  const discardPile = `<button type="button" class="pile" data-act="${canChoose && top ? 'take' : ''}" ${canChoose && top ? '' : 'disabled'} aria-label="Discard pile${top ? ', top card ' + cardName(top) : ', empty'}">
      ${top ? card(top, { up: true, glow: canChoose || (myTurn && ui.mode === 'match') }) : '<div class="emptyslot"></div>'}<span class="plbl">Discard</span></button>`;
  let held = '';
  if (ph === 'drawn' && st.drawn) {
    const mine = cur === me;
    held = `<div class="held">${card(st.drawn, { size: 'lg', up: mine || st.from === 'discard', glow: mine })}<span class="plbl">${mine ? 'You drew' : esc(G.nameOf(st, cur)) + ' holds'}</span></div>`;
  }

  const hand = seated ? (st.hands[me] || []) : [];
  const tapMine = myTurn && (ui.mode === 'match' || ui.mode === 'swap' || (ph === 'drawn' && st.from === 'discard') || ph === 'p7' || ph === 'p10');
  const myCards = hand.map((c, i) => card(c, {
    up: rv && rv.by === me && rv.owner === me && rv.idx === i,
    act: tapMine && 'mine', data: { i }, sel: ph === 'p10' && ui.sel === i,
    flash: isFlash(me, i), aria: `Your card ${i + 1}`,
  })).join('');

  const s = st.settings;
  const modeLine = s.mode === 'rounds' ? `Best of ${s.bestOf} · Round ${st.round}` : `Play to ${s.limit} · Round ${st.round}`;

  return `<section class="game">
    <div class="topbar">
      <button type="button" class="icon-btn" data-act="home" aria-label="Leave game">${ICON.back}</button>
      <div class="mid"><span class="eyebrow">${modeLine}</span><span class="goal">Goal: <b>4 or less</b></span></div>
      <button type="button" class="icon-btn" data-act="rules" aria-label="Rules">${ICON.help}</button>
    </div>
    <div class="felt">
      <div class="seats">${seats}${toast}</div>
      <div class="center">${drawPile}${held}${discardPile}</div>
      <div class="myhand">${myCards || (seated ? '<span class="mine-label">No cards left!</span>' : '<span class="mine-label">You are out. Watching this round.</span>')}</div>
      ${seated ? `<div class="mine-label">${myTurn ? 'Your turn' : 'Your hand'}</div>` : ''}
    </div>
    <div class="actions">${actionBar(st, myTurn, top)}</div>
  </section>`;
}

function actionBar(st, myTurn, top) {
  const ph = st.phase;
  const cur = G.currentId(st);
  const fz = st.freezeBy ? `<div class="freezebar">${SNOW.replace('<svg', '<svg width="14" height="14"')} ${nm(st, st.freezeBy)} called Freeze · ${st.finalLeft} turn${st.finalLeft === 1 ? '' : 's'} left</div>` : '';
  if (!myTurn) {
    const who = `<b>${esc(G.nameOf(st, cur))}</b>`;
    const doing = ph === 'drawn' ? `${who} is deciding what to do…` : ['p7', 'p8', 'p10', 'reveal'].includes(ph) ? `${who} is using a power card…` : `${who}'s turn`;
    return `${fz}<p class="waiting">${doing}</p>`;
  }
  const cancel = '<button type="button" class="btn" data-act="cancel">Cancel</button>';
  if (ph === 'choose') {
    if (ui.mode === 'match') return `${fz}<p class="prompt">Tap the card you think matches the <b>${esc(G.label(top))}</b>. Wrong = draw 2.</p><div class="btnrow">${cancel}</div>`;
    return `${fz}<div class="btnrow">
        <button type="button" class="btn primary" data-act="draw">Draw</button>
        <button type="button" class="btn" data-act="take" ${top ? '' : 'disabled'}>Take ${top ? esc(G.label(top)) : ''}</button>
        <button type="button" class="btn" data-act="matchMode" ${top && (st.hands[ui.me] || []).length ? '' : 'disabled'}>Match</button>
      </div>
      ${st.freezeBy ? '' : `<button type="button" class="btn ice wide" data-act="freeze" style="height:46px">${SNOW.replace('<svg', '<svg width="18" height="18"')} Call Freeze</button>`}`;
  }
  if (ph === 'drawn') {
    if (st.from === 'discard') return `${fz}<p class="prompt">Tap one of your cards to swap in the <b>${esc(G.label(st.drawn))}</b>.</p>`;
    if (ui.mode === 'swap') return `${fz}<p class="prompt">Tap the card to replace with your <b>${esc(G.label(st.drawn))}</b>.</p><div class="btnrow">${cancel}</div>`;
    const r = G.rankOf(st.drawn);
    const power = G.POWERS[r];
    return `${fz}<p class="prompt">You drew <b>${esc(G.label(st.drawn))}</b>${power ? ` · power: <b>${G.POWER_NAMES[r]}</b>` : ''}</p>
      <div class="btnrow">
        <button type="button" class="btn ${power ? '' : 'primary'}" data-act="swapMode">Swap in</button>
        <button type="button" class="btn" data-act="discard">Discard</button>
        ${power ? '<button type="button" class="btn primary" data-act="power">Use power</button>' : ''}
      </div>`;
  }
  if (ph === 'p7') return `${fz}<p class="prompt">Tap one of <b>your</b> cards to look at it.</p>`;
  if (ph === 'p8') return `${fz}<p class="prompt">Tap any <b>rival's</b> card to look at it.</p>`;
  if (ph === 'p10') {
    return ui.sel === null
      ? `${fz}<p class="prompt">Blind swap: first tap <b>your</b> card to give away.</p>`
      : `${fz}<p class="prompt">Now tap the <b>rival's</b> card you want.</p><div class="btnrow">${cancel}</div>`;
  }
  if (ph === 'reveal') {
    const rv = st.reveal;
    const c = st.hands[rv.owner][rv.idx];
    const whose = rv.owner === ui.me ? 'Your' : `${esc(G.nameOf(st, rv.owner))}'s`;
    return `${fz}<p class="prompt">${whose} card is <b>${esc(G.label(c))}</b> (worth ${G.value(c)}). Only you can see it.</p>
      <button type="button" class="btn primary wide" data-act="done">Got it</button>`;
  }
  return fz;
}

function renderResults(st) {
  const r = st.results;
  const s = st.settings;
  const rows = st.seats.slice().sort((a, b) => r.totals[a] - r.totals[b]).map((id) => {
    const win = r.winners.includes(id);
    const tags = [win ? '<span class="pill host">Won</span>' : '', r.freezeBy === id ? '<span class="pill ice">Froze</span>' : ''].join(' ');
    return `<div class="rrow ${win ? 'win' : ''}">${avatar(st, id, 30)}
      <div class="rname">${nm(st, id)}<span>${tags}</span></div>
      <div class="rcards">${(st.hands[id] || []).map((c) => card(c, { up: true, size: 'sm' })).join('')}</div>
      <div class="rtot">${r.totals[id]}</div></div>`;
  }).join('');
  let board;
  if (s.mode === 'rounds') {
    const need = G.roundsToWin(st);
    board = st.players.map((p) => `<div class="srow">${avatar(st, p.id, 24)}<span style="min-width:64px">${nm(st, p.id)}</span><span class="bar"><i style="width:${Math.min(100, ((st.wins[p.id] || 0) / need) * 100)}%"></i></span><b>${st.wins[p.id] || 0}/${need}</b></div>`).join('');
  } else {
    board = st.players.map((p) => `<div class="srow">${avatar(st, p.id, 24)}<span style="min-width:64px">${nm(st, p.id)}</span><span class="bar"><i style="width:${Math.max(0, Math.min(100, ((st.scores[p.id] || 0) / s.limit) * 100))}%;${st.out[p.id] ? 'background:var(--bad)' : ''}"></i></span><b>${st.scores[p.id] || 0}</b>${st.out[p.id] ? '<span class="pill out">Out</span>' : ''}</div>`).join('');
  }
  const over = st.status === 'over';
  const champs = over ? st.champions.map((id) => nm(st, id)).join(' & ') : '';
  const host = isHost(st);
  return `<section class="screen">
    <div class="row"><button type="button" class="icon-btn" data-act="home" aria-label="Leave">${ICON.back}</button><span class="eyebrow grow" style="text-align:center">Round ${st.round} results</span><span style="width:44px"></span></div>
    ${over ? `<div class="champ"><p class="eyebrow">Game over</p><h1 class="wordmark" style="font-size:44px">${champs}</h1><p class="sub">${st.champions.length > 1 ? 'share the win' : (st.champions[0] === ui.me ? 'win the game!' : 'wins the game')}</p></div>`
    : `<h1 class="title" style="font-size:34px">${r.winners.length ? `${r.winners.map((id) => nm(st, id)).join(' & ')} ${r.winners.length > 1 || r.winners[0] === ui.me ? 'win' : 'wins'} the round` : 'Nobody got to 4 or less'}</h1>`}
    <div class="res">${rows}</div>
    <div class="panel score"><span class="eyebrow">${s.mode === 'rounds' ? `Rounds won · first to ${G.roundsToWin(st)}` : `Points · out at ${s.limit}`}</span>${board}</div>
    <div style="margin-top:auto">
      ${host ? (over ? '<button type="button" class="btn primary wide" data-act="newGame">New game</button>' : '<button type="button" class="btn primary wide" data-act="next">Deal next round</button>')
      : `<p class="waiting">Waiting for <b>${esc(G.nameOf(st, st.hostId))}</b> to ${over ? 'start a new game' : 'deal'}…</p>`}
    </div>
  </section>`;
}

function renderRules() {
  return `<div class="sheet-bg" data-act="closeRules"><div class="sheet" role="dialog" aria-label="How to play Freeze" data-stop="1">
    <h2>How to play</h2>
    <ul>
      <li>Everyone gets <b>4 face-down cards</b>. Peek at 2 at the start, then remember them.</li>
      <li>Win a round with the <b>lowest hand of 4 or less</b>.</li>
      <li>On your turn: <b>draw</b>, <b>take the last discard</b>, or <b>match</b> it by dropping one of yours with the same rank. Wrong match = draw 2.</li>
      <li>After drawing, swap it for one of your cards (no peeking) or discard it. A taken discard must be swapped in.</li>
      <li><b>7</b>: look at one of yours. <b>8</b>: look at a rival's. <b>10</b>: swap one of yours with a rival's, blind. Powers only work when drawn from the deck.</li>
      <li>Think you're low? <b>Call Freeze</b> instead of drawing. Everyone else gets one last turn, then all cards flip.</li>
      <li>Values: A = 1, 2–10 = face, J/Q = 10, <b>black K = −2</b>, <b>red K = 0</b>.</li>
      <li><b>Rounds</b> mode: first to win the majority takes it. <b>Points</b> mode: totals add up, hit the limit and you're out.</li>
    </ul>
    <button type="button" class="btn primary wide" data-act="closeRules">Got it</button>
  </div></div>`;
}

function render() {
  const st = ui.st;
  let html;
  if (!ui.code || !st) html = renderHome();
  else if (st.status === 'lobby') html = renderLobby(st);
  else if (!player(st, ui.me)) html = renderSpectator(st, 'This game already started. Ask the host to start a new one.');
  else if (st.status === 'peek') html = renderPeek(st);
  else if (st.status === 'playing') html = renderTable(st);
  else html = renderResults(st);
  const active = document.activeElement;
  const keep = active && active.id && active.tagName === 'INPUT' ? { id: active.id, v: active.value, s: active.selectionStart } : null;
  $app.innerHTML = html + (ui.rules ? renderRules() : '') + (ui.err ? `<div class="error" role="alert">${esc(ui.err)}</div>` : '');
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { el.value = keep.v; el.focus(); try { el.setSelectionRange(keep.s, keep.s); } catch (e) { /* ignore */ } }
  }
}

// ---------- Actions ----------

async function act(a) {
  if (ui.busy) return;
  ui.busy = true;
  try {
    await ui.backend.transact(ui.code, (cur) => {
      if (!cur) throw new G.RuleError('This room no longer exists');
      return G.apply(cur, a, ui.me, Date.now());
    });
  } catch (e) {
    showError(e instanceof G.RuleError ? e.message : 'Connection hiccup. Try again.');
    if (!(e instanceof G.RuleError)) console.error(e);
  } finally { ui.busy = false; }
}

function readName() {
  const el = document.getElementById('name');
  const n = (el ? el.value : ui.name).trim().slice(0, 14);
  if (!n) { showError('Enter your name first'); return null; }
  ui.name = n;
  (ui.backend && ui.backend.demo ? sessionStorage : localStorage).setItem('freeze:name', n);
  return n;
}

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

function inviteUrl() {
  const u = new URL(location.href);
  u.search = '?room=' + ui.code;
  u.hash = '';
  return u.toString();
}

function enterRoom(code) {
  if (ui.unsub) ui.unsub();
  ui.code = code;
  ui.st = null;
  history.replaceState(null, '', '?room=' + code);
  let first = true;
  ui.unsub = ui.backend.subscribe(code, async (st) => {
    if (first) {
      first = false;
      if (!st) { leaveRoom(); showError(`No room called ${code}`); return; }
      if (!player(st, ui.me) && st.status === 'lobby') {
        ui.st = st;
        await act({ type: 'join', name: ui.name });
        return;
      }
    }
    onState(st);
  });
}

function onState(st) {
  if (!st) { leaveRoom(); showError('The room was closed'); return; }
  const key = `${st.status}|${st.round}|${st.turn}|${st.phase}`;
  if (key !== ui.phaseKey) {
    const prev = ui.phaseKey.split('|');
    ui.mode = null; ui.sel = null;
    if (prev[1] !== String(st.round)) ui.opening = [];
    if (st.status === 'playing' && G.currentId(st) === ui.me && st.phase === 'choose' && navigator.vibrate) navigator.vibrate(35);
    ui.phaseKey = key;
  }
  ui.st = st;
  render();
}

function leaveRoom() {
  if (ui.unsub) ui.unsub();
  ui.unsub = null; ui.code = null; ui.st = null; ui.phaseKey = '';
  history.replaceState(null, '', location.pathname);
  render();
}

async function handle(actName, d) {
  const st = ui.st;
  switch (actName) {
    case 'create': {
      const n = readName(); if (!n) return;
      const code = newCode();
      try {
        await ui.backend.transact(code, (cur) => {
          if (cur) throw new G.RuleError('Code clash, tap again');
          return G.createRoom(code, { id: ui.me, name: n });
        });
        enterRoom(code);
      } catch (e) { showError(e instanceof G.RuleError ? e.message : 'Could not create the room'); console.error(e); }
      return;
    }
    case 'join': {
      const n = readName(); if (!n) return;
      const code = (d.code || (document.getElementById('code') || {}).value || '').trim().toUpperCase();
      if (code.length < 4) { showError('Enter the 4-letter room code'); return; }
      enterRoom(code);
      return;
    }
    case 'home':
      if (st && st.status === 'lobby') await act({ type: 'leave' });
      leaveRoom();
      return;
    case 'rules': ui.rules = true; render(); return;
    case 'closeRules': ui.rules = false; render(); return;
    case 'copy':
      try { await navigator.clipboard.writeText(inviteUrl()); showError('Invite link copied'); } catch (e) { showError(inviteUrl()); }
      return;
    case 'invite': {
      const url = inviteUrl();
      const text = `Join my Freeze game! Room ${ui.code}`;
      if (navigator.share) { try { await navigator.share({ title: 'Freeze', text, url }); } catch (e) { /* cancelled */ } }
      else location.href = `sms:&body=${encodeURIComponent(text + ' ' + url)}`;
      return;
    }
    case 'mode': return act({ type: 'settings', settings: { ...st.settings, mode: d.mode } });
    case 'bestof': return act({ type: 'settings', settings: { ...st.settings, mode: 'rounds', bestOf: Number(d.n) } });
    case 'limit': return act({ type: 'settings', settings: { ...st.settings, mode: 'points', limit: st.settings.limit + Number(d.d) } });
    case 'start': return act({ type: 'start' });
    case 'openPeek': {
      const i = Number(d.i);
      if (!ui.opening.includes(i) && ui.opening.length < 2) ui.opening.push(i);
      render();
      return;
    }
    case 'ready': return act({ type: 'ready' });
    case 'draw': return act({ type: 'draw' });
    case 'take': return act({ type: 'take' });
    case 'freeze': return act({ type: 'freeze' });
    case 'matchMode': ui.mode = 'match'; render(); return;
    case 'swapMode': ui.mode = 'swap'; render(); return;
    case 'cancel': ui.mode = null; ui.sel = null; render(); return;
    case 'discard': return act({ type: 'discard' });
    case 'power': return act({ type: 'power' });
    case 'done': return act({ type: 'done' });
    case 'mine': {
      const i = Number(d.i);
      if (ui.mode === 'match') return act({ type: 'match', idx: i });
      if (st.phase === 'drawn') return act({ type: 'swap', idx: i });
      if (st.phase === 'p7') return act({ type: 'peekOwn', idx: i });
      if (st.phase === 'p10') { ui.sel = ui.sel === i ? null : i; render(); }
      return;
    }
    case 'theirs': {
      const i = Number(d.i);
      if (st.phase === 'p8') return act({ type: 'peekOther', owner: d.o, idx: i });
      if (st.phase === 'p10' && ui.sel !== null) return act({ type: 'blindSwap', idx: ui.sel, owner: d.o, theirIdx: i });
      return;
    }
    case 'next': return act({ type: 'next' });
    case 'newGame': return act({ type: 'newGame' });
    default:
  }
}

$app.addEventListener('click', (e) => {
  if (e.target.closest('[data-stop]') && !e.target.closest('[data-act]')) return;
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled || !el.dataset.act) return;
  if (el.dataset.act === 'closeRules' && el.classList.contains('sheet-bg') && e.target !== el) return;
  handle(el.dataset.act, el.dataset);
});
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('input')) return;
  const code = document.getElementById('code');
  handle(code && code.value.trim() ? 'join' : (new URLSearchParams(location.search).get('room') ? 'join' : 'create'),
    { code: new URLSearchParams(location.search).get('room') || '' });
});

// ---------- Boot ----------

(async function boot() {
  ui.backend = await makeBackend();
  ui.me = ui.backend.uid;
  // In demo mode every tab is its own player, so each tab keeps its own name.
  if (ui.backend.demo) ui.name = sessionStorage.getItem('freeze:name') || '';
  const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (code && ui.name) enterRoom(code);
  else render();
})();
