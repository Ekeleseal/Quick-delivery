'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (n) => '₦' + Math.round(n).toLocaleString('en-NG');
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const ACTIVE = ['assigned', 'accepted', 'arrived', 'in_progress'];
const OPEN = ['requested', ...ACTIVE];
const LABEL = {
  requested: 'Finding a driver', assigned: 'Driver assigned', accepted: 'Driver is on the way',
  arrived: 'Driver has arrived', in_progress: 'On trip', completed: 'Trip completed', cancelled: 'Cancelled',
};
const KM_PER_UNIT = 0.35;
const ROADS = [['station', 'market'], ['station', 'hospital'], ['station', 'hotel'], ['station', 'stadium'], ['hotel', 'mall'],
  ['hotel', 'harbor'], ['market', 'park'], ['market', 'univ'], ['hospital', 'airport'], ['stadium', 'univ'], ['harbor', 'park'], ['stadium', 'hospital']];

let S = null;
let sig = '';
let role = store.get('role', 'rider');

// ---------- API ----------
async function call(path, body) {
  const res = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}
let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}
async function refresh(force) {
  S = await call('state');
  render(force);
}
async function act(fn) {
  try { await fn(); await refresh(true); } catch (e) { toast(e.message, true); }
}

// ---------- Helpers ----------
const busy = (d) => S.rides.some((r) => r.driverId === d.id && ACTIVE.includes(r.status));
const kmBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * KM_PER_UNIT;
const driverById = (id) => S.drivers.find((d) => d.id === id);
const driverState = (d) => (d.status !== 'online' ? 'off' : busy(d) ? 'busy' : 'free');
const myRide = () => { const id = Number(store.get('myRide', 0)); return S.rides.find((r) => r.id === id) || null; };
const meDriver = () => driverById(store.get('driver', '')) || null;
const route = (r) => `${esc(r.pickup.name)} to ${esc(r.dropoff.name)}`;

// ---------- Render ----------
function render(force) {
  const s = JSON.stringify([S.drivers, S.rides, S.settings]);
  if (!force && s === sig) return;
  sig = s;
  const keep = $$('select[data-pick]').map((el) => [el.dataset.pick, el.value]);
  renderHeader();
  renderMap();
  renderRider();
  renderDriver();
  renderDispatch();
  keep.forEach(([id, v]) => { const el = $(`select[data-pick="${id}"]`); if (el) el.value = v; });
}

function renderHeader() {
  const free = S.drivers.filter((d) => driverState(d) === 'free').length;
  const waiting = S.rides.filter((r) => r.status === 'requested').length;
  $('#hdr-stats').textContent = `${free} free ${free === 1 ? 'driver' : 'drivers'}, ${waiting} waiting for a driver`;
}

function renderMap() {
  const P = Object.fromEntries(S.places.map((p) => [p.id, p]));
  const me = meDriver();
  const mine = myRide();
  let h = '<path d="M-2 38 C 18 28, 32 58, 52 42 S 82 52, 102 40" fill="none" stroke="var(--water)" stroke-width="7" stroke-linecap="round"/>';
  ROADS.forEach(([a, b]) => {
    h += `<line class="road-edge" x1="${P[a].x}" y1="${P[a].y}" x2="${P[b].x}" y2="${P[b].y}" stroke-width="1.9"/>`;
    h += `<line class="road" x1="${P[a].x}" y1="${P[a].y}" x2="${P[b].x}" y2="${P[b].y}" stroke-width="1.2"/>`;
  });
  S.places.forEach((p) => {
    const left = p.x > 75;
    h += `<circle class="place-dot" cx="${p.x}" cy="${p.y}" r="1"/>`;
    h += `<text class="place-name" x="${p.x + (left ? -2 : 2)}" y="${p.y + 0.8}" text-anchor="${left ? 'end' : 'start'}">${esc(p.name)}</text>`;
  });
  S.rides.filter((r) => OPEN.includes(r.status)).forEach((r) => {
    const hi = (mine && mine.id === r.id) || (me && r.driverId === me.id);
    h += `<line class="route${hi ? ' hi' : ''}" x1="${r.pickup.x}" y1="${r.pickup.y}" x2="${r.dropoff.x}" y2="${r.dropoff.y}"/>`;
    if (['assigned', 'accepted'].includes(r.status) && r.driverId) {
      const d = driverById(r.driverId);
      if (d) h += `<line class="approach" x1="${d.x}" y1="${d.y}" x2="${r.pickup.x}" y2="${r.pickup.y}"/>`;
    }
    h += `<circle class="pin" cx="${r.pickup.x}" cy="${r.pickup.y}" r="1.5"><title>Pickup for ${esc(r.riderName)}</title></circle>`;
    h += `<rect class="drop" x="${r.dropoff.x - 1.3}" y="${r.dropoff.y - 1.3}" width="2.6" height="2.6"><title>Drop-off for ${esc(r.riderName)}</title></rect>`;
  });
  S.drivers.forEach((d) => {
    const st = driverState(d);
    if (me && me.id === d.id) h += `<circle class="car-ring" cx="${d.x}" cy="${d.y}" r="3.4"/>`;
    h += `<circle class="car ${st}" cx="${d.x}" cy="${d.y}" r="2.1"><title>${esc(d.name)}, ${esc(d.vehicle)}</title></circle>`;
    h += `<text class="car-label" x="${d.x}" y="${d.y + 0.7}">${esc(d.name[0])}</text>`;
  });
  $('#map').innerHTML = h;
}

