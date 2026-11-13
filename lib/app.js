// Bargo server logic: accounts, deliveries, price negotiation, daily commission.
// Framework-free. `createApp(store, config).handle(req, res)` works in a plain Node server and in a Vercel function.
'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const { mutate, newDb, selfTest } = require('./storage');
const push = require('./push');

const scrypt = promisify(crypto.scrypt);
const TZ = 'Africa/Lagos'; // Port Harcourt is on the same clock (WAT)
const SESSION_COOKIE = 'bargo_session';
const SESSION_DAYS = 30;

// ---------- Reference data ----------
// Port Harcourt service area (south/north latitude, west/east longitude). Widen it to open new areas.
const BOUNDS = { south: 4.6, north: 5.15, west: 6.8, east: 7.35 };
const CENTER = { lat: 4.8156, lng: 7.0498 };
const AREAS = [
  'Old GRA', 'GRA Phase 2', 'Rumuola', 'Rumuokoro', 'Rumuigbo', 'Rumuokwuta', 'Diobu', 'Mile 1', 'Mile 3',
  'Trans-Amadi', 'D-Line', 'Eliozu', 'Woji', 'Elelenwo', 'Choba', 'Borokiri', 'Ada George', 'Peter Odili Road',
  'Port Harcourt International Airport',
];
const VEHICLES = {
  bike: { label: 'Bike', base: 600, perKm: 120 },
  car: { label: 'Car', base: 1200, perKm: 200 },
  van: { label: 'Van', base: 2500, perKm: 300 },
};
const ITEMS = ['Documents', 'Electronics/Gadgets', 'Food Items/Groceries', 'Clothing', 'Other'];
const MIN_PRICE = 100;
const MAX_PRICE = 5000000;
const ACTIVE_STATES = ['agreed', 'picked_up'];
const AVG_SPEED_KMH = 25; // city traffic

// ---------- Small helpers ----------
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const need = (cond, code, msg) => { if (!cond) throw httpErr(code, msg); };
const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const dayOf = (ts = Date.now()) => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
const inBounds = (lat, lng, pad = 0) => lat >= BOUNDS.south - pad && lat <= BOUNDS.north + pad && lng >= BOUNDS.west - pad && lng <= BOUNDS.east + pad;

function haversineKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Suggested price. `routeKm` is the road distance the phone measured on the map. We only trust it when it is
// plausible for the straight-line distance; otherwise we estimate the road distance ourselves.
function suggest(a, b, vehicle, routeKm) {
  const straight = haversineKm(a, b);
  const rk = num(routeKm);
  let km, approx = false;
  if (Number.isFinite(rk) && rk >= straight * 0.95 && rk <= Math.max(straight * 3, straight + 5)) km = rk;
  else { km = straight * 1.35; approx = true; }
  km = Math.max(1, Math.round(km * 10) / 10);
  const v = VEHICLES[vehicle];
  const fare = Math.max(v.base, v.base + km * v.perKm);
  return { km, minutes: Math.max(5, Math.round((km / AVG_SPEED_KMH) * 60)), fare: Math.round(fare / 50) * 50, approx, straight: Math.round(straight * 10) / 10 };
}

function priceOf(v) {
  const n = num(v);
  need(Number.isInteger(n) && n >= MIN_PRICE && n <= MAX_PRICE, 400, `Price must be a whole number from ₦${MIN_PRICE} to ₦${MAX_PRICE.toLocaleString('en-NG')}`);
  return n;
}

function normPhone(raw) {
  let s = String(raw ?? '').replace(/[\s().-]/g, '');
  if (/^0\d{10}$/.test(s)) s = '+234' + s.slice(1);
  else if (/^234\d{10}$/.test(s)) s = '+' + s;
  return /^\+\d{10,15}$/.test(s) ? s : null;
}

// ---------- Passwords and sessions ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`; // makes unknown phone numbers cost the same time as wrong passwords
async function verifyPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  const want = Buffer.from(keyHex, 'hex');
  const got = await scrypt(pw, Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(got, want);
}
function checkPassword(pw) {
  need(typeof pw === 'string' && pw.length >= 8, 400, 'Password must be at least 8 characters.');
  need(pw.length <= 100, 400, 'Password is too long.');
}

const secretOf = (db, config) => config.sessionSecret || db.secret;
function sign(db, config, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secretOf(db, config)).update(body).digest('base64url');
}
function verifyToken(db, config, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secretOf(db, config)).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const cookieStr = (value, maxAgeSec, secure) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;

function throttled(db, key) { const t = db.throttle[key]; return t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 60000) : 0; }
function noteFailure(db, key) {
  const t = (db.throttle[key] ||= { n: 0, until: 0 });
  t.n += 1;
  if (t.n >= 5) { t.until = Date.now() + 10 * 60000; t.n = 0; } // five wrong tries lock the account for 10 minutes
}

// ---------- Views: what each side is allowed to see ----------
const publicUser = (u) => (u.role === 'driver'
  ? { id: u.id, role: u.role, name: u.name, phone: u.phone, vehicle: u.vehicle, plate: u.plate, status: u.status, rating: u.rating, ratingCount: u.ratingCount, completed: u.completed }
  : { id: u.id, role: u.role, name: u.name, phone: u.phone });
