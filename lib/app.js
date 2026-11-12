// Bargo server logic: accounts, deliveries, price negotiation, daily commission.
// Framework-free. `createApp(store, config).handle(req, res)` works in a plain Node server and in a Vercel function.
'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const { mutate, newDb } = require('./storage');

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

function baseJob(j) { const { negotiations, declinedBy, senderId, ...rest } = j; return rest; }
function senderView(db, j) {
  const d = j.driverId ? getDriver(db, j.driverId) : null;
  return {
    ...baseJob(j),
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
function seal(db, job, driver, price) {
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
}

function chargeCommission(db, driverId, jobId) {
  const date = dayOf();
  if (db.ledger.some((l) => l.driverId === driverId && l.date === date)) return;
  db.ledger.push({ driverId, date, amount: db.settings.commissionPerDay, jobId });
}

function senderAction(db, user, job, action, body) {
  need(job.senderId === user.id, 403, 'This is not your delivery');
  need(job.status === 'open', 409, 'This delivery is no longer open for offers');
  const n = job.negotiations.find((x) => x.driverId === body.driverId);
  need(n && n.status === 'active', 404, 'No active offer from this courier');
  const last = lastOf(n);
  need(last.by === 'driver', 409, "It is the courier's turn to respond");
  if (action === 'counter') n.history.push({ by: 'sender', price: priceOf(body.price), at: Date.now() });
  else if (action === 'accept') seal(db, job, getDriver(db, n.driverId), last.price);
  else if (action === 'decline') n.status = 'declined';
  else throw httpErr(404, 'Not found');
  return senderView(db, job);
}

function driverAction(db, d, job, action, body) {
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
      if (n) { need(n.status === 'active' && lastOf(n).by === 'sender', 409, "It is the sender's turn to respond"); seal(db, job, d, lastOf(n).price); }
      else seal(db, job, d, job.openingPrice);
      break;
    case 'counter': {
      openChecks();
      const price = priceOf(body.price);
      let neg = n;
      if (!neg) { neg = { driverId: d.id, history: [{ by: 'sender', price: job.openingPrice, at: Date.now() }], status: 'active' }; job.negotiations.push(neg); }
      need(neg.status === 'active' && lastOf(neg).by === 'sender', 409, "It is the sender's turn to respond");
      neg.history.push({ by: 'driver', price, at: Date.now() });
      break;
    }
    case 'reject':
      need(job.status === 'open', 409, 'This delivery is no longer open');
      if (n && n.status === 'active') n.status = 'withdrawn';
      if (!job.declinedBy.includes(d.id)) job.declinedBy.push(d.id);
      break;
    case 'pickup':
      need(job.driverId === d.id && job.status === 'agreed', 409, 'This delivery is not ready for pickup');
      job.status = 'picked_up';
      job.timeline.push({ status: 'picked_up', at: Date.now() });
      break;
    case 'deliver':
      need(job.driverId === d.id && job.status === 'picked_up', 409, 'Pick the package up first');
      job.status = 'delivered';
      job.deliveredAt = Date.now();
      job.deliveredDate = dayOf();
      job.timeline.push({ status: 'delivered', at: Date.now() });
      d.completed += 1;
      chargeCommission(db, d.id, job.id);
      break;
    case 'withdraw':
      need(job.driverId === d.id && job.status === 'agreed', 409, 'You can only pull out before pickup');
      job.status = 'open';
      job.driverId = null;
      job.agreedPrice = null;
      job.declinedBy.push(d.id);
      job.negotiations.forEach((x) => { if (x.driverId === d.id) x.status = 'withdrawn'; else if (x.status === 'closed') x.status = 'active'; });
      job.timeline.push({ status: 'courier_withdrew', at: Date.now(), note: d.name });
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

function createJob(db, user, body) {
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
    status: 'open', driverId: null, agreedPrice: null, negotiations: [], declinedBy: [], createdAt: Date.now(),
    timeline: [{ status: 'open', at: Date.now() }],
  };
  db.jobs.push(job);
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
  const cfg = { adminPin: '', commissionPerDay: 500, sessionSecret: '', ...config };

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
    const needUser = (role) => {
      const u = sessionUser(db, ctx);
      need(u, 401, 'Log in to continue');
      if (role) need(u.role === role, 403, { sender: 'This is for senders only', driver: 'This is for couriers only', admin: 'This is for admins only' }[role]);
      return u;
    };

    if (m === 'GET' && parts[0] === 'health') return ok({ ok: true, storage: store.kind, ephemeral: !!store.ephemeral });
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

    // ----- Senders -----
    if (m === 'GET' && parts[0] === 'sender' && parts[1] === 'jobs') {
      const u = needUser('sender');
      return ok({ jobs: db.jobs.filter((j) => j.senderId === u.id).sort((a, b) => b.createdAt - a.createdAt).map((j) => senderView(db, j)) });
    }
    if (parts[0] === 'jobs') {
      if (m === 'POST' && parts.length === 1) return ok(senderView(db, createJob(db, needUser('sender'), body)), 201);
      const job = getJob(db, parts[1]);
      if (m === 'POST' && parts[2] === 'cancel') {
        const u = needUser('sender');
        need(job.senderId === u.id, 403, 'This is not your delivery');
        need(['open', 'agreed'].includes(job.status), 409, 'It is too late to cancel this delivery');
        job.status = 'cancelled';
        job.timeline.push({ status: 'cancelled', at: Date.now() });
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
        return ok(senderView(db, job));
      }
      if (m === 'POST' && parts[2] === 'sender') return ok(senderAction(db, needUser('sender'), job, parts[3], body));
      if (m === 'POST' && parts[2] === 'driver') return ok(driverAction(db, needUser('driver'), job, parts[3], body));
    }

    // ----- Couriers -----
    if (parts[0] === 'driver') {
      const d = needUser('driver');
      if (m === 'GET' && parts[1] === 'feed') return ok(driverFeed(db, d));
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
        out = await mutate(store, (db) => route(db, { ...ctx, session: undefined }), newDb(cfg.commissionPerDay));
      }
      send(res, out.status, out.body, out.cookies);
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the server. Please try again.' });
    }
  }

  return { handle, route };
}

module.exports = { createApp, suggest, haversineKm, normPhone, BOUNDS, CENTER, VEHICLES, AREAS };