function renderRider() {
  const r = myRide();
  const live = $('#r-live');
  const active = r && OPEN.includes(r.status);
  $('#r-form').hidden = !!active;
  if (!r) { live.innerHTML = ''; return; }
  const d = r.driverId ? driverById(r.driverId) : null;
  let h = `<article class="ride st-${r.status}"><h4>${LABEL[r.status]}</h4>`;
  h += `<p>${route(r)}</p><p class="fare">${naira(r.finalFare || r.estimate.fare)}</p>`;
  if (['assigned', 'accepted'].includes(r.status) && r.etaMin) h += `<p class="muted">Driver arrives in about ${r.etaMin} min.</p>`;
  if (d && r.status !== 'cancelled') {
    h += `<p><strong>${esc(d.name)}</strong> in a ${esc(d.vehicle)}, plate ${esc(d.plate)}. Rating ${d.rating.toFixed(1)}.</p>`;
  }
  if (r.status === 'requested') h += '<p class="muted">We will assign the nearest free driver as soon as one is available.</p>';
  h += '<div class="actions">';
  if (['requested', 'assigned', 'accepted'].includes(r.status)) h += `<button class="danger small" data-do="cancel" data-id="${r.id}">Cancel ride</button>`;
  if (r.status === 'completed' && !r.rating) {
    h += '<span>Rate your driver:</span><span class="stars">' + [1, 2, 3, 4, 5].map((n) => `<button data-do="rate" data-id="${r.id}" data-n="${n}" aria-label="${n} stars">${n}★</button>`).join('') + '</span>';
  }
  if (r.status === 'completed' && r.rating) h += `<span class="muted">You rated this trip ${r.rating} of 5.</span>`;
  if (!OPEN.includes(r.status)) h += '<button class="primary small" data-do="newride">Book another ride</button>';
  h += '</div></article>';
  live.innerHTML = h;
}

