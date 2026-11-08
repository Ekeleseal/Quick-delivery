'use strict';
// Bargo front end: one small app, three roles (sender, courier, admin).
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
const store = {
  get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// ---------- Icons ----------
const ICON = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  home: '<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  wallet: '<path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7l12-3v3"/><circle cx="16.5" cy="13.5" r="1"/>',
  list: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
  bike: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-8h4l4 8M10 8L9 6H7M13 12h4"/>',
  car: '<path d="M5 16l1.5-5.5A2 2 0 0 1 8.4 9h7.2a2 2 0 0 1 1.9 1.5L19 16"/><rect x="3" y="16" width="18" height="4" rx="1.5"/><circle cx="7.5" cy="18" r=".6"/><circle cx="16.5" cy="18" r=".6"/>',
  van: '<path d="M2 17V7a1 1 0 0 1 1-1h10v11M13 9h4l4 4v4h-8"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  pin: '<path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v9"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

// ---------- API ----------
async function call(path, body, headers = {}) {
  const res = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || 'Something went wrong. Try again.'), { status: res.status });
  return json;
}
let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3800);
}

// ---------- State ----------
let meta = null;
let data = null;
let dsig = '';
const me = {
  role: store.get('role'), senderId: store.get('senderId'), name: store.get('name'),
  phone: store.get('phone'), driverId: store.get('driverId'),
};
let nav = { stack: [], cur: { name: 'home' } };
const ui = { step: 1, draft: null, est: null, counter: {}, open: {}, seen: new Set(), reg: {}, prof: {}, pin: '', pinBad: false, drivers: null, showReg: false, error: '' };
let installEvent = null;

const OPEN = ['open', 'agreed', 'picked_up'];
const STATUS = { open: 'Open', agreed: 'Deal sealed', picked_up: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled' };
const STEP_LABEL = { agreed: 'Deal sealed', picked_up: 'Picked up', delivered: 'Delivered' };

function persistMe() { for (const k of ['role', 'senderId', 'name', 'phone', 'driverId']) store.set(k, me[k] || ''); }
const go = (name, params = {}) => { nav.stack.push(nav.cur); nav.cur = { name, ...params }; render(true); };
const back = () => { nav.cur = nav.stack.pop() || { name: 'home' }; render(true); };
const tab = (name) => { nav = { stack: [], cur: { name } }; render(true); };

// ---------- Helpers ----------
const fmtDate = (ts) => new Date(ts).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const dayLabel = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' });
const vlabel = (v) => meta?.vehicles?.[v]?.label || v;
const turnCount = (j) => (j.status === 'open' ? (j.negotiations || []).filter((n) => n.status === 'active' && n.turn === 'sender').length : 0);
const senderJob = (id) => (data?.jobs || []).find((j) => String(j.id) === String(id));
const driverJob = (id) => {
  if (!data) return null;
  for (const k of ['current', 'offers', 'available', 'history']) { const j = (data[k] || []).find((x) => String(x.id) === String(id)); if (j) return j; }
  return null;
};
const route = (j) => `${esc(j.pickup.area)} ${ic('arrow')} ${esc(j.drop.area)}`;
const chip = (j) => `<span class="chip ${j.status}">${STATUS[j.status]}</span>`;
const empty = (icon, msg) => `<div class="empty">${ic(icon)}<p>${msg}</p></div>`;
const genId = () => 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const getPath = (p) => { const i = p.indexOf('.'); return ui[p.slice(0, i)]?.[p.slice(i + 1)]; };
function setPath(p, v) { const i = p.indexOf('.'); const root = p.slice(0, i); ui[root] ||= {}; ui[root][p.slice(i + 1)] = v; }

function defaultDraft(type) {
  return {
    type, pickupAreaId: 'ikeja', pickupAddress: '', dropAreaId: 'vi', dropAddress: '', vehicle: 'bike', scheduledAt: '',
    itemType: '', quantity: 1, note: '', recipientName: '', recipientPhone: '', payer: 'sender', payment: 'cash', price: 0, priceTouched: false,
  };
}

const stepper = (path, val, cls = '') => `
  <div class="stepper ${cls}">
    <button type="button" data-act="step" data-path="${path}" data-d="-100" aria-label="Lower the price by 100 naira">&minus;</button>
    <span class="amt"><i aria-hidden="true">₦</i><input class="input" inputmode="numeric" data-num="1" data-bind="${path}" value="${esc(val)}" aria-label="Price in naira"></span>
    <button type="button" data-act="step" data-path="${path}" data-d="100" aria-label="Raise the price by 100 naira">+</button>
  </div>`;

function thread(history, youAre) {
  return `<div class="thread">${history.map((h) => {
    const mine = h.by === youAre;
    return `<div class="bub ${h.by}"><small>${mine ? 'You' : h.by === 'sender' ? 'Sender' : 'Courier'}</small><b>${money(h.price)}</b></div>`;
  }).join('')}</div>`;
}

function miniMap(j) {
  const P = meta.places;
  const a = P.find((p) => p.id === j.pickup.areaId), b = P.find((p) => p.id === j.drop.areaId);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  let w = Math.max(46, Math.abs(a.x - b.x) + 30);
  if (Math.abs(a.y - b.y) + 18 > w * 0.6) w = (Math.abs(a.y - b.y) + 18) / 0.6;
  const h = w * 0.6, fs = w * 0.05;
  let s = `<svg class="map" viewBox="${cx - w / 2} ${cy - h / 2} ${w} ${h}" role="img" aria-label="Route from ${esc(j.pickup.area)} to ${esc(j.drop.area)}">`;
  P.forEach((p) => {
    const key = p.id === a.id || p.id === b.id;
    // Label on the side facing the middle of the map so it never runs off the edge or under a marker.
    const right = p.x <= cx, off = key ? fs * 1.3 : fs * 0.6;
    s += `<circle cx="${p.x}" cy="${p.y}" r="${fs * 0.28}" fill="#9db3a5"/>`;
    if (key) s += `<text x="${right ? p.x + off : p.x - off}" y="${p.y + fs * 0.3}" text-anchor="${right ? 'start' : 'end'}" font-size="${fs * 1.1}" fill="#15262a" font-weight="600">${esc(p.name)}</text>`;
  });
  s += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#0a6a6e" stroke-width="${fs * 0.3}" stroke-dasharray="${fs * 0.7} ${fs * 0.5}" stroke-linecap="round"/>`;
  s += `<circle cx="${a.x}" cy="${a.y}" r="${fs * 0.75}" fill="#fff" stroke="#0a6a6e" stroke-width="${fs * 0.3}"/>`;
  s += `<circle cx="${b.x}" cy="${b.y}" r="${fs * 0.85}" fill="#f4b400" stroke="#fff" stroke-width="${fs * 0.2}"/></svg>`;
  return s;
}

// ---------- Views: welcome and setup ----------
function vWelcome() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let install = '';
  if (installEvent) install = '<button class="link" data-act="install" style="color:#fff">Install the app</button>';
  else if (ios && !standalone) install = 'On iPhone: tap Share, then Add to Home Screen.';
  return `<div class="welcome">
    <div class="logo"><img src="/icons/icon.svg" alt="">Bargo</div>
    <div>
      <div class="route-art" aria-hidden="true">
        <svg viewBox="0 0 320 150"><path d="M40 120 C 40 60, 270 110, 270 40" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 14"/>
        <circle cx="40" cy="122" r="13" fill="#fff"/><circle cx="40" cy="122" r="5" fill="#005357"/><circle cx="270" cy="38" r="15" fill="#f4b400"/>
        <g class="tag"><rect x="108" y="38" width="104" height="38" rx="19" fill="#fff"/><text x="160" y="63" text-anchor="middle" font-size="18" font-weight="700" fill="#005357" font-family="Poppins, sans-serif">₦3,500</text></g></svg>
      </div>
      <h1>Book a courier. Agree the price.</h1>
      <p>Name your price. Couriers accept or counter. When you both agree, the deal is sealed.</p>
      <div class="btns">
        <button class="btn" data-act="role" data-role="sender">Send a package</button>
        <button class="btn ghost" data-act="role" data-role="driver">Deliver as a courier</button>
      </div>
    </div>
    <p class="foot">${install ? install + '<br>' : ''}<button class="link" data-act="role" data-role="admin" style="color:#cfe6e6;font-weight:500">Admin</button></p>
  </div>`;
}

