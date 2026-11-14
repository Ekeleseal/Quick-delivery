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
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0"/>',
  nav: '<path d="M3 11l18-8-8 18-2-8z"/>',
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
  if (!res.ok) throw Object.assign(new Error(json.error || `Something went wrong (server answered ${res.status}). Try again.`), { status: res.status });
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
let pushSt = 'unknown'; // unsupported | needs-install | denied | off | on
let lastNoteId = null;
let pendingJob = new URLSearchParams(location.search).get('job');
const ui = { app: null, dc: {}, chat: {}, auth: null, admin: null, step: 1, draft: null, est: null, route: null, counter: {}, open: {}, seen: new Set(), pw: {}, sh: null, error: '', tempPw: null, adm: {} };

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
const avatar = (u, cls = '') => (u && u.photoAt && u.id ? `<img class="avatar ${cls}" alt="" src="/api/photo/${esc(u.id)}?v=${u.photoAt}">` : `<span class="avatar ${cls}">${esc(((u && u.name) || '?')[0])}</span>`);
const ID_TYPES = ['NIN', "Driver's licence", "Voter's card", 'International passport'];
async function readPhoto(file) {
  if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('Choose a picture from your phone or take one.');
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That picture could not be opened.')); i.src = URL.createObjectURL(file); });
  }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, side = Math.min(w, h), size = 360;
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  cv.getContext('2d').drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
  for (const q of [0.82, 0.7, 0.55, 0.4]) { const url = cv.toDataURL('image/jpeg', q); if (url.length < 150000) return url; }
  throw new Error('That picture is too large. Try another one.');
}
const photoInput = (kind) => `<input id="photo-${kind}" type="file" accept="image/*" ${kind === 'auth' || kind === 'app' ? 'capture="user"' : ''} hidden data-photo="${kind}">`;
const route = (j) => `${esc(j.pickup.label)} ${ic('arrow')} ${esc(j.drop.label)}`;
const chip = (j) => `<span class="chip ${j.status}">${STATUS[j.status]}</span>`;
const empty = (icon, msg) => `<div class="empty">${ic(icon)}<p>${msg}</p></div>`;
const getPath = (p) => { const i = p.indexOf('.'); return ui[p.slice(0, i)]?.[p.slice(i + 1)]; };
function setPath(p, v) { const i = p.indexOf('.'); const root = p.slice(0, i); ui[root] ||= {}; ui[root][p.slice(i + 1)] = v; }
const inService = (lat, lng) => { const b = meta.bounds; return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east; };
const storageWarning = () => (meta?.ephemeral ? '<p class="warn" role="alert">This server is not saving data permanently yet, so accounts and deliveries will disappear. The owner needs to connect a database (see the README).</p>' : '');

