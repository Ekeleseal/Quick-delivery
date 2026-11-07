'use strict';
// ---------- Small helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
const digits = (v) => Number(String(v ?? '').replace(/\D/g, '')) || 0;
const timeOf = (ts) => new Date(ts).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' });
const dayOf = (ts) => new Date(ts).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
const dateKeyLabel = (k) => new Date(k + 'T12:00:00').toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' });
const initials = (n) => String(n).split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const stars = (r) => `${Number(r).toFixed(1)} rating`;

const ICONS = {
  bike: '<circle cx="5.5" cy="16.5" r="3"/><circle cx="18.5" cy="16.5" r="3"/><path d="M8.5 16.5h4l3-6h-3M15.5 10.5l3 6M12 7.5h3"/>',
  car: '<path d="M3 15v-3l2-5h14l2 5v3M3 15h18M3 15v3h3v-3M21 15v3h-3v-3M6 12h12"/>',
  van: '<path d="M2 16V7h11v9M13 10h4l3 3v3H2"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9z"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  pin: '<path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  hand: '<path d="M4 13l4-4 4 3 4-3 4 4-6 6-3-1-3 1z"/>',
};
const ic = (n, s = 22) => `<svg class="ic" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

// ---------- State ----------
const A = {
  cfg: null, token: store.get('token', ''), user: null, feed: null,
  route: { name: 'welcome' }, ui: {}, sig: '',
  skipped: new Set(JSON.parse(store.get('skipped', '[]') || '[]')),
};
const ROADS = [['station', 'market'], ['station', 'hospital'], ['station', 'hotel'], ['station', 'stadium'], ['hotel', 'mall'],
  ['hotel', 'harbor'], ['market', 'park'], ['market', 'univ'], ['hospital', 'airport'], ['stadium', 'univ'], ['harbor', 'park'], ['stadium', 'hospital']];

// ---------- API ----------
async function api(path, body) {
  const res = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(A.token ? { Authorization: 'Bearer ' + A.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && A.token && !path.startsWith('auth/')) { signOut(); throw new Error('Your session ended. Please sign in again.'); }
  if (!res.ok) throw new Error(json.error || 'Something went wrong');
  return json;
}
let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3800);
}
async function run(fn) {
  try { await fn(); } catch (e) { toast(e.message, true); }
}
async function refreshFeed(force) {
  if (!A.user) return;
  A.feed = await api('feed');
  if (A.feed.me) A.user = A.feed.me;
  render(force);
}

// ---------- Navigation and rendering ----------
function go(name, params = {}) {
  A.route = { name, ...params };
  const s = $('#screen');
  if (s) s.scrollTop = 0;
  render(true);
}
function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.dataset || !el.dataset.k) return null;
  return { k: el.dataset.k, s: el.selectionStart, e: el.selectionEnd };
}
function restoreFocus(f) {
  if (!f) return;
  const el = $(`[data-k="${CSS.escape(f.k)}"]`);
  if (!el) return;
  el.focus();
  try { if (f.s != null) el.setSelectionRange(f.s, f.e); } catch { /* not a text input */ }
}
function render(force) {
  const sig = JSON.stringify([A.route, A.user && A.user.id, A.feed, A.cfg && A.cfg.settings]);
  if (!force && sig === A.sig) return;
  A.sig = sig;
  const f = captureFocus();
  $('#screen').innerHTML = screenHTML();
  const tabs = tabsHTML();
  $('#tabs').innerHTML = tabs;
  $('#tabs').hidden = !tabs;
  restoreFocus(f);
}
function signOut() {
  store.del('token');
  Object.assign(A, { token: '', user: null, feed: null, ui: {}, route: { name: 'welcome' } });
  render(true);
}

const TABS = {
  customer: [['home', 'Home', 'home'], ['list', 'Deliveries', 'list'], ['profile', 'Profile', 'user']],
  courier: [['home', 'Home', 'home'], ['earnings', 'Earnings', 'wallet'], ['list', 'Deliveries', 'list'], ['profile', 'Profile', 'user']],
  admin: [['home', 'Overview', 'chart'], ['commission', 'Commission', 'wallet'], ['settings', 'Settings', 'gear']],
};
function tabsHTML() {
  if (!A.user || A.route.name === 'new') return '';
  const on = A.route.name === 'delivery' ? 'list' : A.route.name;
  return TABS[A.user.role].map(([n, label, icon]) =>
    `<button type="button" class="tab${on === n ? ' on' : ''}" data-do="go" data-to="${n}" ${on === n ? 'aria-current="page"' : ''}>${ic(icon)}<span>${label}</span></button>`).join('');
}
function screenHTML() {
  const n = A.route.name, u = A.user;
  if (!u) return ({ welcome, login, register }[n] || welcome)();
  const M = {
    customer: { home: custHome, new: wizard, delivery: custDelivery, list: custList, profile },
    courier: { home: courHome, earnings: courEarnings, list: courList, profile },
    admin: { home: adminHome, commission: adminCommission, settings: adminSettings, profile },
  }[u.role];
  return (M[n] || M.home)();
}

// ---------- Reusable UI pieces ----------
const topBar = (title, sub) => `<header class="top"><div><p class="sm muted">${esc(sub)}</p><h1 class="name">${esc(title)}</h1></div><span class="avatar" aria-hidden="true">${esc(initials(A.user.name))}</span></header>`;
const backBar = (title, to, id) => `<header class="bar"><button type="button" class="back" data-do="go" data-to="${to}" ${id ? `data-id="${id}"` : ''} aria-label="Back">${ic('back', 26)}</button><h1>${esc(title)}</h1></header>`;
function field(label, k, o = {}) {
  const v = A.ui[k] ?? o.value ?? '';
  const a = (n, val) => (val ? ` ${n}="${esc(val)}"` : '');
  const tag = o.area ? `<textarea data-k="${k}" rows="2"${a('placeholder', o.ph)}${a('maxlength', o.max)}>${esc(v)}</textarea>` :
    `<input data-k="${k}" value="${esc(v)}"${a('type', o.type)}${a('placeholder', o.ph)}${a('inputmode', o.mode)}${a('maxlength', o.max)}${a('autocomplete', o.ac)}>`;
  return `<label class="field"><span>${esc(label)}</span>${tag}</label>`;
}
function selectField(label, k, options) {
  const v = A.ui[k] ?? options[0][0];
  return `<label class="field"><span>${esc(label)}</span><select data-k="${k}">${options.map(([val, txt]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(txt)}</option>`).join('')}</select></label>`;
}
function seg(label, k, options) {
  const v = A.ui[k] ?? options[0][0];
  return `<div class="field"><span>${esc(label)}</span><div class="seg" role="group" aria-label="${esc(label)}">${options.map(([val, txt]) =>
    `<button type="button" class="${val === v ? 'on' : ''}" data-do="pick" data-k="${k}" data-v="${esc(val)}" aria-pressed="${val === v}">${esc(txt)}</button>`).join('')}</div></div>`;
}
function vehicleTiles(k) {
  const v = A.ui[k] || 'bike';
  return `<div class="field"><span>Vehicle type</span><div class="tiles" role="group" aria-label="Vehicle type">${Object.entries(A.cfg.vehicles).map(([id, o]) =>
    `<button type="button" class="tile${v === id ? ' on' : ''}" data-do="pick" data-k="${k}" data-v="${id}" aria-pressed="${v === id}">${ic(id, 34)}<small>${esc(o.label)}</small></button>`).join('')}</div></div>`;
}
const STATUS = {
  open: ['Waiting for offers', 'warn'], sealed: ['Deal sealed', 'teal'], picked_up: ['On its way', 'teal'],
  delivered: ['Delivered', 'good'], cancelled: ['Cancelled', 'grey'],
};
const chip = (d) => {
  const [t, c] = STATUS[d.status] || [d.status, 'grey'];
  const label = d.status === 'open' && d.threads && d.threads.length ? `${d.threads.filter((x) => x.status === 'active').length} offer${d.threads.filter((x) => x.status === 'active').length === 1 ? '' : 's'}` : t;
  return `<span class="chip ${c}">${esc(label)}</span>`;
};

function mapSvg({ pickup, dropoff, courier } = {}) {
  const P = A.cfg.places, byId = Object.fromEntries(P.map((p) => [p.id, p]));
  const hi = new Set([pickup && pickup.id, dropoff && dropoff.id]);
  let h = '<path d="M-2 38 C 18 28, 32 58, 52 42 S 82 52, 102 40" fill="none" stroke="#BFDDE6" stroke-width="7" stroke-linecap="round"/>';
  ROADS.forEach(([a, b]) => {
    h += `<line x1="${byId[a].x}" y1="${byId[a].y}" x2="${byId[b].x}" y2="${byId[b].y}" stroke="#C5D0CC" stroke-width="2"/><line x1="${byId[a].x}" y1="${byId[a].y}" x2="${byId[b].x}" y2="${byId[b].y}" stroke="#fff" stroke-width="1.3"/>`;
  });
  P.forEach((p) => {
    const end = p.x > 72;
    h += `<circle cx="${p.x}" cy="${p.y}" r="0.9" fill="#7C8F93"/><text x="${p.x + (end ? -2 : 2)}" y="${p.y + 1}" text-anchor="${end ? 'end' : 'start'}" class="mp${hi.has(p.id) ? ' hi' : ''}">${esc(p.name)}</text>`;
  });
  if (pickup && dropoff) h += `<line x1="${pickup.x}" y1="${pickup.y}" x2="${dropoff.x}" y2="${dropoff.y}" stroke="#00606B" stroke-width="0.9" stroke-dasharray="1.8 1.4"/>`;
  if (pickup) h += `<circle cx="${pickup.x}" cy="${pickup.y}" r="2.6" fill="#00606B" stroke="#fff" stroke-width="0.8"><title>Pickup</title></circle><circle cx="${pickup.x}" cy="${pickup.y}" r="0.9" fill="#fff"/>`;
  if (dropoff) h += `<rect x="${dropoff.x - 2.3}" y="${dropoff.y - 2.3}" width="4.6" height="4.6" rx="1" fill="#16282C" stroke="#fff" stroke-width="0.8"><title>Drop-off</title></rect>`;
  if (courier) h += `<circle cx="${courier.x}" cy="${courier.y}" r="3.2" fill="#F2B705" stroke="#16282C" stroke-width="0.8"><title>Rider</title></circle><text x="${courier.x}" y="${courier.y + 1.2}" text-anchor="middle" class="mc">R</text>`;
  return `<svg class="map" id="map" viewBox="0 0 100 100" role="img" aria-label="Map of the route">${h}</svg>`;
}
const placeOf = (id) => A.cfg.places.find((p) => p.id === id);
const routeText = (d) => `${esc(d.pickup.name)} to ${esc(d.dropoff.name)}`;
const empty = (t) => `<p class="empty">${esc(t)}</p>`;
function deliveryRow(d, forCourier) {
  const price = d.agreedPrice || d.askPrice;
  return `<button type="button" class="row" ${forCourier ? 'disabled' : `data-do="go" data-to="delivery" data-id="${d.id}"`}>
    <span><strong>${routeText(d)}</strong><span class="sm muted">${esc(d.item)}, ${dayOf(d.createdAt)} ${timeOf(d.createdAt)}</span></span>
    <span class="right"><span class="money">${naira(price)}</span>${chip(d)}</span></button>`;
}

// ---------- Signed-out screens ----------
function welcome() {
  return `<section class="hero">
    <svg class="hero-art" viewBox="0 0 320 230" aria-hidden="true"><path d="M-10 200 C 70 200, 80 120, 150 120 S 250 70, 330 36" fill="none" stroke="#2E8E99" stroke-width="30" stroke-linecap="round"/><path d="M-10 200 C 70 200, 80 120, 150 120 S 250 70, 330 36" fill="none" stroke="#F2B705" stroke-width="2.5" stroke-dasharray="11 9"/><circle cx="262" cy="58" r="13" fill="#F2B705"/><circle cx="262" cy="58" r="5" fill="#00606B"/><rect x="60" y="150" width="26" height="26" rx="6" fill="#fff"/><rect x="66" y="156" width="14" height="14" rx="3" fill="#00606B"/></svg>
    <div class="brand"><span class="logo" aria-hidden="true">${ic('hand', 22)}</span>RideDispatch</div>
    <h1 class="big">Send anything.<br>Agree your price.</h1>
    <p class="lead">Book a dispatch rider, negotiate the fare, and shake on it. No surprises.</p>
    <button type="button" class="btn primary block" data-do="go" data-to="register">Get started</button>
    <p class="center sm">Have an account already? <button type="button" class="link" data-do="go" data-to="login">Sign in</button></p>
  </section>`;
}
function login() {
  return `${backBar('Sign in', 'welcome')}<form class="pad stack" data-form="login">
    ${field('Phone number', 'li.phone', { type: 'tel', mode: 'tel', ac: 'tel', max: 20 })}
    ${field('PIN', 'li.pin', { type: 'password', mode: 'numeric', ac: 'current-password', max: 6 })}
    <button class="btn primary block" type="submit">Sign in</button>
    <p class="center sm">New here? <button type="button" class="link" data-do="go" data-to="register">Create an account</button></p></form>`;
}
function register() {
  const step = A.route.step || 1;
  if (step === 1) {
    return `${backBar('Create account', 'welcome')}<div class="pad stack"><p class="muted">How will you use RideDispatch?</p>
      <button type="button" class="mintcard" data-do="role" data-v="customer">${ic('bolt', 28)}<strong>I want to send packages</strong><span>Post a delivery, name your price and pick the offer you like.</span></button>
      <button type="button" class="mintcard alt" data-do="role" data-v="courier">${ic('bike', 28)}<strong>I am a dispatch rider</strong><span>Browse requests, counter the price, and keep what you earn minus a flat ${naira(A.cfg.settings.commissionPerDay)} per active day.</span></button></div>`;
  }
  const rider = A.ui['reg.role'] === 'courier';
  return `${backBar(rider ? 'Rider sign-up' : 'Your details', 'register')}<form class="pad stack" data-form="register">
    ${field('Full name', 'reg.name', { ac: 'name', max: 60 })}
    ${field('Phone number', 'reg.phone', { type: 'tel', mode: 'tel', ac: 'tel', max: 20 })}
    ${field('Choose a PIN (4 to 6 digits)', 'reg.pin', { type: 'password', mode: 'numeric', ac: 'new-password', max: 6 })}
    ${rider ? vehicleTiles('reg.vehicle') + field('Plate number', 'reg.plate', { max: 15 }) : ''}
    <button class="btn primary block" type="submit">Create account</button></form>`;
}

// ---------- Customer ----------
function custHome() {
  const ds = A.feed ? A.feed.deliveries : [];
  const active = ds.filter((d) => ['sealed', 'picked_up'].includes(d.status));
  const open = ds.filter((d) => d.status === 'open');
  let h = topBar(A.user.name, 'Welcome back');
  h += '<div class="pad">';
  if (active.length) {
    h += `<p class="sm muted">You have ${active.length} ${active.length === 1 ? 'delivery' : 'deliveries'} in progress</p>` + active.map((d) =>
      `<button type="button" class="banner" data-do="go" data-to="delivery" data-id="${d.id}"><span class="chip warn">${esc(STATUS[d.status][0])}</span><strong>Delivery #${d.id}</strong><span class="sm">To ${esc(d.recipientName)}, ${routeText(d)}</span><span class="sm"><b>${naira(d.agreedPrice)}</b> agreed</span></button>`).join('');
  }
  if (open.length) {
    h += `<p class="sm muted">Waiting for riders</p>` + open.map((d) => {
      const n = d.threads.filter((t) => t.status === 'active').length;
      return `<button type="button" class="banner calm" data-do="go" data-to="delivery" data-id="${d.id}"><strong>Delivery #${d.id}: ${routeText(d)}</strong><span class="sm">${n ? `${n} offer${n === 1 ? '' : 's'} to review` : 'No offers yet'}. You asked ${naira(d.askPrice)}.</span></button>`;
    }).join('');
  }
  h += `<hr><p class="label">What would you like to do?</p>
    <button type="button" class="mintcard" data-do="new">${ic('bolt', 28)}<strong>Request a delivery</strong><span>Name your price. Riders accept or counter, and you choose the offer you like.</span></button>`;
  const recent = ds.filter((d) => ['delivered', 'cancelled'].includes(d.status)).slice(0, 3);
  if (recent.length) h += `<p class="label">Recent</p><div class="list">${recent.map((d) => deliveryRow(d)).join('')}</div>`;
  return h + '</div>';
}
function custList() {
  const ds = A.feed ? A.feed.deliveries : [];
  return `${topBar('Deliveries', 'All your requests')}<div class="pad">${ds.length ? `<div class="list">${ds.map((d) => deliveryRow(d)).join('')}</div>` : empty('No deliveries yet. Request one from the Home tab.')}</div>`;
}

function resetWizard() {
  Object.keys(A.ui).filter((k) => k.startsWith('w.')).forEach((k) => delete A.ui[k]);
  Object.assign(A.ui, {
    'w.step': 1, 'w.pickupId': 'station', 'w.dropoffId': 'mall', 'w.vehicle': 'bike', 'w.item': A.cfg.items[0],
    'w.quantity': '1', 'w.payer': 'sender', 'w.payMethod': 'cash',
  });
}
function wizard() {
  const u = A.ui, step = u['w.step'] || 1;
  const names = ['Where to?', 'Details', 'Your price'];
  const back = `<header class="bar"><button type="button" class="back" data-do="${step === 1 ? 'go' : 'wiz-back'}" data-to="home" aria-label="Back">${ic('back', 26)}</button><h1>${names[step - 1]}</h1><span class="stepno">Step ${step} of 3</span></header>`;
  const areas = A.cfg.places.map((p) => [p.id, p.name]);
  if (step === 1) {
    return `${back}<div class="pad stack">${mapSvg({ pickup: placeOf(u['w.pickupId']), dropoff: placeOf(u['w.dropoffId']) })}
      ${selectField('Pickup area', 'w.pickupId', areas)}${field('Pickup street address', 'w.pickupAddress', { ph: '32 Samwell Sq', max: 120 })}
      ${selectField('Drop-off area', 'w.dropoffId', areas)}${field('Drop-off street address', 'w.dropoffAddress', { ph: '21b Karimu Kotun Street', max: 120 })}
      ${vehicleTiles('w.vehicle')}
      <button type="button" class="btn primary block" data-do="wiz-next">Next</button></div>`;
  }
  if (step === 2) {
    return `${back}<div class="pad stack">
      ${selectField('What are you sending?', 'w.item', A.cfg.items.map((i) => [i, i]))}
      ${field('Quantity', 'w.quantity', { type: 'number', mode: 'numeric', max: 2 })}
      ${seg('Who pays the rider?', 'w.payer', [['sender', 'Me'], ['recipient', 'Recipient']])}
      ${seg('How will they pay?', 'w.payMethod', [['cash', 'Cash'], ['transfer', 'Bank transfer']])}
      <p class="sm muted">You pay the rider directly. RideDispatch does not handle the money.</p>
      ${field('Recipient name', 'w.recipientName', { max: 60 })}
      ${field('Recipient phone number', 'w.recipientPhone', { type: 'tel', mode: 'tel', max: 20 })}
      ${field('Note for the rider (optional)', 'w.note', { area: true, max: 200, ph: 'Fragile. Call on arrival.' })}
      <p class="sm muted">Riders only see the recipient details after you agree on a price.</p>
      <button type="button" class="btn primary block" data-do="wiz-next">Next</button></div>`;
  }
  const e = u['w.est'];
  return `${back}<div class="pad stack">
    <div class="card"><strong>${esc(placeOf(u['w.pickupId']).name)} to ${esc(placeOf(u['w.dropoffId']).name)}</strong>
      <p class="sm muted">${esc(u['w.item'])} x${esc(u['w.quantity'])}, ${esc(A.cfg.vehicles[u['w.vehicle']].label)}${e ? `, about ${e.km} km` : ''}</p></div>
    ${e ? `<div class="hint"><strong>Riders usually ask ${naira(e.low)} to ${naira(e.high)}</strong><span class="sm">Suggested starting price: ${naira(e.suggested)}</span></div>` : ''}
    <label class="field"><span>Your price (naira)</span><div class="priceinput"><button type="button" class="step" data-do="price-adj" data-d="-100" aria-label="Lower by 100">-</button>
      <input data-k="w.price" inputmode="numeric" value="${esc(u['w.price'] ?? '')}" aria-label="Your price in naira"><button type="button" class="step" data-do="price-adj" data-d="100" aria-label="Raise by 100">+</button></div></label>
    <p class="sm muted">Riders can accept this price or counter it. You only agree when you accept an offer, and the minimum is ${naira(A.cfg.settings.minPrice)}.</p>
    <button type="button" class="btn primary block" data-do="wiz-post">Post request</button></div>`;
}

function threadHTML(d, t) {
  const key = `${d.id}:${t.courierId}`;
  const c = t.courier || { name: 'Rider', vehicle: 'bike', rating: 5, completed: 0 };
  const hist = t.history.filter((x) => !x.accepted).map((x) => `${x.by === 'customer' ? 'You' : 'Rider'} ${naira(x.price)}`).join(', then ');
  let h = `<article class="thread"><div class="who"><span class="avatar sm">${esc(initials(c.name))}</span><div><strong>${esc(c.name)}</strong>
    <span class="sm muted">${esc(A.cfg.vehicles[c.vehicle] ? A.cfg.vehicles[c.vehicle].label : c.vehicle)}, ${stars(c.rating)}, ${c.completed} trips</span></div><span class="money big">${naira(t.price)}</span></div>
    <p class="sm muted">${esc(hist)}</p>`;
  if (t.status === 'active') {
    if (t.turn === 'customer') h += `<p class="sm"><b>${esc(c.name.split(' ')[0])} asks ${naira(t.price)}.</b> Accept, counter, or decline.</p>`;
    else h += `<p class="sm">You offered ${naira(t.price)}. Waiting for their reply.</p>`;
    h += counterBox(key, t.price, d.id, t.courierId);
    h += `<div class="actions">${t.turn === 'customer' ? `<button type="button" class="btn primary small" data-do="accept" data-id="${d.id}" data-courier="${t.courierId}">Accept ${naira(t.price)}</button>` : ''}
      <button type="button" class="btn ghost small" data-do="counter-toggle" data-key="${key}" data-price="${t.price}">${t.turn === 'customer' ? 'Counter' : 'Change offer'}</button>
      <button type="button" class="btn danger small" data-do="leave" data-id="${d.id}" data-courier="${t.courierId}">Decline</button></div>`;
  } else h += `<p class="sm muted">${{ declined: 'You declined this rider.', withdrawn: 'This rider walked away.', closed: 'Closed.', accepted: 'Deal sealed.' }[t.status] || ''}</p>`;
  return h + '</article>';
}
function counterBox(key, price, id, courierId) {
  if (!A.ui['c.open.' + key]) return '';
  return `<div class="counter"><input data-k="c.${key}" inputmode="numeric" value="${esc(A.ui['c.' + key] ?? price)}" aria-label="Your offer in naira">
    <button type="button" class="btn primary small" data-do="counter-send" data-id="${id}" ${courierId ? `data-courier="${courierId}"` : ''} data-key="${key}">Send offer</button></div>`;
}

function custDelivery() {
  const d = (A.feed ? A.feed.deliveries : []).find((x) => String(x.id) === String(A.route.id));
  if (!d) return `${backBar('Delivery', 'list')}<div class="pad">${empty('We could not find this delivery.')}</div>`;
  let h = `${backBar('Delivery #' + d.id, 'list')}<div class="pad stack">`;
  h += `<div class="between">${chip(d)}<span class="money big">${naira(d.agreedPrice || d.askPrice)}</span></div>`;
  h += mapSvg({ pickup: d.pickup, dropoff: d.dropoff, courier: d.courier && ['sealed', 'picked_up'].includes(d.status) ? d.courier : null });
  h += `<div class="card"><p><b>From</b> ${esc(d.pickup.name)}<br><span class="sm muted">${esc(d.pickup.address)}</span></p><p><b>To</b> ${esc(d.dropoff.name)}<br><span class="sm muted">${esc(d.dropoff.address)}</span></p>
    <p class="sm muted">${esc(d.item)} x${d.quantity}, ${esc(A.cfg.vehicles[d.vehicle].label)}, ${d.km} km. ${d.payer === 'sender' ? 'You pay' : 'Recipient pays'} by ${esc(d.payMethod)}.</p>
    <p class="sm muted">Recipient: ${esc(d.recipientName)}, ${esc(d.recipientPhone)}</p></div>`;
  if (d.status === 'open') {
    const live = d.threads.filter((t) => t.status === 'active'), past = d.threads.filter((t) => t.status !== 'active');
    h += `<h2 class="h2">Offers</h2>`;
    h += live.length ? live.map((t) => threadHTML(d, t)).join('') : empty(`No offers yet. Riders nearby can see your request, asking ${naira(d.askPrice)}. This page updates by itself.`);
    if (past.length) h += `<details class="past"><summary>Earlier offers (${past.length})</summary>${past.map((t) => threadHTML(d, t)).join('')}</details>`;
    h += `<button type="button" class="btn danger block" data-do="cancel" data-id="${d.id}">Cancel request</button>`;
  } else if (d.courier && d.status !== 'cancelled') {
    const c = d.courier;
    h += `<div class="card ok"><strong>Deal sealed at ${naira(d.agreedPrice)}</strong>
      <p class="sm">${d.status === 'sealed' ? 'Your rider is heading to the pickup point.' : d.status === 'picked_up' ? 'Your package is on its way.' : 'Delivered. Thank you for using RideDispatch.'}</p>
      <p><b>${esc(c.name)}</b>, ${esc(A.cfg.vehicles[c.vehicle].label)}, plate ${esc(c.plate)}<br><span class="sm muted">${stars(c.rating)}, ${c.completed} trips</span></p>
      <a class="btn ghost small" href="tel:${esc(c.phone)}">Call rider</a></div>`;
    if (d.status === 'sealed') h += `<button type="button" class="btn danger block" data-do="cancel" data-id="${d.id}">Cancel delivery</button>`;
    if (d.status === 'delivered') {
      h += d.rating ? `<p class="center muted">You rated this trip ${d.rating} out of 5.</p>` :
        `<div class="card"><strong>Rate your rider</strong><div class="stars" role="group" aria-label="Rate your rider">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-do="rate" data-id="${d.id}" data-n="${n}" aria-label="${n} stars">${n}★</button>`).join('')}</div></div>`;
    }
  } else if (d.status === 'cancelled') h += empty('This delivery was cancelled.');
  return h + '</div>';
}

// ---------- Courier ----------
function reqCard(d) {
  const t = d.myThread, online = A.user.courier.online, key = `${d.id}:me`;
  let h = `<article class="req"><div class="between"><span class="vh">${ic(d.vehicle, 26)}<span><strong>${esc(d.item)} x${d.quantity}</strong><span class="sm muted">From ${esc(d.customerName)}</span></span></span>
    <span class="right"><span class="sm muted">${t ? 'Latest' : 'Asking'}</span><span class="money big">${naira(t ? t.price : d.askPrice)}</span></span></div>
    <p class="route"><b>${esc(d.pickup.name)}</b> <span class="sm muted">${esc(d.pickup.address)}</span><br><b>${esc(d.dropoff.name)}</b> <span class="sm muted">${esc(d.dropoff.address)}</span></p>
    <p class="sm muted">${d.km} km, about ${d.minutes} min. ${d.payer === 'sender' ? 'Sender pays' : 'Recipient pays'} by ${esc(d.payMethod)}.${d.note ? ` Note: ${esc(d.note)}` : ''}</p>`;
  const price = t ? t.price : d.askPrice;
  h += counterBox(key, price, d.id, null);
  if (!online) h += '<p class="sm warnText">Go online to send offers.</p>';
  if (t && t.turn === 'customer') h += `<p class="sm">Your offer is ${naira(t.price)}. Waiting for the customer.</p>`;
  if (t && t.turn === 'courier') h += `<p class="sm"><b>The customer countered ${naira(t.price)}.</b></p>`;
  h += `<div class="actions">`;
  if (!t || t.turn === 'courier') h += `<button type="button" class="btn primary small" data-do="accept" data-id="${d.id}" ${online ? '' : 'disabled'}>Accept ${naira(price)}</button>`;
  h += `<button type="button" class="btn ghost small" data-do="counter-toggle" data-key="${key}" data-price="${price}" ${online ? '' : 'disabled'}>${t && t.turn === 'customer' ? 'Change offer' : 'Counter'}</button>`;
  h += t ? `<button type="button" class="btn danger small" data-do="leave" data-id="${d.id}">Walk away</button>` : `<button type="button" class="btn ghost small" data-do="skip" data-id="${d.id}">Skip</button>`;
  return h + '</div></article>';
}
function jobCard(j) {
  const next = j.status === 'sealed' ? 'I have picked up the package' : 'I have delivered it';
  return `<article class="req job"><div class="between"><span class="chip teal">${esc(STATUS[j.status][0])}</span><span class="money big">${naira(j.agreedPrice)}</span></div>
    ${mapSvg({ pickup: j.pickup, dropoff: j.dropoff, courier: A.user.courier })}<p class="sm muted center">Tap the map to update your position.</p>
    <p class="route"><b>Pickup</b> ${esc(j.pickup.name)} <span class="sm muted">${esc(j.pickup.address)}</span><br><b>Drop-off</b> ${esc(j.dropoff.name)} <span class="sm muted">${esc(j.dropoff.address)}</span></p>
    <p class="sm">${esc(j.item)} x${j.quantity}. ${j.payer === 'sender' ? 'Sender pays' : 'Recipient pays'} by ${esc(j.payMethod)}, ${naira(j.agreedPrice)}.${j.note ? ` Note: ${esc(j.note)}` : ''}</p>
    <div class="card"><p class="sm"><b>Recipient</b> ${esc(j.recipientName)}</p><div class="actions"><a class="btn ghost small" href="tel:${esc(j.recipientPhone)}">Call ${esc(j.recipientPhone)}</a>
      ${j.customerPhone ? `<a class="btn ghost small" href="tel:${esc(j.customerPhone)}">Call customer</a>` : ''}</div></div>
    <button type="button" class="btn primary block" data-do="advance" data-id="${j.id}">${next}</button></article>`;
}
function courHome() {
  const F = A.feed || { available: [], mine: [], earnings: { today: {}, commissionPerDay: 500 } };
  const c = A.user.courier, job = F.mine.find((d) => ['sealed', 'picked_up'].includes(d.status));
  const e = F.earnings;
  let h = topBar(A.user.name, 'Welcome back') + '<div class="pad">';
  h += `<div class="toggle ${c.online ? 'on' : ''}"><div><strong>${c.online ? 'You are online' : 'You are offline'}</strong><span class="sm">${c.online ? 'Customers can see your offers.' : 'Go online to see requests and send offers.'}</span></div>
    <button type="button" class="btn ${c.online ? 'ghost' : 'primary'} small" data-do="online" data-v="${c.online ? '0' : '1'}" ${job && c.online ? 'disabled' : ''}>${c.online ? 'Go offline' : 'Go online'}</button></div>`;
  h += `<p class="sm muted commission">Flat ${naira(e.commissionPerDay)} per active day, taken after your first delivery of the day. Today: ${e.today.commission ? `${naira(e.today.commission)} charged` : 'not charged yet'}. Net today ${naira(e.today.net || 0)}.</p>`;
  if (job) h += `<h2 class="h2">Current delivery</h2>${jobCard(job)}`;
  else {
    const list = F.available.filter((d) => !A.skipped.has(d.id) || d.myThread);
    h += `<h2 class="h2">Available requests</h2>${list.length ? list.map(reqCard).join('') : empty(c.online ? `No ${A.cfg.vehicles[c.vehicle].label.toLowerCase()} requests right now. New ones appear here by themselves.` : 'You are offline.')}`;
  }
  return h + '</div>';
}
function courEarnings() {
  const e = (A.feed && A.feed.earnings) || { today: {}, week: [], owed: 0, commissionPerDay: 500, totalDelivered: 0 };
  return `${topBar('Earnings', 'Your money')}<div class="pad stack">
    <div class="card big"><span class="sm muted">Net today</span><span class="money huge">${naira(e.today.net || 0)}</span>
      <div class="three"><span><b>${e.today.deliveries || 0}</b><small>Deliveries</small></span><span><b>${naira(e.today.gross || 0)}</b><small>Earned</small></span><span><b>${naira(e.today.commission || 0)}</b><small>Commission</small></span></div></div>
    <p class="sm muted">Commission is a flat ${naira(e.commissionPerDay)} for each day you complete at least one delivery, however many you do.</p>
    ${e.owed ? `<div class="banner calm"><strong>${naira(e.owed)} commission to pay</strong><span class="sm">Settle with the RideDispatch admin.</span></div>` : ''}
    <h2 class="h2">Last 7 days</h2><div class="list">${e.week.map((d) => `<div class="row static"><span><strong>${dateKeyLabel(d.date)}</strong><span class="sm muted">${d.deliveries} ${d.deliveries === 1 ? 'delivery' : 'deliveries'}, earned ${naira(d.gross)}, commission ${naira(d.commission)}</span></span><span class="money">${naira(d.net)}</span></div>`).join('')}</div></div>`;
}
function courList() {
  const ds = A.feed ? A.feed.mine : [];
  return `${topBar('Deliveries', 'Your jobs')}<div class="pad">${ds.length ? `<div class="list">${ds.map((d) => deliveryRow(d, true)).join('')}</div>` : empty('No deliveries yet. Accept a request from the Home tab.')}</div>`;
}

// ---------- Profile ----------
function profile() {
  const u = A.user, c = u.courier;
  return `${topBar('Profile', u.role === 'admin' ? 'Administrator' : u.role === 'courier' ? 'Dispatch rider' : 'Customer')}<div class="pad stack">
    <div class="card"><p><b>${esc(u.name)}</b></p><p class="sm muted">${esc(u.phone)}</p>
      ${c ? `<p class="sm">${esc(A.cfg.vehicles[c.vehicle].label)}, plate ${esc(c.plate)}</p><p class="sm muted">${stars(c.rating)} from ${c.ratingCount} ratings, ${c.completed} trips</p>` : ''}</div>
    <button type="button" class="btn ghost block" data-do="signout">Sign out</button></div>`;
}

// ---------- Admin ----------
function adminHome() {
  const F = A.feed;
  if (!F) return topBar('Overview', 'Admin') + '<div class="pad"></div>';
  const t = F.totals;
  const box = (n, l) => `<div><b>${n}</b><span>${l}</span></div>`;
  return `${topBar('Overview', 'Admin')}<div class="pad stack"><div class="stats">${box(t.open, 'Open requests')}${box(t.active, 'In progress')}${box(t.delivered, 'Delivered')}${box(t.online + '/' + t.couriers, 'Riders online')}${box(t.customers, 'Customers')}${box(naira(t.owed), 'Commission owed')}</div>
    <h2 class="h2">Recent deliveries</h2>${F.deliveries.length ? `<div class="list">${F.deliveries.slice(0, 25).map((d) =>
    `<div class="row static"><span><strong>#${d.id} ${routeText(d)}</strong><span class="sm muted">${esc(d.customer)}${d.courier ? ' with ' + esc(d.courier) : ''}, ${d.threadCount} negotiat${d.threadCount === 1 ? 'ion' : 'ions'}</span></span><span class="right"><span class="money">${naira(d.agreedPrice || d.askPrice)}</span>${chip(d)}</span></div>`).join('')}</div>` : empty('No deliveries yet.')}</div>`;
}
function adminCommission() {
  const F = A.feed;
  if (!F) return topBar('Commission', 'Admin') + '<div class="pad"></div>';
  const t = F.totals;
  return `${topBar('Commission', 'Flat ' + naira(F.settings.commissionPerDay) + ' per rider per active day')}<div class="pad stack">
    <div class="stats two"><div><b>${naira(t.owed)}</b><span>Owed</span></div><div><b>${naira(t.collected)}</b><span>Collected</span></div></div>
    <h2 class="h2">Riders</h2><div class="list">${F.couriers.length ? F.couriers.map((c) => `<div class="row static"><span><strong>${esc(c.name)}</strong><span class="sm muted">${esc(c.phone)}, ${c.completed} trips, ${c.online ? 'online' : 'offline'}</span></span>
      <span class="right"><span class="money">${naira(c.owed)}</span>${c.owed ? `<button type="button" class="btn primary small" data-do="settle" data-id="${esc(c.id)}">Mark paid</button>` : '<span class="chip grey">Nothing owed</span>'}</span></div>`).join('') : empty('No riders yet.')}</div>
    <h2 class="h2">Ledger</h2><div class="list">${F.ledger.length ? F.ledger.map((l) => `<div class="row static"><span><strong>${esc(l.courier)}</strong><span class="sm muted">${dateKeyLabel(l.date)}, delivery #${l.deliveryId}</span></span><span class="right"><span class="money">${naira(l.amount)}</span><span class="chip ${l.status === 'paid' ? 'good' : 'warn'}">${l.status === 'paid' ? 'Paid' : 'Owed'}</span></span></div>`).join('') : empty('Nothing charged yet. Commission is added when a rider completes their first delivery of the day.')}</div></div>`;
}
function adminSettings() {
  const s = (A.feed && A.feed.settings) || A.cfg.settings;
  return `${topBar('Settings', 'Admin')}<form class="pad stack" data-form="settings">
    ${field('Commission per rider per active day (naira)', 's.commission', { value: s.commissionPerDay, mode: 'numeric', max: 6 })}
    ${field('Minimum price for a delivery (naira)', 's.min', { value: s.minPrice, mode: 'numeric', max: 6 })}
    <p class="sm muted">A new commission applies from the next rider-day charged. Entries already in the ledger keep their amount.</p>
    <button class="btn primary block" type="submit">Save settings</button>
    <button type="button" class="btn ghost block" data-do="signout">Sign out</button></form>`;
}

// ---------- Actions ----------
async function afterAuth(r) {
  A.token = r.token; A.user = r.user; store.set('token', r.token);
  A.ui = {};
  A.route = { name: 'home' };
  await refreshFeed(true);
}
const U = (k) => String(A.ui[k] ?? '').trim();
const actions = {
  go: (b) => { if (b.dataset.to === 'new') return actions.new(); go(b.dataset.to, b.dataset.id ? { id: b.dataset.id } : {}); },
  new: () => { resetWizard(); go('new'); },
  role: (b) => { A.ui['reg.role'] = b.dataset.v; go('register', { step: 2 }); },
  pick: (b) => { A.ui[b.dataset.k] = b.dataset.v; render(true); },
  signout: () => run(async () => { try { await api('auth/logout', {}); } catch { /* already signed out */ } signOut(); }),
  'wiz-back': () => { A.ui['w.step'] -= 1; render(true); },
  'wiz-next': () => run(async () => {
    const step = A.ui['w.step'];
    if (step === 1) {
      if (A.ui['w.pickupId'] === A.ui['w.dropoffId']) throw new Error('Pickup and drop-off must be different areas.');
      if (!U('w.pickupAddress') || !U('w.dropoffAddress')) throw new Error('Enter the street address for pickup and drop-off.');
    }
    if (step === 2) {
      if (!U('w.recipientName')) throw new Error('Enter the recipient name.');
      if (!/^\+?\d{7,15}$/.test(U('w.recipientPhone').replace(/[\s-]/g, ''))) throw new Error('Enter a valid recipient phone number.');
      const q = Number(A.ui['w.quantity']);
      if (!Number.isInteger(q) || q < 1 || q > 99) throw new Error('Quantity must be between 1 and 99.');
      A.ui['w.est'] = await api('estimate', { pickupId: A.ui['w.pickupId'], dropoffId: A.ui['w.dropoffId'], vehicle: A.ui['w.vehicle'] });
      if (!A.ui['w.price']) A.ui['w.price'] = A.ui['w.est'].suggested;
    }
    A.ui['w.step'] = step + 1;
    render(true);
  }),
  'price-adj': (b) => { A.ui['w.price'] = Math.max(A.cfg.settings.minPrice, digits(A.ui['w.price']) + Number(b.dataset.d)); render(true); },
  'wiz-post': () => run(async () => {
    const u = A.ui;
    const d = await api('deliveries', {
      pickupId: u['w.pickupId'], dropoffId: u['w.dropoffId'], pickupAddress: U('w.pickupAddress'), dropoffAddress: U('w.dropoffAddress'),
      vehicle: u['w.vehicle'], item: u['w.item'], quantity: Number(u['w.quantity']), payer: u['w.payer'], payMethod: u['w.payMethod'],
      recipientName: U('w.recipientName'), recipientPhone: U('w.recipientPhone'), note: U('w.note'), askPrice: digits(u['w.price']),
    });
    toast('Request posted. Riders can see it now.');
    await refreshFeed();
    go('delivery', { id: d.id });
  }),
  'counter-toggle': (b) => {
    const k = 'c.open.' + b.dataset.key;
    A.ui[k] = !A.ui[k];
    if (A.ui[k]) A.ui['c.' + b.dataset.key] = b.dataset.price;
    render(true);
  },
  'counter-send': (b) => run(async () => {
    const price = digits(A.ui['c.' + b.dataset.key]);
    const r = await api(`deliveries/${b.dataset.id}/offer`, { price, courierId: b.dataset.courier });
    A.ui['c.open.' + b.dataset.key] = false;
    toast(r.status === 'sealed' ? 'Deal sealed.' : 'Offer sent.');
    await refreshFeed(true);
  }),
  accept: (b) => run(async () => { await api(`deliveries/${b.dataset.id}/accept`, { courierId: b.dataset.courier }); toast('Deal sealed.'); await refreshFeed(true); }),
  leave: (b) => run(async () => { await api(`deliveries/${b.dataset.id}/leave`, { courierId: b.dataset.courier }); await refreshFeed(true); }),
  cancel: (b) => { if (confirm('Cancel this delivery?')) run(async () => { await api(`deliveries/${b.dataset.id}/cancel`, {}); await refreshFeed(true); }); },
  rate: (b) => run(async () => { await api(`deliveries/${b.dataset.id}/rate`, { rating: Number(b.dataset.n) }); toast('Thanks for rating.'); await refreshFeed(true); }),
  skip: (b) => { A.skipped.add(Number(b.dataset.id)); store.set('skipped', JSON.stringify([...A.skipped].slice(-200))); render(true); },
  online: (b) => run(async () => { A.user = await api('me/courier', { online: b.dataset.v === '1' }); await refreshFeed(true); }),
  advance: (b) => run(async () => { const r = await api(`deliveries/${b.dataset.id}/advance`, {}); toast(r.status === 'delivered' ? 'Delivered. Well done.' : 'Marked as picked up.'); await refreshFeed(true); }),
  settle: (b) => run(async () => { await api(`admin/couriers/${b.dataset.id}/settle`, {}); toast('Marked as paid.'); await refreshFeed(true); }),
};
const forms = {
  login: () => run(async () => afterAuth(await api('auth/login', { phone: U('li.phone'), pin: A.ui['li.pin'] }))),
  register: () => run(async () => afterAuth(await api('auth/register', {
    role: A.ui['reg.role'], name: U('reg.name'), phone: U('reg.phone'), pin: A.ui['reg.pin'], vehicle: A.ui['reg.vehicle'] || 'bike', plate: U('reg.plate'),
  }))),
  settings: () => run(async () => {
    A.cfg.settings = { ...A.cfg.settings, ...(await api('admin/settings', { commissionPerDay: digits(A.ui['s.commission'] ?? A.feed.settings.commissionPerDay), minPrice: digits(A.ui['s.min'] ?? A.feed.settings.minPrice) })) };
    toast('Settings saved.');
    await refreshFeed(true);
  }),
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-do]');
  if (!b || b.disabled) return;
  e.preventDefault();
  const fn = actions[b.dataset.do];
  if (fn) fn(b);
});
document.addEventListener('input', (e) => { const k = e.target.dataset && e.target.dataset.k; if (k) A.ui[k] = e.target.value; });
document.addEventListener('change', (e) => {
  const k = e.target.dataset && e.target.dataset.k;
  if (!k) return;
  A.ui[k] = e.target.value;
  if (k === 'w.pickupId' || k === 'w.dropoffId') render(true); // redraw the map
});
document.addEventListener('submit', (e) => {
  const f = e.target.dataset && e.target.dataset.form;
  if (!f) return;
  e.preventDefault();
  forms[f]();
});
document.addEventListener('click', (e) => {
  const svg = e.target.closest('#map');
  if (!svg || !A.user || A.user.role !== 'courier' || A.route.name !== 'home') return;
  const job = A.feed && A.feed.mine.find((d) => ['sealed', 'picked_up'].includes(d.status));
  if (!job) return;
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  const c = (v) => Math.min(100, Math.max(0, v));
  run(async () => { A.user = await api('me/courier', { x: c(p.x), y: c(p.y) }); await refreshFeed(true); });
});

// ---------- Start ----------
(async function init() {
  try {
    A.cfg = await api('config');
    if (A.token) {
      try { A.user = await api('me'); A.route = { name: 'home' }; await refreshFeed(true); } catch { signOut(); }
    }
    render(true);
    setInterval(() => { if (A.user && !document.hidden) refreshFeed().catch(() => {}); }, 3000);
  } catch (e) {
    $('#screen').innerHTML = `<p class="empty">Cannot reach the server. ${esc(e.message)}</p>`;
  }
})();