function vSenderSetup() {
  const p = ui.prof;
  return `<div class="top"><button class="icon-btn" data-act="leave" aria-label="Back">${ic('back')}</button></div>
    <h2 class="title">Your details</h2><p class="sub" style="margin:.3rem 0 1.2rem">Couriers see your first name. Your phone number is shared only after a deal is sealed.</p>
    <form data-form="setup">
      <label class="field"><span>Your name</span><input class="input" required maxlength="60" autocomplete="name" data-bind="prof.name" value="${esc(p.name ?? me.name)}"></label>
      <label class="field"><span>Phone number</span><input class="input" required maxlength="20" inputmode="tel" autocomplete="tel" data-bind="prof.phone" value="${esc(p.phone ?? me.phone)}"></label>
      <button class="btn" type="submit">Continue</button>
    </form>`;
}

function vDriverPick() {
  const list = ui.drivers;
  let h = `<div class="top"><button class="icon-btn" data-act="leave" aria-label="Back">${ic('back')}</button></div>
    <h2 class="title">Who is driving?</h2><p class="sub" style="margin:.3rem 0 1.2rem">Choose your courier profile, or register a new one.</p>`;
  if (!list) h += '<p class="empty">Loading couriers...</p>';
  else h += list.map((d) => `<button class="pick" data-act="pick-driver" data-id="${esc(d.id)}"><span class="avatar">${esc(d.name[0])}</span><span class="grow"><b>${esc(d.name)}</b><br><small class="muted">${esc(vlabel(d.vehicle))}, ${esc(d.plate)}</small></span>${ic(d.vehicle)}</button>`).join('');
  h += `<button class="link" data-act="toggle-reg">${ui.showReg ? 'Hide registration' : 'Register as a new courier'}</button>`;
  if (ui.showReg) {
    const r = ui.reg;
    h += `<form data-form="register" style="margin-top:.8rem">
      <label class="field"><span>Full name</span><input class="input" required maxlength="60" data-bind="reg.name" value="${esc(r.name ?? '')}"></label>
      <label class="field"><span>Phone number</span><input class="input" required maxlength="20" inputmode="tel" data-bind="reg.phone" value="${esc(r.phone ?? '')}"></label>
      <div class="vehicles">${['bike', 'car', 'van'].map((v) => `<button type="button" class="vehicle" data-act="reg-veh" data-v="${v}" aria-pressed="${(r.vehicle || 'bike') === v}">${ic(v)}${vlabel(v)}</button>`).join('')}</div>
      <label class="field"><span>Plate number</span><input class="input" required maxlength="15" data-bind="reg.plate" value="${esc(r.plate ?? '')}"></label>
      <button class="btn" type="submit">Register</button></form>`;
  }
  return h;
}

// ---------- Views: sender ----------
function vSHome() {
  const jobs = data?.jobs || [];
  const live = jobs.filter((j) => OPEN.includes(j.status));
  const needs = jobs.reduce((s, j) => s + turnCount(j), 0);
  let h = `<div class="greet"><div><small>Welcome back</small><strong>${esc(me.name)}</strong></div><span class="avatar">${esc(me.name[0] || '?')}</span></div>`;
  if (live.length) {
    const j = live[0];
    h += `<article class="banner" role="link" tabindex="0" data-act="open-job" data-id="${j.id}" style="cursor:pointer">
      ${needs ? `<span class="badge">${needs} ${needs === 1 ? 'offer needs' : 'offers need'} you</span>` : ''}
      <small class="muted">You have ${live.length} ${live.length === 1 ? 'delivery' : 'deliveries'} in progress</small>
      <b>#${j.id} ${esc(j.itemType)}</b>
      <small>Recipient: ${esc(j.recipientName)}</small><br>
      <small><b style="display:inline;color:var(--amber)">${j.status === 'open' ? (j.negotiations.length ? `${j.negotiations.length} courier ${j.negotiations.length === 1 ? 'offer' : 'offers'}` : 'Waiting for offers') : STATUS[j.status]}</b></small>
    </article>`;
  }
  h += `<p class="h3" style="margin-top:0">What would you like to do?</p>
    <button class="choice" data-act="start-new" data-type="instant">${ic('bolt', 'lg')}<b>Instant Delivery</b><span>A courier picks up your package as soon as you agree a price</span>${ic('bolt', 'bg')}</button>
    <button class="choice alt" data-act="start-new" data-type="scheduled">${ic('clock', 'lg')}<b>Schedule Delivery</b><span>A courier comes at the date and time you choose</span>${ic('clock', 'bg')}</button>
    <p class="tip">You set the first price. Couriers can accept it or counter. You only pay once you accept a price.</p>`;
  return h;
}

