'use strict';
// Bargo front end: accounts, deliveries, price negotiation, Port Harcourt maps.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
const ls = {
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
  locate: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  logout: '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9"/>',
};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

// ---------- API ----------
async function call(path, body, headers = {}) {
  let res;
  try {
    res = await fetch('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw Object.assign(new Error('No connection. Check your internet and try again.'), { status: 0 }); }
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
  toastTimer = setTimeout(() => { t.className = ''; }, 4200);
}

// ---------- State ----------
let meta = null;   // public settings from the server
let me = null;     // the signed-in account, or null
let data = null;   // the signed-in account's live data (deliveries, feed or admin overview)
let dsig = '';
let nav = { stack: [], cur: { name: 'home' } };
let installEvent = null;
const ui = { auth: null, admin: null, step: 1, draft: null, est: null, route: null, counter: {}, open: {}, seen: new Set(), pw: {}, sh: null, error: '', tempPw: null, adm: {} };

const OPEN = ['open', 'agreed', 'picked_up'];
const STATUS = { open: 'Open', agreed: 'Deal sealed', picked_up: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled' };
const STEP_LABEL = { agreed: 'Deal sealed', picked_up: 'Picked up', delivered: 'Delivered' };

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
const findJob = (id) => (me?.role === 'sender' ? senderJob(id) : driverJob(id));
const route = (j) => `${esc(j.pickup.label)} ${ic('arrow')} ${esc(j.drop.label)}`;
const chip = (j) => `<span class="chip ${j.status}">${STATUS[j.status]}</span>`;
const empty = (icon, msg) => `<div class="empty">${ic(icon)}<p>${msg}</p></div>`;
const getPath = (p) => { const i = p.indexOf('.'); return ui[p.slice(0, i)]?.[p.slice(i + 1)]; };
function setPath(p, v) { const i = p.indexOf('.'); const root = p.slice(0, i); ui[root] ||= {}; ui[root][p.slice(i + 1)] = v; }
const inService = (lat, lng) => { const b = meta.bounds; return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east; };
const storageWarning = () => (meta?.ephemeral ? '<p class="warn" role="alert">This server is not saving data permanently yet, so accounts and deliveries will disappear. The owner needs to connect a database (see the README).</p>' : '');

function defaultDraft(type) {
  return { type, pickup: null, drop: null, vehicle: 'bike', scheduledAt: '', itemType: '', quantity: 1, note: '', recipientName: '', recipientPhone: '', payer: 'sender', payment: 'cash', price: 0, priceTouched: false };
}

const stepper = (path, val, cls = '') => `
  <div class="stepper ${cls}">
    <button type="button" data-act="step" data-path="${path}" data-d="-100" aria-label="Lower the price by 100 naira">&minus;</button>
    <span class="amt"><i aria-hidden="true">₦</i><input class="input" inputmode="numeric" data-num="1" data-bind="${path}" value="${esc(val)}" aria-label="Price in naira"></span>
    <button type="button" data-act="step" data-path="${path}" data-d="100" aria-label="Raise the price by 100 naira">+</button>
  </div>`;

function thread(history, youAre) {
  return `<div class="thread">${history.map((h) => `<div class="bub ${h.by}"><small>${h.by === youAre ? 'You' : h.by === 'sender' ? 'Sender' : 'Courier'}</small><b>${money(h.price)}</b></div>`).join('')}</div>`;
}

function installHelp() {
  const ua = navigator.userAgent;
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return '';
  if (installEvent) return '<button class="link" data-act="install" style="color:inherit">Install the app</button>';
  if (/FBAN|FBAV|Instagram|TikTok|MicroMessenger|Line\/|; wv\)/i.test(ua)) return 'To install the app, open this page in Chrome or Safari.';
  if (/iphone|ipad|ipod/i.test(ua)) return 'To install on iPhone: open this page in Safari, tap Share, then Add to Home Screen.';
  if (/android/i.test(ua)) return 'To install on Android: open this page in Chrome, tap the menu (three dots), then Install app.';
  return '';
}

// ---------- Maps and places (OpenStreetMap services) ----------
const bounded = () => `${meta.bounds.west},${meta.bounds.north},${meta.bounds.east},${meta.bounds.south}`;
function cleanAddress(dn) { return String(dn || '').replace(/,\s*Nigeria\s*$/i, '').replace(/,\s*\d{5,6}\s*(?=,|$)/g, '').slice(0, 160); }

async function geocode(q, signal) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=ng&bounded=1&viewbox=${bounded()}&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('search failed');
  const rows = await r.json();
  return rows.map((x) => ({ lat: Number(x.lat), lng: Number(x.lon), label: String(x.name || x.address?.road || x.display_name.split(',')[0]).slice(0, 60), address: cleanAddress(x.display_name) }))
    .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng) && inService(x.lat, x.lng));
}
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('reverse failed');
    const j = await r.json();
    const a = j.address || {};
    const area = a.suburb || a.neighbourhood || a.city_district || '';
    const label = (a.road ? (area ? `${a.road}, ${area}` : a.road) : (j.name || area || 'Pinned location')).slice(0, 60);
    return { label, address: cleanAddress(j.display_name) };
  } catch { return { label: 'Pinned location', address: '' }; }
}
const thin = (pts, max) => (pts.length <= max ? pts : Array.from({ length: max }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (max - 1))]));
async function fetchRoute(a, b) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`, { signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const rt = j.routes && j.routes[0];
    if (j.code !== 'Ok' || !rt) return null;
    return { km: rt.distance / 1000, minutes: Math.round(rt.duration / 60), geo: thin(rt.geometry.coordinates.map(([lng, lat]) => [lat, lng]), 300) };
  } catch { return null; } finally { clearTimeout(timer); }
}

let liveMaps = [];
function destroyMaps() { liveMaps.forEach((m) => m.destroy()); liveMaps = []; }
function routeMap(el, pickup, drop, geo) {
  if (!window.TileMap) { el.innerHTML = '<p class="empty">Map unavailable.</p>'; return; }
  const m = new TileMap(el, { interactive: false });
  const line = geo && geo.length > 1 ? geo : [[pickup.lat, pickup.lng], [drop.lat, drop.lng]];
  m.addLine(line, { dashed: !(geo && geo.length > 1) });
  m.addMarker(pickup.lat, pickup.lng, 'pickup', pickup.label);
  m.addMarker(drop.lat, drop.lng, 'drop', drop.label);
  m.fitBounds([...line, pickup, drop]);
  liveMaps.push(m);
}
function mountMaps() {
  $$('#screen .lmap').forEach((el) => {
    if (el.dataset.kind === 'job') { const j = findJob(el.dataset.id); if (j) routeMap(el, j.pickup, j.drop, j.routeGeo); }
    else if (ui.draft && ui.draft.pickup && ui.draft.drop) routeMap(el, ui.draft.pickup, ui.draft.drop, ui.route?.status === 'ok' ? ui.route.geo : null);
  });
}

// Measure the route by road when both places are chosen, then ask the server for a suggested price.
async function updateRoute() {
  const d = ui.draft;
  if (!d || !d.pickup || !d.drop) { ui.route = null; ui.est = null; render(); return; }
  const key = `${d.pickup.lat},${d.pickup.lng}|${d.drop.lat},${d.drop.lng}`;
  if (!ui.route || ui.route.key !== key) {
    ui.route = { key, status: 'loading' }; ui.est = null; render();
    const r = await fetchRoute(d.pickup, d.drop);
    if (!ui.draft || ui.route?.key !== key) return;
    ui.route = r ? { key, status: 'ok', ...r } : { key, status: 'fail' };
  }
  await updateEstimate();
}
async function updateEstimate() {
  const d = ui.draft;
  if (!d || !d.pickup || !d.drop) return;
  try {
    const est = await call('estimate', { pickup: d.pickup, drop: d.drop, vehicle: d.vehicle, routeKm: ui.route?.status === 'ok' ? ui.route.km : undefined });
    if (!ui.draft) return;
    ui.est = est; ui.error = '';
    if (!d.priceTouched) d.price = est.fare;
  } catch (e) { ui.est = null; ui.error = e.message; }
  render();
}

// ---------- Place picker (a full-screen sheet) ----------
let sheetMap = null, searchTimer = 0, searchCtl = null;
const placeText = (kind) => (kind === 'pickup' ? 'Pickup location' : 'Delivery location');
function openSheet(kind) {
  ui.sh = { kind, q: '', results: [], msg: '', mode: 'search', seq: 0, center: null, label: '', address: '' };
  $('#sheet').hidden = false;
  drawSheet();
  setTimeout(() => { const i = $('#sheet input'); if (i) i.focus(); }, 60);
}
function closeSheet() {
  if (sheetMap) { sheetMap.destroy(); sheetMap = null; }
  clearTimeout(searchTimer);
  ui.sh = null;
  const s = $('#sheet'); s.hidden = true; s.innerHTML = '';
}
function drawSheet() {
  const sh = ui.sh, el = $('#sheet');
  if (!sh) return;
  if (sheetMap) { sheetMap.destroy(); sheetMap = null; }
  if (sh.mode === 'map') {
    el.innerHTML = `<div class="sh-head"><button class="icon-btn" data-act="sheet-search" aria-label="Back to search">${ic('back')}</button><h2 class="title">${placeText(sh.kind)}</h2></div>
      <div class="sh-map" id="sh-map"></div>
      <div class="sh-foot"><p id="sh-label" class="sub">Move the map to put the pin on the exact spot.</p><button class="btn" data-act="sheet-confirm">Confirm location</button></div>`;
    const d = ui.draft, here = d[sh.kind] || d[sh.kind === 'pickup' ? 'drop' : 'pickup'] || meta.center;
    sheetMap = new TileMap($('#sh-map'), { center: here, zoom: d[sh.kind] ? 16 : 14, centerPin: true });
    sheetMap.on('moveend', resolveCenter);
    resolveCenter();
  } else {
    el.innerHTML = `<div class="sh-head"><button class="icon-btn" data-act="sheet-close" aria-label="Close">${ic('back')}</button><h2 class="title">${placeText(sh.kind)}</h2></div>
      <div class="sh-body">
        <label class="field"><span class="sr" style="position:absolute;left:-9999px">Search</span><input class="input" type="search" autocomplete="off" placeholder="Search a street, area or landmark" data-bind="sh.q" data-search="1" value="${esc(sh.q)}"></label>
        <button class="pick" data-act="sheet-gps">${ic('locate')}<span class="grow"><b>Use my current location</b></span></button>
        <button class="pick" data-act="sheet-map">${ic('pin')}<span class="grow"><b>Choose on the map</b><br><small class="muted">Drop a pin on the exact spot</small></span></button>
        <div id="sh-results"></div>
      </div>`;
    renderResults();
  }
}
function renderResults() {
  const box = $('#sh-results'), sh = ui.sh;
  if (!box || !sh) return;
  if (sh.results.length) box.innerHTML = sh.results.map((r, i) => `<button class="pick" data-act="sheet-pick" data-i="${i}">${ic('pin')}<span class="grow"><b>${esc(r.label)}</b><br><small class="muted">${esc(r.address)}</small></span></button>`).join('');
  else if (sh.msg) box.innerHTML = `<p class="skel">${esc(sh.msg)}</p>`;
  else box.innerHTML = `<p class="h3" style="margin-top:.4rem">Popular areas</p><div class="chips">${meta.areas.map((a) => `<button data-act="sheet-area" data-name="${esc(a)}">${esc(a)}</button>`).join('')}</div>`;
}
function scheduleSearch() {
  const sh = ui.sh;
  clearTimeout(searchTimer);
  const q = sh.q.trim();
  if (q.length < 3) { sh.results = []; sh.msg = ''; sh.seq++; renderResults(); return; }
  sh.msg = 'Searching...'; renderResults();
  searchTimer = setTimeout(() => runSearch(q), 500);
}
async function runSearch(q, alt) {
  const sh = ui.sh;
  if (!sh) return;
  const seq = ++sh.seq;
  if (searchCtl) searchCtl.abort();
  searchCtl = new AbortController();
  try {
    let res = await geocode(alt || q, searchCtl.signal);
    if (!res.length && !alt) res = await geocode(q + ', Port Harcourt', searchCtl.signal);
    if (ui.sh !== sh || sh.seq !== seq) return;
    sh.results = res;
    sh.msg = res.length ? '' : 'No matches in Port Harcourt. Try a landmark, or choose the spot on the map.';
  } catch (e) {
    if (e.name === 'AbortError' || ui.sh !== sh || sh.seq !== seq) return;
    sh.results = []; sh.msg = 'Search is not available right now. Choose the spot on the map instead.';
  }
  renderResults();
}
async function resolveCenter() {
  const sh = ui.sh;
  if (!sh || !sheetMap) return;
  const c = sheetMap.getCenter(), seq = ++sh.seq;
  sh.center = c; sh.label = ''; sh.address = '';
  const lab = $('#sh-label');
  if (!inService(c.lat, c.lng)) { if (lab) lab.textContent = 'That spot is outside our Port Harcourt service area.'; return; }
  if (lab) lab.textContent = 'Finding the address...';
  const r = await reverseGeocode(c.lat, c.lng);
  if (ui.sh !== sh || sh.seq !== seq) return;
  sh.label = r.label; sh.address = r.address;
  const l2 = $('#sh-label');
  if (l2) l2.textContent = r.address || r.label;
}
function setPoint(kind, pt) {
  ui.draft[kind] = pt;
  closeSheet();
  updateRoute();
}
function useGps() {
  const sh = ui.sh;
  if (!navigator.geolocation) return toast('Location is not available on this device.', true);
  toast('Finding your location...');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lng } = pos.coords;
    if (!inService(lat, lng)) return toast('You are outside our Port Harcourt service area. Search for a place or choose it on the map.', true);
    const r = await reverseGeocode(lat, lng);
    if (ui.sh === sh) setPoint(sh.kind, { lat, lng, label: r.label, address: r.address });
  }, () => toast('Could not get your location. Allow location access, or search instead.', true), { enableHighAccuracy: true, timeout: 12000 });
}

// ---------- Views: welcome and accounts ----------
function vWelcome() {
  const help = installHelp();
  return `<div class="welcome">
    <div class="logo"><img src="/icons/icon.svg" alt="">Bargo</div>
    <div>
      <div class="route-art" aria-hidden="true">
        <svg viewBox="0 0 320 150"><path d="M40 120 C 40 60, 270 110, 270 40" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 14"/>
        <circle cx="40" cy="122" r="13" fill="#fff"/><circle cx="40" cy="122" r="5" fill="#005357"/><circle cx="270" cy="38" r="15" fill="#f4b400"/>
        <g class="tag"><rect x="108" y="38" width="104" height="38" rx="19" fill="#fff"/><text x="160" y="63" text-anchor="middle" font-size="18" font-weight="700" fill="#005357" font-family="Poppins, sans-serif">₦3,500</text></g></svg>
      </div>
      <h1>Book a courier. Agree the price.</h1>
      <p>Deliveries across Port Harcourt. Name your price, couriers accept or counter, and the deal is sealed when you both agree.</p>
      ${storageWarning()}
      <div class="btns">
        <button class="btn" data-act="auth-start" data-role="sender">Send a package</button>
        <button class="btn ghost" data-act="auth-start" data-role="driver">Deliver as a courier</button>
      </div>
    </div>
    <p class="foot">${help ? help + '<br>' : ''}${meta.adminEnabled ? '<button class="link" data-act="admin-start" style="color:#cfe6e6;font-weight:500">Admin</button>' : ''}</p>
  </div>`;
}

function vAuth() {
  const a = ui.auth, isDriver = a.role === 'driver', reg = a.mode === 'register';
  const veh = a.vehicle || 'bike';
  return `<div class="top"><button class="icon-btn" data-act="auth-back" aria-label="Back">${ic('back')}</button></div>
    <h2 class="title">${reg ? 'Create your account' : 'Welcome back'}</h2>
    <p class="sub" style="margin:.3rem 0 1.1rem">${isDriver ? 'Courier account' : 'Sender account'}</p>
    <div class="seg" role="group" aria-label="Log in or create an account">
      <button type="button" data-act="auth-mode" data-mode="login" aria-pressed="${!reg}">Log in</button>
      <button type="button" data-act="auth-mode" data-mode="register" aria-pressed="${reg}">Create account</button>
    </div>
    ${storageWarning()}
    <form data-form="auth" novalidate>
      ${reg ? `<label class="field"><span>Full name</span><input class="input" maxlength="60" autocomplete="name" data-bind="auth.name" value="${esc(a.name ?? '')}"></label>` : ''}
      <label class="field"><span>Phone number</span><input class="input" type="tel" inputmode="tel" maxlength="20" autocomplete="username" placeholder="08012345678" data-bind="auth.phone" value="${esc(a.phone ?? '')}"></label>
      ${reg && isDriver ? `<p class="sub" style="margin-bottom:.4rem">Your vehicle</p>
        <div class="vehicles">${['bike', 'car', 'van'].map((v) => `<button type="button" class="vehicle" data-act="auth-veh" data-v="${v}" aria-pressed="${veh === v}">${ic(v)}${vlabel(v)}</button>`).join('')}</div>
        <label class="field"><span>Plate number</span><input class="input" maxlength="15" autocapitalize="characters" data-bind="auth.plate" value="${esc(a.plate ?? '')}"></label>` : ''}
      <div class="field"><label for="auth-pw" style="color:var(--muted);font-size:.8rem">Password</label>
        <div class="pw"><input id="auth-pw" class="input" type="${a.show ? 'text' : 'password'}" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="${reg ? 'At least 8 characters' : ''}" data-bind="auth.password" value="${esc(a.password ?? '')}"><button type="button" data-act="toggle-pw">${a.show ? 'Hide' : 'Show'}</button></div></div>
      ${a.error ? `<p class="err" role="alert">${esc(a.error)}</p>` : ''}
      <button class="btn" type="submit" style="margin-top:.8rem" ${a.busy ? 'disabled' : ''}>${a.busy ? 'Please wait...' : reg ? 'Create account' : 'Log in'}</button>
    </form>
    <p class="help">${reg ? (isDriver ? 'Senders see your name, vehicle and plate after you make an offer.' : 'Couriers see only your first name until a deal is sealed.') : 'Forgot your password? Ask Bargo support to reset it, then change it in Profile.'}</p>`;
}

function vAdminLogin() {
  const a = ui.admin;
  return `<div class="top"><button class="icon-btn" data-act="admin-back" aria-label="Back">${ic('back')}</button></div>
    <h2 class="title">Admin</h2><p class="sub" style="margin:.3rem 0 1.1rem">Enter the admin PIN.</p>
    <form data-form="admin-login">
      <label class="field"><span>PIN</span><input class="input" type="password" inputmode="numeric" autocomplete="off" data-bind="admin.pin" value="${esc(a.pin ?? '')}"></label>
      ${a.error ? `<p class="err" role="alert">${esc(a.error)}</p>` : ''}
      <button class="btn" type="submit" style="margin-top:.6rem">Open admin</button>
    </form>`;
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

function placeButton(kind, label, pt) {
  return `<button type="button" class="place" data-act="open-sheet" data-kind="${kind}"><span class="dot ${kind === 'pickup' ? 'start' : 'end'}"></span>
    <span class="grow"><small>${label}</small><b class="${pt ? '' : 'ph'}">${pt ? esc(pt.label) : 'Choose ' + (kind === 'pickup' ? 'pickup' : 'delivery') + ' location'}</b>${pt && pt.address ? `<em>${esc(pt.address)}</em>` : ''}</span>${ic('chevron')}</button>`;
}

function vSNew() {
  const d = ui.draft || (ui.draft = defaultDraft('instant'));
  const bar = `<div class="steps">${[1, 2, 3].map((n) => `<i class="${n <= ui.step ? 'on' : ''}"></i>`).join('')}</div>`;
  const top = `<div class="top"><button class="icon-btn" data-act="new-back" aria-label="Back">${ic('back')}</button></div>`;
  const err = ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : '';
  if (ui.step === 1) {
    const r = ui.route;
    let routeInfo = '';
    if (d.pickup && d.drop) {
      const status = !r || r.status === 'loading' ? 'Measuring the route by road...'
        : r.status === 'ok' ? `<b>${ui.est ? ui.est.km : (r.km).toFixed(1)} km</b> by road, about ${ui.est ? ui.est.minutes : r.minutes} min`
          : `About <b>${ui.est ? ui.est.km : '...'} km</b> (estimated: the road route could not be measured)`;
      routeInfo = `<div class="routebox"><div class="lmap" data-kind="draft" role="img" aria-label="Map of your route"></div><p>${status}</p></div>`;
    }
    return `${top}<h2 class="title">${d.type === 'scheduled' ? 'Schedule Delivery' : 'Instant Delivery'}</h2>${bar}
      ${placeButton('pickup', 'Pickup', d.pickup)}${placeButton('drop', 'Delivery', d.drop)}
      ${routeInfo}
      <p class="sub" style="margin-bottom:.4rem">Vehicle type</p>
      <div class="vehicles">${['bike', 'car', 'van'].map((v) => `<button type="button" class="vehicle" data-act="veh" data-v="${v}" aria-pressed="${d.vehicle === v}">${ic(v)}${vlabel(v)}</button>`).join('')}</div>
      ${d.type === 'scheduled' ? `<label class="field"><span>Pickup date and time</span><input class="input" type="datetime-local" data-bind="draft.scheduledAt" value="${esc(d.scheduledAt)}"></label>` : ''}
      ${err}<button class="btn" data-act="new-next" style="margin-top:.4rem">Next</button>`;
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
    <div class="panel"><div class="row between"><b>${esc(d.pickup.label)} ${ic('arrow')} ${esc(d.drop.label)}</b>${ic(d.vehicle)}</div>
    <p class="sub">${esc(d.itemType)}, ${esc(vlabel(d.vehicle))}, ${e.approx ? 'about' : ''} ${e.km} km${e.approx ? ' (estimated)' : ' by road'}</p></div>
    <p class="sub" style="margin-bottom:.4rem">Your offer to couriers</p>${stepper('draft.price', d.price)}
    <p class="sub" style="margin:.5rem 0 1rem">Suggested for this trip: <b>${money(e.fare)}</b>. Couriers can accept your price or send a counter-offer. The deal is sealed when you both agree.</p>
    ${err}<button class="btn" data-act="post-job">Post request</button>`;
}