const driverPub = (d) => ({ id: d.id, name: d.name, vehicle: d.vehicle, plate: d.plate, rating: d.rating, ratingCount: d.ratingCount, completed: d.completed, status: d.status });
const getDriver = (db, id) => { const d = db.users.find((u) => u.id === id && u.role === 'driver'); need(d, 404, 'Courier not found'); return d; };
const getJob = (db, id) => { const j = db.jobs.find((x) => String(x.id) === String(id)); need(j, 404, 'Delivery not found'); return j; };
const isBusy = (db, d) => db.jobs.some((j) => j.driverId === d.id && ACTIVE_STATES.includes(j.status));
const lastOf = (n) => n.history[n.history.length - 1];
const turnOf = (n) => (n.status === 'active' ? (lastOf(n).by === 'driver' ? 'sender' : 'driver') : null);

const naira = (n) => '₦' + Number(n).toLocaleString('en-NG');
function ensure(db) { // older saved data gets the newer fields on its next write
  db.notifications ||= []; db.push ||= []; db.nextNoteId ||= 1;
  db.vapid ||= push.makeVapid();
  return db;
}
// Adds an alert for someone; the same object is also sent to their phone as a push message after saving.
function notify(db, outbox, userId, n) {
  const rec = { id: db.nextNoteId++, userId, type: n.type, title: n.title, body: n.body || '', jobId: n.jobId ?? null, at: Date.now(), read: false };
  db.notifications.push(rec);
  if (db.notifications.length > 3000) db.notifications.splice(0, db.notifications.length - 2000);
  if (outbox) outbox.push(rec);
  return rec;
}
function notesOf(db, userId) {
  const mine = (db.notifications || []).filter((x) => x.userId === userId);
  return { unread: mine.filter((x) => !x.read).length, items: mine.slice(-30).reverse().map(({ userId: _u, ...x }) => x) };
}

const CALL_RING_MS = 45000;
function liveCall(j) { // a call nobody picked up within 45 s is over
  const c = j.call;
  if (c && c.status === 'ringing' && Date.now() - c.at > CALL_RING_MS) { c.status = 'ended'; c.reason = 'missed'; c.endedAt = Date.now(); }
  return c || null;
}
const callPub = (j) => { const c = j.call; return c ? { from: c.from, status: c.status === 'ringing' && Date.now() - c.at > CALL_RING_MS ? 'ended' : c.status, at: c.at, reason: c.reason || null } : null; };
function baseJob(j) { const { negotiations, declinedBy, senderId, deliveryCode, codeFails, codeLock, call, ...rest } = j; return { ...rest, call: callPub(j) }; }
function senderView(db, j) {
  const d = j.driverId ? getDriver(db, j.driverId) : null;
  return {
    ...baseJob(j),
    deliveryCode: j.deliveryCode,
    negotiations: j.negotiations.map((n) => ({ ...n, turn: turnOf(n), driver: driverPub(getDriver(db, n.driverId)) })),
    driver: d ? { ...driverPub(d), phone: d.phone } : null,
  };
}
function driverView(j, driverId) {
  const n = j.negotiations.find((x) => x.driverId === driverId);
  const mine = j.driverId === driverId;
  const showContacts = mine && ['agreed', 'picked_up', 'delivered'].includes(j.status);
  const v = baseJob(j);
  if (!showContacts) { delete v.recipientName; delete v.recipientPhone; delete v.senderPhone; v.senderName = v.senderName.split(' ')[0]; }
  return { ...v, mine, negotiation: n ? { history: n.history, status: n.status, turn: turnOf(n) } : null };
}

// ---------- Deals ----------
function seal(db, job, driver, price, note) {
  need(job.status === 'open', 409, 'This delivery already has a deal');
  need(driver.status === 'online', 409, 'This courier is offline');
  need(!isBusy(db, driver), 409, 'This courier is already on a delivery');
  let n = job.negotiations.find((x) => x.driverId === driver.id);
  if (!n) { n = { driverId: driver.id, history: [{ by: 'sender', price: job.openingPrice, at: Date.now() }], status: 'active' }; job.negotiations.push(n); }
  job.negotiations.forEach((x) => { if (x !== n && x.status === 'active') x.status = 'closed'; });
  n.status = 'sealed';
  job.status = 'agreed';
  job.driverId = driver.id;
  job.agreedPrice = price;
  job.timeline.push({ status: 'agreed', at: Date.now(), note: `${driver.name} at ${price}` });
  note(job.senderId, { type: 'sealed', title: 'Deal sealed', body: `${driver.name} will deliver for ${naira(price)}. You will see them on the map.`, jobId: job.id });
  note(driver.id, { type: 'sealed', title: 'Deal sealed. Go pick up!', body: `${naira(price)} · pickup at ${job.pickup.label}`, jobId: job.id });
  job.negotiations.forEach((x) => { if (x !== n && x.status === 'closed') note(x.driverId, { type: 'closed', title: 'Another courier was chosen', body: `Delivery #${job.id} is taken.`, jobId: job.id }); });
}

function chargeCommission(db, driverId, jobId) {
  const date = dayOf();
  if (db.ledger.some((l) => l.driverId === driverId && l.date === date)) return;
  db.ledger.push({ driverId, date, amount: db.settings.commissionPerDay, jobId });
}