function vSNew() {
  const d = ui.draft || (ui.draft = defaultDraft('instant'));
  const places = meta.places;
  const opts = (sel) => places.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const bar = `<div class="steps">${[1, 2, 3].map((n) => `<i class="${n <= ui.step ? 'on' : ''}"></i>`).join('')}</div>`;
  const top = `<div class="top"><button class="icon-btn" data-act="new-back" aria-label="Back">${ic('back')}</button></div>`;
  const err = ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : '';
  if (ui.step === 1) {
    return `${top}<h2 class="title">${d.type === 'scheduled' ? 'Schedule Delivery' : 'Instant Delivery'}</h2>${bar}
      <label class="field"><span>Pickup area</span><select class="input" data-bind="draft.pickupAreaId">${opts(d.pickupAreaId)}</select></label>
      <label class="field"><span>Pickup address</span><input class="input" maxlength="120" placeholder="32 Samwell Sq, Chevron" data-bind="draft.pickupAddress" value="${esc(d.pickupAddress)}"></label>
      <label class="field"><span>Delivery area</span><select class="input" data-bind="draft.dropAreaId">${opts(d.dropAreaId)}</select></label>
      <label class="field"><span>Delivery address</span><input class="input" maxlength="120" placeholder="21b Karimu Kotun Street" data-bind="draft.dropAddress" value="${esc(d.dropAddress)}"></label>
      <p class="sub" style="margin-bottom:.4rem">Vehicle type</p>
      <div class="vehicles">${['bike', 'car', 'van'].map((v) => `<button type="button" class="vehicle" data-act="veh" data-v="${v}" aria-pressed="${d.vehicle === v}">${ic(v)}${vlabel(v)}</button>`).join('')}</div>
      ${d.type === 'scheduled' ? `<label class="field"><span>Pickup date and time</span><input class="input" type="datetime-local" data-bind="draft.scheduledAt" value="${esc(d.scheduledAt)}"></label>` : ''}
      ${err}<button class="btn" data-act="new-next" style="margin-top:.6rem">Next</button>`;
  }
  if (ui.step === 2) {
    return `${top}<h2 class="title">Details</h2>${bar}
      <label class="field"><span>What are you sending?</span><select class="input" data-bind="draft.itemType"><option value="">Select</option>${meta.items.map((i) => `<option ${d.itemType === i ? 'selected' : ''}>${esc(i)}</option>`).join('')}</select></label>
      <div class="two"><label class="field"><span>Quantity</span><input class="input" type="number" min="1" max="999" data-num="1" data-bind="draft.quantity" value="${esc(d.quantity)}"></label>
      <label class="field"><span>Note (optional)</span><input class="input" maxlength="200" placeholder="Fragile" data-bind="draft.note" value="${esc(d.note)}"></label></div>
      <p class="sub" style="margin:-.3rem 0 .9rem">Weapons, drugs and anything illegal are not allowed.</p>
      <label class="field"><span>Recipient name</span><input class="input" maxlength="60" data-bind="draft.recipientName" value="${esc(d.recipientName)}"></label>
      <label class="field"><span>Recipient phone number</span><input class="input" inputmode="tel" maxlength="20" data-bind="draft.recipientPhone" value="${esc(d.recipientPhone)}"></label>
      <p class="sub" style="margin-bottom:.3rem">Who pays the courier?</p>
      <div class="radios"><label><input type="radio" name="payer" value="sender" data-bind="draft.payer" ${d.payer === 'sender' ? 'checked' : ''}>Me</label><label><input type="radio" name="payer" value="recipient" data-bind="draft.payer" ${d.payer === 'recipient' ? 'checked' : ''}>Recipient</label></div>
      <label class="field"><span>Payment type</span><select class="input" data-bind="draft.payment"><option value="cash" ${d.payment === 'cash' ? 'selected' : ''}>Cash to courier</option><option value="transfer" ${d.payment === 'transfer' ? 'selected' : ''}>Bank transfer to courier</option></select></label>
      ${err}<button class="btn" data-act="new-next">Next</button>`;
  }
  const e = ui.est || { km: 0, minutes: 0, fare: 0 };
  return `${top}<h2 class="title">Your price</h2>${bar}
    <div class="panel"><div class="row between"><b>${esc(places.find((p) => p.id === d.pickupAreaId).name)} ${ic('arrow')} ${esc(places.find((p) => p.id === d.dropAreaId).name)}</b>${ic(d.vehicle)}</div>
    <p class="sub">${esc(d.itemType)}, ${esc(vlabel(d.vehicle))}, about ${e.km} km</p></div>
    <p class="sub" style="margin-bottom:.4rem">Your offer to couriers</p>${stepper('draft.price', d.price)}
    <p class="sub" style="margin:.5rem 0 1rem">Suggested for this trip: <b>${money(e.fare)}</b>. Couriers can accept your price or send a counter-offer. The deal is sealed when you both agree.</p>
    ${err}<button class="btn" data-act="post-job">Post request</button>`;
}

function jobCardS(j) {
  const t = turnCount(j);
  const price = j.agreedPrice || j.openingPrice;
  return `<article class="jcard ${t ? 'hot' : ''}" role="link" tabindex="0" data-act="open-job" data-id="${j.id}">
    <div class="head"><div><h4>${esc(j.itemType)} <span class="muted small">x${j.quantity}</span></h4><div class="route-line">${route(j)}</div></div>${chip(j)}</div>
    <div class="row between" style="margin-top:.5rem"><span class="price">${money(price)}${j.agreedPrice ? '' : ' <small class="muted">your offer</small>'}</span>
    ${t ? `<span class="badge">${t} ${t === 1 ? 'offer needs' : 'offers need'} you</span>` : j.status === 'open' ? `<small class="muted">${j.negotiations.filter((n) => n.status === 'active').length} offers</small>` : ''}</div></article>`;
}

function vSJobs() {
  const jobs = data?.jobs || [];
  const live = jobs.filter((j) => OPEN.includes(j.status)), past = jobs.filter((j) => !OPEN.includes(j.status));
  let h = '<h2 class="title" style="margin-bottom:1rem">Deliveries</h2>';
  if (!jobs.length) return h + empty('box', 'No deliveries yet. Book one from Home.') + '<button class="btn" data-act="tab" data-tab="home">Book a delivery</button>';
  if (live.length) h += '<p class="h3" style="margin-top:0">In progress</p>' + live.map(jobCardS).join('');
  if (past.length) h += '<p class="h3">Past</p>' + past.map(jobCardS).join('');
  return h;
}