function renderDriver() {
  const sel = $('#d-select');
  const optSig = S.drivers.map((d) => d.id + d.name).join('|');
  if (sel.dataset.sig !== optSig) {
    sel.innerHTML = '<option value="">Choose your profile</option>' + S.drivers.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
    sel.dataset.sig = optSig;
  }
  sel.value = store.get('driver', '');
  const me = meDriver();
  const box = $('#d-live');
  $('#maphint').hidden = !(role === 'driver' && me);
  if (!me) { box.innerHTML = '<p class="empty">Choose your profile to see ride requests, or register a new driver below.</p>'; return; }
  const job = S.rides.find((r) => r.driverId === me.id && ACTIVE.includes(r.status));
  const earned = S.rides.filter((r) => r.driverId === me.id && r.status === 'completed').reduce((s, r) => s + (r.finalFare || 0), 0);
  const online = me.status === 'online';
  let h = `<div class="stats"><div><b>${me.completed}</b><span>Trips completed</span></div><div><b>${naira(earned)}</b><span>Recent earnings</span></div><div><b>${me.rating.toFixed(1)}</b><span>Rating</span></div></div>`;
  h += `<div class="actions"><button class="${online ? 'ghost' : 'primary'}" data-do="toggle" data-id="${esc(me.id)}" data-status="${online ? 'offline' : 'online'}">${online ? 'Go offline' : 'Go online'}</button></div><h3>Current job</h3>`;
  if (!job) {
    h += `<p class="empty">${online ? 'Waiting for a ride request. Tap the map to update your location.' : 'You are offline. Go online to receive ride requests.'}</p>`;
  } else {
    const next = { assigned: ['accept', 'Accept ride'], accepted: ['arrive', 'I have arrived'], arrived: ['start', 'Start trip'], in_progress: ['complete', 'Complete trip'] }[job.status];
    h += `<article class="ride st-${job.status}"><h4>${LABEL[job.status]}</h4><p>${route(job)}</p>`;
    h += `<p>Rider: <strong>${esc(job.riderName)}</strong>${job.riderPhone ? ', ' + esc(job.riderPhone) : ''}</p>`;
    h += `<p class="fare">${naira(job.estimate.fare)} <span class="muted">(${job.estimate.km} km)</span></p><div class="actions">`;
    h += `<button class="primary" data-do="${next[0]}" data-id="${job.id}" data-driver="${esc(me.id)}">${next[1]}</button>`;
    if (job.status === 'assigned') h += `<button class="ghost" data-do="decline" data-id="${job.id}" data-driver="${esc(me.id)}">Decline</button>`;
    h += '</div></article>';
  }
  box.innerHTML = h;
}

function renderDispatch() {
  const open = S.rides.filter((r) => OPEN.includes(r.status));
  const free = S.drivers.filter((d) => driverState(d) === 'free').length;
  $('#x-stats').innerHTML = `<div><b>${open.filter((r) => r.status === 'requested').length}</b><span>Waiting</span></div><div><b>${open.filter((r) => r.status !== 'requested').length}</b><span>Active rides</span></div><div><b>${free}</b><span>Free drivers</span></div>`;
  $('#x-auto').checked = S.settings.autoDispatch;

  $('#x-queue').innerHTML = open.length ? open.map((r) => {
    const d = r.driverId ? driverById(r.driverId) : null;
    let h = `<article class="ride st-${r.status}"><h4>#${r.id} ${esc(r.riderName)}: ${LABEL[r.status]}</h4><p>${route(r)}</p>`;
    h += `<p class="fare">${naira(r.estimate.fare)} <span class="muted">${r.estimate.km} km</span></p>`;
    if (d) h += `<p>Driver: <strong>${esc(d.name)}</strong>, ${esc(d.vehicle)}</p>`;
    h += '<div class="actions">';
    if (['requested', 'assigned'].includes(r.status)) {
      const opts = S.drivers.filter((x) => x.status === 'online' && (!busy(x) || x.id === r.driverId))
        .map((x) => ({ x, km: kmBetween(x, r.pickup) })).sort((a, b) => a.km - b.km)
        .map(({ x, km }) => `<option value="${esc(x.id)}">${esc(x.name)}, ${km.toFixed(1)} km away</option>`).join('');
      if (opts) h += `<select data-pick="${r.id}" aria-label="Driver for ride ${r.id}">${opts}</select><button class="primary small" data-do="assign" data-id="${r.id}">${d ? 'Reassign' : 'Assign'}</button><button class="ghost small" data-do="autoassign" data-id="${r.id}">Nearest</button>`;
      else h += '<span class="muted">No free drivers right now.</span>';
    }
    if (['requested', 'assigned', 'accepted'].includes(r.status)) h += `<button class="danger small" data-do="cancel" data-id="${r.id}">Cancel</button>`;
    return h + '</div></article>';
  }).join('') : '<p class="empty">No open rides. New requests appear here.</p>';

  $('#x-drivers').innerHTML = S.drivers.map((d) => {
    const st = driverState(d);
    const label = { free: 'Free', busy: 'On a ride', off: 'Offline' }[st];
    return `<div class="drow"><span><strong>${esc(d.name)}</strong> <span class="muted">${esc(d.vehicle)}, ${esc(d.plate)}, rated ${d.rating.toFixed(1)}</span></span><span class="chip ${st}">${label}</span></div>`;
  }).join('');

  const recent = S.rides.filter((r) => !OPEN.includes(r.status)).slice(-6).reverse();
  $('#x-recent').innerHTML = recent.length ? recent.map((r) => `<div class="drow"><span>#${r.id} ${esc(r.riderName)}: ${route(r)}</span><span class="chip">${LABEL[r.status]}</span></div>`).join('') : '<p class="empty">Finished rides appear here.</p>';
}