function jobCardS(j) {
  const t = turnCount(j);
  return `<article class="jcard ${t ? 'hot' : ''}" role="link" tabindex="0" data-act="open-job" data-id="${j.id}">
    <div class="head"><div><h4>${esc(j.itemType)} <span class="muted small">x${j.quantity}</span></h4><div class="route-line">${route(j)}</div></div>${chip(j)}</div>
    <div class="row between" style="margin-top:.5rem"><span class="price">${money(j.agreedPrice || j.openingPrice)}${j.agreedPrice ? '' : ' <small class="muted">your offer</small>'}</span>
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
const jobMap = (j) => `<div class="routebox"><div class="lmap" data-kind="job" data-id="${j.id}" role="img" aria-label="Map from ${esc(j.pickup.label)} to ${esc(j.drop.label)}"></div><p><b>${j.km} km</b> ${j.approxDistance ? '(estimated distance)' : 'by road'}</p></div>`;
const addr = (p) => `${esc(p.label)}${p.address ? `<br><small class="muted">${esc(p.address)}</small>` : ''}`;

function vSJob() {
  const j = senderJob(nav.cur.id);
  const top = `<div class="top"><button class="icon-btn" data-act="back" aria-label="Back">${ic('back')}</button><h2 class="title grow">Delivery #${nav.cur.id}</h2></div>`;
  if (!j) return top + empty('box', 'This delivery could not be found.');
  let h = top + jobMap(j) + `<div class="row between"><b>${esc(j.itemType)} <span class="muted small">x${j.quantity}</span></b>${chip(j)}</div>
    <div class="kv"><div><small>Pickup</small><span>${addr(j.pickup)}</span></div><div><small>Delivery</small><span>${addr(j.drop)}</span></div>
    <div><small>Recipient</small><span>${esc(j.recipientName)}</span></div><div><small>Vehicle</small><span>${esc(vlabel(j.vehicle))}</span></div>
    ${j.scheduledAt ? `<div class="full"><small>Pickup time</small><span>${fmtDate(j.scheduledAt)}</span></div>` : ''}</div>`;
  if (j.status === 'open') {
    h += `<div class="panel"><div class="row between"><span class="sub">Your offer</span><b class="price">${money(j.openingPrice)}</b></div></div>`;
    const live = j.negotiations.filter((n) => n.status === 'active'), rest = j.negotiations.filter((n) => n.status !== 'active');
    h += '<p class="h3">Offers from couriers</p>';
    h += live.length ? live.map((n) => offerCardS(j, n)).join('') : empty('bike', `No offers yet. Online couriers with a ${vlabel(j.vehicle).toLowerCase()} can see your request now.`);
    h += rest.map((n) => offerCardS(j, n)).join('');
  } else if (j.driver && j.status !== 'cancelled') {
    const d = j.driver;
    h += sealedBanner(j, j.status === 'delivered' ? 'Delivered. Thank you for using Bargo.' : `You pay ${j.payment === 'cash' ? 'cash' : 'by bank transfer'} to the courier.`);
    h += progress(j);
    h += `<div class="panel"><div class="row"><span class="avatar">${esc(d.name[0])}</span><div class="grow"><b>${esc(d.name)}</b><br><small class="muted">${esc(vlabel(d.vehicle))}, ${esc(d.plate)}, ${d.rating.toFixed(1)} stars</small></div>
      <a class="btn sm" style="width:auto;text-decoration:none" href="tel:${esc(d.phone)}" aria-label="Call ${esc(d.name)}">${ic('phone')}</a></div></div>`;
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
    <div class="route-line" style="margin-top:.35rem">${ic('pin')}${j.km} km${j.approxDistance ? ' (est.)' : ''} &middot; ${esc(j.drop.address || j.drop.label)}${j.scheduledAt ? ' &middot; ' + fmtDate(j.scheduledAt) : ''}</div>`;
  if (n && n.status === 'active') h += `<p class="small" style="margin-top:.4rem;color:var(--amber);font-weight:600">${turn ? `Sender countered ${money(last)}` : `Waiting for sender (you asked ${money(last)})`}</p>`;
  if (actions) h += `<div class="btns"><button class="btn soft" data-act="d-reject" data-id="${j.id}">Reject</button><button class="btn line" data-act="open-job" data-id="${j.id}">Counter</button><button class="btn" data-act="d-accept" data-id="${j.id}">Accept</button></div>`;
  return h + '</article>';
}

function vDHome() {
  const f = data, d = f.driver, on = d.status === 'online';
  let h = `<div class="greet"><div class="row"><span class="avatar">${esc(d.name[0])}</span><div><small>Welcome back</small><strong>${esc(d.name)}</strong></div></div><div class="row"><small class="muted">${on ? 'Online' : 'Offline'}</small>
    <label class="switch" title="${on ? 'Online' : 'Offline'}"><input type="checkbox" data-act="toggle-online" ${on ? 'checked' : ''} aria-label="Online"><i></i></label></div></div>`;
  if (f.current.length) {
    const j = f.current[0];
    h += `<article class="banner" role="link" tabindex="0" data-act="open-job" data-id="${j.id}" style="cursor:pointer"><small class="muted">You have 1 delivery in progress</small><b>#${j.id} ${esc(j.itemType)}</b>
      <small>Recipient: ${esc(j.recipientName || 'hidden')}</small><br><small><b style="display:inline;color:var(--amber)">${money(j.agreedPrice)} &middot; ${STATUS[j.status]}</b></small></article>`;
  }
  if (f.offers.length) h += `<p class="h3" style="margin-top:0">Your offers</p>${f.offers.map((j) => jobCardD(j, false)).join('')}`;
  h += '<p class="h3" style="margin:.2rem 0 .6rem">Available requests</p>';
  if (!on) h += '<p class="notice">You are offline. Go online to see and take requests.</p>';
  else if (f.current.length) h += '<p class="notice">Finish your current delivery to take another.</p>' + f.available.map((j) => jobCardD(j, false)).join('');
  else h += f.available.length ? f.available.map((j) => jobCardD(j, true)).join('') : empty('bike', `No requests for a ${vlabel(d.vehicle).toLowerCase()} right now. New ones appear here instantly.`);
  return h;
}

function vDJob() {
  const j = driverJob(nav.cur.id);
  const top = `<div class="top"><button class="icon-btn" data-act="back" aria-label="Back">${ic('back')}</button><h2 class="title grow">Delivery #${nav.cur.id}</h2></div>`;
  if (!j) return top + empty('box', 'This delivery is no longer available.') + '<button class="btn" data-act="back">Back to requests</button>';
  const e = data.earnings;
  let h = top + jobMap(j) + `<div class="row between"><b>${esc(j.itemType)} <span class="muted small">x${j.quantity}</span></b>${chip(j)}</div>
    <div class="kv"><div><small>Pickup</small><span>${addr(j.pickup)}</span></div><div><small>Delivery</small><span>${addr(j.drop)}</span></div>
    <div><small>Vehicle</small><span>${esc(vlabel(j.vehicle))}</span></div><div><small>Payment</small><span>${j.payer === 'sender' ? 'Sender' : 'Recipient'} pays, ${j.payment === 'cash' ? 'cash' : 'transfer'}</span></div>
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
  const key = `${j.id}:${me.id}`;
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
  const d = isD ? data?.driver : null;
  let h = `<h2 class="title" style="margin-bottom:1rem">Profile</h2>
    <div class="row" style="margin-bottom:1rem"><span class="avatar lg">${esc(me.name[0] || '?')}</span><div><b>${esc(me.name)}</b><br><small class="muted">${esc(me.phone)}${isD ? `, ${esc(vlabel(me.vehicle))}, ${esc(me.plate)}` : ''}</small></div></div>`;
  if (d) h += `<div class="stats"><div class="stat"><b>${d.rating.toFixed(1)}</b><small>Rating</small></div><div class="stat"><b>${d.completed}</b><small>Deliveries</small></div><div class="stat"><b>${money(data.earnings.commissionPerDay)}</b><small>Daily commission</small></div></div>`;
  h += `<form class="panel" data-form="pw"><p class="sub" style="margin-bottom:.6rem">Change password</p>
    <label class="field"><span>Current password</span><input class="input" type="password" autocomplete="current-password" data-bind="pw.current" value="${esc(ui.pw.current ?? '')}"></label>
    <label class="field"><span>New password (8 or more characters)</span><input class="input" type="password" autocomplete="new-password" data-bind="pw.next" value="${esc(ui.pw.next ?? '')}"></label>
    ${ui.pw.error ? `<p class="err" role="alert">${esc(ui.pw.error)}</p>` : ''}
    <button class="btn sm inline" type="submit">Save new password</button></form>
    <button class="btn soft" data-act="logout">${ic('logout')} Log out</button>`;
  const help = installHelp();
  if (help) h += `<p class="help" style="margin-top:1rem">${help}</p>`;
  return h;
}

// ---------- Views: admin ----------
function vAdmin() {
  const head = `<div class="top"><button class="icon-btn" data-act="logout" aria-label="Log out of admin">${ic('back')}</button><h2 class="title grow">Admin</h2></div>`;
  if (!data) return `<div class="admin">${head}<p class="empty">Loading...</p></div>`;
  const t = data.totals;
  const reset = (u) => `<button class="btn line sm inline" data-act="admin-reset" data-id="${esc(u.id)}" data-name="${esc(u.name)}">Reset password</button>`;
  return `<div class="admin">${head}
    ${ui.tempPw ? `<div class="temp" role="status">New password for <b>${esc(ui.tempPw.name)}</b> (${esc(ui.tempPw.phone)}): <code>${esc(ui.tempPw.password)}</code><br><small>Shown once. Send it to them and ask them to change it in Profile.</small></div>` : ''}
    <div class="stats"><div class="stat dark"><b>${money(t.commission)}</b><small>Commission collected</small></div><div class="stat"><b>${money(t.dealValue)}</b><small>Deal value delivered</small></div>
      <div class="stat"><b>${t.delivered}</b><small>Delivered</small></div><div class="stat"><b>${t.active}</b><small>On the road</small></div><div class="stat"><b>${t.open}</b><small>Open for offers</small></div>
      <div class="stat"><b>${t.couriers}</b><small>Couriers</small></div><div class="stat"><b>${t.senders}</b><small>Senders</small></div></div>
    <form class="panel" data-form="admin-save"><p class="sub">Daily commission per courier</p>
      <div class="row" style="margin-top:.4rem"><input class="input" inputmode="numeric" data-num="1" data-bind="adm.commission" value="${esc(ui.adm.commission ?? data.settings.commissionPerDay)}" style="max-width:180px" aria-label="Daily commission in naira"><button class="btn sm inline" type="submit">Save</button></div>
      <p class="sub" style="margin-top:.5rem">Charged once per courier on their first delivery of each day. Changes apply to later days. Past charges stay as they were.</p></form>
    <div class="cols"><div><p class="h3">Couriers</p><div class="tbl-wrap"><table class="tbl"><tr><th>Courier</th><th>Status</th><th>Trips</th><th>Paid us</th><th></th></tr>
      ${data.drivers.map((d) => `<tr><td><b>${esc(d.name)}</b><br><small class="muted">${esc(d.phone)}, ${esc(vlabel(d.vehicle))}, ${esc(d.plate)}</small></td><td>${esc(d.status)}</td><td>${d.completed}</td><td>${money(d.earnings.commission)}</td><td>${reset(d)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No couriers yet.</td></tr>'}</table></div></div>
    <div><p class="h3">Senders</p><div class="tbl-wrap"><table class="tbl"><tr><th>Sender</th><th>Deliveries</th><th></th></tr>
      ${data.senders.map((u) => `<tr><td><b>${esc(u.name)}</b><br><small class="muted">${esc(u.phone)}</small></td><td>${u.jobs}</td><td>${reset(u)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No senders yet.</td></tr>'}</table></div></div></div>
    <p class="h3">Recent deliveries</p><div class="tbl-wrap"><table class="tbl"><tr><th>#</th><th>Route</th><th>Distance</th><th>Price</th><th>Status</th></tr>
      ${data.jobs.slice(0, 15).map((j) => `<tr><td>${j.id}</td><td>${esc(j.pickup.label)} to ${esc(j.drop.label)}</td><td>${j.km} km</td><td>${money(j.agreedPrice || j.openingPrice)}</td><td>${STATUS[j.status]}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No deliveries yet.</td></tr>'}</table></div>
    <p class="h3">Commission ledger</p><div class="tbl-wrap"><table class="tbl"><tr><th>Date</th><th>Courier</th><th>Amount</th></tr>
      ${data.ledger.map((l) => `<tr><td>${dayLabel(l.date)}</td><td>${esc(data.drivers.find((d) => d.id === l.driverId)?.name || l.driverId)}</td><td>${money(l.amount)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing collected yet.</td></tr>'}</table></div></div>`;
}

// ---------- Rendering ----------
const TABS = {
  sender: [['home', 'Home', 'home'], ['jobs', 'Deliveries', 'list'], ['profile', 'Profile', 'user']],
  driver: [['home', 'Home', 'home'], ['earnings', 'Earnings', 'wallet'], ['bookings', 'Bookings', 'list'], ['profile', 'Profile', 'user']],
};

function currentView() {
  if (!me) {
    if (ui.admin) return { html: vAdminLogin(), tabs: false };
    if (ui.auth) return { html: vAuth(), tabs: false };
    return { html: vWelcome(), bare: true, tabs: false };
  }
  if (me.role === 'admin') return { html: vAdmin(), tabs: false, wide: true };
  const n = nav.cur.name;
  if (me.role === 'sender') {
    if (n === 'new') return { html: vSNew(), tabs: false };
    const f = { home: vSHome, jobs: vSJobs, job: vSJob, profile: vProfile }[n] || vSHome;
    return { html: f(), tabs: true };
  }
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
  destroyMaps();
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
  scr.scrollTop = reset ? 0 : top;
  mountMaps();
  if (bind && !reset) {
    const el = scr.querySelector(`[data-bind="${CSS.escape(bind)}"]`);
    if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* not a text input */ } }
  }
}

// ---------- Data loading ----------
function signedOut(msg) {
  me = null; data = null; dsig = ''; closeSheet();
  nav = { stack: [], cur: { name: 'home' } };
  if (msg) toast(msg, true);
  render(true);
}
async function pull(fresh) {
  if (!me) return;
  const q = fresh ? '?fresh=1' : '';
  try {
    const next = me.role === 'sender' ? await call('sender/jobs' + q) : me.role === 'driver' ? await call('driver/feed' + q) : await call('admin' + q);
    $('#offline').hidden = true;
    const s = JSON.stringify(next);
    if (s !== dsig) { data = next; dsig = s; render(); }
  } catch (e) {
    if (e.status === 401) return signedOut('You were signed out. Please log in again.');
    if (e.status === 0 || !navigator.onLine) $('#offline').hidden = false;
  }
}
async function run(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message, true); }
  dsig = ''; await pull(true);
}
async function startSession(user) {
  me = user; data = null; dsig = ''; ui.auth = null; ui.admin = null;
  nav = { stack: [], cur: { name: 'home' } };
  render(true);
  await pull(true);
}

// ---------- Actions ----------
const ACT = {
  'auth-start': ({ role }) => { ui.auth = { role, mode: 'login', phone: ls.get('phone'), password: '', name: '', vehicle: 'bike', plate: '', show: false, error: '', busy: false }; render(true); },
  'auth-back': () => { ui.auth = null; render(true); },
  'auth-mode': ({ mode }) => { ui.auth.mode = mode; ui.auth.error = ''; render(); },
  'auth-veh': ({ v }) => { ui.auth.vehicle = v; render(); },
  'toggle-pw': () => { ui.auth.show = !ui.auth.show; render(); },
  'admin-start': () => { ui.admin = { pin: '', error: '' }; render(true); },
  'admin-back': () => { ui.admin = null; render(true); },
  logout: async () => { try { await call('auth/logout', {}); } catch { /* signing out locally anyway */ } signedOut(); },
  tab: ({ tab: t }) => tab(t),
  back: () => back(),
  'open-job': ({ id }) => go('job', { id }),
  'start-new': ({ type }) => { ui.draft = defaultDraft(type); ui.step = 1; ui.error = ''; ui.est = null; ui.route = null; go('new'); },
  veh: ({ v }) => { ui.draft.vehicle = v; render(); updateEstimate(); },
  'open-sheet': ({ kind }) => openSheet(kind),
  'sheet-close': () => closeSheet(),
  'sheet-search': () => { ui.sh.mode = 'search'; drawSheet(); },
  'sheet-map': () => { ui.sh.mode = 'map'; drawSheet(); },
  'sheet-gps': () => useGps(),
  'sheet-area': ({ name }) => { ui.sh.q = name; ui.sh.msg = 'Searching...'; ui.sh.results = []; $('#sheet input').value = name; renderResults(); runSearch(name, `${name}, Port Harcourt`); },
  'sheet-pick': ({ i }) => { const r = ui.sh.results[Number(i)]; if (r) setPoint(ui.sh.kind, r); },
  'sheet-confirm': () => {
    const c = sheetMap.getCenter(), sh = ui.sh;
    if (!inService(c.lat, c.lng)) return toast('That spot is outside our Port Harcourt service area.', true);
    setPoint(sh.kind, { lat: c.lat, lng: c.lng, label: sh.label || 'Pinned location', address: sh.address || '' });
  },
  'new-back': () => { ui.error = ''; if (ui.step > 1) { ui.step -= 1; render(true); } else { ui.draft = null; back(); } },
  'new-next': () => {
    const d = ui.draft; ui.error = '';
    if (ui.step === 1) {
      if (!d.pickup || !d.drop) ui.error = 'Choose both the pickup and the delivery location.';
      else if (!ui.est) ui.error = ui.route?.status === 'loading' ? 'Hold on, we are still measuring the route.' : (ui.error || 'We could not price this trip. Try again.');
      else if (d.type === 'scheduled' && !(new Date(d.scheduledAt) > new Date())) ui.error = 'Choose a pickup time in the future.';
    } else if (ui.step === 2) {
      if (!d.itemType) ui.error = 'Choose what you are sending.';
      else if (!d.recipientName.trim()) ui.error = 'Enter the recipient name.';
      else if (!/^[+\d][\d\s-]{6,18}$/.test(d.recipientPhone.trim())) ui.error = 'Enter a valid recipient phone number.';
    }
    if (!ui.error) ui.step += 1;
    render(true);
  },
  'post-job': () => run(async () => {
    const d = ui.draft, r = ui.route;
    const job = await call('jobs', {
      deliveryType: d.type, scheduledAt: d.type === 'scheduled' && d.scheduledAt ? new Date(d.scheduledAt).toISOString() : undefined,
      pickup: d.pickup, drop: d.drop, routeKm: r?.status === 'ok' ? r.km : undefined, routeGeo: r?.status === 'ok' ? r.geo : undefined,
      vehicle: d.vehicle, itemType: d.itemType, quantity: d.quantity, note: d.note, recipientName: d.recipientName,
      recipientPhone: d.recipientPhone, payer: d.payer, payment: d.payment, openingPrice: d.price,
    });
    ui.draft = null; ui.route = null; ui.est = null;
    nav = { stack: [{ name: 'jobs' }], cur: { name: 'job', id: job.id } };
    toast('Request posted. Couriers can now make offers.');
  }),
  step: ({ path, d }, el) => {
    const shown = Number(String(el.parentElement.querySelector('input').value).replace(/\D/g, ''));
    setPath(path, Math.max(100, (shown || Number(getPath(path)) || 0) + Number(d)));
    if (path === 'draft.price') ui.draft.priceTouched = true;
    render();
  },
  'toggle-counter': ({ key, price }) => { ui.open[key] = !ui.open[key]; if (ui.counter[key] == null) ui.counter[key] = Number(price); render(); },
  's-accept': ({ id, driver }) => run(() => call(`jobs/${id}/sender/accept`, { driverId: driver })),
  's-decline': ({ id, driver }) => run(() => call(`jobs/${id}/sender/decline`, { driverId: driver })),
  's-counter': ({ id, driver, key }) => run(async () => { await call(`jobs/${id}/sender/counter`, { driverId: driver, price: ui.counter[key] }); ui.open[key] = false; delete ui.counter[key]; }, 'Counter-offer sent.'),
  's-cancel': ({ id }) => { if (confirm('Cancel this delivery?')) run(() => call(`jobs/${id}/cancel`, {}), 'Delivery cancelled.'); },
  rate: ({ id, n }) => run(() => call(`jobs/${id}/rate`, { rating: Number(n) }), 'Thanks for rating.'),
  'toggle-online': (_, el) => run(() => call('driver/status', { status: el.checked ? 'online' : 'offline' })),
  'd-accept': ({ id }) => run(() => call(`jobs/${id}/driver/accept`, {}), 'Deal sealed.'),
  'd-reject': ({ id }) => run(async () => { await call(`jobs/${id}/driver/reject`, {}); if (nav.cur.name === 'job') back(); }),
  'd-counter': ({ id, key }) => run(async () => { await call(`jobs/${id}/driver/counter`, { price: ui.counter[key] }); delete ui.counter[key]; }, 'Counter-offer sent.'),
  'd-pickup': ({ id }) => run(() => call(`jobs/${id}/driver/pickup`, {}), 'Marked as picked up.'),
  'd-deliver': ({ id }) => run(() => call(`jobs/${id}/driver/deliver`, {}), 'Delivery complete.'),
  'd-withdraw': ({ id }) => { if (confirm('Pull out? The delivery goes back to other couriers.')) run(async () => { await call(`jobs/${id}/driver/withdraw`, {}); back(); }); },
  'admin-reset': ({ id, name }) => { if (confirm(`Reset the password for ${name}? Their current sessions will end.`)) run(async () => { const r = await call(`admin/users/${id}/reset`, {}); ui.tempPw = { name: r.name, phone: r.phone, password: r.tempPassword }; }); },
  install: async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice; installEvent = null; render(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const f = ACT[el.dataset.act];
  if (f) f(el.dataset, el, e);
});
document.addEventListener('change', (e) => { if (e.target.dataset?.act === 'toggle-online') ACT['toggle-online'](e.target.dataset, e.target); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[role="link"][data-act]')) { e.preventDefault(); e.target.click(); }
  if (e.key === 'Escape' && ui.sh) closeSheet();
});
document.addEventListener('input', (e) => {
  const t = e.target, path = t.dataset?.bind;
  if (!path) return;
  if (t.type === 'radio' && !t.checked) return;
  setPath(path, t.dataset.num ? Number(String(t.value).replace(/\D/g, '')) : t.value);
  if (path === 'draft.price') ui.draft.priceTouched = true;
  if (t.dataset.search) scheduleSearch();
});

async function submitAuth() {
  const a = ui.auth, reg = a.mode === 'register';
  a.error = '';
  if (reg && !(a.name || '').trim()) a.error = 'Enter your full name.';
  else if (!(a.phone || '').trim()) a.error = 'Enter your phone number.';
  else if (!a.password) a.error = 'Enter your password.';
  else if (reg && a.password.length < 8) a.error = 'Password must be at least 8 characters.';
  else if (reg && a.role === 'driver' && !(a.plate || '').trim()) a.error = 'Enter your vehicle plate number.';
  if (a.error) return render();
  a.busy = true; render();
  try {
    const body = { role: a.role, phone: a.phone, password: a.password };
    if (reg) body.name = a.name;
    if (reg && a.role === 'driver') { body.vehicle = a.vehicle || 'bike'; body.plate = a.plate; }
    const r = await call(reg ? 'auth/register' : 'auth/login', body);
    ls.set('phone', a.phone);
    await startSession(r.user);
    if (reg && r.user.role === 'driver') toast('Welcome! Switch on Online to see requests.');
  } catch (e) { a.busy = false; a.error = e.message; a.password = ''; render(); }
}

document.addEventListener('submit', (e) => {
  const f = e.target.dataset?.form;
  if (!f) return;
  e.preventDefault();
  if (f === 'auth') submitAuth();
  else if (f === 'admin-login') {
    (async () => {
      try { const r = await call('auth/admin', { pin: ui.admin.pin }); await startSession(r.user); }
      catch (err) { ui.admin.error = err.message; ui.admin.pin = ''; render(); }
    })();
  } else if (f === 'admin-save') run(async () => { await call('admin/settings', { commissionPerDay: ui.adm.commission ?? data.settings.commissionPerDay }); ui.adm = {}; }, 'Commission updated.');
  else if (f === 'pw') {
    (async () => {
      ui.pw.error = '';
      try { await call('me/password', { current: ui.pw.current || '', next: ui.pw.next || '' }); ui.pw = {}; toast('Password changed. Other devices were signed out.'); }
      catch (err) { ui.pw.error = err.message; }
      render();
    })();
  }
});

// ---------- PWA ----------
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; render(); });
window.addEventListener('appinstalled', () => { installEvent = null; toast('Bargo installed.'); render(); });
window.addEventListener('online', () => { $('#offline').hidden = true; pull(true); });
window.addEventListener('offline', () => { $('#offline').hidden = false; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

// ---------- Start ----------
(async function init() {
  try { meta = await call('meta'); } catch {
    $('#screen').innerHTML = '<p class="empty">Cannot reach the server. Check your connection and reload.</p>';
    return;
  }
  try { me = (await call('me')).user; } catch { me = null; }
  render(true);
  if (me) pull(true);
  setInterval(() => { if (!document.hidden) pull(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(true); });
})();