function offerCardS(j, n) {
  const last = n.history[n.history.length - 1];
  const key = `${j.id}:${n.driverId}`;
  const turn = n.status === 'active' && n.turn === 'sender';
  const d = n.driver;
  let h = `<section class="offer ${turn ? 'turn' : ''} ${n.status !== 'active' ? 'dead' : ''}">
    <div class="row"><span class="avatar">${esc(d.name[0])}</span><div class="grow"><b>${esc(d.name)}</b><br><small class="muted">${esc(vlabel(d.vehicle))}, ${esc(d.plate)}, ${d.rating.toFixed(1)} stars (${d.ratingCount})</small></div>${ic(d.vehicle)}</div>
    ${thread(n.history, 'sender')}`;
  if (n.status === 'active' && turn) {
    const open = ui.open[key];
    h += `<div class="btns"><button class="btn" data-act="s-accept" data-id="${j.id}" data-driver="${esc(n.driverId)}">Accept ${money(last.price)}</button></div>
      <div class="btns"><button class="btn line sm" data-act="toggle-counter" data-key="${esc(key)}" data-price="${last.price}">${open ? 'Hide counter' : 'Counter'}</button><button class="btn danger sm" data-act="s-decline" data-id="${j.id}" data-driver="${esc(n.driverId)}">Decline</button></div>`;
    if (open) {
      const val = ui.counter[key] ?? last.price;
      h += `<div class="counter-box"><p class="sub" style="margin-bottom:.4rem">Your counter-offer</p>${stepper('counter.' + key, val, 'sm')}
        <button class="btn sm" style="margin-top:.6rem" data-act="s-counter" data-id="${j.id}" data-driver="${esc(n.driverId)}" data-key="${esc(key)}">Send counter</button></div>`;
    }
  } else if (n.status === 'active') h += `<p class="wait">Waiting for ${esc(d.name.split(' ')[0])} to respond to ${money(last.price)}.</p>`;
  else h += `<p class="wait">${{ declined: 'You declined this offer.', withdrawn: 'The courier withdrew.', closed: 'Closed after another deal was sealed.', sealed: 'Deal sealed.' }[n.status] || ''}</p>`;
  return h + '</section>';
}

function sealedBanner(j, who) {
  const anim = !ui.seen.has(j.id) ? 'anim' : '';
  ui.seen.add(j.id);
  return `<div class="sealed ${anim}"><svg class="ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="24"/><path d="M14 25l7 7 13-15"/></svg>
    <div><b>Deal sealed at ${money(j.agreedPrice)}</b><span class="small">${who}</span></div></div>`;
}

function progress(j) {
  const order = ['agreed', 'picked_up', 'delivered'];
  const at = order.indexOf(j.status);
  return `<div class="progress">${order.map((s, i) => `<div class="${i <= at ? 'done' : ''}"><i></i>${STEP_LABEL[s]}</div>`).join('')}</div>`;
}