function senderAction(db, user, job, action, body, note) {
  need(job.senderId === user.id, 403, 'This is not your delivery');
  need(job.status === 'open', 409, 'This delivery is no longer open for offers');
  const n = job.negotiations.find((x) => x.driverId === body.driverId);
  need(n && n.status === 'active', 404, 'No active offer from this courier');
  const last = lastOf(n);
  need(last.by === 'driver', 409, "It is the courier's turn to respond");
  if (action === 'counter') {
    const price = priceOf(body.price);
    n.history.push({ by: 'sender', price, at: Date.now() });
    note(n.driverId, { type: 'counter', title: `Sender countered ${naira(price)}`, body: `Delivery #${job.id}: accept or counter back.`, jobId: job.id });
  } else if (action === 'accept') seal(db, job, getDriver(db, n.driverId), last.price, note);
  else if (action === 'decline') { n.status = 'declined'; note(n.driverId, { type: 'declined', title: 'Offer declined', body: `The sender declined your offer on delivery #${job.id}.`, jobId: job.id }); }
  else throw httpErr(404, 'Not found');
  return senderView(db, job);
}

function driverAction(db, d, job, action, body, note) {
  const n = job.negotiations.find((x) => x.driverId === d.id);
  const openChecks = () => {
    need(job.status === 'open', 409, 'This delivery is no longer open');
    need(d.status === 'online', 409, 'Go online first');
    need(d.vehicle === job.vehicle, 409, `This delivery needs a ${VEHICLES[job.vehicle].label.toLowerCase()}`);
    need(!job.declinedBy.includes(d.id) && !(n && ['declined', 'withdrawn'].includes(n.status)), 409, 'You can no longer make offers on this delivery');
  };
  switch (action) {
    case 'accept':
      openChecks();
      if (n) { need(n.status === 'active' && lastOf(n).by === 'sender', 409, "It is the sender's turn to respond"); seal(db, job, d, lastOf(n).price, note); }
      else seal(db, job, d, job.openingPrice, note);
      break;
    case 'counter': {
      openChecks();
      const price = priceOf(body.price);
      let neg = n;
      if (!neg) { neg = { driverId: d.id, history: [{ by: 'sender', price: job.openingPrice, at: Date.now() }], status: 'active' }; job.negotiations.push(neg); }
      need(neg.status === 'active' && lastOf(neg).by === 'sender', 409, "It is the sender's turn to respond");
      neg.history.push({ by: 'driver', price, at: Date.now() });
      note(job.senderId, { type: 'offer', title: `${d.name} offered ${naira(price)}`, body: `Delivery #${job.id}: accept, counter or decline.`, jobId: job.id });
      break;
    }
    case 'reject':
      need(job.status === 'open', 409, 'This delivery is no longer open');
      if (n && n.status === 'active') { n.status = 'withdrawn'; note(job.senderId, { type: 'walked', title: `${d.name} walked away`, body: `Delivery #${job.id} is still open for other couriers.`, jobId: job.id }); }
      if (!job.declinedBy.includes(d.id)) job.declinedBy.push(d.id);
      break;
    case 'pickup':
      need(job.driverId === d.id && job.status === 'agreed', 409, 'This delivery is not ready for pickup');
      job.status = 'picked_up';
      job.timeline.push({ status: 'picked_up', at: Date.now() });
      note(job.senderId, { type: 'picked_up', title: 'Package picked up', body: `${d.name} is on the way to ${job.drop.label}.`, jobId: job.id });
      break;
    case 'deliver':
      need(job.driverId === d.id && job.status === 'picked_up', 409, 'Pick the package up first');
      need(!job.codeLock || job.codeLock < Date.now(), 429, 'Too many wrong codes. Wait a few minutes or ask the sender.');
      if (String(body.code ?? '').trim() !== job.deliveryCode) {
        job.codeFails = (job.codeFails || 0) + 1;
        if (job.codeFails >= 5) { job.codeFails = 0; job.codeLock = Date.now() + 5 * 60000; }
        throw Object.assign(httpErr(422, 'That delivery code is not right. Ask the recipient for the 4-digit code.'), { keepChanges: true });
      }
      job.status = 'delivered';
      job.deliveredAt = Date.now();
      job.deliveredDate = dayOf();
      job.timeline.push({ status: 'delivered', at: Date.now() });
      d.completed += 1;
      chargeCommission(db, d.id, job.id);
      note(job.senderId, { type: 'delivered', title: 'Delivered', body: `Delivery #${job.id} is complete. Rate ${d.name.split(' ')[0]} to help other senders.`, jobId: job.id });
      break;
    case 'withdraw':
      need(job.driverId === d.id && job.status === 'agreed', 409, 'You can only pull out before pickup');
      job.status = 'open';
      job.driverId = null;
      job.agreedPrice = null;
      job.declinedBy.push(d.id);
      job.negotiations.forEach((x) => { if (x.driverId === d.id) x.status = 'withdrawn'; else if (x.status === 'closed') x.status = 'active'; });
      job.timeline.push({ status: 'courier_withdrew', at: Date.now(), note: d.name });
      note(job.senderId, { type: 'withdrew', title: 'Courier pulled out', body: `Delivery #${job.id} is open again for other offers.`, jobId: job.id });
      break;
    default: throw httpErr(404, 'Not found');
  }
  return driverView(job, d.id);
}