// ---------- Events ----------
function setRole(r) {
  role = r;
  store.set('role', r);
  $$('.roles button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.role === r)));
  ['rider', 'driver', 'dispatch'].forEach((v) => { $('#view-' + v).hidden = v !== r; });
  if (S) render(true);
}

async function updateEstimate() {
  const a = $('#r-pickup').value, b = $('#r-drop').value, el = $('#r-est');
  if (a === b) { el.textContent = 'Choose two different places.'; return; }
  try {
    const e = await call('estimate', { pickupId: a, dropoffId: b });
    el.innerHTML = `<strong>${naira(e.fare)}</strong><span>${e.km} km, about ${e.minutes} min</span>`;
  } catch (err) { el.textContent = err.message; }
}

function bind() {
  $$('.roles button').forEach((b) => b.addEventListener('click', () => setRole(b.dataset.role)));

  const opts = S.places.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('#r-pickup').innerHTML = opts;
  $('#r-drop').innerHTML = opts;
  $('#r-pickup').value = 'station';
  $('#r-drop').value = 'airport';
  $('#r-name').value = store.get('riderName', '');
  $('#r-phone').value = store.get('riderPhone', '');
  $('#r-pickup').addEventListener('change', updateEstimate);
  $('#r-drop').addEventListener('change', updateEstimate);
  updateEstimate();

  $('#r-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act(async () => {
      const ride = await call('rides', {
        riderName: $('#r-name').value, riderPhone: $('#r-phone').value,
        pickupId: $('#r-pickup').value, dropoffId: $('#r-drop').value,
      });
      store.set('myRide', ride.id);
      store.set('riderName', $('#r-name').value);
      store.set('riderPhone', $('#r-phone').value);
    });
  });

  $('#d-select').addEventListener('change', (e) => { store.set('driver', e.target.value); render(true); });
  $('#d-form').addEventListener('submit', (e) => {
    e.preventDefault();
    act(async () => {
      const d = await call('drivers', { name: $('#d-name').value, vehicle: $('#d-vehicle').value, plate: $('#d-plate').value });
      store.set('driver', d.id);
      e.target.reset();
      toast('Driver registered. Go online to receive rides.');
    });
  });

  $('#x-auto').addEventListener('change', (e) => act(() => call('settings', { autoDispatch: e.target.checked })));

  $('#map').addEventListener('click', (e) => {
    const me = meDriver();
    if (role !== 'driver' || !me) return;
    const svg = $('#map');
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const c = (v) => Math.min(100, Math.max(0, v));
    act(() => call(`drivers/${me.id}/location`, { x: c(p.x), y: c(p.y) }));
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-do]');
    if (!b) return;
    const { id, driver, n, status } = b.dataset;
    switch (b.dataset.do) {
      case 'cancel': return act(() => call(`rides/${id}/cancel`, {}));
      case 'rate': return act(() => call(`rides/${id}/rate`, { rating: Number(n) }));
      case 'newride': store.set('myRide', 0); return render(true);
      case 'toggle': return act(() => call(`drivers/${id}/status`, { status }));
      case 'accept': case 'arrive': case 'start': case 'complete':
        return act(() => call(`rides/${id}/advance`, { driverId: driver }));
      case 'decline': return act(() => call(`rides/${id}/decline`, { driverId: driver }));
      case 'assign': return act(() => call(`rides/${id}/assign`, { driverId: $(`select[data-pick="${id}"]`).value }));
      case 'autoassign': return act(() => call(`rides/${id}/auto-assign`, {}));
    }
  });
}

(async function init() {
  try {
    S = await call('state');
    bind();
    setRole(['rider', 'driver', 'dispatch'].includes(role) ? role : 'rider');
    render(true);
    setInterval(() => refresh().catch(() => { $('#hdr-stats').textContent = 'Connection lost. Retrying...'; }), 2000);
  } catch (e) {
    toast('Cannot reach the server: ' + e.message, true);
  }
})();