function vSJob() {
  const j = senderJob(nav.cur.id);
  const top = `<div class="top"><button class="icon-btn" data-act="back" aria-label="Back">${ic('back')}</button><h2 class="title grow">Delivery #${nav.cur.id}</h2></div>`;
  if (!j) return top + empty('box', 'This delivery could not be found.');
  let h = top + miniMap(j) + `<div class="row between"><b>${esc(j.itemType)} <span class="muted small">x${j.quantity}</span></b>${chip(j)}</div>
    <div class="kv"><div><small>Pickup</small><span>${esc(j.pickup.address)}, ${esc(j.pickup.area)}</span></div><div><small>Delivery</small><span>${esc(j.drop.address)}, ${esc(j.drop.area)}</span></div>
    <div><small>Recipient</small><span>${esc(j.recipientName)}</span></div><div><small>Vehicle</small><span>${esc(vlabel(j.vehicle))}, ${j.km} km</span></div>
    ${j.scheduledAt ? `<div class="full"><small>Pickup time</small><span>${fmtDate(j.scheduledAt)}</span></div>` : ''}</div>`;
  if (j.status === 'open') {
    h += `<div class="panel"><div class="row between"><span class="sub">Your offer</span><b class="price">${money(j.openingPrice)}</b></div></div>`;
    const live = j.negotiations.filter((n) => n.status === 'active'), rest = j.negotiations.filter((n) => n.status !== 'active');
    h += `<p class="h3">Offers from couriers</p>`;
    h += live.length ? live.map((n) => offerCardS(j, n)).join('') : empty('bike', `No offers yet. Online couriers with a ${vlabel(j.vehicle).toLowerCase()} can see your request now.`);
    h += rest.map((n) => offerCardS(j, n)).join('');
  } else if (j.driver && j.status !== 'cancelled') {
    const d = j.driver;
    h += sealedBanner(j, j.status === 'delivered' ? 'Delivered. Thank you for using Bargo.' : `You pay ${j.payment === 'cash' ? 'cash' : 'by bank transfer'} to the courier.`);
    h += progress(j);
    h += `<div class="panel"><div class="row"><span class="avatar">${esc(d.name[0])}</span><div class="grow"><b>${esc(d.name)}</b><br><small class="muted">${esc(vlabel(d.vehicle))}, ${esc(d.plate)}, ${d.rating.toFixed(1)} stars</small></div>
      <a class="btn sm" style="width:auto;text-decoration:none" href="tel:${esc(d.phone)}">${ic('phone')}</a></div></div>`;
    const sealed = j.negotiations.find((n) => n.status === 'sealed');
    if (sealed) h += `<p class="h3">How you agreed</p>${thread(sealed.history, 'sender')}`;
    if (j.status === 'delivered') {
      h += j.rating ? `<p class="sub">You rated this delivery ${j.rating} out of 5.</p>`
        : `<p class="h3">Rate ${esc(d.name.split(' ')[0])}</p><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-act="rate" data-id="${j.id}" data-n="${n}" aria-label="${n} stars">${n}★</button>`).join('')}</div>`;
    }
  } else if (j.status === 'cancelled') h += empty('box', 'This delivery was cancelled.');
  if (['open', 'agreed'].includes(j.status)) h += `<button class="btn danger" style="margin-top:1rem" data-act="s-cancel" data-id="${j.id}">Cancel delivery</button>`;
  return h;
}

// ---------- Views: courier ----------
function jobCardD(j, actions) {
  const n = j.negotiation;
  const turn = n && n.status === 'active' && n.turn === 'driver';
  const last = n ? n.history[n.history.length - 1].price : j.openingPrice;
  let h = `<article class="jcard ${turn ? 'hot' : ''}" role="link" tabindex="0" data-act="open-job" data-id="${j.id}">
    <div class="head"><div><h4>${esc(j.itemType)} <span class="muted small">x${j.quantity}</span></h4><div class="route-line">${route(j)}</div></div><span class="price">${money(j.agreedPrice || last)}</span></div>
    <div class="route-line" style="margin-top:.35rem">${ic('pin')}${esc(j.drop.address)} &middot; ${j.km} km${j.scheduledAt ? ' &middot; ' + fmtDate(j.scheduledAt) : ''}</div>`;
  if (n && n.status === 'active') h += `<p class="small" style="margin-top:.4rem;color:var(--amber);font-weight:600">${turn ? `Sender countered ${money(last)}` : `Waiting for sender (you asked ${money(last)})`}</p>`;
  if (actions) {
    h += `<div class="btns"><button class="btn soft" data-act="d-reject" data-id="${j.id}">Reject</button><button class="btn line" data-act="open-job" data-id="${j.id}">Counter</button><button class="btn" data-act="d-accept" data-id="${j.id}">Accept</button></div>`;
  }
  return h + '</article>';
}

function onlineSwitch() {
  const d = data.driver, on = d.status === 'online';
  return `<label class="switch" title="${on ? 'Online' : 'Offline'}"><input type="checkbox" data-act="toggle-online" ${on ? 'checked' : ''} aria-label="Online"><i></i></label>`;
}

function vDHome() {
  const f = data, d = f.driver, on = d.status === 'online';
  let h = `<div class="greet"><div class="row"><span class="avatar">${esc(d.name[0])}</span><div><small>Welcome back</small><strong>${esc(d.name)}</strong></div></div><div class="row"><small class="muted">${on ? 'Online' : 'Offline'}</small>${onlineSwitch()}</div></div>`;
  if (f.current.length) {
    const j = f.current[0];
    h += `<article class="banner" role="link" tabindex="0" data-act="open-job" data-id="${j.id}" style="cursor:pointer"><small class="muted">You have 1 delivery in progress</small><b>#${j.id} ${esc(j.itemType)}</b>
      <small>Recipient: ${esc(j.recipientName || 'hidden')}</small><br><small><b style="display:inline;color:var(--amber)">${money(j.agreedPrice)} &middot; ${STATUS[j.status]}</b></small></article>`;
  }
  if (f.offers.length) h += `<p class="h3" style="margin-top:0">Your offers</p>${f.offers.map((j) => jobCardD(j, false)).join('')}`;
  h += `<div class="row between"><p class="h3" style="margin:.2rem 0 .6rem">Available requests</p></div>`;
  if (!on) h += `<p class="notice">You are offline. Go online to see and take requests.</p>`;
  else if (f.current.length) h += `<p class="notice">Finish your current delivery to take another.</p>` + f.available.map((j) => jobCardD(j, false)).join('');
  else h += f.available.length ? f.available.map((j) => jobCardD(j, true)).join('') : empty('bike', `No requests for a ${vlabel(d.vehicle).toLowerCase()} right now. New ones appear here instantly.`);
  return h;
}

function vDJob() {
  const j = driverJob(nav.cur.id);
  const top = `<div class="top"><button class="icon-btn" data-act="back" aria-label="Back">${ic('back')}</button><h2 class="title grow">Delivery #${nav.cur.id}</h2></div>`;
  if (!j) return top + empty('box', 'This delivery is no longer available.') + '<button class="btn" data-act="back">Back to requests</button>';
  const e = data.earnings;
  let h = top + miniMap(j) + `<div class="row between"><b>${esc(j.itemType)} <span class="muted small">x${j.quantity}</span></b>${chip(j)}</div>
    <div class="kv"><div><small>Pickup</small><span>${esc(j.pickup.address)}, ${esc(j.pickup.area)}</span></div><div><small>Delivery</small><span>${esc(j.drop.address)}, ${esc(j.drop.area)}</span></div>
    <div><small>Distance</small><span>${j.km} km, ${esc(vlabel(j.vehicle))}</span></div><div><small>Payment</small><span>${j.payer === 'sender' ? 'Sender' : 'Recipient'} pays, ${j.payment === 'cash' ? 'cash' : 'transfer'}</span></div>
    ${j.note ? `<div class="full"><small>Note</small><span>${esc(j.note)}</span></div>` : ''}${j.scheduledAt ? `<div class="full"><small>Pickup time</small><span>${fmtDate(j.scheduledAt)}</span></div>` : ''}</div>`;
  if (j.mine && j.status !== 'cancelled') {
    h += sealedBanner(j, j.status === 'delivered' ? 'Delivered.' : `You earn ${money(j.agreedPrice)} on this trip.`) + progress(j);
    h += `<div class="panel"><p class="sub">Contacts</p>
      <div class="row between" style="margin-top:.4rem"><span>Sender: <b>${esc(j.senderName)}</b></span>${j.senderPhone ? `<a class="link" href="tel:${esc(j.senderPhone)}">${esc(j.senderPhone)}</a>` : ''}</div>
      <div class="row between" style="margin-top:.4rem"><span>Recipient: <b>${esc(j.recipientName)}</b></span><a class="link" href="tel:${esc(j.recipientPhone)}">${esc(j.recipientPhone)}</a></div></div>`;
    if (j.status === 'agreed') h += `<button class="btn" data-act="d-pickup" data-id="${j.id}">I have picked up the package</button><button class="link" style="margin-top:.7rem" data-act="d-withdraw" data-id="${j.id}">Pull out of this delivery</button>`;
    if (j.status === 'picked_up') h += `<button class="btn" data-act="d-deliver" data-id="${j.id}">Mark as delivered</button>`;
    if (j.status !== 'delivered') h += `<p class="sub" style="margin-top:.8rem">${e.commissionDueToday ? `Your daily commission of ${money(e.commissionPerDay)} is charged when you complete your first delivery today.` : 'Your commission for today is already paid. This delivery costs you nothing extra.'}</p>`;
    return h;
  }
  const n = j.negotiation;
  if (j.status !== 'open' || (n && n.status !== 'active')) return h + `<p class="notice">${n && n.status === 'declined' ? 'The sender declined your offer.' : 'This delivery is no longer available.'}</p>`;
  const key = `${j.id}:${data.driver.id}`;
  const turn = !n || n.turn === 'driver';
  const last = n ? n.history[n.history.length - 1].price : j.openingPrice;
  if (n) h += `<p class="h3">Negotiation</p>${thread(n.history, 'driver')}`;
  if (!turn) return h + `<p class="wait">Waiting for the sender to respond to your ${money(last)} offer.</p><button class="link" data-act="d-reject" data-id="${j.id}">Walk away from this delivery</button>`;
  const val = ui.counter[key] ?? last;
  h += `<div class="panel"><div class="row between"><span class="sub">${n ? 'Sender countered' : 'Sender offers'}</span><b class="price">${money(last)}</b></div></div>
    <button class="btn" data-act="d-accept" data-id="${j.id}">Accept ${money(last)}</button>
    <p class="h3">Or make a counter-offer</p>${stepper('counter.' + key, val, 'sm')}
    <div class="btns"><button class="btn line" data-act="d-counter" data-id="${j.id}" data-key="${esc(key)}">Send counter</button><button class="btn soft" data-act="d-reject" data-id="${j.id}">${n ? 'Walk away' : 'Reject'}</button></div>
    <p class="sub" style="margin-top:.8rem">Commission: ${money(e.commissionPerDay)} a day, charged once on your first delivery of the day.</p>`;
  return h;
}