// ---------- Creating a delivery ----------
function cleanPoint(p, what) {
  need(p && typeof p === 'object', 400, `Choose the ${what} location`);
  const lat = num(p.lat), lng = num(p.lng);
  need(Number.isFinite(lat) && Number.isFinite(lng), 400, `Choose the ${what} location`);
  need(inBounds(lat, lng), 400, `The ${what} is outside our Port Harcourt service area`);
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, label: str(p.label, 60) || 'Pinned location', address: str(p.address, 160) };
}
function cleanGeo(arr) {
  if (!Array.isArray(arr) || arr.length < 2 || arr.length > 400) return null;
  const out = [];
  for (const p of arr) {
    const lat = num(p?.[0]), lng = num(p?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inBounds(lat, lng, 0.3)) return null;
    out.push([Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
  }
  return out;
}

function createJob(db, user, body, note) {
  const pickup = cleanPoint(body.pickup, 'pickup'), drop = cleanPoint(body.drop, 'delivery');
  need(pickup.address || pickup.label, 400, 'Enter the pickup address');
  need(VEHICLES[body.vehicle], 400, 'Choose a vehicle type');
  need(ITEMS.includes(body.itemType), 400, 'Choose what you are sending');
  const quantity = num(body.quantity);
  need(Number.isInteger(quantity) && quantity >= 1 && quantity <= 999, 400, 'Quantity must be between 1 and 999');
  const recipientName = str(body.recipientName, 60), recipientPhone = str(body.recipientPhone, 20);
  need(recipientName, 400, 'Enter the recipient name');
  need(/^[+\d][\d\s-]{6,18}$/.test(recipientPhone), 400, 'Enter a valid recipient phone number');
  const payer = body.payer === 'recipient' ? 'recipient' : 'sender';
  need(['cash', 'transfer'].includes(body.payment), 400, 'Choose how the courier will be paid');
  const deliveryType = body.deliveryType === 'scheduled' ? 'scheduled' : 'instant';
  let scheduledAt = null;
  if (deliveryType === 'scheduled') {
    scheduledAt = new Date(body.scheduledAt).getTime();
    need(Number.isFinite(scheduledAt) && scheduledAt > Date.now(), 400, 'Pick a pickup time in the future');
  }
  const est = suggest(pickup, drop, body.vehicle, body.routeKm);
  const openingPrice = body.openingPrice === undefined || body.openingPrice === '' ? est.fare : priceOf(body.openingPrice);
  const job = {
    id: db.nextJobId++, senderId: user.id, senderName: user.name, senderPhone: user.phone,
    deliveryType, scheduledAt, pickup, drop, routeGeo: est.approx ? null : cleanGeo(body.routeGeo),
    itemType: body.itemType, quantity, note: str(body.note, 200), recipientName, recipientPhone,
    vehicle: body.vehicle, payer, payment: body.payment,
    km: est.km, approxDistance: est.approx, suggested: est.fare, openingPrice,
    deliveryCode: String(crypto.randomInt(1000, 10000)), messages: [], courierLoc: null,
    status: 'open', driverId: null, agreedPrice: null, negotiations: [], declinedBy: [], createdAt: Date.now(),
    timeline: [{ status: 'open', at: Date.now() }],
  };
  db.jobs.push(job);
  const km = est.km, fare = naira(openingPrice);
  db.users.filter((u) => u.role === 'driver' && u.status === 'online' && u.vehicle === job.vehicle && !isBusy(db, u)).slice(0, 100)
    .forEach((u) => note(u.id, { type: 'new_job', title: 'New delivery request', body: `${job.itemType} · ${km} km · ${pickup.label} to ${drop.label} · ${fare}`, jobId: job.id }));
  return job;
}

// ---------- Feeds ----------
function earningsOf(db, driverId) {
  const delivered = db.jobs.filter((j) => j.driverId === driverId && j.status === 'delivered');
  const days = {};
  delivered.forEach((j) => { const x = (days[j.deliveredDate] ||= { date: j.deliveredDate, jobs: 0, gross: 0, commission: 0 }); x.jobs += 1; x.gross += j.agreedPrice; });
  db.ledger.filter((l) => l.driverId === driverId).forEach((l) => { const x = (days[l.date] ||= { date: l.date, jobs: 0, gross: 0, commission: 0 }); x.commission += l.amount; });
  const byDay = Object.values(days).sort((a, b) => (a.date < b.date ? 1 : -1)).map((x) => ({ ...x, net: x.gross - x.commission }));
  const gross = byDay.reduce((s, x) => s + x.gross, 0), commission = byDay.reduce((s, x) => s + x.commission, 0);
  const today = dayOf();
  return {
    gross, commission, net: gross - commission, byDay,
    commissionPerDay: db.settings.commissionPerDay,
    commissionDueToday: db.ledger.some((l) => l.driverId === driverId && l.date === today) ? 0 : db.settings.commissionPerDay,
  };
}

function driverFeed(db, d) {
  const mine = db.jobs.filter((j) => j.driverId === d.id);
  const open = db.jobs.filter((j) => j.status === 'open' && j.vehicle === d.vehicle && !j.declinedBy.includes(d.id));
  const neg = (j) => j.negotiations.find((n) => n.driverId === d.id);
  const newest = (a, b) => b.createdAt - a.createdAt;
  return {
    driver: { ...driverPub(d), phone: d.phone },
    available: open.filter((j) => !neg(j)).sort(newest).map((j) => driverView(j, d.id)),
    offers: open.filter((j) => neg(j) && neg(j).status === 'active').sort(newest).map((j) => driverView(j, d.id)),
    current: mine.filter((j) => ACTIVE_STATES.includes(j.status)).map((j) => driverView(j, d.id)),
    history: mine.filter((j) => j.status === 'delivered' || j.status === 'cancelled').sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0)).slice(0, 30).map((j) => driverView(j, d.id)),
    earnings: earningsOf(db, d.id),
    notes: notesOf(db, d.id),
  };
}