function defaultDraft(type) {
  return { type, pickup: null, drop: null, pickupDetails: '', dropDetails: '', vehicle: 'bike', scheduledAt: '', itemType: '', quantity: 1, note: '', recipientName: '', recipientPhone: '', payer: 'sender', payment: 'cash', price: 0, priceTouched: false };
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

async function geocodeGoogle(q, signal) {
  const b = meta.bounds;
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': meta.mapsKey, 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location' },
    body: JSON.stringify({ textQuery: /port harcourt/i.test(q) ? q : q + ', Port Harcourt', regionCode: 'NG', maxResultCount: 8, locationRestriction: { rectangle: { low: { latitude: b.south, longitude: b.west }, high: { latitude: b.north, longitude: b.east } } } }),
  });
  if (!r.ok) throw new Error('google search failed');
  const j = await r.json();
  return (j.places || []).map((x) => ({ lat: x.location.latitude, lng: x.location.longitude, label: String(x.displayName?.text || x.formattedAddress || 'Place').slice(0, 60), address: cleanAddress(x.formattedAddress) })).filter((x) => inService(x.lat, x.lng));
}
async function geocode(q, signal) {
  if (meta.mapsKey) { try { const g = await geocodeGoogle(q, signal); if (g.length) return g; } catch (e) { if (e.name === 'AbortError') throw e; } }
  return geocodeOsm(q, signal);
}
async function geocodeOsm(q, signal) {
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
function routeMap(el, pickup, drop, geo, courier) {
  if (!window.TileMap) { el.innerHTML = '<p class="empty">Map unavailable.</p>'; return; }
  const m = new TileMap(el, { interactive: false });
  const line = geo && geo.length > 1 ? geo : [[pickup.lat, pickup.lng], [drop.lat, drop.lng]];
  m.addLine(line, { dashed: !(geo && geo.length > 1) });
  m.addMarker(pickup.lat, pickup.lng, 'pickup', pickup.label);
  m.addMarker(drop.lat, drop.lng, 'drop', drop.label);
  if (courier) m.addMarker(courier.lat, courier.lng, 'courier', 'Courier');
  m.fitBounds([...line, pickup, drop, ...(courier ? [courier] : [])]);
  liveMaps.push(m);
}
function mountMaps() {
  $$('#screen .lmap').forEach((el) => {
    if (el.dataset.kind === 'job') { const j = findJob(el.dataset.id); if (j) routeMap(el, j.pickup, j.drop, j.routeGeo, ['agreed', 'picked_up'].includes(j.status) ? j.courierLoc : null); }
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
      <div class="sh-foot"><p id="sh-label" class="sub">${sh.typed ? `Address: ${esc(sh.typed)}. ` : ''}Move the map to put the pin on the exact spot.</p><button class="btn" data-act="sheet-confirm">Confirm location</button></div>`;
    const d = ui.draft, here = sh.start || d[sh.kind] || d[sh.kind === 'pickup' ? 'drop' : 'pickup'] || meta.center;
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
  const q = (sh.q || '').trim();
  const typed = q.length >= 3 && !sh.msg.startsWith('Searching') ? `<button class="pick typed" data-act="sheet-typed">${ic('pin')}<span class="grow"><b>Use “${esc(q.slice(0, 60))}” as the address</b><br><small class="muted">Then drop the pin on the exact spot</small></span></button>` : '';
  if (sh.results.length) box.innerHTML = typed + sh.results.map((r, i) => `<button class="pick" data-act="sheet-pick" data-i="${i}">${ic('pin')}<span class="grow"><b>${esc(r.label)}</b><br><small class="muted">${esc(r.address)}</small></span></button>`).join('');
  else if (sh.msg) box.innerHTML = `<p class="skel">${esc(sh.msg)}</p>` + typed;
  else box.innerHTML = (recents().length ? `<p class="h3" style="margin-top:.4rem">Recent</p>${recents().map((r, i) => `<button class="pick" data-act="sheet-recent" data-i="${i}">${ic('clock')}<span class="grow"><b>${esc(r.label)}</b><br><small class="muted">${esc(r.address)}</small></span></button>`).join('')}` : '') + `<p class="h3" style="margin-top:.4rem">Popular areas</p><div class="chips">${meta.areas.map((a) => `<button data-act="sheet-area" data-name="${esc(a)}">${esc(a)}</button>`).join('')}</div>`;
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
  if (sh.typed) { sh.label = sh.typed.slice(0, 60); sh.address = sh.typed; if (lab) lab.textContent = `Address: ${sh.typed}. Move the map to put the pin on the exact spot.`; return; }
  if (lab) lab.textContent = 'Finding the address...';
  const r = await reverseGeocode(c.lat, c.lng);
  if (ui.sh !== sh || sh.seq !== seq) return;
  sh.label = r.label; sh.address = r.address;
  const l2 = $('#sh-label');
  if (l2) l2.textContent = r.address || r.label;
}
const recents = () => { try { return JSON.parse(ls.get('bargo_recent', '[]')).filter((r) => r && Number.isFinite(r.lat)).slice(0, 5); } catch { return []; } };
function setPoint(kind, pt) {
  ui.draft[kind] = pt;
  if (pt.label && pt.label !== 'Pinned location') ls.set('bargo_recent', JSON.stringify([pt, ...recents().filter((r) => r.label !== pt.label)].slice(0, 5)));
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

// ---------- Alerts, push, tracking, chat ----------
const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ts).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }); };
const hav = (a, b) => { const r = (d) => (d * Math.PI) / 180, h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const waNum = (p) => { const d = String(p).replace(/\D/g, ''); return d.startsWith('0') ? '234' + d.slice(1) : d; };
const mapsLink = (pt) => `https://www.google.com/maps/dir/?api=1&destination=${pt.lat},${pt.lng}&travelmode=driving`;

function etaText(j) {
  const L = j.courierLoc;
  if (me?.role !== 'sender' || !L || !['agreed', 'picked_up'].includes(j.status) || !j.driver) return '';
  const km = hav(L, j.status === 'agreed' ? j.pickup : j.drop) * 1.35, min = Math.max(1, Math.round((km / 25) * 60));
  const age = Math.round((Date.now() - L.at) / 60000);
  return `<p class="eta"><span class="live"></span><b>${esc(j.driver.name.split(' ')[0])}</b> is about <b>${min} min</b> ${j.status === 'agreed' ? 'from the pickup' : 'from the drop-off'}${age >= 2 ? `<small class="muted"> (last seen ${age} min ago)</small>` : ''}</p>`;
}

function codePanel(j) {
  if (!['agreed', 'picked_up'].includes(j.status) || !j.deliveryCode) return '';
  const msg = `Hello ${j.recipientName}, ${me.name} is sending you a package with Bargo. Give the courier this delivery code when it arrives: ${j.deliveryCode}`;
  return `<div class="panel code"><p class="sub">Delivery code</p>
    <div class="pin">${j.deliveryCode.split('').map((c) => `<span>${c}</span>`).join('')}</div>
    <p class="small">Give this code to ${esc(j.recipientName)}. The courier needs it to complete the delivery, so the package only counts as delivered when the recipient has it.</p>
    <div class="btns"><a class="btn line sm" target="_blank" rel="noopener" href="https://wa.me/${waNum(j.recipientPhone)}?text=${encodeURIComponent(msg)}">Send on WhatsApp</a><a class="btn line sm" href="sms:${esc(j.recipientPhone)}?body=${encodeURIComponent(msg)}">Send by SMS</a></div></div>`;
}

function chatPanel(j) {
  const msgs = j.messages || [], live = ['agreed', 'picked_up'].includes(j.status), mine = me.role === 'sender' ? 'sender' : 'driver';
  if (!live && !msgs.length) return '';
  const quick = me.role === 'sender' ? ['Please call me', 'I am at the pickup point', 'Handle with care'] : ['I am on my way', 'I have arrived', 'Please call me'];
  return `<div class="panel chat"><p class="sub">Messages</p>
    <div class="msgs" id="msgs">${msgs.length ? msgs.map((m) => `<div class="msg ${m.from === mine ? 'me' : 'them'}">${esc(m.text)}<small>${new Date(m.at).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}</small></div>`).join('') : '<p class="muted small" style="margin:0">No messages yet. Say hello.</p>'}</div>
    ${live ? `<div class="chips">${quick.map((q) => `<button type="button" data-act="chat-quick" data-id="${j.id}" data-text="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <form class="row" data-form="chat" data-id="${j.id}"><input class="input" maxlength="300" placeholder="Type a message" autocomplete="off" data-bind="chat.t${j.id}" value="${esc(ui.chat['t' + j.id] ?? '')}"><button class="btn sm inline" type="submit" style="width:auto">Send</button></form>` : ''}</div>`;
}

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function refreshPushState() {
  try {
    if (!pushSupported()) pushSt = /iphone|ipad|ipod/i.test(navigator.userAgent) && !(matchMedia('(display-mode: standalone)').matches || navigator.standalone) ? 'needs-install' : 'unsupported';
    else if (Notification.permission === 'denied') pushSt = 'denied';
    else {
      const reg = await navigator.serviceWorker.ready;
      pushSt = Notification.permission === 'granted' && (await reg.pushManager.getSubscription()) ? 'on' : 'off';
    }
  } catch { pushSt = 'unsupported'; }
}
const b64ToBytes = (b) => Uint8Array.from(atob(b.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
async function enablePush() {
  if (!pushSupported()) throw new Error('This browser cannot show alerts when the app is closed.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { await refreshPushState(); throw new Error('Alerts are blocked. Allow notifications for Bargo in your browser settings.'); }
  const { key } = await call('push/key');
  if (!key) throw new Error('Alerts are not ready yet. Try again in a moment.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
  await call('me/push', { subscription: sub.toJSON() });
  await refreshPushState();
}
async function syncPush() { // after login: make sure this phone's subscription belongs to this account
  try {
    await refreshPushState();
    if (pushSt !== 'on') return;
    const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    if (sub) await call('me/push', { subscription: sub.toJSON() });
  } catch { /* alerts still work inside the app */ }
}
async function dropPush() { // before logout: the next person on this phone must not get this account's alerts
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    if (sub) await call('me/push/remove', { endpoint: sub.endpoint });
  } catch { /* ignore */ }
}
function pushCard(full) {
  const st = pushSt;
  if (st === 'on') return full ? '<p class="notice ok">Phone alerts are on. You will hear about offers and updates even when Bargo is closed.</p>' : '';
  if (!full && (st !== 'off' || ls.get('bargo_push_dismiss') === '1')) return '';
  if (st === 'off') return `<div class="panel pushcard">${ic('bell')}<div class="grow"><b>Never miss an offer</b><br><small class="muted">Get an alert on your phone for new requests, offers and deliveries, even when the app is closed.</small></div><div class="stack"><button class="btn sm inline" data-act="push-on">Turn on</button>${full ? '' : '<button class="link" data-act="push-dismiss">Not now</button>'}</div></div>`;
  if (!full) return '';
  if (st === 'needs-install') return '<p class="notice">On iPhone, add Bargo to your Home Screen first (Safari: Share, then Add to Home Screen), then open it from there to turn on phone alerts.</p>';
  if (st === 'denied') return '<p class="notice">Alerts are blocked for Bargo. Allow notifications in your browser or phone settings to turn them on.</p>';
  return '<p class="notice">This browser cannot send phone alerts. You will still see alerts here when Bargo is open.</p>';
}
function vAlerts() {
  const n = data?.notes || { items: [], unread: 0 };
  let h = `<div class="row between" style="margin-bottom:.8rem"><h2 class="title">Alerts</h2>${n.unread ? '<button class="link" data-act="mark-read">Mark all read</button>' : ''}</div>${pushCard(true)}`;
  h += n.items.length ? n.items.map((x) => `<button class="note ${x.read ? '' : 'unread'}" data-act="open-note" data-id="${x.id}" data-job="${x.jobId ?? ''}"><span class="dot"></span><span class="grow"><b>${esc(x.title)}</b><small>${esc(x.body)}</small></span><time>${ago(x.at)}</time></button>`).join('')
    : empty('bell', 'No alerts yet. Offers, deals and delivery updates show up here.');
  return h;
}

let audioCtx = null;
function chime() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [660, 880].forEach((f, i) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination); g.gain.setValueAtTime(0.0001, t + i * 0.14); g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.14 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.14 + 0.22); o.start(t + i * 0.14); o.stop(t + i * 0.14 + 0.25); });
  } catch { /* sound is a nicety */ }
  try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch { /* ignore */ }
}
async function markRead(ids) {
  try { const r = await call('me/notifications', ids ? { ids } : {}); if (data) { data.notes = r; dsig = ''; render(); } } catch { /* try again next time */ }
}
function handleNotes(n) {
  if (!n) return;
  try { navigator.setAppBadge && (n.unread ? navigator.setAppBadge(n.unread) : navigator.clearAppBadge()); } catch { /* not supported */ }
  const top = n.items.reduce((m, x) => Math.max(m, x.id), 0);
  if (lastNoteId === null) { lastNoteId = top; return; }
  const fresh = n.items.filter((x) => x.id > lastNoteId && !x.read);
  lastNoteId = Math.max(lastNoteId, top);
  if (!fresh.length) return;
  if (nav.cur.name === 'alerts') setTimeout(() => markRead(), 1200);
  if (document.hidden) {
    if (pushSt !== 'on' && 'Notification' in window && Notification.permission === 'granted') navigator.serviceWorker?.ready.then((r) => r.showNotification(fresh[0].title, { body: fresh[0].body, tag: 'bargo-' + (fresh[0].jobId ?? fresh[0].type), icon: '/icons/icon-192.png', data: { jobId: fresh[0].jobId } })).catch(() => {});
    return;
  }
  chime();
  toast(fresh.length > 1 ? `${fresh[0].title} (and ${fresh.length - 1} more)` : `${fresh[0].title}. ${fresh[0].body}`.slice(0, 140));
}

// Live location: while a courier has a delivery in progress and the app is open, share position with the sender.
let watchId = null, lastSent = 0, lastPos = null;
function syncTracking() {
  const need = me?.role === 'driver' && data?.current?.length && navigator.geolocation;
  if (need && watchId === null) {
    watchId = navigator.geolocation.watchPosition((p) => { ui.geoDenied = false; lastPos = p.coords; sendLoc(); }, (e) => { if (e.code === 1 && !ui.geoDenied) { ui.geoDenied = true; render(); } }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  } else if (!need && watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; lastPos = null; }
  if (need && lastPos) sendLoc();
}
function sendLoc() {
  if (!lastPos || Date.now() - lastSent < 10000) return;
  lastSent = Date.now();
  call('driver/location', { lat: lastPos.latitude, lng: lastPos.longitude }).catch(() => {});
}

// ---------- In-app voice calls (WebRTC; the server only passes the connection details) ----------
let cs = null; // the call on screen: { jobId, dir: 'out' | 'in', status, name, pc, stream, muted, since, poll, ring }
const callSeen = new Set();
const jobPartyName = (j) => (me.role === 'sender' ? (j.driver?.name || 'Courier') : (j.senderName || 'Sender')).split(' ')[0];
const gathered = (pc) => new Promise((res) => {
  if (pc.iceGatheringState === 'complete') return res();
  const t = setTimeout(res, 4000);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
});
function callUi() {
  let el = $('#callui');
  if (!cs) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'callui'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Voice call'); document.body.appendChild(el); }
  const label = { starting: 'Starting...', ringing: 'Calling...', incoming: 'Incoming call', connecting: 'Connecting...', active: '', ended: cs.msg || 'Call ended' }[cs.status];
  const timer = cs.status === 'active' ? (() => { const sec = Math.floor((Date.now() - cs.since) / 1000); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; })() : '';
  el.innerHTML = `<div class="callbox"><span class="avatar lg">${esc((cs.name || '?')[0])}</span><h2>${esc(cs.name)}</h2><p id="call-status">${label || timer}</p>
    <div class="callbtns">${cs.status === 'incoming'
    ? `<button class="cbtn red" data-act="call-decline" aria-label="Decline">${ic('phone')}</button><button class="cbtn green" data-act="call-answer" aria-label="Answer">${ic('phone')}</button>`
    : cs.status === 'ended' ? '<button class="cbtn" data-act="call-close">Close</button>'
      : `<button class="cbtn ${cs.muted ? 'on' : ''}" data-act="call-mute" aria-label="${cs.muted ? 'Unmute' : 'Mute'}">${ic('mic')}</button><button class="cbtn red" data-act="call-hangup" aria-label="Hang up">${ic('phone')}</button>`}</div>
    ${cs.status === 'ended' || cs.status === 'incoming' ? '' : '<small>Voice call through Bargo. Your phone number stays private.</small>'}</div>`;
}
function stopRing() { if (cs?.ring) { clearInterval(cs.ring); cs.ring = null; } }
function startRing() {
  stopRing();
  const beep = () => { chime(); };
  beep(); cs.ring = setInterval(beep, 2200);
}
function cleanupCall(msg) {
  if (!cs) return;
  stopRing(); clearInterval(cs.poll); clearInterval(cs.tick);
  try { cs.pc && cs.pc.close(); } catch { /* already closed */ }
  try { cs.stream && cs.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  const a = $('#remote-audio'); if (a) a.srcObject = null;
  if (msg) { cs.status = 'ended'; cs.msg = msg; callUi(); const mine = cs; setTimeout(() => { if (cs === mine) { cs = null; callUi(); } }, 2500); } else { cs = null; callUi(); }
}
function makePeer(ice, stream) {
  const pc = new RTCPeerConnection({ iceServers: ice });
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  pc.ontrack = (e) => {
    let a = $('#remote-audio');
    if (!a) { a = document.createElement('audio'); a.id = 'remote-audio'; a.autoplay = true; a.setAttribute('playsinline', ''); document.body.appendChild(a); }
    a.srcObject = e.streams[0]; a.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (!cs || cs.pc !== pc) return;
    if (pc.connectionState === 'connected' && cs.status !== 'active') {
      cs.status = 'active'; cs.since = Date.now(); callUi();
      cs.tick = setInterval(() => { const t = $('#call-status'); if (t && cs?.status === 'active') { const sec = Math.floor((Date.now() - cs.since) / 1000); t.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; } }, 1000);
    }
    if (pc.connectionState === 'failed') { call(`jobs/${cs.jobId}/call`, { action: 'end' }).catch(() => {}); cleanupCall('The call could not connect. Try again, or call by phone.'); }
  };
  return pc;
}
async function micStream() {
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('Calls are not supported on this browser. Use the phone button instead.');
  try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { throw new Error('Allow microphone access for Bargo to make calls.'); }
}
function watchCall() {
  clearInterval(cs.poll);
  const mine = cs;
  cs.poll = setInterval(async () => {
    if (cs !== mine) return;
    try {
      const { call: c } = await call(`jobs/${mine.jobId}/call?fresh=1`);
      if (cs !== mine || !c) return;
      if (c.status === 'ended') { cleanupCall(c.reason === 'declined' ? 'Call declined' : c.reason === 'missed' ? 'No answer' : c.reason === 'cancelled' ? 'Call cancelled' : 'Call ended'); return; }
      if (mine.dir === 'out' && c.status === 'active' && c.answer && !mine.gotAnswer) {
        mine.gotAnswer = true; mine.status = 'connecting'; callUi();
        await mine.pc.setRemoteDescription({ type: 'answer', sdp: c.answer });
      }
    } catch { /* keep trying */ }
  }, 1200);
}
async function startCall(id) {
  if (cs) return;
  const j = findJob(id);
  cs = { jobId: id, dir: 'out', status: 'starting', name: j ? jobPartyName(j) : 'Call', muted: false };
  const mine = cs; callUi();
  try {
    mine.stream = await micStream();
    const { ice } = await call(`jobs/${id}/call`);
    mine.pc = makePeer(ice, mine.stream);
    await mine.pc.setLocalDescription(await mine.pc.createOffer());
    await gathered(mine.pc);
    if (cs !== mine) return;
    await call(`jobs/${id}/call`, { action: 'start', sdp: mine.pc.localDescription.sdp });
    mine.status = 'ringing'; callUi(); watchCall();
  } catch (e) { if (cs === mine) cleanupCall(e.message); }
}
function checkIncoming() {
  if (cs || !me || me.role === 'admin' || !data) return;
  const jobs = me.role === 'sender' ? data.jobs || [] : data.current || [];
  const j = jobs.find((x) => x.call && x.call.status === 'ringing' && x.call.from !== me.role && Date.now() - x.call.at < 44000 && !callSeen.has(x.id + ':' + x.call.at));
  if (!j) return;
  callSeen.add(j.id + ':' + j.call.at);
  cs = { jobId: j.id, dir: 'in', status: 'incoming', name: jobPartyName(j), muted: false };
  callUi(); startRing(); watchCall();
  setTimeout(() => { if (cs && cs.status === 'incoming' && cs.jobId === j.id) cleanupCall('Missed call'); }, 45000);
}
async function answerCall() {
  if (!cs || cs.status !== 'incoming') return;
  const mine = cs; stopRing(); mine.status = 'connecting'; callUi();
  try {
    mine.stream = await micStream();
    const { call: c, ice } = await call(`jobs/${mine.jobId}/call?fresh=1`);
    if (!c || c.status !== 'ringing') throw new Error('The caller hung up.');
    mine.pc = makePeer(ice, mine.stream);
    await mine.pc.setRemoteDescription({ type: 'offer', sdp: c.offer });
    await mine.pc.setLocalDescription(await mine.pc.createAnswer());
    await gathered(mine.pc);
    await call(`jobs/${mine.jobId}/call`, { action: 'answer', sdp: mine.pc.localDescription.sdp });
  } catch (e) { if (cs === mine) { call(`jobs/${mine.jobId}/call`, { action: 'end' }).catch(() => {}); cleanupCall(e.message); } }
}
async function endCall() {
  if (!cs) return;
  const id = cs.jobId;
  cleanupCall();
  try { await call(`jobs/${id}/call`, { action: 'end' }); } catch { /* the other side will see it time out */ }
  pull(true);
}
window.bargoCall = () => (cs ? { status: cs.status, conn: cs.pc?.connectionState || null } : null);

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
        <button class="btn ghost" data-act="auth-start" data-role="driver">Apply as a courier</button>
      </div>
    </div>
    <p class="foot">${help ? help + '<br>' : ''}${meta.adminEnabled ? '<button class="link" data-act="admin-start" style="color:#cfe6e6;font-weight:500">Admin</button>' : ''}</p>
  </div>`;
}

const idSelect = (bind, val) => `<select class="input" data-bind="${bind}"><option value="">Select</option>${ID_TYPES.map((t) => `<option ${val === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
const photoPicker = (kind, photo, existing) => `<div class="photopick">${photo || existing ? `<img class="avatar xl" alt="Your photo" src="${photo || existing}">` : `<span class="avatar xl empty">${ic('user')}</span>`}
  <div><label class="btn line sm inline" for="photo-${kind}" style="width:auto">${photo || existing ? 'Change photo' : 'Take or choose photo'}</label>${photoInput(kind)}
  <p class="small muted" style="margin:.4rem 0 0">A clear photo of your face, no sunglasses.</p></div></div>`;
const appFields = (bind, v) => `<label class="field"><span>Area where you live</span><input class="input" maxlength="80" placeholder="e.g. Rumuokoro, Port Harcourt" data-bind="${bind}.area" value="${esc(v.area ?? '')}"></label>
  <div class="two"><label class="field"><span>ID type</span>${idSelect(bind + '.idType', v.idType)}</label>
  <label class="field"><span>ID number</span><input class="input" maxlength="30" autocapitalize="characters" data-bind="${bind}.idNumber" value="${esc(v.idNumber ?? '')}"></label></div>
  <p class="sub" style="margin:.2rem 0 .4rem">Someone who can vouch for you (guarantor)</p>
  <div class="two"><label class="field"><span>Name</span><input class="input" maxlength="60" data-bind="${bind}.guarantorName" value="${esc(v.guarantorName ?? '')}"></label>
  <label class="field"><span>Phone number</span><input class="input" type="tel" inputmode="tel" maxlength="20" data-bind="${bind}.guarantorPhone" value="${esc(v.guarantorPhone ?? '')}"></label></div>`;

function vAuth() {
  const a = ui.auth, isDriver = a.role === 'driver', reg = a.mode === 'register';
  const veh = a.vehicle || 'bike';
  const step = reg && isDriver ? (a.step || 1) : 0;
  const bar = step ? `<div class="steps">${[1, 2, 3].map((n) => `<i class="${n <= step ? 'on' : ''}"></i>`).join('')}</div>` : '';
  const title = reg ? (isDriver ? ['Apply to be a courier', 'Your vehicle', 'About you'][step - 1] : 'Create your account') : 'Welcome back';
  const pw = `<div class="field"><label for="auth-pw" style="color:var(--muted);font-size:.8rem">Password</label>
        <div class="pw"><input id="auth-pw" class="input" type="${a.show ? 'text' : 'password'}" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="${reg ? 'At least 8 characters' : ''}" data-bind="auth.password" value="${esc(a.password ?? '')}"><button type="button" data-act="toggle-pw">${a.show ? 'Hide' : 'Show'}</button></div></div>`;
  const nameF = `<label class="field"><span>Full name</span><input class="input" maxlength="60" autocomplete="name" data-bind="auth.name" value="${esc(a.name ?? '')}"></label>`;
  const phoneF = `<label class="field"><span>Phone number</span><input class="input" type="tel" inputmode="tel" maxlength="20" autocomplete="username" placeholder="08012345678" data-bind="auth.phone" value="${esc(a.phone ?? '')}"></label>`;
  let body;
  if (!reg) body = phoneF + pw;
  else if (!isDriver) body = nameF + phoneF + pw + `<p class="sub" style="margin:.2rem 0 .4rem">Profile photo (optional)</p>${photoPicker('auth', a.photo)}`;
  else if (step === 1) body = nameF + phoneF + pw;
  else if (step === 2) body = `<p class="sub" style="margin-bottom:.4rem">What do you ride or drive?</p>
        <div class="vehicles">${['bike', 'car', 'van'].map((v) => `<button type="button" class="vehicle" data-act="auth-veh" data-v="${v}" aria-pressed="${veh === v}">${ic(v)}${vlabel(v)}</button>`).join('')}</div>
        <label class="field"><span>Plate number</span><input class="input" maxlength="15" autocapitalize="characters" data-bind="auth.plate" value="${esc(a.plate ?? '')}"></label>`;
  else body = photoPicker('auth', a.photo) + appFields('auth', a) + '<p class="small muted">We use these details only to check you before you can take deliveries. A Bargo admin reviews every application.</p>';
  const cta = a.busy ? 'Please wait...' : !reg ? 'Log in' : !isDriver ? 'Create account' : step < 3 ? 'Next' : 'Submit application';
  return `<div class="top"><button class="icon-btn" data-act="auth-back" aria-label="Back">${ic('back')}</button></div>
    <h2 class="title">${title}</h2>
    <p class="sub" style="margin:.3rem 0 1.1rem">${isDriver ? 'Courier account' : 'Sender account'}</p>
    ${step ? bar : `<div class="seg" role="group" aria-label="Log in or create an account">
      <button type="button" data-act="auth-mode" data-mode="login" aria-pressed="${!reg}">Log in</button>
      <button type="button" data-act="auth-mode" data-mode="register" aria-pressed="${reg}">${isDriver ? 'Apply' : 'Create account'}</button></div>`}
    ${step === 1 || !reg ? '' : ''}${storageWarning()}
    <form data-form="auth" novalidate>
      ${body}
      ${a.error ? `<p class="err" role="alert">${esc(a.error)}</p>` : ''}
      <button class="btn" type="submit" style="margin-top:.8rem" ${a.busy ? 'disabled' : ''}>${cta}</button>
    </form>
    ${!reg && isDriver ? '<p class="help">New here? Tap Apply above. Your application is reviewed before you can take deliveries.</p>' : ''}
    ${!reg && !isDriver ? '<p class="help">Forgot your password? Ask Bargo support to reset it, then change it in Profile.</p>' : ''}
    ${reg && !isDriver ? '<p class="help">Couriers see only your first name until a deal is sealed.</p>' : ''}`;
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
  let h = `<div class="greet"><div><small>Welcome back</small><strong>${esc(me.name)}</strong></div>${avatar(me)}</div>${pushCard(false)}`;
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
      ${placeButton('pickup', 'Pickup', d.pickup)}${d.pickup ? `<label class="field detailf"><span>Pickup details (optional): house number, landmark, gate</span><input class="input" maxlength="120" placeholder="e.g. No. 12, opposite First Bank" data-bind="draft.pickupDetails" value="${esc(d.pickupDetails)}"></label>` : ''}
      ${placeButton('drop', 'Delivery', d.drop)}${d.drop ? `<label class="field detailf"><span>Delivery details (optional): house number, landmark, gate</span><input class="input" maxlength="120" placeholder="e.g. Flat 3, yellow gate" data-bind="draft.dropDetails" value="${esc(d.dropDetails)}"></label>` : ''}
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
    <div class="row">${avatar(d)}<div class="grow"><b>${esc(d.name)}</b><br><small class="muted">${esc(vlabel(d.vehicle))}, ${esc(d.plate)}, ${d.rating.toFixed(1)} stars (${d.ratingCount})</small></div>${ic(d.vehicle)}</div>
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
const jobMap = (j) => `<div class="routebox"><div class="lmap" data-kind="job" data-id="${j.id}" role="img" aria-label="Map from ${esc(j.pickup.label)} to ${esc(j.drop.label)}"></div><p><b>${j.km} km</b> ${j.approxDistance ? '(estimated distance)' : 'by road'}</p>${etaText(j)}</div>`;
const addr = (p) => `${esc(p.label)}${p.address ? `<br><small class="muted">${esc(p.address)}</small>` : ''}${p.details ? `<br><small class="detail">${esc(p.details)}</small>` : ''}`;

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
    h += `<div class="panel"><div class="row">${avatar(d)}<div class="grow"><b>${esc(d.name)}</b><br><small class="muted">${esc(vlabel(d.vehicle))}, ${esc(d.plate)}, ${d.rating.toFixed(1)} stars</small></div>
      ${['agreed', 'picked_up'].includes(j.status) ? `<button class="btn sm" style="width:auto;margin-right:.4rem" data-act="call-start" data-id="${j.id}" aria-label="Call ${esc(d.name)} in the app">${ic('mic')} Call</button>` : ''}
      <a class="btn line sm" style="width:auto;text-decoration:none" href="tel:${esc(d.phone)}" aria-label="Call ${esc(d.name)} by phone">${ic('phone')}</a></div></div>`;
    h += codePanel(j) + chatPanel(j);
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

function appSummary(a) {
  return `<div class="kv"><div><small>Area</small><span>${esc(a.area || '-')}</span></div><div><small>ID</small><span>${esc(a.idType || '-')} ${esc(a.idNumber || '')}</span></div>
    <div><small>Guarantor</small><span>${esc(a.guarantorName || '-')}</span></div><div><small>Guarantor phone</small><span>${esc(a.guarantorPhone || '-')}</span></div></div>`;
}
function vDPending() {
  const d = data.driver, ap = d.approval, a = d.application || {};
  const msg = {
    pending: ['Application under review', 'A Bargo admin is checking your details. We will send you an alert as soon as you are approved. This usually takes a day or less.'],
    rejected: ['Your application needs changes', d.approvalNote || 'Please check your details and apply again.'],
    suspended: ['Your account is suspended', d.approvalNote ? `Reason: ${d.approvalNote}. Contact Bargo support to sort this out.` : 'Contact Bargo support to sort this out.'],
  }[ap] || ['Waiting for approval', ''];
  return `<div class="greet"><div class="row">${avatar(d)}<div><small>Welcome</small><strong>${esc(d.name)}</strong></div></div></div>
    <div class="panel status ${ap}"><b>${msg[0]}</b><p>${esc(msg[1])}</p></div>
    ${pushCard(false)}
    <p class="h3">Your application</p>
    <div class="panel"><div class="row">${avatar(d, 'lg')}<div><b>${esc(d.name)}</b><br><small class="muted">${esc(d.phone)}<br>${esc(vlabel(d.vehicle))}, ${esc(d.plate)}</small></div></div>${appSummary(a)}</div>
    ${ap === 'rejected' ? '<button class="btn" data-act="apply-edit">Update my application</button>' : ''}
    ${ap === 'pending' ? '<button class="btn line" data-act="apply-edit">Edit my details</button>' : ''}`;
}
function vApply() {
  const f = ui.app, top = `<div class="top"><button class="icon-btn" data-act="back" aria-label="Back">${ic('back')}</button><h2 class="title grow">Your application</h2></div>`;
  return `${top}<form data-form="apply">
    ${photoPicker('app', f.photo, data.driver.photoAt ? `/api/photo/${data.driver.id}?v=${data.driver.photoAt}` : '')}
    <p class="sub" style="margin-bottom:.4rem">Vehicle</p>
    <div class="vehicles">${['bike', 'car', 'van'].map((v) => `<button type="button" class="vehicle" data-act="app-veh" data-v="${v}" aria-pressed="${f.vehicle === v}">${ic(v)}${vlabel(v)}</button>`).join('')}</div>
    <label class="field"><span>Plate number</span><input class="input" maxlength="15" autocapitalize="characters" data-bind="app.plate" value="${esc(f.plate ?? '')}"></label>
    ${appFields('app', f)}
    ${f.error ? `<p class="err" role="alert">${esc(f.error)}</p>` : ''}
    <button class="btn" type="submit" ${f.busy ? 'disabled' : ''}>${f.busy ? 'Please wait...' : 'Send application'}</button></form>`;
}

function vDHome() {
  const f = data, d = f.driver, on = d.status === 'online';
  let h = `<div class="greet"><div class="row">${avatar(d)}<div><small>Welcome back</small><strong>${esc(d.name)}</strong></div></div><div class="row"><small class="muted">${on ? 'Online' : 'Offline'}</small>
    <label class="switch" title="${on ? 'Online' : 'Offline'}"><input type="checkbox" data-act="toggle-online" ${on ? 'checked' : ''} aria-label="Online"><i></i></label></div></div>${pushCard(false)}`;
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
    if (['agreed', 'picked_up'].includes(j.status)) h += `<button class="btn" style="margin-bottom:.6rem" data-act="call-start" data-id="${j.id}">${ic('mic')} Call ${esc(j.senderName.split(' ')[0])} in the app</button><a class="btn line" style="text-decoration:none;margin-bottom:.7rem" target="_blank" rel="noopener" href="${mapsLink(j.status === 'agreed' ? j.pickup : j.drop)}">${ic('nav')} Navigate to ${j.status === 'agreed' ? 'pickup' : 'drop-off'}</a>${ui.geoDenied ? '<p class="notice">Turn on location for Bargo so the sender can follow your trip.</p>' : '<p class="small muted" style="margin:-.3rem 0 .7rem">The sender can follow you on the map while this app is open.</p>'}` + chatPanel(j);
    if (j.status === 'agreed') h += `<button class="btn" data-act="d-pickup" data-id="${j.id}">I have picked up the package</button><button class="link" style="margin-top:.7rem" data-act="d-withdraw" data-id="${j.id}">Pull out of this delivery</button>`;
    if (j.status === 'picked_up') h += `<form class="panel" data-form="deliver" data-id="${j.id}"><p class="sub" style="margin-bottom:.5rem">Ask ${esc(j.recipientName)} for the 4-digit delivery code</p>
      <div class="row"><input class="input codein" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="one-time-code" placeholder="0000" aria-label="Delivery code" data-bind="dc.code" value="${esc(ui.dc.code ?? '')}"><button class="btn inline" type="submit" style="width:auto">Complete delivery</button></div></form>`;
    if (j.status !== 'delivered') h += `<p class="sub" style="margin-top:.8rem">${!e.commissionActive ? 'There is no commission right now. You keep the full price.' : e.commissionDueToday ? `Your daily commission of ${money(e.commissionPerDay)} is charged when you complete your first delivery today.` : 'Your commission for today is already paid. This delivery costs you nothing extra.'}</p>`;
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
    <p class="sub" style="margin-top:.8rem">${e.commissionActive ? `Commission: ${money(e.commissionPerDay)} a day, charged once on your first delivery of the day.` : 'No commission right now: you keep the full price.'}</p>`;
  return h;
}

function vDEarn() {
  const e = data.earnings;
  let h = `<h2 class="title" style="margin-bottom:1rem">Earnings</h2>
    <div class="stats"><div class="stat dark"><b>${money(e.net)}</b><small>You keep</small></div><div class="stat"><b>${money(e.gross)}</b><small>Deal value</small></div><div class="stat"><b>${money(e.commission)}</b><small>Commission</small></div></div>
    <p class="notice">${e.commissionActive ? `Commission is a flat ${money(e.commissionPerDay)} per working day, charged on your first delivery of the day. ${e.commissionDueToday ? 'Nothing charged yet today.' : 'Today is already covered.'}` : 'There is no commission right now. You keep the full price of every delivery.'}</p>`;
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
    <div class="row" style="margin-bottom:1rem">${avatar(isD && d ? d : me, 'lg')}<div class="grow"><b>${esc(me.name)}</b><br><small class="muted">${esc(me.phone)}${isD ? `, ${esc(vlabel(me.vehicle))}, ${esc(me.plate)}` : ''}</small><br>
      <label class="link" for="photo-profile" style="cursor:pointer">${(isD && d ? d : me).photoAt ? 'Change photo' : 'Add a photo'}</label>${me.photoAt && !isD ? ' <button class="link" data-act="photo-remove" style="margin-left:.6rem">Remove</button>' : ''}${photoInput('profile')}</div></div>`;
  if (d) h += `<div class="stats"><div class="stat"><b>${d.rating.toFixed(1)}</b><small>Rating</small></div><div class="stat"><b>${d.completed}</b><small>Deliveries</small></div><div class="stat"><b>${data.earnings.commissionActive ? money(data.earnings.commissionPerDay) : 'Free'}</b><small>Daily commission</small></div></div>`;
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

function pendingApps() {
  const list = data.drivers.filter((d) => d.approval === 'pending');
  const rej = data.drivers.filter((d) => d.approval === 'rejected');
  const card = (d) => `<article class="panel app"><div class="row">${avatar(d, 'lg')}<div class="grow"><b>${esc(d.name)}</b><br><small class="muted">${esc(d.phone)}<br>${esc(vlabel(d.vehicle))}, ${esc(d.plate)}</small></div><small class="muted">${fmtDate(d.application.appliedAt)}</small></div>
    ${appSummary(d.application)}
    ${d.approval === 'rejected' ? `<p class="small" style="color:#b3261e">Rejected: ${esc(d.approvalNote)}</p>` : `<div class="btns"><button class="btn sm" data-act="admin-approve" data-id="${esc(d.id)}">Approve</button><button class="btn danger sm" data-act="admin-reject" data-id="${esc(d.id)}" data-name="${esc(d.name)}">Reject</button></div>`}</article>`;
  return `<p class="h3" style="margin-top:0">Courier applications${list.length ? ` <span class="badge">${list.length} waiting</span>` : ''}</p>
    ${list.length ? list.map(card).join('') : '<p class="sub">No applications waiting.</p>'}
    ${rej.length ? `<p class="sub" style="margin-top:.6rem">Waiting for corrections: ${rej.map((d) => esc(d.name)).join(', ')}</p>` : ''}`;
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
    ${pendingApps()}
    <form class="panel" data-form="admin-save"><p class="sub">Daily commission per courier</p>
      <label class="check"><input type="checkbox" data-bind="adm.active" ${(ui.adm.active ?? data.settings.commissionActive) ? 'checked' : ''}> <span>Charge commission${(ui.adm.active ?? data.settings.commissionActive) ? '' : ' (off: couriers keep the full price)'}</span></label>
      <div class="row" style="margin-top:.4rem"><input class="input" inputmode="numeric" data-num="1" data-bind="adm.commission" value="${esc(ui.adm.commission ?? data.settings.commissionPerDay)}" style="max-width:180px" aria-label="Daily commission in naira"><button class="btn sm inline" type="submit">Save</button></div>
      <p class="sub" style="margin-top:.5rem">When on, charged once per courier on their first delivery of each day. Changes apply to later days. Past charges stay as they were. The amount is kept while commission is off.</p></form>
    <form class="panel" data-form="admin-prices"><p class="sub">Delivery prices (suggested to senders)</p>
      <div class="tbl-wrap"><table class="tbl"><tr><th>Vehicle</th><th>Starting price</th><th>Per km</th></tr>
      ${['bike', 'car', 'van'].map((v) => `<tr><td><b>${vlabel(v)}</b></td><td><input class="input" inputmode="numeric" data-num="1" data-bind="adm.${v}_base" value="${esc(ui.adm[v + '_base'] ?? data.pricing[v].base)}" aria-label="${vlabel(v)} starting price"></td><td><input class="input" inputmode="numeric" data-num="1" data-bind="adm.${v}_km" value="${esc(ui.adm[v + '_km'] ?? data.pricing[v].perKm)}" aria-label="${vlabel(v)} price per km"></td></tr>`).join('')}</table></div>
      <button class="btn sm inline" type="submit" style="margin-top:.5rem">Save prices</button>
      <p class="sub" style="margin-top:.5rem">Senders still choose their own price and couriers can counter. These only set the suggested starting price: starting price plus the rate per km of road distance.</p></form>
    <div class="cols"><div><p class="h3">Couriers</p><div class="tbl-wrap"><table class="tbl"><tr><th>Courier</th><th>Status</th><th>Trips</th><th></th></tr>
      ${data.drivers.filter((d) => d.approval !== 'pending').map((d) => `<tr><td><div class="row">${avatar(d)}<div><b>${esc(d.name)}</b><br><small class="muted">${esc(d.phone)}, ${esc(vlabel(d.vehicle))}, ${esc(d.plate)}</small></div></div></td><td>${esc(d.approval === 'approved' ? d.status : d.approval)}</td><td>${d.completed}</td><td>${d.approval === 'approved' ? `<button class="btn line sm inline" data-act="admin-suspend" data-id="${esc(d.id)}" data-name="${esc(d.name)}">Suspend</button>` : d.approval === 'suspended' ? `<button class="btn line sm inline" data-act="admin-reinstate" data-id="${esc(d.id)}">Reinstate</button>` : ''} ${reset(d)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No couriers yet.</td></tr>'}</table></div></div>
    <div><p class="h3">Senders</p><div class="tbl-wrap"><table class="tbl"><tr><th>Sender</th><th>Deliveries</th><th></th></tr>
      ${data.senders.map((u) => `<tr><td><div class="row">${avatar(u)}<div><b>${esc(u.name)}</b><br><small class="muted">${esc(u.phone)}</small></div></div></td><td>${u.jobs}</td><td>${reset(u)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No senders yet.</td></tr>'}</table></div></div></div>
    <p class="h3">Recent deliveries</p><div class="tbl-wrap"><table class="tbl"><tr><th>#</th><th>Route</th><th>Distance</th><th>Price</th><th>Status</th></tr>
      ${data.jobs.slice(0, 15).map((j) => `<tr><td>${j.id}</td><td>${esc(j.pickup.label)} to ${esc(j.drop.label)}</td><td>${j.km} km</td><td>${money(j.agreedPrice || j.openingPrice)}</td><td>${STATUS[j.status]}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No deliveries yet.</td></tr>'}</table></div>
    <p class="h3">Commission ledger</p><div class="tbl-wrap"><table class="tbl"><tr><th>Date</th><th>Courier</th><th>Amount</th></tr>
      ${data.ledger.map((l) => `<tr><td>${dayLabel(l.date)}</td><td>${esc(data.drivers.find((d) => d.id === l.driverId)?.name || l.driverId)}</td><td>${money(l.amount)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing collected yet.</td></tr>'}</table></div></div>`;
}

// ---------- Rendering ----------
const TABS = {
  sender: [['home', 'Home', 'home'], ['jobs', 'Deliveries', 'list'], ['alerts', 'Alerts', 'bell'], ['profile', 'Profile', 'user']],
  driver: [['home', 'Home', 'home'], ['earnings', 'Earnings', 'wallet'], ['bookings', 'Bookings', 'list'], ['alerts', 'Alerts', 'bell'], ['profile', 'Profile', 'user']],
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
    const f = { home: vSHome, jobs: vSJobs, job: vSJob, alerts: vAlerts, profile: vProfile }[n] || vSHome;
    return { html: f(), tabs: true };
  }
  if (!data) return { html: '<p class="empty">Loading...</p>', tabs: true };
  if (data.driver.approval && data.driver.approval !== 'approved') {
    if (n === 'apply' && ui.app) return { html: vApply(), tabs: false };
    if (!['alerts', 'profile'].includes(n)) return { html: vDPending(), tabs: true };
  }
  const f = { home: vDHome, job: vDJob, earnings: vDEarn, bookings: vDBook, alerts: vAlerts, profile: vProfile }[n] || vDHome;
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
    const cur = ['job', 'apply'].includes(nav.cur.name) ? (me.role === 'sender' ? 'jobs' : 'home') : nav.cur.name;
    const unread = data?.notes?.unread || 0;
    tabs.innerHTML = TABS[me.role].map(([id, label, icon]) => `<button data-act="tab" data-tab="${id}" ${cur === id ? 'aria-current="page"' : ''}>${ic(icon)}${id === 'alerts' && unread ? `<i class="tb" aria-label="${unread} unread">${unread > 9 ? '9+' : unread}</i>` : ''}${label}</button>`).join('');
  }
  scr.scrollTop = reset ? 0 : top;
  mountMaps();
  const msgs = $('#msgs'); if (msgs) msgs.scrollTop = msgs.scrollHeight;
  if (bind && !reset) {
    const el = scr.querySelector(`[data-bind="${CSS.escape(bind)}"]`);
    if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* not a text input */ } }
  }
}

// ---------- Data loading ----------
function signedOut(msg) {
  if (cs) cleanupCall();
  me = null; data = null; dsig = ''; lastNoteId = null; syncTracking(); try { navigator.clearAppBadge && navigator.clearAppBadge(); } catch { /* ignore */ } closeSheet();
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
    handleNotes(next.notes);
    const s = JSON.stringify(next);
    if (s !== dsig) { data = next; dsig = s; render(); }
    syncTracking();
    checkIncoming();
    if (pendingJob && me.role !== 'admin') { const id = pendingJob; pendingJob = null; if (findJob(id)) go('job', { id }); }
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
  me = user; data = null; dsig = ''; lastNoteId = null; ui.auth = null; ui.admin = null;
  nav = { stack: [], cur: { name: 'home' } };
  render(true);
  await pull(true);
  if (user.role !== 'admin') syncPush();
}

// ---------- Actions ----------
const ACT = {
  'auth-start': ({ role }) => { ui.auth = { role, mode: 'login', step: 1, phone: ls.get('phone'), password: '', name: '', vehicle: 'bike', plate: '', photo: '', area: '', idType: '', idNumber: '', guarantorName: '', guarantorPhone: '', show: false, error: '', busy: false }; render(true); },
  'auth-back': () => { const a = ui.auth; if (a.mode === 'register' && a.role === 'driver' && (a.step || 1) > 1) { a.step -= 1; a.error = ''; render(true); } else if (a.mode === 'register' && a.role === 'driver') { a.mode = 'login'; a.error = ''; render(true); } else { ui.auth = null; render(true); } },
  'auth-mode': ({ mode }) => { ui.auth.mode = mode; ui.auth.step = 1; ui.auth.error = ''; render(true); },
  'auth-veh': ({ v }) => { ui.auth.vehicle = v; render(); },
  'toggle-pw': () => { ui.auth.show = !ui.auth.show; render(); },
  'admin-start': () => { ui.admin = { pin: '', error: '' }; render(true); },
  'admin-back': () => { ui.admin = null; render(true); },
  logout: async () => { if (me && me.role !== 'admin') await dropPush(); try { await call('auth/logout', {}); } catch { /* signing out locally anyway */ } signedOut(); },
  tab: ({ tab: t }) => { tab(t); if (t === 'alerts' && data?.notes?.unread) setTimeout(() => nav.cur.name === 'alerts' && markRead(), 1500); },
  'apply-edit': () => { const d = data.driver, a = d.application || {}; ui.app = { vehicle: d.vehicle, plate: d.plate, area: a.area, idType: a.idType, idNumber: a.idNumber, guarantorName: a.guarantorName, guarantorPhone: a.guarantorPhone, photo: '', error: '', busy: false }; go('apply'); },
  'app-veh': ({ v }) => { ui.app.vehicle = v; render(); },
  'photo-remove': () => run(async () => { const r = await call('me/photo/remove', {}); me = r.user; }, 'Photo removed.'),
  'admin-approve': ({ id }) => run(() => call(`admin/users/${id}/approval`, { action: 'approve' }), 'Courier approved.'),
  'admin-reject': ({ id, name }) => { const reason = prompt(`Why is ${name}'s application being rejected? They will see this, so say what to fix.`); if (reason && reason.trim().length >= 3) run(() => call(`admin/users/${id}/approval`, { action: 'reject', reason: reason.trim() }), 'Application sent back.'); },
  'admin-suspend': ({ id, name }) => { const reason = prompt(`Why is ${name} being suspended? They will see this.`); if (reason && reason.trim().length >= 3) run(() => call(`admin/users/${id}/approval`, { action: 'suspend', reason: reason.trim() }), 'Courier suspended.'); },
  'admin-reinstate': ({ id }) => run(() => call(`admin/users/${id}/approval`, { action: 'reinstate' }), 'Courier reinstated.'),
  'mark-read': () => markRead(),
  'open-note': ({ id, job }) => { markRead([Number(id)]); if (job) go('job', { id: job }); },
  'push-on': async () => { try { await enablePush(); toast('Phone alerts are on.'); } catch (e) { toast(e.message, true); } render(); },
  'push-dismiss': () => { ls.set('bargo_push_dismiss', '1'); render(); },
  'call-start': ({ id }) => startCall(id),
  'call-answer': () => answerCall(),
  'call-decline': () => endCall(),
  'call-hangup': () => endCall(),
  'call-close': () => cleanupCall(),
  'call-mute': () => { if (!cs?.stream) return; cs.muted = !cs.muted; cs.stream.getAudioTracks().forEach((t) => { t.enabled = !cs.muted; }); callUi(); },
  'chat-quick': ({ id, text }) => sendChat(id, text),
  back: () => back(),
  'open-job': ({ id }) => go('job', { id }),
  'start-new': ({ type }) => { ui.draft = defaultDraft(type); ui.step = 1; ui.error = ''; ui.est = null; ui.route = null; go('new'); },
  veh: ({ v }) => { ui.draft.vehicle = v; render(); updateEstimate(); },
  'open-sheet': ({ kind }) => openSheet(kind),
  'sheet-close': () => closeSheet(),
  'sheet-search': () => { ui.sh.mode = 'search'; drawSheet(); },
  'sheet-map': () => { ui.sh.mode = 'map'; ui.sh.typed = ''; drawSheet(); },
  'sheet-typed': () => { const sh = ui.sh; sh.typed = (sh.q || '').trim().slice(0, 160); sh.mode = 'map'; if (sh.results[0]) sh.start = sh.results[0]; drawSheet(); },
  'sheet-gps': () => useGps(),
  'sheet-area': ({ name }) => { ui.sh.q = name; ui.sh.msg = 'Searching...'; ui.sh.results = []; $('#sheet input').value = name; renderResults(); runSearch(name, `${name}, Port Harcourt`); },
  'sheet-recent': ({ i }) => { const r = recents()[Number(i)]; if (r && inService(r.lat, r.lng)) setPoint(ui.sh.kind, r); },
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
      pickup: { ...d.pickup, details: d.pickupDetails }, drop: { ...d.drop, details: d.dropDetails }, routeKm: r?.status === 'ok' ? r.km : undefined, routeGeo: r?.status === 'ok' ? r.geo : undefined,
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
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset?.act === 'toggle-online') return ACT['toggle-online'](t.dataset, t);
  if (t.dataset?.photo && t.files && t.files[0]) {
    const kind = t.dataset.photo;
    try {
      const url = await readPhoto(t.files[0]);
      if (kind === 'auth') { ui.auth.photo = url; ui.auth.error = ''; render(); }
      else if (kind === 'app') { ui.app.photo = url; ui.app.error = ''; render(); }
      else { const r = await call('me/photo', { photo: url }); me = r.user; dsig = ''; toast('Photo saved.'); await pull(true); render(); }
    } catch (err) { toast(err.message, true); }
    t.value = '';
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[role="link"][data-act]')) { e.preventDefault(); e.target.click(); }
  if (e.key === 'Escape' && ui.sh) closeSheet();
});
document.addEventListener('input', (e) => {
  const t = e.target, path = t.dataset?.bind;
  if (!path) return;
  if (t.type === 'radio' && !t.checked) return;
  if (t.type === 'checkbox') { setPath(path, t.checked); render(); return; }
  setPath(path, t.dataset.num ? Number(String(t.value).replace(/\D/g, '')) : t.value);
  if (path === 'draft.price') ui.draft.priceTouched = true;
  if (t.dataset.search) scheduleSearch();
});

function sendChat(id, text) {
  text = String(text || '').trim();
  if (!text) return;
  delete ui.chat['t' + id];
  run(() => call(`jobs/${id}/messages`, { text }));
}

function authError(a) {
  const reg = a.mode === 'register', isD = a.role === 'driver', step = reg && isD ? (a.step || 1) : 0;
  const okPhone = /^[+\d][\d\s()-]{7,18}$/.test((a.phone || '').trim());
  if (!reg) return !okPhone ? 'Enter your phone number.' : !a.password ? 'Enter your password.' : '';
  if (!step || step === 1) {
    if ((a.name || '').trim().length < 2) return 'Enter your full name.';
    if (!okPhone) return 'Enter a valid phone number, like 08012345678.';
    if (!a.password || a.password.length < 8) return 'Password must be at least 8 characters.';
  }
  if (step === 2 && (a.plate || '').trim().length < 3) return 'Enter your vehicle plate number.';
  if (step === 3) {
    if (!a.photo) return 'Add a clear photo of yourself.';
    if ((a.area || '').trim().length < 3) return 'Enter the area where you live.';
    if (!a.idType) return 'Choose the type of ID you will use.';
    if (!/^[A-Za-z0-9][A-Za-z0-9 -]{4,29}$/.test((a.idNumber || '').trim())) return 'Enter your ID number.';
    if ((a.guarantorName || '').trim().length < 2) return "Enter your guarantor's name.";
    if (!/^[+\d][\d\s()-]{7,18}$/.test((a.guarantorPhone || '').trim())) return "Enter your guarantor's phone number.";
  }
  return '';
}
async function submitAuth() {
  const a = ui.auth, reg = a.mode === 'register', isD = a.role === 'driver';
  a.error = authError(a);
  if (a.error) return render();
  if (reg && isD && (a.step || 1) < 3) { a.step = (a.step || 1) + 1; return render(true); }
  a.busy = true; render();
  try {
    const body = { role: a.role, phone: a.phone, password: a.password };
    if (reg) { body.name = a.name; if (a.photo) body.photo = a.photo; }
    if (reg && isD) Object.assign(body, { vehicle: a.vehicle || 'bike', plate: a.plate, area: a.area, idType: a.idType, idNumber: a.idNumber, guarantorName: a.guarantorName, guarantorPhone: a.guarantorPhone });
    const r = await call(reg ? 'auth/register' : 'auth/login', body);
    ls.set('phone', a.phone);
    await startSession(r.user);
    if (reg && isD) toast('Application sent. We will alert you when it is reviewed.');
  } catch (e) { a.busy = false; a.error = e.message; if (!reg) a.password = ''; if (reg && isD && /photo|ID|guarantor|area|plate|vehicle/i.test(e.message)) a.step = /plate|vehicle/i.test(e.message) ? 2 : 3; render(); }
}

document.addEventListener('submit', (e) => {
  const f = e.target.dataset?.form;
  if (!f) return;
  e.preventDefault();
  if (f === 'auth') submitAuth();
  else if (f === 'apply') {
    (async () => {
      const a = ui.app; a.error = ''; a.busy = true; render();
      try {
        const body = { vehicle: a.vehicle, plate: a.plate, area: a.area, idType: a.idType, idNumber: a.idNumber, guarantorName: a.guarantorName, guarantorPhone: a.guarantorPhone };
        if (a.photo) body.photo = a.photo;
        await call('driver/application', body);
        ui.app = null; toast('Application sent. We will alert you when it is reviewed.'); tab('home'); dsig = ''; await pull(true);
      } catch (err) { a.busy = false; a.error = err.message; render(); }
    })();
  }
  else if (f === 'chat') sendChat(e.target.dataset.id, ui.chat['t' + e.target.dataset.id]);
  else if (f === 'deliver') run(async () => { await call(`jobs/${e.target.dataset.id}/driver/deliver`, { code: ui.dc.code || '' }); ui.dc = {}; }, 'Delivery complete.');
  else if (f === 'admin-login') {
    (async () => {
      try { const r = await call('auth/admin', { pin: ui.admin.pin }); await startSession(r.user); }
      catch (err) { ui.admin.error = err.message; ui.admin.pin = ''; render(); }
    })();
  } else if (f === 'admin-save') run(async () => { await call('admin/settings', { commissionPerDay: ui.adm.commission ?? data.settings.commissionPerDay, commissionActive: ui.adm.active ?? data.settings.commissionActive }); ui.adm = {}; }, 'Commission settings saved.');
  else if (f === 'admin-prices') run(async () => {
    const pricing = {};
    for (const v of ['bike', 'car', 'van']) pricing[v] = { base: ui.adm[v + '_base'] ?? data.pricing[v].base, perKm: ui.adm[v + '_km'] ?? data.pricing[v].perKm };
    await call('admin/settings', { pricing }); ui.adm = {}; meta = await call('meta');
  }, 'Prices saved.');
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
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  navigator.serviceWorker.addEventListener('message', (e) => { // tapping a phone alert opens its delivery
    if (e.data?.type === 'open-job' && e.data.jobId && me && me.role !== 'admin') { if (findJob(e.data.jobId)) go('job', { id: e.data.jobId }); else { pendingJob = e.data.jobId; pull(true); } }
  });
}

// ---------- Start ----------
(async function init() {
  try { meta = await call('meta'); } catch {
    $('#screen').innerHTML = '<p class="empty">Cannot reach the server. Check your connection and reload.</p>';
    return;
  }
  try { me = (await call('me')).user; } catch { me = null; }
  render(true);
  refreshPushState().then(() => render());
  if (me) { pull(true); if (me.role !== 'admin') syncPush(); }
  let tick = 0;
  setInterval(() => { // quicker while a delivery or call is live, relaxed otherwise
    if (document.hidden) return;
    const live = cs || data?.current?.length || (data?.jobs || []).some((j) => ['agreed', 'picked_up'].includes(j.status));
    if (live || tick++ % 2 === 0) pull();
  }, 2500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(true); });
})();