function vDEarn() {
  const e = data.earnings;
  let h = `<h2 class="title" style="margin-bottom:1rem">Earnings</h2>
    <div class="stats"><div class="stat dark"><b>${money(e.net)}</b><small>You keep</small></div><div class="stat"><b>${money(e.gross)}</b><small>Deal value</small></div><div class="stat"><b>${money(e.commission)}</b><small>Commission</small></div></div>
    <p class="notice">Commission is a flat ${money(e.commissionPerDay)} per working day, charged on your first delivery of the day. ${e.commissionDueToday ? 'Nothing charged yet today.' : 'Today is already covered.'}</p>`;
  h += e.byDay.length ? e.byDay.map((x) => `<div class="list-row"><span><b>${dayLabel(x.date)}</b><br><small class="muted">${x.jobs} ${x.jobs === 1 ? 'delivery' : 'deliveries'}, ${money(x.gross)} less ${money(x.commission)}</small></span><b>${money(x.net)}</b></div>`).join('') : empty('wallet', 'Your earnings by day show up here after your first delivery.');
  return h;
}

function vDBook() {
  const f = data;
  let h = '<h2 class="title" style="margin-bottom:1rem">Bookings</h2>';
  if (!f.current.length && !f.history.length) return h + empty('list', 'Deals you seal appear here.');
  if (f.current.length) h += '<p class="h3" style="margin-top:0">In progress</p>' + f.current.map((j) => jobCardD(j, false)).join('');
  if (f.history.length) h += '<p class="h3">Past</p>' + f.history.map((j) => jobCardD(j, false)).join('');
  return h;
}

function vProfile() {
  const isD = me.role === 'driver';
  let h = '<h2 class="title" style="margin-bottom:1rem">Profile</h2>';
  if (isD) {
    const d = data.driver;
    h += `<div class="row" style="margin-bottom:1rem"><span class="avatar lg">${esc(d.name[0])}</span><div><b>${esc(d.name)}</b><br><small class="muted">${esc(vlabel(d.vehicle))}, ${esc(d.plate)}</small></div></div>
      <div class="stats"><div class="stat"><b>${d.rating.toFixed(1)}</b><small>Rating</small></div><div class="stat"><b>${d.completed}</b><small>Deliveries</small></div><div class="stat"><b>${esc(d.phone || '')}</b><small>Phone</small></div></div>`;
  } else {
    h += `<div class="row" style="margin-bottom:1rem"><span class="avatar lg">${esc(me.name[0] || '?')}</span><div><b>${esc(me.name)}</b><br><small class="muted">${esc(me.phone)}</small></div></div>`;
  }
  h += `<button class="btn soft" data-act="leave">Switch role</button>`;
  if (installEvent) h += `<button class="btn line" style="margin-top:.6rem" data-act="install">Install the app</button>`;
  return h;
}