function adminFeed(db) {
  const delivered = db.jobs.filter((j) => j.status === 'delivered');
  return {
    settings: db.settings,
    totals: {
      jobs: db.jobs.length,
      open: db.jobs.filter((j) => j.status === 'open').length,
      active: db.jobs.filter((j) => ACTIVE_STATES.includes(j.status)).length,
      delivered: delivered.length,
      dealValue: delivered.reduce((s, j) => s + j.agreedPrice, 0),
      commission: db.ledger.reduce((s, l) => s + l.amount, 0),
      senders: db.users.filter((u) => u.role === 'sender').length,
      couriers: db.users.filter((u) => u.role === 'driver').length,
    },
    drivers: db.users.filter((u) => u.role === 'driver').map((d) => ({ ...driverPub(d), phone: d.phone, earnings: earningsOf(db, d.id) })),
    senders: db.users.filter((u) => u.role === 'sender').map((u) => ({ id: u.id, name: u.name, phone: u.phone, createdAt: u.createdAt, jobs: db.jobs.filter((j) => j.senderId === u.id).length })),
    jobs: db.jobs.slice(-60).reverse().map((j) => ({ ...baseJob(j), routeGeo: undefined, offers: j.negotiations.length })),
    ledger: db.ledger.slice(-60).reverse(),
  };
}

