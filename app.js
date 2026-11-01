import * as G from './game.js';
import * as BOT from './bots.js';

// ---------- Backends: Firebase for real play, browser storage for demo mode ----------

async function makeBackend() {
  const cfg = window.FREEZE_FIREBASE;
  if (cfg && cfg.apiKey && !cfg.apiKey.startsWith('PASTE') && cfg.databaseURL) {
    try { return await firebaseBackend(cfg); }
    catch (e) { console.error(e); setTimeout(() => showError('Could not reach the game server. Running in demo mode.')); }
  }
  return localBackend();
}

function addStats(cur, uid, prof, won) {
  const p = cur || {};
  return { name: prof.name, icon: prof.icon, color: prof.color, wins: (p.wins || 0) + (won ? 1 : 0), games: (p.games || 0) + 1, updated: Date.now() };
}

async function firebaseBackend(cfg) {
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const [appM, authM, dbM] = await Promise.all([
    import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-database.js'),
  ]);
  const app = appM.initializeApp(cfg);
  const auth = authM.getAuth(app);
  // Keep a saved Google/email login; only fall back to a guest login when nobody is signed in.
  await auth.authStateReady();
  if (!auth.currentUser) await authM.signInAnonymously(auth);
  const uid = auth.currentUser.uid;
  const db = dbM.getDatabase(app);
  const roomRef = (code) => dbM.ref(db, 'rooms/' + code);
  const A = authM;
  return {
    uid, demo: false,
    account() {
      const u = auth.currentUser;
      if (!u) return null;
      const email = u.email || ((u.providerData || []).find((x) => x.email) || {}).email || '';
      return { anon: u.isAnonymous, email };
    },
    async google() {
      const prov = new A.GoogleAuthProvider();
      const u = auth.currentUser;
      try {
        if (u && u.isAnonymous) { await A.linkWithPopup(u, prov); return { switched: false }; }
        await A.signInWithPopup(auth, prov);
        return { switched: true };
      } catch (e) {
        if (e.code === 'auth/credential-already-in-use') {
          await A.signInWithCredential(auth, A.GoogleAuthProvider.credentialFromError(e));
          return { switched: true };
        }
        throw e;
      }
    },
    async emailSignUp(email, pw) {
      const u = auth.currentUser;
      if (u && u.isAnonymous) { await A.linkWithCredential(u, A.EmailAuthProvider.credential(email, pw)); return { switched: false }; }
      await A.createUserWithEmailAndPassword(auth, email, pw);
      return { switched: true };
    },
    async emailSignIn(email, pw) { await A.signInWithEmailAndPassword(auth, email, pw); return { switched: true }; },
    async resetPassword(email) { await A.sendPasswordResetEmail(auth, email); },
    async signOut() { await A.signOut(auth); },
    async myGames(id) {
      const s = await dbM.get(dbM.query(dbM.ref(db, 'history/' + id), dbM.orderByChild('at'), dbM.limitToLast(30)));
      const rows = [];
      s.forEach((c) => { rows.push(c.val()); });
      return rows.reverse();
    },
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
    async getStats(id) {
      const s = await dbM.get(dbM.ref(db, 'players/' + id));
      return s.val();
    },
    async saveProfile(id, prof) {
      await dbM.update(dbM.ref(db, 'players/' + id), { name: prof.name, icon: prof.icon, color: prof.color, layout: prof.layout || 'grid', updated: Date.now() });
    },
    async recordGame(id, prof, won, summary) {
      await dbM.runTransaction(dbM.ref(db, 'players/' + id), (cur) => ({ ...addStats(cur, id, prof, won), layout: (cur && cur.layout) || 'grid' }));
      if (summary) await dbM.set(dbM.ref(db, 'history/' + id + '/' + summary.gameId), summary);
    },
    async leaderboard() {
      const s = await dbM.get(dbM.query(dbM.ref(db, 'players'), dbM.orderByChild('wins'), dbM.limitToLast(50)));
      const rows = [];
      s.forEach((c) => { rows.push({ id: c.key, ...c.val() }); });
      return rows;
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
  const players = () => JSON.parse(localStorage.getItem('freeze:players') || '{}');
  const setPlayers = (p) => localStorage.setItem('freeze:players', JSON.stringify(p));
  addEventListener('storage', (e) => { if (e.key && e.key.startsWith('freeze:room:')) notify(e.key.slice(12)); });
  return {
    uid, demo: true,
    subscribe(code, cb) {
      subs.set(code, (subs.get(code) || []).concat(cb));
      setTimeout(() => cb(read(code)));
      return () => subs.set(code, (subs.get(code) || []).filter((x) => x !== cb));
    },
    async transact(code, fn) {
      const next = fn(read(code));
      if (next === undefined) return; // the step was no longer needed
      localStorage.setItem(key(code), JSON.stringify(next));
      notify(code);
    },
    account() { return null; },
    async getStats(id) { return players()[id] || null; },
    async saveProfile(id, prof) { const p = players(); p[id] = { ...(p[id] || {}), name: prof.name, icon: prof.icon, color: prof.color }; setPlayers(p); },
    async recordGame(id, prof, won, summary) {
      const p = players(); p[id] = addStats(p[id], id, prof, won); setPlayers(p);
      if (summary) { const h = JSON.parse(localStorage.getItem('freeze:history:' + id) || '[]'); h.unshift(summary); localStorage.setItem('freeze:history:' + id, JSON.stringify(h.slice(0, 30))); }
    },
    async myGames(id) { return JSON.parse(localStorage.getItem('freeze:history:' + id) || '[]'); },
    async leaderboard() { return Object.entries(players()).map(([id, v]) => ({ id, ...v })); },
  };
}

// ---------- App state ----------

const $app = document.getElementById('app');
const COLORS = ['#F2B544', '#6EA8FE', '#F27BA0', '#8FD3A8', '#C49BFF', '#F2734A', '#7FD6E8', '#E8E2D0'];
const ICONS = ['\u{1F436}', '\u{1F431}', '\u{1F98A}', '\u{1F43C}', '\u{1F438}', '\u{1F435}', '\u{1F984}', '\u{1F42F}',
  '\u{1F427}', '\u{1F419}', '\u{1F996}', '\u{1F41D}', '\u{1F47B}', '\u{1F916}', '\u{1F47D}', '\u{1F920}',
  '\u{1F451}', '\u{1F525}', '⚡', '❄️', '\u{1F335}', '\u{1F355}', '\u{1F369}', '\u{1F3B2}'];

const ui = {
  backend: null, me: null, code: null, st: null, unsub: null, store: localStorage,
  profile: { name: '', icon: ICONS[19], color: 0, layout: 'grid' },
  draft: null, sheet: null, boardTab: 'game', board: null, myStats: null, games: null,
  form: { email: '', pw: '' }, authBusy: false,
  mode: null, sel: null, opening: [], phaseKey: '', toastT: 0,
  solo: { bots: 2, level: 'easy' }, botT: null, fxKey: null,
  err: null, errTimer: null, busy: false,
};

function loadProfile() {
  try { const p = JSON.parse(ui.store.getItem('freeze:profile') || 'null'); if (p) ui.profile = { ...ui.profile, ...p }; }
  catch (e) { /* ignore */ }
}
function storeProfile() { ui.store.setItem('freeze:profile', JSON.stringify(ui.profile)); }

const SNOW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 3l3 3 3-3M9 21l3-3 3 3"/></svg>';
const svg = (d, w = 20) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17.5h.01"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  trophy: svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  grid: svg('<rect x="4" y="3" width="7" height="8" rx="1.5"/><rect x="13" y="3" width="7" height="8" rx="1.5"/><rect x="4" y="13" width="7" height="8" rx="1.5"/><rect x="13" y="13" width="7" height="8" rx="1.5"/>', 18),
  row: svg('<rect x="1.5" y="7" width="4.5" height="10" rx="1"/><rect x="7.2" y="7" width="4.5" height="10" rx="1"/><rect x="12.9" y="7" width="4.5" height="10" rx="1"/><rect x="18.6" y="7" width="4" height="10" rx="1"/>', 18),
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const player = (st, id) => st.players.find((p) => p.id === id);
const nm = (st, id) => (id === ui.me ? 'You' : esc(G.nameOf(st, id)));
const isHost = (st) => st.hostId === ui.me;
const profileForRoom = () => ({ name: ui.profile.name, icon: ui.profile.icon, color: ui.profile.color });

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

function avatarOf(p, size = 32) {
  const pp = p || { icon: '?', color: 0 };
  return `<span class="avatar" aria-hidden="true" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.56)}px;background:${COLORS[(pp.color || 0) % COLORS.length]}">${esc(pp.icon || '?')}</span>`;
}
const avatar = (st, id, size) => avatarOf(player(st, id), size);

// ---------- Profile editor ----------

function profileFields(d, withLayout) {
  const icons = ICONS.map((ic) => `<button type="button" class="iconpick ${d.icon === ic ? 'on' : ''}" data-act="pickIcon" data-v="${esc(ic)}" aria-label="Icon ${esc(ic)}" aria-pressed="${d.icon === ic}">${ic}</button>`).join('');
  const colors = COLORS.map((c, i) => `<button type="button" class="colorpick ${d.color === i ? 'on' : ''}" data-act="pickColor" data-v="${i}" aria-label="Color ${i + 1}" aria-pressed="${d.color === i}" style="background:${c}"></button>`).join('');
  return `
    <div class="row" style="gap:14px">${avatarOf(d, 64)}
      <div class="grow" style="display:flex;flex-direction:column;gap:6px"><label class="lbl" for="name">Your name</label>
      <input id="name" class="field" maxlength="14" autocomplete="nickname" placeholder="Name" value="${esc(d.name)}"></div></div>
    <span class="lbl">Pick your icon</span><div class="icongrid">${icons}</div>
    <span class="lbl">Pick your color</span><div class="colorrow">${colors}</div>
    ${withLayout ? `<span class="lbl">Show my cards</span>
    <div class="seg">
      <button type="button" class="btn small ${d.layout === 'grid' ? 'on' : ''}" data-act="pickLayout" data-v="grid" aria-pressed="${d.layout === 'grid'}">${ICON.grid} 2 × 2</button>
      <button type="button" class="btn small ${d.layout === 'row' ? 'on' : ''}" data-act="pickLayout" data-v="row" aria-pressed="${d.layout === 'row'}">${ICON.row} In a row</button>
    </div>` : ''}`;
}

// ---------- Screens ----------

function renderHome() {
  const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  const hasProfile = !!ui.profile.name;
  if (!hasProfile && !ui.draft) ui.draft = { ...ui.profile };
  const stats = ui.myStats;
  const soloPanel = hasProfile ? `<div class="panel">
      <span class="eyebrow">Play solo</span>
      <p class="sub" style="font-size:14px;margin:0">Play against computer players. Same rules, same rounds.</p>
      <span class="eyebrow" style="font-size:11px">Computer players</span>
      <div class="seg">
        ${[1, 2, 3].map((n) => `<button type="button" class="btn small ${ui.solo.bots === n ? 'on' : ''}" data-act="soloBots" data-n="${n}" aria-pressed="${ui.solo.bots === n}">${n}</button>`).join('')}
      </div>
      <span class="eyebrow" style="font-size:11px">Level</span>
      <div class="seg">
        <button type="button" class="btn small ${ui.solo.level === 'easy' ? 'on' : ''}" data-act="soloLevel" data-v="easy" aria-pressed="${ui.solo.level === 'easy'}">Easy</button>
        <button type="button" class="btn small ${ui.solo.level === 'hard' ? 'on' : ''}" data-act="soloLevel" data-v="hard" aria-pressed="${ui.solo.level === 'hard'}">Hard</button>
      </div>
      <button type="button" class="btn primary wide" data-act="soloStart">Play solo</button>
    </div>` : '';
  return `<section class="screen">
    <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
      <p class="eyebrow">A memory card game</p>
      <h1 class="wordmark">FREEZE</h1>
      <p class="sub">Get your hand to 4 or less. Remember what you saw.</p>
    </div>
    ${hasProfile ? `
    <div class="fan" aria-hidden="true">
      ${card('KS', { up: true, size: 'lg', cls: 'c1' })}${card('KH', { up: true, size: 'lg', cls: 'c2' })}${card('AC', { up: true, size: 'lg', cls: 'c3' })}
    </div>
    <div class="panel">
      <div class="row">${avatarOf(ui.profile, 44)}
        <div class="grow" style="display:flex;flex-direction:column;gap:2px"><b style="font-size:17px">${esc(ui.profile.name)}</b>
        <span style="font-size:13px;color:var(--muted)">${stats ? `${stats.wins || 0} win${stats.wins === 1 ? '' : 's'} · ${stats.games || 0} game${stats.games === 1 ? '' : 's'} all time` : 'No games yet'}</span>
        ${acctLine()}</div>
        <button type="button" class="icon-btn" data-act="openBoard" aria-label="Leaderboard">${ICON.trophy}</button>
        <button type="button" class="icon-btn" data-act="openProfile" aria-label="Edit profile and settings">${ICON.gear}</button>
      </div>
      ${code ? `<p class="sub" style="font-size:14px">Joining room <b>${esc(code)}</b></p>
        <button type="button" class="btn primary wide" data-act="join" data-code="${esc(code)}">Join the table</button>
        <button type="button" class="btn wide small" data-act="clearCode">Start my own game instead</button>`
      : `<button type="button" class="btn primary wide" data-act="create">Start a new game</button>
        <div class="row"><input id="code" class="field code grow" maxlength="4" placeholder="CODE" autocapitalize="characters" aria-label="Room code"><button type="button" class="btn" data-act="join">Join</button></div>`}
    </div>`
    : `<div class="panel">
      <span class="eyebrow">Make your player</span>
      ${profileFields(ui.draft, false)}
      <button type="button" class="btn primary wide" data-act="saveProfile">${code ? `Join room ${esc(code)}` : "Let's play"}</button>
    </div>`}
    ${soloPanel}
    ${ui.backend && ui.backend.demo ? `<p class="banner">Demo mode: open this page in a few browser tabs to test as different players.</p>` : ''}
  </section>`;
}

function renderLobby(st) {
  const host = isHost(st);
  const s = st.settings;
  const players = st.players.map((p) => `<li>${avatarOf(p, 34)}<span class="nm">${p.id === ui.me ? 'You' : esc(p.name)}</span>${p.id === st.hostId ? '<span class="pill host">Host</span>' : '<span class="pill ok">Ready</span>'}</li>`).join('');
  const dis = host ? '' : 'disabled';
  const modes = `
    <div class="mode ${s.mode === 'rounds' ? 'on' : ''}">
      <button type="button" class="head" data-act="mode" data-mode="rounds" ${dis} aria-pressed="${s.mode === 'rounds'}"><span class="radio"></span><span><span class="mt">Rounds</span><span class="md">Win the most rounds to take the game.</span></span></button>
      <div class="body seg">
        <button type="button" class="btn small ${s.bestOf === 3 ? 'on' : ''}" data-act="bestof" data-n="3" ${dis} aria-pressed="${s.bestOf === 3}">Best of 3</button>
        <button type="button" class="btn small ${s.bestOf === 5 ? 'on' : ''}" data-act="bestof" data-n="5" ${dis} aria-pressed="${s.bestOf === 5}">Best of 5</button>
      </div>
    </div>
    <div class="mode ${s.mode === 'points' ? 'on' : ''}">
      <button type="button" class="head" data-act="mode" data-mode="points" ${dis} aria-pressed="${s.mode === 'points'}"><span class="radio"></span><span><span class="mt">Points</span><span class="md">Hand totals add up. Hit the limit and you're out.</span></span></button>
      <div class="body stepper">
        <span class="grow" style="font-size:14px;color:var(--muted)">Play to</span>
        <button type="button" class="icon-btn" data-act="limit" data-d="-25" aria-label="Lower limit" ${dis}>−</button>
        <span class="val">${s.limit}</span>
        <button type="button" class="icon-btn" data-act="limit" data-d="25" aria-label="Raise limit" ${dis}>+</button>
      </div>
    </div>`;
  return `<section class="screen">
    <div class="row"><button type="button" class="icon-btn" data-act="home" aria-label="Leave room">${ICON.back}</button><span class="grow"></span>
      <button type="button" class="icon-btn" data-act="openBoard" aria-label="Leaderboard">${ICON.trophy}</button>
      <button type="button" class="icon-btn" data-act="openProfile" aria-label="Profile and settings">${ICON.gear}</button></div>
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
      ${st.solo ? '' : `<button type="button" class="btn primary wide" data-act="invite">${ICON.chat} Invite via iMessage</button>`}
      ${host ? `<button type="button" class="btn wide" data-act="start" ${st.players.length < 2 ? 'disabled' : ''}>${st.players.length < 2 ? 'Waiting for players…' : `Deal the cards · ${st.players.length} players`}</button>`
      : `<p class="waiting">Waiting for <b>${esc(G.nameOf(st, st.hostId))}</b> to deal…</p>`}
    </div>
  </section>`;
}

function handClass() { return ui.profile.layout === 'row' ? 'hand row' : 'hand grid'; }

function renderPeek(st) {
  const hand = st.hands[ui.me];
  if (!hand) return renderSpectator(st, "Round in progress. You'll join the next game.");
  const ready = st.ready[ui.me];
  const need = Math.min(2, hand.length);
  const size = ui.profile.layout === 'row' ? 'pk' : 'xl';
  const cards = hand.map((c, i) => {
    const seen = !ready && ui.opening.includes(i);
    const canTap = !ready && !seen && ui.opening.length < need;
    return card(c, { size, up: seen, act: canTap ? 'openPeek' : null, data: { i }, cls: seen ? 'mine-seen' : '', aria: `Your card ${i + 1}` });
  }).join('');
  const waitingFor = st.seats.filter((id) => !st.ready[id]).map((id) => nm(st, id));
  return `<section class="screen">
    <div class="row"><span class="eyebrow grow">Round ${st.round}</span>
      <button type="button" class="icon-btn" data-act="toggleLayout" aria-label="Switch card layout">${ui.profile.layout === 'row' ? ICON.grid : ICON.row}</button></div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <h1 class="title" style="font-size:40px">${ready ? 'Locked in.' : 'Memorize<br>two cards.'}</h1>
      <p class="sub">${ready ? 'Your cards are face down again, in this same order on the table.' : `Tap ${need === 2 ? 'two cards' : 'a card'} to look. They stay in this order on the table.`}</p>
    </div>
    <div class="${handClass()} peek">${cards}</div>
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
    const tag = st.freezeBy === id ? `<span class="tag">${SNOW.replace('<svg', '<svg width="11" height="11"')}Froze</span>` : '';
    return `<div class="seat ${cur === id ? 'active' : ''}" style="left:${x}%;top:${y}%">
      <div class="minis">${minis}</div>
      <div class="who">${avatar(st, id, 28)}<span class="nm">${esc(G.nameOf(st, id))}</span></div>${tag}
    </div>`;
  }).join('');

  const lastNew = st.last && st.last.t !== ui.toastT;
  if (lastNew) ui.toastT = st.last.t;
  const toast = st.last ? `<div class="toast ${lastNew ? 'new' : ''} ${st.freezeBy ? 'freeze' : ''}"><span class="dot"></span>${esc(st.last.text)}</div>` : '';

  const canChoose = myTurn && ph === 'choose' && !ui.mode;
  const drawPile = `<button type="button" class="pile" data-act="${canChoose ? 'draw' : ''}" ${canChoose ? '' : 'disabled'} aria-label="Draw pile, ${st.deck.length} cards">
      <div class="stack">${card(null, { glow: canChoose })}</div><span class="plbl">Draw · ${st.deck.length}</span></button>`;
  const run = G.topRun(st);
  const discardPile = `<button type="button" class="pile" data-act="${canChoose && top ? 'take' : ''}" ${canChoose && top ? '' : 'disabled'} aria-label="Discard pile${top ? ', top card ' + cardName(top) : ', empty'}">
      ${top ? card(top, { up: true, glow: canChoose || (myTurn && ui.mode === 'match') }) : '<div class="emptyslot"></div>'}<span class="plbl">Discard${run >= 2 ? ' · pair' : ''}</span></button>`;
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
      <div class="row" style="gap:6px">
        <button type="button" class="icon-btn" data-act="openBoard" aria-label="Standings">${ICON.trophy}</button>
        <button type="button" class="icon-btn" data-act="openProfile" aria-label="Settings and rules">${ICON.gear}</button>
      </div>
    </div>
    <div class="felt">
      <div class="seats">${seats}${toast}</div>
      <div class="center">${drawPile}${held}${discardPile}</div>
      <div class="myhand ${handClass()}">${myCards || (seated ? '<span class="mine-label">No cards left!</span>' : '<span class="mine-label">You are out. Watching this round.</span>')}</div>
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
    if (ui.mode === 'match') {
      const pairNote = G.topRun(st) >= 2 ? ` There are already two ${esc(G.rankOf(top))}s, so a third isn't allowed.` : '';
      return `${fz}<p class="prompt">Tap the card you think matches the <b>${esc(G.label(top))}</b>. Wrong = you keep it and draw 1.${pairNote}</p><div class="btnrow">${cancel}</div>`;
    }
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

function gameBoard(st) {
  const s = st.settings;
  if (s.mode === 'rounds') {
    const need = G.roundsToWin(st);
    return st.players.slice().sort((a, b) => (st.wins[b.id] || 0) - (st.wins[a.id] || 0)).map((p) => `<div class="srow">${avatarOf(p, 26)}<span class="sname">${nm(st, p.id)}</span><span class="bar"><i style="width:${Math.min(100, ((st.wins[p.id] || 0) / need) * 100)}%"></i></span><b>${st.wins[p.id] || 0}/${need}</b></div>`).join('');
  }
  return st.players.slice().sort((a, b) => (st.scores[a.id] || 0) - (st.scores[b.id] || 0)).map((p) => `<div class="srow">${avatarOf(p, 26)}<span class="sname">${nm(st, p.id)}</span><span class="bar"><i style="width:${Math.max(0, Math.min(100, ((st.scores[p.id] || 0) / s.limit) * 100))}%;${st.out[p.id] ? 'background:var(--bad)' : ''}"></i></span><b>${st.scores[p.id] || 0}</b>${st.out[p.id] ? '<span class="pill out">Out</span>' : ''}</div>`).join('');
}
const boardTitle = (st) => (st.settings.mode === 'rounds' ? `Rounds won · first to ${G.roundsToWin(st)}` : `Points · out at ${st.settings.limit}`);

function renderResults(st) {
  const r = st.results;
  const rows = st.seats.slice().sort((a, b) => r.totals[a] - r.totals[b]).map((id) => {
    const win = r.winners.includes(id);
    const tags = [win ? '<span class="pill host">Won</span>' : '', r.freezeBy === id ? '<span class="pill ice">Froze</span>' : ''].join(' ');
    return `<div class="rrow ${win ? 'win' : ''}">${avatar(st, id, 32)}
      <div class="rname">${nm(st, id)}<span>${tags}</span></div>
      <div class="rcards">${(st.hands[id] || []).map((c) => card(c, { up: true, size: 'sm' })).join('')}</div>
      <div class="rtot">${r.totals[id]}</div></div>`;
  }).join('');
  const over = st.status === 'over';
  const champs = over ? st.champions.map((id) => nm(st, id)).join(' & ') : '';
  const host = isHost(st);
  return `<section class="screen">
    <div class="row"><button type="button" class="icon-btn" data-act="home" aria-label="Leave">${ICON.back}</button><span class="eyebrow grow" style="text-align:center">Round ${st.round} results</span>
      <button type="button" class="icon-btn" data-act="openBoard" aria-label="Leaderboard">${ICON.trophy}</button></div>
    ${over ? `<div class="champ"><p class="eyebrow">Game over</p><div style="display:flex;gap:6px">${st.champions.map((id) => avatar(st, id, 56)).join('')}</div><h1 class="wordmark" style="font-size:44px">${champs}</h1><p class="sub">${st.champions.length > 1 ? 'share the win' : (st.champions[0] === ui.me ? 'win the game!' : 'wins the game')}</p></div>`
    : `<h1 class="title" style="font-size:34px">${r.winners.length ? `${r.winners.map((id) => nm(st, id)).join(' & ')} ${r.winners.length > 1 || r.winners[0] === ui.me ? 'win' : 'wins'} the round` : 'Nobody got to 4 or less'}</h1>`}
    <div class="res">${rows}</div>
    <div class="panel score"><span class="eyebrow">${boardTitle(st)}</span>${gameBoard(st)}</div>
    <div style="margin-top:auto">
      ${host ? (over ? '<button type="button" class="btn primary wide" data-act="newGame">New game</button>' : '<button type="button" class="btn primary wide" data-act="next">Deal next round</button>')
      : `<p class="waiting">Waiting for <b>${esc(G.nameOf(st, st.hostId))}</b> to ${over ? 'start a new game' : 'deal'}…</p>`}
    </div>
  </section>`;
}

// ---------- Sheets ----------

function acctLine() {
  const a = ui.backend && ui.backend.account();
  if (!a) return '';
  return a.anon
    ? '<button type="button" class="linkbtn" data-act="openProfile" style="text-align:left;padding:0">Guest · sign in to save your wins</button>'
    : `<span style="font-size:12px;color:var(--good)">Saved to your account</span>`;
}

function accountSection() {
  const acct = ui.backend.account();
  if (!acct) return '<p class="banner">Accounts work once the game is online.</p>';
  if (!acct.anon) {
    return `<div class="acct"><span class="lbl">Account</span>
      <div class="row"><span class="grow" style="font-size:15px">Signed in${acct.email ? ` as <b>${esc(acct.email)}</b>` : ''}. Your wins and games are saved.</span></div>
      <button type="button" class="btn wide small" data-act="signOut">Log out</button></div>`;
  }
  const dis = ui.authBusy ? 'disabled' : '';
  return `<div class="acct"><span class="lbl">Save your player</span>
    <p class="sub" style="font-size:14px">You're playing as a guest. Sign in so your wins and game history follow you to any phone.</p>
    ${window.FREEZE_GOOGLE_SIGNIN ? `<button type="button" class="btn wide google" data-act="google" ${dis}><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg> Continue with Google</button>
    <div class="ordiv"><span>or use email</span></div>` : ''}
    <label class="lbl" for="email">Email</label>
    <input id="email" class="field" type="email" autocomplete="email" inputmode="email" value="${esc(ui.form.email)}">
    <label class="lbl" for="pw">Password (6+ characters)</label>
    <input id="pw" class="field" type="password" autocomplete="current-password" value="${esc(ui.form.pw)}">
    <div class="seg">
      <button type="button" class="btn small" data-act="emailUp" ${dis}>Create account</button>
      <button type="button" class="btn small" data-act="emailIn" ${dis}>Log in</button>
    </div>
    <button type="button" class="linkbtn" data-act="resetPw">Forgot password?</button>
  </div>`;
}

function authMessage(e) {
  const c = (e && e.code) || '';
  if (c.includes('popup-closed') || c.includes('cancelled-popup')) return 'Google sign-in was closed';
  if (c.includes('popup-blocked')) return 'Allow pop-ups, or use email instead';
  if (c.includes('email-already-in-use') || c.includes('credential-already-in-use')) return 'That email already has an account. Tap Log in.';
  if (c.includes('invalid-email')) return 'That email looks off';
  if (c.includes('weak-password')) return 'Password needs at least 6 characters';
  if (c.includes('wrong-password') || c.includes('invalid-credential') || c.includes('user-not-found') || c.includes('invalid-login')) return 'Wrong email or password';
  if (c.includes('too-many-requests')) return 'Too many tries. Wait a minute.';
  if (c.includes('operation-not-allowed')) return "That sign-in method isn't turned on yet";
  return 'Sign-in failed. Try again.';
}

async function doAuth(fn) {
  if (ui.authBusy) return;
  ui.authBusy = true; render();
  try {
    const r = await fn();
    if (r && r.switched) {
      // A different account: start fresh with its saved player.
      ui.store.removeItem('freeze:profile');
      location.reload();
      return;
    }
    // Guest upgraded in place: same player, now saved to the account.
    await ui.backend.saveProfile(ui.me, { ...profileForRoom(), layout: ui.profile.layout });
    ui.form = { email: '', pw: '' };
    showError('Saved! Your player is now on your account.');
  } catch (e) { console.error(e); showError(authMessage(e)); }
  finally { ui.authBusy = false; render(); }
}

function renderSheet() {
  if (!ui.sheet) return '';
  let body = '';
  if (ui.sheet === 'rules') {
    body = `<h2>How to play</h2>
    <ul>
      <li>Everyone gets <b>4 face-down cards</b>. Peek at 2 at the start, then remember them.</li>
      <li>Win a round with the <b>lowest hand of 4 or less</b>.</li>
      <li>On your turn: <b>draw</b>, <b>take the last discard</b>, or <b>match</b> it by dropping one of yours with the same rank.</li>
      <li>Wrong match, or trying to stack a <b>third</b> card of the same rank? You keep your card and <b>draw 1</b>.</li>
      <li>After drawing, swap it for one of your cards (no peeking) or discard it. A taken discard must be swapped in.</li>
      <li><b>7</b>: look at one of yours. <b>8</b>: look at a rival's. <b>10</b>: pick one of yours and one of a rival's and swap them, blind. Powers only work when drawn from the deck.</li>
      <li>Think you're low? <b>Call Freeze</b> instead of drawing. Everyone else gets one last turn, then all cards flip.</li>
      <li>Values: A = 1, 2–10 = face, J/Q = 10, <b>black K = −2</b>, <b>red K = 0</b>.</li>
      <li><b>Rounds</b> mode: first to win the majority takes it. <b>Points</b> mode: totals add up, hit the limit and you're out.</li>
    </ul>
    <button type="button" class="btn primary wide" data-act="closeSheet">Got it</button>`;
  } else if (ui.sheet === 'profile') {
    body = `<h2>You</h2>${profileFields(ui.draft, true)}
      <button type="button" class="btn primary wide" data-act="saveProfile">Save</button>
      ${accountSection()}
      <button type="button" class="btn wide small" data-act="openRules">How to play</button>`;
  } else if (ui.sheet === 'board') {
    const inGame = ui.st && ui.st.players && ui.st.status !== 'lobby' && ui.st.round > 0;
    const tab = !inGame && ui.boardTab === 'game' ? 'all' : ui.boardTab;
    let content;
    if (tab === 'game') content = `<span class="eyebrow">${boardTitle(ui.st)}</span><div class="score">${gameBoard(ui.st)}</div>`;
    else if (tab === 'mine') {
      if (!ui.games) content = '<p class="waiting">Loading…</p>';
      else if (!ui.games.length) content = '<p class="waiting">Your finished games will show up here.</p>';
      else {
        content = `<ol class="lb">${ui.games.map((g) => `<li><span class="pill ${g.won ? 'host' : 'out'}" style="min-width:44px;text-align:center">${g.won ? 'Won' : 'Lost'}</span>
          <span class="ghist"><b>${esc(g.mode || '')}</b><small>${new Date(g.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${g.rounds || 0} round${g.rounds === 1 ? '' : 's'} · won by ${esc((g.champs || []).join(' & '))}</small></span>
          <span class="gpl">${(g.players || []).slice(0, 6).map((p) => avatarOf(p, 22)).join('')}</span></li>`).join('')}</ol>`;
      }
    } else if (!ui.board) content = '<p class="waiting">Loading…</p>';
    else if (!ui.board.length) content = '<p class="waiting">No finished games yet. Go win one!</p>';
    else {
      content = `<ol class="lb">${ui.board.map((p, i) => `<li class="${p.id === ui.me ? 'me' : ''}"><span class="rk">${i + 1}</span>${avatarOf(p, 32)}<span class="sname">${p.id === ui.me ? 'You' : esc(p.name || 'Player')}</span><span class="lbw"><b>${p.wins || 0}</b> win${p.wins === 1 ? '' : 's'}<small>${p.games || 0} played</small></span></li>`).join('')}</ol>`;
    }
    const tabBtn = (v, label) => `<button type="button" class="btn small ${tab === v ? 'on' : ''}" data-act="boardTab" data-v="${v}" aria-pressed="${tab === v}">${label}</button>`;
    body = `<h2>Leaderboard</h2>
      <div class="seg">${inGame ? tabBtn('game', 'This game') : ''}${tabBtn('all', 'All time')}${tabBtn('mine', 'My games')}</div>
      ${content}
      <button type="button" class="btn primary wide" data-act="closeSheet">Close</button>`;
  }
  return `<div class="sheet-bg" data-act="closeSheet"><div class="sheet" role="dialog" aria-modal="true" data-stop="1">${body}</div></div>`;
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
  $app.innerHTML = html + renderSheet() + (ui.err ? `<div class="error" role="alert">${esc(ui.err)}</div>` : '');
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

function syncDraftName() {
  const el = document.getElementById('name');
  if (el && ui.draft) ui.draft.name = el.value;
}

async function saveProfile() {
  syncDraftName();
  const d = ui.draft || ui.profile;
  const name = String(d.name || '').trim().slice(0, 14);
  if (!name) { showError('Enter your name first'); return false; }
  ui.profile = { ...ui.profile, ...d, name };
  storeProfile();
  ui.draft = null;
  ui.sheet = null;
  try { await ui.backend.saveProfile(ui.me, { ...profileForRoom(), layout: ui.profile.layout }); } catch (e) { console.error(e); }
  if (ui.st && player(ui.st, ui.me)) await act({ type: 'join', ...profileForRoom() });
  refreshStats();
  render();
  return true;
}

async function refreshStats() {
  try { ui.myStats = await ui.backend.getStats(ui.me); render(); } catch (e) { console.error(e); }
}

async function openBoard() {
  ui.sheet = 'board';
  ui.boardTab = ui.st && ui.st.status !== 'lobby' && ui.st.round > 0 ? 'game' : 'all';
  ui.board = null;
  render();
  try {
    const rows = await ui.backend.leaderboard();
    ui.board = rows.filter((r) => (r.games || 0) > 0).sort((a, b) => (b.wins || 0) - (a.wins || 0) || (b.games || 0) - (a.games || 0));
  } catch (e) { console.error(e); ui.board = []; }
  if (ui.sheet === 'board') render();
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
  ui.fxKey = null;
  history.replaceState(null, '', '?room=' + code);
  let first = true;
  ui.unsub = ui.backend.subscribe(code, async (st) => {
    if (first) {
      first = false;
      if (!st) { leaveRoom(); showError(`No room called ${code}`); return; }
      if (!player(st, ui.me) && st.status === 'lobby') {
        ui.st = st;
        await act({ type: 'join', ...profileForRoom() });
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
  // Count a finished game toward all-time stats, once per player per game. Solo games don't count.
  if (st.status === 'over' && st.gameId && !st.solo && player(st, ui.me)) {
    const k = 'freeze:rec:' + st.gameId;
    if (!ui.store.getItem(k)) {
      ui.store.setItem(k, '1');
      const s = st.settings;
      const summary = {
        gameId: st.gameId.replace(/[.#$/[\]]/g, '_'), at: Date.now(), won: st.champions.includes(ui.me),
        mode: s.mode === 'rounds' ? `Best of ${s.bestOf}` : `Play to ${s.limit}`, rounds: st.round,
        champs: st.champions.map((id) => G.nameOf(st, id)),
        players: st.players.map((p) => ({ name: p.name, icon: p.icon, color: p.color })),
      };
      ui.backend.recordGame(ui.me, profileForRoom(), summary.won, summary).then(refreshStats).catch(console.error);
    }
  }
  fxFor(st);
  ui.st = st;
  render();
  scheduleBots();
}

// Icicles when someone calls freeze, and when a round or the whole game is won.
// The first state seen in a room is only remembered, so joining never replays an old moment.
function fxFor(st) {
  if (!window.freezeIntro || !st) return;
  let key = null, opts = null;
  if (st.last && st.last.freeze && st.freezeBy) {
    key = 'f|' + st.last.t;
    opts = { title: 'FREEZE!', sub: `${G.nameOf(st, st.freezeBy)} called it`, hold: 2000 };
  } else if ((st.status === 'roundEnd' || st.status === 'over') && st.results) {
    key = `w|${st.gameId}|${st.round}|${st.status}`;
    const w = st.results.winners.map((id) => G.nameOf(st, id)).join(' & ');
    opts = st.status === 'over'
      ? { title: 'CHAMPION', sub: `${st.champions.map((id) => G.nameOf(st, id)).join(' & ')} wins the game`, hold: 2800 }
      : { title: 'ROUND WON', sub: w ? `${w} took round ${st.round}` : `Nobody made it to 4 in round ${st.round}`, hold: 2400 };
  }
  if (!key) return;
  if (ui.fxKey === null) { ui.fxKey = key; return; }
  if (key === ui.fxKey) return;
  ui.fxKey = key;
  window.freezeIntro(opts);
}

function leaveRoom() {
  if (ui.unsub) ui.unsub();
  clearTimeout(ui.botT); ui.botT = null;
  ui.unsub = null; ui.code = null; ui.st = null; ui.phaseKey = '';
  history.replaceState(null, '', location.pathname);
  refreshStats();
  render();
}

// ---------- Computer players (solo games) ----------
// Only the player's own browser runs the bots, one move at a time, through the same rules as everyone else.

const isBotId = (st, id) => !!(st && st.solo && (st.solo.bots || []).includes(id));

// Which computer player should move now, or null.
function pendingBot(st) {
  if (!st || !st.solo) return null;
  if (st.status === 'peek') return st.seats.find((id) => isBotId(st, id) && !st.ready[id]) || null;
  if (st.status === 'playing') { const id = G.currentId(st); return isBotId(st, id) ? id : null; }
  return null;
}

// Makes one bot move on a copy of the room. Returns the new room, or undefined when nothing is needed.
function botMove(cur, id) {
  const now = Date.now();
  if (cur.status === 'peek') {
    const next = G.apply(JSON.parse(JSON.stringify(cur)), { type: 'ready' }, id, now);
    BOT.note(cur, id, { type: 'ready' });
    return next;
  }
  let a = BOT.decide(cur, id);
  if (a) {
    try {
      const next = G.apply(JSON.parse(JSON.stringify(cur)), a, id, now);
      BOT.note(cur, id, a);
      return next;
    } catch (e) {
      if (!(e instanceof G.RuleError)) throw e;
    }
  }
  a = BOT.fallback(cur, id);
  const next = G.apply(JSON.parse(JSON.stringify(cur)), a, id, now);
  BOT.note(cur, id, a);
  return next;
}

function scheduleBots() {
  clearTimeout(ui.botT); ui.botT = null;
  if (!ui.code || !ui.st || !pendingBot(ui.st)) return;
  ui.botT = setTimeout(botTick, ui.st.status === 'peek' ? 500 : 900);
}

async function botTick() {
  ui.botT = null;
  const code = ui.code;
  const who = pendingBot(ui.st);
  if (!code || !who) return;
  try {
    await ui.backend.transact(code, (cur) => {
      if (!cur || pendingBot(cur) !== who) return undefined; // the room moved on
      return botMove(cur, who);
    });
  } catch (e) { console.error(e); }
}

async function startSolo() {
  const code = newCode();
  const bots = BOT.BOTS.slice(0, ui.solo.bots);
  const level = ui.solo.level;
  try {
    await ui.backend.transact(code, (cur) => {
      if (cur) throw new G.RuleError('Code clash, tap again');
      const st = G.createRoom(code, { id: ui.me, ...profileForRoom() });
      for (const b of bots) G.join(st, { id: b.id, name: b.name, icon: b.icon, color: b.color });
      st.solo = { level, bots: bots.map((b) => b.id) };
      return st;
    });
    enterRoom(code);
  } catch (e) { showError(e instanceof G.RuleError ? e.message : 'Could not start the game'); console.error(e); }
}

async function handle(actName, d) {
  const st = ui.st;
  switch (actName) {
    case 'soloBots': ui.solo.bots = Number(d.n); render(); return;
    case 'soloLevel': ui.solo.level = d.v === 'hard' ? 'hard' : 'easy'; render(); return;
    case 'soloStart': return startSolo();
    case 'create': {
      const code = newCode();
      try {
        await ui.backend.transact(code, (cur) => {
          if (cur) throw new G.RuleError('Code clash, tap again');
          return G.createRoom(code, { id: ui.me, ...profileForRoom() });
        });
        enterRoom(code);
      } catch (e) { showError(e instanceof G.RuleError ? e.message : 'Could not create the room'); console.error(e); }
      return;
    }
    case 'join': {
      const code = (d.code || (document.getElementById('code') || {}).value || '').trim().toUpperCase();
      if (code.length < 4) { showError('Enter the 4-letter room code'); return; }
      enterRoom(code);
      return;
    }
    case 'clearCode': history.replaceState(null, '', location.pathname); render(); return;
    case 'home':
      if (st && st.status === 'lobby') await act({ type: 'leave' });
      leaveRoom();
      return;
    case 'openRules': ui.sheet = 'rules'; render(); return;
    case 'openProfile': ui.draft = { ...ui.profile }; ui.sheet = 'profile'; render(); return;
    case 'openBoard': return openBoard();
    case 'boardTab':
      ui.boardTab = d.v;
      if (d.v === 'mine') {
        ui.games = null; render();
        try { ui.games = await ui.backend.myGames(ui.me); } catch (e) { console.error(e); ui.games = []; }
      }
      render();
      return;
    case 'google': return doAuth(() => ui.backend.google());
    case 'emailUp':
    case 'emailIn': {
      const email = ui.form.email.trim();
      const pw = ui.form.pw;
      if (!email || !pw) { showError('Enter your email and a password'); return; }
      return doAuth(() => (actName === 'emailUp' ? ui.backend.emailSignUp(email, pw) : ui.backend.emailSignIn(email, pw)));
    }
    case 'resetPw': {
      const email = ui.form.email.trim();
      if (!email) { showError('Type your email first'); return; }
      try { await ui.backend.resetPassword(email); showError('Check your email for a reset link'); } catch (e) { showError(authMessage(e)); }
      return;
    }
    case 'signOut':
      try { await ui.backend.signOut(); } catch (e) { console.error(e); }
      ui.store.removeItem('freeze:profile');
      location.href = location.pathname;
      return;
    case 'closeSheet': ui.sheet = null; ui.draft = ui.profile.name ? null : ui.draft; render(); return;
    case 'pickIcon': syncDraftName(); ui.draft.icon = d.v; render(); return;
    case 'pickColor': syncDraftName(); ui.draft.color = Number(d.v); render(); return;
    case 'pickLayout': syncDraftName(); ui.draft.layout = d.v; render(); return;
    case 'toggleLayout': ui.profile.layout = ui.profile.layout === 'row' ? 'grid' : 'row'; storeProfile(); render(); return;
    case 'saveProfile': {
      const wasNew = !ui.profile.name;
      const ok = await saveProfile();
      const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
      if (ok && wasNew && code) enterRoom(code);
      return;
    }
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
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled || !el.dataset.act) return;
  // Taps inside a sheet never close it unless they hit a real control.
  if (el.classList.contains('sheet-bg') && e.target !== el) return;
  handle(el.dataset.act, el.dataset);
});
$app.addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'email' || id === 'pw') ui.form[id] = e.target.value;
  if (id === 'name' && ui.draft) ui.draft.name = e.target.value;
});
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('input')) return;
  if (e.target.id === 'name') { handle('saveProfile', {}); return; }
  if (e.target.id === 'code') handle('join', {});
});

// ---------- Boot ----------

(async function boot() {
  ui.backend = await makeBackend();
  ui.me = ui.backend.uid;
  // In demo mode every tab is its own player, so each tab keeps its own profile.
  ui.store = ui.backend.demo ? sessionStorage : localStorage;
  loadProfile();
  // Signed-in players get their saved player from the account on any device.
  const acct = ui.backend.account();
  if (acct && !acct.anon) {
    try {
      const s = await ui.backend.getStats(ui.me);
      if (s && s.name) {
        ui.profile = { ...ui.profile, name: s.name, icon: s.icon || ui.profile.icon, color: s.color ?? ui.profile.color, layout: s.layout || ui.profile.layout };
        storeProfile();
      }
    } catch (e) { console.error(e); }
  }
  const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (code && ui.profile.name) enterRoom(code);
  else render();
  if (ui.profile.name) refreshStats();
})();