// ---------- Views: admin ----------
function vAdmin() {
  const head = `<div class="top"><button class="icon-btn" data-act="leave" aria-label="Back">${ic('back')}</button><h2 class="title grow">Admin</h2></div>`;
  if (meta.adminPinRequired && !data) {
    return `<div class="admin" style="max-width:380px">${head}<form data-form="admin-login"><label class="field"><span>Admin PIN</span><input class="input" type="password" inputmode="numeric" autocomplete="off" data-bind="pinf.pin" value="${esc(ui.pinf?.pin || '')}"></label>
      ${ui.pinBad ? '<p class="err">That PIN is not correct.</p>' : ''}<button class="btn" type="submit">Open admin</button></form></div>`;
  }
  if (!data) return `<div class="admin">${head}<p class="empty">Loading...</p></div>`;
  const t = data.totals;
  return `<div class="admin">${head}
    <div class="stats"><div class="stat dark"><b>${money(t.commission)}</b><small>Commission collected</small></div><div class="stat"><b>${money(t.dealValue)}</b><small>Deal value delivered</small></div>
      <div class="stat"><b>${t.delivered}</b><small>Delivered</small></div><div class="stat"><b>${t.active}</b><small>On the road</small></div><div class="stat"><b>${t.open}</b><small>Open for offers</small></div></div>
    <form class="panel" data-form="admin-save"><p class="sub">Daily commission per courier</p>
      <div class="row" style="margin-top:.4rem"><input class="input" inputmode="numeric" data-num="1" data-bind="adm.commission" value="${esc(ui.adm?.commission ?? data.settings.commissionPerDay)}" style="max-width:180px" aria-label="Daily commission in naira"><button class="btn sm" style="width:auto" type="submit">Save</button></div>
      <p class="sub" style="margin-top:.5rem">Charged once per courier on their first delivery of each day. Changes apply to later days. Past charges stay as they were.</p></form>
    <div class="cols"><div><p class="h3">Couriers</p><div class="tbl-wrap"><table class="tbl"><tr><th>Courier</th><th>Status</th><th>Trips</th><th>Paid us</th></tr>
      ${data.drivers.map((d) => `<tr><td><b>${esc(d.name)}</b><br><small class="muted">${esc(vlabel(d.vehicle))}, ${esc(d.plate)}</small></td><td>${esc(d.status)}</td><td>${d.completed}</td><td>${money(d.earnings.commission)}</td></tr>`).join('')}</table></div></div>
    <div><p class="h3">Recent deliveries</p><div class="tbl-wrap"><table class="tbl"><tr><th>#</th><th>Route</th><th>Price</th><th>Status</th></tr>
      ${data.jobs.slice(0, 15).map((j) => `<tr><td>${j.id}</td><td>${esc(j.pickup.area)} to ${esc(j.drop.area)}</td><td>${money(j.agreedPrice || j.openingPrice)}</td><td>${STATUS[j.status]}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No deliveries yet.</td></tr>'}</table></div></div></div>
    <p class="h3">Commission ledger</p><div class="tbl-wrap"><table class="tbl"><tr><th>Date</th><th>Courier</th><th>Amount</th></tr>
      ${data.ledger.map((l) => `<tr><td>${dayLabel(l.date)}</td><td>${esc(data.drivers.find((d) => d.id === l.driverId)?.name || l.driverId)}</td><td>${money(l.amount)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing collected yet.</td></tr>'}</table></div></div>`;
}

// ---------- Rendering ----------
const TABS = {
  sender: [['home', 'Home', 'home'], ['jobs', 'Deliveries', 'list'], ['profile', 'Profile', 'user']],
  driver: [['home', 'Home', 'home'], ['earnings', 'Earnings', 'wallet'], ['bookings', 'Bookings', 'list'], ['profile', 'Profile', 'user']],
};

function currentView() {
  if (!me.role) return { html: vWelcome(), bare: true, tabs: false };
  if (me.role === 'admin') return { html: vAdmin(), tabs: false, wide: true };
  const n = nav.cur.name;
  if (me.role === 'sender') {
    if (!me.name) return { html: vSenderSetup(), tabs: false };
    if (n === 'new') return { html: vSNew(), tabs: false };
    const f = { home: vSHome, jobs: vSJobs, job: vSJob, profile: vProfile }[n] || vSHome;
    return { html: f(), tabs: true };
  }
  if (!me.driverId) return { html: vDriverPick(), tabs: false };
  if (!data) return { html: '<p class="empty">Loading...</p>', tabs: true };
  const f = { home: vDHome, job: vDJob, earnings: vDEarn, bookings: vDBook, profile: vProfile }[n] || vDHome;
  return { html: f(), tabs: true };
}

function render(reset) {
  if (!meta) return;
  const a = document.activeElement;
  const bind = a && a.dataset && a.dataset.bind;
  const pos = bind && a.selectionStart;
  const scr = $('#screen'), top = scr.scrollTop;
  const v = currentView();
  scr.innerHTML = v.html;
  scr.classList.toggle('bare', !!v.bare);
  $('#phone').classList.toggle('wide', !!v.wide);
  const tabs = $('#tabs');
  tabs.hidden = !v.tabs;
  if (v.tabs) {
    const cur = nav.cur.name === 'job' ? (me.role === 'sender' ? 'jobs' : 'home') : nav.cur.name;
    tabs.innerHTML = TABS[me.role].map(([id, label, icon]) => `<button data-act="tab" data-tab="${id}" ${cur === id ? 'aria-current="page"' : ''}>${ic(icon)}${label}</button>`).join('');
  }
  if (reset) scr.scrollTop = 0; else scr.scrollTop = top;
  if (bind && !reset) {
    const el = scr.querySelector(`[data-bind="${CSS.escape(bind)}"]`);
    if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* not a text input */ } }
  }
}

// ---------- Data loading ----------
async function pull() {
  try {
    let next = null;
    if (me.role === 'sender' && me.senderId) next = await call(`sender/${me.senderId}/jobs`);
    else if (me.role === 'driver' && me.driverId) next = await call(`driver/${me.driverId}`);
    else if (me.role === 'admin' && (!meta.adminPinRequired || ui.pin)) next = await call('admin', undefined, { 'x-admin-pin': ui.pin });
    $('#offline').hidden = true;
    const s = JSON.stringify(next);
    if (s !== dsig) { data = next; dsig = s; render(); }
  } catch (e) {
    if (e.status === 401) { ui.pin = ''; ui.pinBad = true; data = null; dsig = ''; render(); return; }
    if (e.status === 404 && me.role === 'driver') { me.driverId = ''; persistMe(); render(true); return; }
    if (!navigator.onLine || e instanceof TypeError) $('#offline').hidden = false;
  }
}
const refresh = async () => { dsig = ''; await pull(); };
async function run(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await refresh(); } catch (e) { toast(e.message, true); await refresh(); }
}

// ---------- Actions ----------
const sBody = (extra) => ({ senderId: me.senderId, ...extra });
const dBody = (extra) => ({ driverId: me.driverId, ...extra });