// ---------- The app ----------
function createApp(store, config = {}) {
  const cfg = { adminPin: '', commissionPerDay: 500, sessionSecret: '', turnUrls: [], turnUser: '', turnPass: '', ...config };

  function sessionUser(db, ctx) {
    if (ctx.session !== undefined) return ctx.session;
    const p = verifyToken(db, cfg, parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE]);
    let u = null;
    if (p && p.role === 'admin') u = cfg.adminPin ? { id: 'admin', role: 'admin', name: 'Admin' } : null;
    else if (p) { const x = db.users.find((y) => y.id === p.uid); u = x && x.tv === p.tv ? x : null; }
    ctx.session = u;
    return u;
  }
  const secure = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.socket?.encrypted;
  function startSession(db, ctx, user, status = 200) {
    const token = sign(db, cfg, { uid: user.id, role: user.role, tv: user.tv, exp: Date.now() + SESSION_DAYS * 86400000 });
    return { status, body: { user: publicUser(user) }, cookies: [cookieStr(token, SESSION_DAYS * 86400, secure(ctx.req))] };
  }

  async function route(db, ctx) {
    const { method: m, parts, body } = ctx;
    const ok = (b, status = 200) => ({ status, body: b });
    const note = (userId, n) => notify(db, ctx.outbox, userId, n);
    const needUser = (role) => {
      const u = sessionUser(db, ctx);
      need(u, 401, 'Log in to continue');
      if (role) need(u.role === role, 403, { sender: 'This is for senders only', driver: 'This is for couriers only', admin: 'This is for admins only' }[role]);
      return u;
    };

    if (m === 'GET' && parts[0] === 'health' && ctx.query.get('deep') === '1') return ok({ ...(await selfTest(store)), storage: store.kind, ephemeral: !!store.ephemeral, via: store.source || undefined, envFound: store.envHint || undefined, node: process.version });
    if (m === 'GET' && parts[0] === 'health') return ok({ ok: true, storage: store.kind, ephemeral: !!store.ephemeral, envFound: store.envHint || undefined, via: store.source || undefined });
    if (m === 'GET' && parts[0] === 'meta') {
      return ok({
        vehicles: VEHICLES, items: ITEMS, areas: AREAS, bounds: BOUNDS, center: CENTER, city: 'Port Harcourt',
        commissionPerDay: db.settings.commissionPerDay, min: MIN_PRICE, max: MAX_PRICE,
        adminEnabled: !!cfg.adminPin, storage: store.kind, ephemeral: !!store.ephemeral,
      });
    }
    if (m === 'POST' && parts[0] === 'estimate') {
      const a = cleanPoint(body.pickup, 'pickup'), b = cleanPoint(body.drop, 'delivery');
      need(VEHICLES[body.vehicle], 400, 'Choose a vehicle type');
      return ok(suggest(a, b, body.vehicle, body.routeKm));
    }

    // ----- Accounts -----
    if (parts[0] === 'auth' && m === 'POST') {
      if (parts[1] === 'register') {
        const role = body.role;
        need(['sender', 'driver'].includes(role), 400, 'Choose whether you send packages or deliver them');
        const name = str(body.name, 60);
        need(name.length >= 2, 400, 'Enter your full name');
        const phone = normPhone(body.phone);
        need(phone, 400, 'Enter a valid phone number, like 08012345678');
        checkPassword(body.password);
        let vehicle, plate;
        if (role === 'driver') {
          vehicle = body.vehicle;
          need(VEHICLES[vehicle], 400, 'Choose your vehicle type');
          plate = str(body.plate, 15).toUpperCase();
          need(plate.length >= 3, 400, 'Enter your vehicle plate number');
        }
        need(!db.users.some((u) => u.role === role && u.phone === phone), 409, 'An account with this phone number already exists. Log in instead.');
        const u = { id: 'u' + db.nextUserId++, role, name, phone, passHash: await hashPassword(body.password), tv: 0, createdAt: Date.now() };
        if (role === 'driver') Object.assign(u, { vehicle, plate, status: 'online', rating: 5, ratingCount: 0, completed: 0 });
        db.users.push(u);
        return startSession(db, ctx, u, 201);
      }
      if (parts[1] === 'login') {
        const role = body.role;
        need(['sender', 'driver'].includes(role), 400, 'Choose whether you send packages or deliver them');
        const phone = normPhone(body.phone);
        const key = `${role}:${phone || str(body.phone, 20)}`;
        const wait = throttled(db, key);
        if (wait) return { status: 429, body: { error: `Too many wrong attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.` } };
        const u = phone && db.users.find((x) => x.role === role && x.phone === phone);
        const good = await verifyPassword(String(body.password ?? ''), u ? u.passHash : DUMMY_HASH);
        if (!u || !good) { noteFailure(db, key); return { status: 401, body: { error: 'Phone number or password is incorrect.' } }; }
        delete db.throttle[key];
        return startSession(db, ctx, u);
      }
      if (parts[1] === 'admin') {
        need(cfg.adminPin, 503, 'Admin is not set up. Set the ADMIN_PIN setting on the server.');
        const wait = throttled(db, 'admin');
        if (wait) return { status: 429, body: { error: `Too many wrong attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.` } };
        const got = Buffer.from(String(body.pin ?? '')), want = Buffer.from(cfg.adminPin);
        if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) { noteFailure(db, 'admin'); return { status: 401, body: { error: 'That PIN is not correct.' } }; }
        delete db.throttle.admin;
        const token = sign(db, cfg, { uid: 'admin', role: 'admin', exp: Date.now() + 12 * 3600000 });
        return { status: 200, body: { user: { id: 'admin', role: 'admin', name: 'Admin' } }, cookies: [cookieStr(token, 12 * 3600, secure(ctx.req))] };
      }
      if (parts[1] === 'logout') return { status: 200, body: { ok: true }, cookies: [cookieStr('', 0, secure(ctx.req))] };
    }
    if (m === 'GET' && parts[0] === 'me') { const u = needUser(); return ok({ user: u.role === 'admin' ? u : publicUser(u) }); }
    if (m === 'POST' && parts[0] === 'me' && parts[1] === 'password') {
      const u = needUser();
      need(u.role !== 'admin', 403, 'Admins use the PIN');
      need(await verifyPassword(String(body.current ?? ''), u.passHash), 401, 'Your current password is not correct.');
      checkPassword(body.next);
      u.passHash = await hashPassword(body.next);
      u.tv += 1; // signs out every other device
      return startSession(db, ctx, u);
    }

    if (m === 'GET' && parts[0] === 'push' && parts[1] === 'key') return ok({ key: db.vapid ? db.vapid.publicKey : null });
    if (m === 'POST' && parts[0] === 'me' && parts[1] === 'notifications') {
      const u = needUser();
      need(u.role !== 'admin', 403, 'Not available');
      const ids = Array.isArray(body.ids) ? new Set(body.ids.map(Number)) : null;
      db.notifications.forEach((x) => { if (x.userId === u.id && (!ids || ids.has(x.id))) x.read = true; });
      return ok(notesOf(db, u.id));
    }
    if (m === 'POST' && parts[0] === 'me' && parts[1] === 'push') {
      const u = needUser();
      need(u.role !== 'admin', 403, 'Not available');
      const sub = body.subscription;
      if (parts[2] === 'remove') { db.push = db.push.filter((x) => x.sub.endpoint !== str(body.endpoint, 600)); return ok({ ok: true }); }
      need(sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 600 && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string', 400, 'Invalid push subscription');
      db.push = db.push.filter((x) => x.sub.endpoint !== sub.endpoint);
      db.push.push({ userId: u.id, sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } }, at: Date.now() });
      const mine = db.push.filter((x) => x.userId === u.id);
      if (mine.length > 5) db.push = db.push.filter((x) => x.userId !== u.id || mine.slice(-5).includes(x));
      return ok({ ok: true });
    }

    // ----- Senders -----
    if (m === 'GET' && parts[0] === 'sender' && parts[1] === 'jobs') {
      const u = needUser('sender');
      return ok({ jobs: db.jobs.filter((j) => j.senderId === u.id).sort((a, b) => b.createdAt - a.createdAt).map((j) => senderView(db, j)), notes: notesOf(db, u.id) });
    }
    if (parts[0] === 'jobs') {
      if (m === 'POST' && parts.length === 1) return ok(senderView(db, createJob(db, needUser('sender'), body, note)), 201);
      const job = getJob(db, parts[1]);
      if (m === 'POST' && parts[2] === 'cancel') {
        const u = needUser('sender');
        need(job.senderId === u.id, 403, 'This is not your delivery');
        need(['open', 'agreed'].includes(job.status), 409, 'It is too late to cancel this delivery');
        const wasDriver = job.driverId;
        job.status = 'cancelled';
        job.timeline.push({ status: 'cancelled', at: Date.now() });
        const told = new Set(wasDriver ? [wasDriver] : job.negotiations.filter((x) => x.status === 'active').map((x) => x.driverId));
        told.forEach((id) => note(id, { type: 'cancelled', title: 'Delivery cancelled', body: `The sender cancelled delivery #${job.id}.`, jobId: job.id }));
        return ok(senderView(db, job));
      }
      if (m === 'POST' && parts[2] === 'rate') {
        const u = needUser('sender');
        need(job.senderId === u.id, 403, 'This is not your delivery');
        need(job.status === 'delivered', 409, 'The delivery is not complete yet');
        need(!job.rating, 409, 'You already rated this delivery');
        const n = num(body.rating);
        need(Number.isInteger(n) && n >= 1 && n <= 5, 400, 'Rating must be from 1 to 5');
        job.rating = n;
        const d = getDriver(db, job.driverId);
        d.rating = Math.round(((d.rating * d.ratingCount + n) / (d.ratingCount + 1)) * 100) / 100;
        d.ratingCount += 1;
        note(d.id, { type: 'rated', title: `You got ${n} star${n === 1 ? '' : 's'}`, body: `From delivery #${job.id}.`, jobId: job.id });
        return ok(senderView(db, job));
      }
      if (m === 'POST' && parts[2] === 'sender') return ok(senderAction(db, needUser('sender'), job, parts[3], body, note));
      if (m === 'POST' && parts[2] === 'driver') {
        const d = needUser('driver');
        try { return ok(driverAction(db, d, job, parts[3], body, note)); } catch (e) {
          if (e.keepChanges) return { status: e.status, body: { error: e.message } }; // keep the wrong-code counter
          throw e;
        }
      }
      if (parts[2] === 'call') {
        const u = needUser();
        need(u.role === 'sender' || u.role === 'driver', 403, 'Not allowed');
        need(u.role === 'sender' ? job.senderId === u.id : job.driverId === u.id, 403, 'This is not your delivery');
        const ice = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
        if (cfg.turnUrls.length) ice.push({ urls: cfg.turnUrls, username: cfg.turnUser, credential: cfg.turnPass });
        if (m === 'GET') { // read-only: work on a copy so the shared cached data is not changed
          const cc = job.call ? { ...job.call } : null;
          if (cc && cc.status === 'ringing' && Date.now() - cc.at > CALL_RING_MS) Object.assign(cc, { status: 'ended', reason: 'missed' });
          return ok({ call: cc, ice });
        }
        need(ACTIVE_STATES.includes(job.status), 409, 'Calls are open while the delivery is in progress');
        const other = u.role === 'sender' ? job.driverId : job.senderId;
        const c = liveCall(job);
        const sdp = typeof body.sdp === 'string' ? body.sdp.slice(0, 20000) : '';
        if (body.action === 'start') {
          need(sdp.startsWith('v=0'), 400, 'Could not start the call');
          need(!(c && ['ringing', 'active'].includes(c.status)), 409, 'A call is already in progress');
          job.call = { from: u.role, status: 'ringing', offer: sdp, answer: null, at: Date.now() };
          note(other, { type: 'call', title: `Incoming call from ${u.name.split(' ')[0]}`, body: `Delivery #${job.id}. Open Bargo to answer.`, jobId: job.id });
          return ok({ call: job.call, ice });
        }
        need(c, 409, 'No call');
        if (body.action === 'answer') {
          need(c.status === 'ringing' && c.from !== u.role, 409, 'Nothing to answer');
          need(sdp.startsWith('v=0'), 400, 'Could not answer the call');
          Object.assign(c, { status: 'active', answer: sdp, answeredAt: Date.now() });
          return ok({ call: c, ice });
        }
        if (body.action === 'end') {
          if (['ringing', 'active'].includes(c.status)) {
            const wasRinging = c.status === 'ringing';
            Object.assign(c, { status: 'ended', endedAt: Date.now(), reason: wasRinging ? (c.from === u.role ? 'cancelled' : 'declined') : 'hangup' });
            if (wasRinging && c.from === u.role) note(other, { type: 'missed_call', title: `Missed call from ${u.name.split(' ')[0]}`, body: `Delivery #${job.id}`, jobId: job.id });
          }
          return ok({ call: c, ice });
        }
        throw httpErr(400, 'Unknown call action');
      }
      if (m === 'POST' && parts[2] === 'messages') {
        const u = needUser();
        need(u.role === 'sender' || u.role === 'driver', 403, 'Not allowed');
        const mine = u.role === 'sender' ? job.senderId === u.id : job.driverId === u.id;
        need(mine, 403, 'This is not your delivery');
        need(ACTIVE_STATES.includes(job.status), 409, 'Chat is open while the delivery is in progress');
        const text = str(body.text, 300);
        need(text, 400, 'Type a message first');
        job.messages ||= [];
        job.messages.push({ from: u.role, text, at: Date.now() });
        if (job.messages.length > 100) job.messages.splice(0, job.messages.length - 100);
        const other = u.role === 'sender' ? job.driverId : job.senderId;
        note(other, { type: 'message', title: `Message from ${u.name.split(' ')[0]}`, body: text, jobId: job.id });
        return ok(u.role === 'sender' ? senderView(db, job) : driverView(job, u.id));
      }
    }

    // ----- Couriers -----
    if (parts[0] === 'driver') {
      const d = needUser('driver');
      if (m === 'GET' && parts[1] === 'feed') return ok(driverFeed(db, d));
      if (m === 'POST' && parts[1] === 'location') {
        const lat = num(body.lat), lng = num(body.lng);
        need(Number.isFinite(lat) && Number.isFinite(lng) && inBounds(lat, lng, 0.5), 400, 'Location is outside the service area');
        const job = db.jobs.find((j) => j.driverId === d.id && ACTIVE_STATES.includes(j.status));
        if (job && !(job.courierLoc && Date.now() - job.courierLoc.at < 7000)) job.courierLoc = { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, at: Date.now() };
        return ok({ ok: true, tracking: !!job });
      }
      if (m === 'POST' && parts[1] === 'status') {
        need(['online', 'offline'].includes(body.status), 400, 'Status must be online or offline');
        need(!(body.status === 'offline' && isBusy(db, d)), 409, 'Finish your current delivery first');
        d.status = body.status;
        return ok(publicUser(d));
      }
    }

    // ----- Admin -----
    if (parts[0] === 'admin') {
      needUser('admin');
      if (m === 'GET' && parts.length === 1) return ok(adminFeed(db));
      if (m === 'POST' && parts[1] === 'settings') {
        const c = num(body.commissionPerDay);
        need(Number.isInteger(c) && c >= 0 && c <= 100000, 400, 'Commission must be a whole number from 0 to 100,000');
        db.settings.commissionPerDay = c;
        return ok(adminFeed(db));
      }
      if (m === 'POST' && parts[1] === 'users' && parts[3] === 'reset') {
        const u = db.users.find((x) => x.id === parts[2]);
        need(u, 404, 'Account not found');
        const temp = body.password ? String(body.password) : crypto.randomBytes(6).toString('base64url');
        checkPassword(temp);
        u.passHash = await hashPassword(temp);
        u.tv += 1;
        return ok({ tempPassword: temp, name: u.name, phone: u.phone });
      }
    }
    throw httpErr(404, 'Not found');
  }

  // Build the phone push messages for the alerts just saved, then send them after the data is safely stored.
  function pushJobs(db, outbox) {
    return outbox.flatMap((n) => db.push.filter((x) => x.userId === n.userId).map((x) => ({ sub: x.sub, vapid: db.vapid, msg: { title: n.title, body: n.body, tag: `bargo-${n.jobId ?? n.type}`, jobId: n.jobId, type: n.type } })));
  }
  async function deliverPush(jobs) {
    if (!jobs.length) return;
    const subject = cfg.pushSubject || 'mailto:support@bargo.app';
    const results = await Promise.race([
      Promise.all(jobs.map(async (j) => ({ endpoint: j.sub.endpoint, ...(await push.sendPush(j.vapid, j.sub, j.msg, subject)) }))),
      new Promise((r) => setTimeout(() => r([]), 3500)),
    ]);
    const gone = new Set(results.filter((r) => r.gone).map((r) => r.endpoint));
    if (gone.size) { try { await mutate(store, (db) => { db.push = (db.push || []).filter((x) => !gone.has(x.sub.endpoint)); }, newDb(cfg.commissionPerDay)); } catch { /* best effort */ } }
  }

  async function readBody(req) {
    if (req.body !== undefined && req.body !== null) { // some hosts have already parsed the body
      if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString()) : {};
      if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
      return req.body;
    }
    return new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (c) => { s += c; if (s.length > 1e6) { reject(httpErr(413, 'Body too large')); req.destroy(); } });
      req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(httpErr(400, 'Invalid JSON')); } });
      req.on('error', reject);
    });
  }

  const send = (res, status, obj, cookies) => {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (cookies && cookies.length) headers['Set-Cookie'] = cookies;
    res.writeHead(status, headers);
    res.end(JSON.stringify(obj));
  };

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      let parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'api') parts = parts.slice(1);
      const method = req.method;
      need(['GET', 'POST'].includes(method), 405, 'Method not allowed');
      let body = {};
      if (method === 'POST') {
        const ct = String(req.headers['content-type'] || '');
        if (ct && !ct.includes('application/json')) throw httpErr(415, 'Send JSON');
        body = await readBody(req);
        need(body && typeof body === 'object' && !Array.isArray(body), 400, 'Invalid JSON');
      }
      const ctx = { req, method, parts, body, query: url.searchParams };
      const readOnly = method === 'GET' || (parts[0] === 'estimate') || (parts[0] === 'auth' && parts[1] === 'logout');
      let out;
      if (readOnly) {
        const { db } = await store.read({ fresh: url.searchParams.get('fresh') === '1' });
        out = await route(db || newDb(cfg.commissionPerDay), ctx);
      } else {
        let jobs = [];
        out = await mutate(store, async (db) => {
          ensure(db);
          const outbox = [];
          const r = await route(db, { ...ctx, session: undefined, outbox });
          jobs = pushJobs(db, outbox); // only the attempt that gets saved is sent
          return r;
        }, newDb(cfg.commissionPerDay));
        await deliverPush(jobs);
      }
      send(res, out.status, out.body, out.cookies);
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'Server error: ' + String((e && e.message) || e).slice(0, 160) });
    }
  }

  return { handle, route };
}

module.exports = { createApp, suggest, haversineKm, normPhone, BOUNDS, CENTER, VEHICLES, AREAS };