const ACT = {
  role: ({ role }) => {
    if (role === 'admin') { me.role = 'admin'; data = null; dsig = ''; ui.pin = ''; ui.pinBad = false; render(true); return; }
    me.role = role; if (role === 'sender' && !me.senderId) me.senderId = genId();
    persistMe(); data = null; dsig = ''; nav = { stack: [], cur: { name: 'home' } };
    if (role === 'driver' && !me.driverId) loadDrivers();
    render(true); pull();
  },
  leave: () => { me.role = ''; if (store.get('role') !== '') store.set('role', ''); data = null; dsig = ''; render(true); },
  tab: ({ tab: t }) => tab(t),
  back: () => back(),
  'open-job': ({ id }) => go('job', { id }),
  'start-new': ({ type }) => { ui.draft = defaultDraft(type); ui.step = 1; ui.error = ''; go('new'); },
  veh: ({ v }) => { ui.draft.vehicle = v; render(); },
  'reg-veh': ({ v }) => { ui.reg.vehicle = v; render(); },
  'toggle-reg': () => { ui.showReg = !ui.showReg; render(); },
  'new-back': () => { ui.error = ''; if (ui.step > 1) { ui.step -= 1; render(true); } else back(); },
  'new-next': async () => {
    const d = ui.draft; ui.error = '';
    if (ui.step === 1) {
      if (!d.pickupAddress.trim() || !d.dropAddress.trim()) ui.error = 'Enter both the pickup and delivery address.';
      else if (d.type === 'scheduled' && !(new Date(d.scheduledAt) > new Date())) ui.error = 'Choose a pickup time in the future.';
    } else if (ui.step === 2) {
      if (!d.itemType) ui.error = 'Choose what you are sending.';
      else if (!d.recipientName.trim()) ui.error = 'Enter the recipient name.';
      else if (!/^[+\d][\d\s-]{6,18}$/.test(d.recipientPhone.trim())) ui.error = 'Enter a valid recipient phone number.';
    }
    if (!ui.error && ui.step === 2) {
      try {
        ui.est = await call('estimate', { pickupAreaId: d.pickupAreaId, dropAreaId: d.dropAreaId, vehicle: d.vehicle });
        if (!d.priceTouched || !d.price) d.price = ui.est.fare;
      } catch (e) { ui.error = e.message; }
    }
    if (!ui.error) ui.step += 1;
    render(true);
  },
  'post-job': () => run(async () => {
    const d = ui.draft;
    const job = await call('jobs', {
      senderId: me.senderId, senderName: me.name, senderPhone: me.phone, deliveryType: d.type,
      scheduledAt: d.type === 'scheduled' && d.scheduledAt ? new Date(d.scheduledAt).toISOString() : undefined,
      pickupAreaId: d.pickupAreaId, pickupAddress: d.pickupAddress, dropAreaId: d.dropAreaId, dropAddress: d.dropAddress,
      vehicle: d.vehicle, itemType: d.itemType, quantity: d.quantity, note: d.note, recipientName: d.recipientName,
      recipientPhone: d.recipientPhone, payer: d.payer, payment: d.payment, openingPrice: d.price,
    });
    ui.draft = null; nav = { stack: [{ name: 'jobs' }], cur: { name: 'job', id: job.id } };
    toast('Request posted. Couriers can now make offers.');
  }),
  step: ({ path, d }, el) => {
    // Start from the number the person actually sees in the field (it may be an unsaved default).
    const shown = Number(String(el.parentElement.querySelector('input').value).replace(/\D/g, ''));
    const cur = shown || Number(getPath(path)) || 0;
    setPath(path, Math.max(100, cur + Number(d)));
    if (path === 'draft.price') ui.draft.priceTouched = true;
    render();
  },
  'toggle-counter': ({ key, price }) => { ui.open[key] = !ui.open[key]; if (ui.counter[key] == null) ui.counter[key] = Number(price); render(); },
  's-accept': ({ id, driver }) => run(() => call(`jobs/${id}/sender/accept`, sBody({ driverId: driver }))),
  's-decline': ({ id, driver }) => run(() => call(`jobs/${id}/sender/decline`, sBody({ driverId: driver }))),
  's-counter': ({ id, driver, key }) => run(async () => { await call(`jobs/${id}/sender/counter`, sBody({ driverId: driver, price: ui.counter[key] })); ui.open[key] = false; delete ui.counter[key]; }, 'Counter-offer sent.'),
  's-cancel': ({ id }) => { if (confirm('Cancel this delivery?')) run(() => call(`jobs/${id}/cancel`, sBody({})), 'Delivery cancelled.'); },
  rate: ({ id, n }) => run(() => call(`jobs/${id}/rate`, sBody({ rating: Number(n) })), 'Thanks for rating.'),
  'toggle-online': (_, el) => run(() => call(`drivers/${me.driverId}/status`, { status: el.checked ? 'online' : 'offline' })),
  'd-accept': ({ id }) => run(() => call(`jobs/${id}/driver/accept`, dBody({})), 'Deal sealed.'),
  'd-reject': ({ id }) => run(async () => { await call(`jobs/${id}/driver/reject`, dBody({})); if (nav.cur.name === 'job') back(); }),
  'd-counter': ({ id, key }) => run(async () => { await call(`jobs/${id}/driver/counter`, dBody({ price: ui.counter[key] })); delete ui.counter[key]; }, 'Counter-offer sent.'),
  'd-pickup': ({ id }) => run(() => call(`jobs/${id}/driver/pickup`, dBody({})), 'Marked as picked up.'),
  'd-deliver': ({ id }) => run(() => call(`jobs/${id}/driver/deliver`, dBody({})), 'Delivery complete.'),
  'd-withdraw': ({ id }) => { if (confirm('Pull out? The delivery goes back to other couriers.')) run(async () => { await call(`jobs/${id}/driver/withdraw`, dBody({})); back(); }); },
  'pick-driver': ({ id }) => { me.driverId = id; persistMe(); nav = { stack: [], cur: { name: 'home' } }; data = null; dsig = ''; render(true); pull(); },
  install: async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice; installEvent = null; render(); },
};

async function loadDrivers() { try { ui.drivers = (await call('drivers')).drivers; render(); } catch { /* retried on next visit */ } }

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const f = ACT[el.dataset.act];
  if (f) f(el.dataset, el, e);
});
document.addEventListener('change', (e) => { if (e.target.dataset?.act === 'toggle-online') ACT['toggle-online'](e.target.dataset, e.target); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[role="link"][data-act]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('input', (e) => {
  const t = e.target, path = t.dataset?.bind;
  if (!path) return;
  if (t.type === 'radio' && !t.checked) return;
  setPath(path, t.dataset.num ? Number(String(t.value).replace(/\D/g, '')) : t.value);
  if (path === 'draft.price') ui.draft.priceTouched = true;
});
document.addEventListener('submit', (e) => {
  const f = e.target.dataset?.form;
  if (!f) return;
  e.preventDefault();
  if (f === 'setup') {
    me.name = (ui.prof.name ?? me.name).trim(); me.phone = (ui.prof.phone ?? me.phone).trim();
    if (!me.name) return toast('Enter your name.', true);
    persistMe(); render(true);
  } else if (f === 'register') {
    const r = ui.reg;
    run(async () => {
      const d = await call('drivers', { name: r.name, phone: r.phone, vehicle: r.vehicle || 'bike', plate: r.plate });
      ui.reg = {}; ui.showReg = false; me.driverId = d.id; persistMe(); nav = { stack: [], cur: { name: 'home' } };
      toast('Registered. Switch on Online to see requests.');
    });
  } else if (f === 'admin-login') {
    ui.pin = ui.pinf?.pin || ''; ui.pinBad = false; refresh();
  } else if (f === 'admin-save') {
    run(async () => { await call('admin/settings', { commissionPerDay: ui.adm?.commission ?? data.settings.commissionPerDay }, { 'x-admin-pin': ui.pin }); ui.adm = {}; }, 'Commission updated.');
  }
});

// ---------- PWA ----------
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; render(); });
window.addEventListener('appinstalled', () => { installEvent = null; toast('Bargo installed.'); render(); });
window.addEventListener('online', () => { $('#offline').hidden = true; pull(); });
window.addEventListener('offline', () => { $('#offline').hidden = false; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

// ---------- Start ----------
(async function init() {
  try {
    meta = await call('meta');
  } catch {
    $('#screen').innerHTML = '<p class="empty">Cannot reach the server. Check your connection and reload.</p>';
    return;
  }
  const want = new URLSearchParams(location.search).get('role');
  if (!me.role && (want === 'sender' || want === 'driver')) ACT.role({ role: want });
  if (me.role === 'admin') me.role = '';
  if (me.role === 'driver' && !me.driverId) loadDrivers();
  render(true);
  pull();
  setInterval(() => { if (!document.hidden) pull(); }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
})();
