// Bargo: book a courier, negotiate the price, seal the deal.
// Zero dependencies (Node 18+). Data is kept in one JSON file.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const TZ = 'Africa/Lagos';
const DEFAULT_COMMISSION = Number(process.env.COMMISSION_PER_DAY) || 500;

// ---------- Reference data ----------
// Areas of Lagos on a rough 100x100 grid, used for distance and the map.
const PLACES = [
  { id: 'ikeja', name: 'Ikeja', x: 28, y: 14 },
  { id: 'maryland', name: 'Maryland', x: 42, y: 24 },
  { id: 'oshodi', name: 'Oshodi', x: 28, y: 36 },
  { id: 'yaba', name: 'Yaba', x: 48, y: 44 },
  { id: 'surulere', name: 'Surulere', x: 30, y: 56 },
  { id: 'apapa', name: 'Apapa', x: 12, y: 72 },
  { id: 'island', name: 'Lagos Island', x: 55, y: 66 },
  { id: 'ikoyi', name: 'Ikoyi', x: 69, y: 60 },
  { id: 'vi', name: 'Victoria Island', x: 62, y: 79 },
  { id: 'lekki', name: 'Lekki Phase 1', x: 80, y: 77 },
  { id: 'ajah', name: 'Ajah', x: 92, y: 90 },
];
const KM_PER_UNIT = 0.4;
const VEHICLES = {
  bike: { label: 'Bike', base: 500, perKm: 100 },
  car: { label: 'Car', base: 1000, perKm: 180 },
  van: { label: 'Van', base: 2000, perKm: 280 },
};
const ITEMS = ['Documents', 'Electronics/Gadgets', 'Food Items/Groceries', 'Clothing', 'Other'];
const MIN_PRICE = 100;
const MAX_PRICE = 5000000;
const OPEN_STATES = ['agreed', 'picked_up'];

// ---------- Persistence ----------
let db;
function seed() {
  const mk = (n, name, phone, vehicle, plate) => ({
    id: 'd' + n, name, phone, vehicle, plate, status: 'online',
    rating: 4.8, ratingCount: 10, completed: 0,
  });
  return {
    settings: { commissionPerDay: DEFAULT_COMMISSION },
    nextJobId: 1,
    nextDriverId: 6,
    drivers: [
      mk(1, 'Emeka Obi', '08031230001', 'bike', 'LSR-221-KJA'),
      mk(2, 'Amina Yusuf', '08031230002', 'bike', 'LSR-318-APP'),
      mk(3, 'Tunde Bello', '08031230003', 'car', 'KJA-742-GH'),
      mk(4, 'Grace Okon', '08031230004', 'car', 'EKY-190-BC'),
      mk(5, 'Ibrahim Musa', '08031230005', 'van', 'LND-563-AA'),
    ],
    jobs: [],
    ledger: [], // one entry per courier per working day
  };
}
function load() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!db.jobs || !db.ledger || !db.settings) throw new Error('old format');
  } catch { db = seed(); flush(); }
}
function flush() {
  const tmp = DATA_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, DATA_FILE); }
  catch (e) { console.error('save failed', e.message); }
}
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 100); }

// ---------- Helpers ----------
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const need = (cond, code, msg) => { if (!cond) throw httpErr(code, msg); };
const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const place = (id) => PLACES.find((p) => p.id === id);
const dayOf = (ts = Date.now()) => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
const kmBetween = (a, b) => Math.max(1, Math.round(Math.hypot(a.x - b.x, a.y - b.y) * KM_PER_UNIT * 10) / 10);

function suggest(a, b, vehicle) {
  const v = VEHICLES[vehicle];
  const km = kmBetween(a, b);
  const fare = Math.max(v.base, v.base + km * v.perKm);
  return { km, minutes: Math.max(5, Math.round((km / 25) * 60)), fare: Math.round(fare / 50) * 50 };
}
function priceOf(v) {
  const n = Number(v);
  need(Number.isInteger(n) && n >= MIN_PRICE && n <= MAX_PRICE, 400, `Price must be a whole number from ₦${MIN_PRICE} to ₦${MAX_PRICE.toLocaleString('en-NG')}`);
  return n;
}
const getJob = (id) => { const j = db.jobs.find((j) => String(j.id) === String(id)); need(j, 404, 'Delivery not found'); return j; };
const getDriver = (id) => { const d = db.drivers.find((d) => d.id === id); need(d, 404, 'Courier not found'); return d; };
const isBusy = (d) => db.jobs.some((j) => j.driverId === d.id && OPEN_STATES.includes(j.status));
const lastOf = (n) => n.history[n.history.length - 1];
const turnOf = (n) => (n.status === 'active' ? (lastOf(n).by === 'driver' ? 'sender' : 'driver') : null);

// ---------- Views (what each side is allowed to see) ----------
const driverPub = (d) => ({
  id: d.id, name: d.name, vehicle: d.vehicle, plate: d.plate, rating: d.rating,
  ratingCount: d.ratingCount, completed: d.completed, status: d.status,
});
function baseJob(j) {
  const { negotiations, declinedBy, senderId, ...rest } = j;
  return rest;
}
function senderView(j) {
  return {
    ...baseJob(j),
    negotiations: j.negotiations.map((n) => ({ ...n, turn: turnOf(n), driver: driverPub(getDriver(n.driverId)) })),
    driver: j.driverId ? { ...driverPub(getDriver(j.driverId)), phone: getDriver(j.driverId).phone } : null,
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

// ---------- Deal logic ----------
function seal(job, driver, price) {
  need(job.status === 'open', 409, 'This delivery already has a deal');
  need(driver.status === 'online', 409, 'This courier is offline');
  need(!isBusy(driver), 409, 'This courier is already on a delivery');
  let n = job.negotiations.find((x) => x.driverId === driver.id);
  if (!n) { n = { driverId: driver.id, history: [{ by: 'sender', price: job.openingPrice, at: Date.now() }], status: 'active' }; job.negotiations.push(n); }
  job.negotiations.forEach((x) => { if (x !== n && x.status === 'active') x.status = 'closed'; });
  n.status = 'sealed';
  job.status = 'agreed';
  job.driverId = driver.id;
  job.agreedPrice = price;
  job.timeline.push({ status: 'agreed', at: Date.now(), note: `${driver.name} at ${price}` });
}

function chargeCommission(driverId, jobId) {
  const date = dayOf();
  if (db.ledger.some((l) => l.driverId === driverId && l.date === date)) return;
  db.ledger.push({ driverId, date, amount: db.settings.commissionPerDay, jobId });
}

function senderAction(job, action, body) {
  need(job.senderId === str(body.senderId, 60), 403, 'This is not your delivery');
  need(job.status === 'open', 409, 'This delivery is no longer open for offers');
  const n = job.negotiations.find((x) => x.driverId === body.driverId);
  need(n && n.status === 'active', 404, 'No active offer from this courier');
  const last = lastOf(n);
  need(last.by === 'driver', 409, "It is the courier's turn to respond");
  if (action === 'counter') n.history.push({ by: 'sender', price: priceOf(body.price), at: Date.now() });
  else if (action === 'accept') seal(job, getDriver(n.driverId), last.price);
  else if (action === 'decline') n.status = 'declined';
  else throw httpErr(404, 'Not found');
  return senderView(job);
}

function driverAction(job, action, body) {
  const d = getDriver(str(body.driverId, 20));
  const n = job.negotiations.find((x) => x.driverId === d.id);
  const openChecks = () => {
    need(job.status === 'open', 409, 'This delivery is no longer open');
    need(d.status === 'online', 409, 'Go online first');
    need(d.vehicle === job.vehicle, 409, `This delivery needs a ${VEHICLES[job.vehicle].label.toLowerCase()}`);
    need(!job.declinedBy.includes(d.id) && !(n && ['declined', 'withdrawn'].includes(n.status)), 409, 'You can no longer make offers on this delivery');
  };
  switch (action) {
    case 'accept': {
      openChecks();
      if (n) { need(n.status === 'active' && lastOf(n).by === 'sender', 409, "It is the sender's turn to respond"); seal(job, d, lastOf(n).price); }
      else seal(job, d, job.openingPrice);
      break;
    }
    case 'counter': {
      openChecks();
      const price = priceOf(body.price);
      let neg = n;
      if (!neg) { neg = { driverId: d.id, history: [{ by: 'sender', price: job.openingPrice, at: Date.now() }], status: 'active' }; job.negotiations.push(neg); }
      need(neg.status === 'active' && lastOf(neg).by === 'sender', 409, "It is the sender's turn to respond");
      neg.history.push({ by: 'driver', price, at: Date.now() });
      break;
    }
    case 'reject': {
      need(job.status === 'open', 409, 'This delivery is no longer open');
      if (n && n.status === 'active') n.status = 'withdrawn';
      if (!job.declinedBy.includes(d.id)) job.declinedBy.push(d.id);
      break;
    }
    case 'pickup': {
      need(job.driverId === d.id && job.status === 'agreed', 409, 'This delivery is not ready for pickup');
      job.status = 'picked_up';
      job.timeline.push({ status: 'picked_up', at: Date.now() });
      break;
    }
    case 'deliver': {
      need(job.driverId === d.id && job.status === 'picked_up', 409, 'Pick the package up first');
      job.status = 'delivered';
      job.deliveredAt = Date.now();
      job.deliveredDate = dayOf();
      job.timeline.push({ status: 'delivered', at: Date.now() });
      d.completed += 1;
      chargeCommission(d.id, job.id);
      break;
    }
    case 'withdraw': {
      need(job.driverId === d.id && job.status === 'agreed', 409, 'You can only pull out before pickup');
      job.status = 'open';
      job.driverId = null;
      job.agreedPrice = null;
      job.declinedBy.push(d.id);
      job.negotiations.forEach((x) => { if (x.driverId === d.id) x.status = 'withdrawn'; else if (x.status === 'closed') x.status = 'active'; });
      job.timeline.push({ status: 'courier_withdrew', at: Date.now(), note: d.name });
      break;
    }
    default: throw httpErr(404, 'Not found');
  }
  return driverView(job, d.id);
}

function createJob(body) {
  const a = place(body.pickupAreaId), b = place(body.dropAreaId);
  need(a && b, 400, 'Choose a pickup and a delivery area');
  const pickupAddress = str(body.pickupAddress, 120), dropAddress = str(body.dropAddress, 120);
  need(pickupAddress && dropAddress, 400, 'Enter the pickup and delivery addresses');
  const senderId = str(body.senderId, 60), senderName = str(body.senderName, 60);
  need(senderId && senderName, 400, 'Your name is required');
  need(VEHICLES[body.vehicle], 400, 'Choose a vehicle type');
  need(ITEMS.includes(body.itemType), 400, 'Choose what you are sending');
  const quantity = Number(body.quantity);
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
  const est = suggest(a, b, body.vehicle);
  const openingPrice = body.openingPrice === undefined || body.openingPrice === '' ? est.fare : priceOf(body.openingPrice);
  const job = {
    id: db.nextJobId++, senderId, senderName, senderPhone: str(body.senderPhone, 20),
    deliveryType, scheduledAt,
    pickup: { areaId: a.id, area: a.name, address: pickupAddress },
    drop: { areaId: b.id, area: b.name, address: dropAddress },
    itemType: body.itemType, quantity, note: str(body.note, 200),
    recipientName, recipientPhone, vehicle: body.vehicle, payer, payment: body.payment,
    km: est.km, suggested: est.fare, openingPrice,
    status: 'open', driverId: null, agreedPrice: null,
    negotiations: [], declinedBy: [], createdAt: Date.now(),
    timeline: [{ status: 'open', at: Date.now() }],
  };
  db.jobs.push(job);
  return job;
}

// ---------- Feeds ----------
function earningsOf(driverId) {
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

function driverFeed(d) {
  const mineJobs = db.jobs.filter((j) => j.driverId === d.id);
  const open = db.jobs.filter((j) => j.status === 'open' && j.vehicle === d.vehicle && !j.declinedBy.includes(d.id));
  const neg = (j) => j.negotiations.find((n) => n.driverId === d.id);
  const newest = (a, b) => b.createdAt - a.createdAt;
  return {
    driver: { ...driverPub(d), phone: d.phone },
    available: open.filter((j) => !neg(j)).sort(newest).map((j) => driverView(j, d.id)),
    offers: open.filter((j) => neg(j) && neg(j).status === 'active').sort(newest).map((j) => driverView(j, d.id)),
    current: mineJobs.filter((j) => OPEN_STATES.includes(j.status)).map((j) => driverView(j, d.id)),
    history: mineJobs.filter((j) => j.status === 'delivered' || j.status === 'cancelled').sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0)).slice(0, 30).map((j) => driverView(j, d.id)),
    earnings: earningsOf(d.id),
  };
}

function adminFeed() {
  const delivered = db.jobs.filter((j) => j.status === 'delivered');
  return {
    settings: db.settings,
    totals: {
      jobs: db.jobs.length,
      open: db.jobs.filter((j) => j.status === 'open').length,
      active: db.jobs.filter((j) => OPEN_STATES.includes(j.status)).length,
      delivered: delivered.length,
      dealValue: delivered.reduce((s, j) => s + j.agreedPrice, 0),
      commission: db.ledger.reduce((s, l) => s + l.amount, 0),
    },
    drivers: db.drivers.map((d) => ({ ...driverPub(d), phone: d.phone, earnings: earningsOf(d.id) })),
    jobs: db.jobs.slice(-60).reverse().map((j) => ({ ...baseJob(j), offers: j.negotiations.length })),
    ledger: db.ledger.slice(-60).reverse(),
  };
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) { reject(httpErr(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(httpErr(400, 'Invalid JSON')); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function adminOk(req) {
  if (!ADMIN_PIN) return true;
  const got = Buffer.from(String(req.headers['x-admin-pin'] || '')), want = Buffer.from(ADMIN_PIN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const m = req.method;
  const body = m === 'POST' ? await readBody(req) : {};
  const ok = (code, obj) => { save(); return send(res, code, obj); };

  if (m === 'GET' && parts[0] === 'meta') {
    return send(res, 200, { places: PLACES, vehicles: VEHICLES, items: ITEMS, commissionPerDay: db.settings.commissionPerDay, adminPinRequired: !!ADMIN_PIN, min: MIN_PRICE, max: MAX_PRICE });
  }
  if (m === 'POST' && parts[0] === 'estimate') {
    const a = place(body.pickupAreaId), b = place(body.dropAreaId);
    need(a && b && VEHICLES[body.vehicle], 400, 'Choose areas and a vehicle');
    return send(res, 200, suggest(a, b, body.vehicle));
  }

  if (parts[0] === 'sender' && m === 'GET' && parts[2] === 'jobs') {
    const id = str(parts[1], 60);
    return send(res, 200, { jobs: db.jobs.filter((j) => j.senderId === id).sort((a, b) => b.createdAt - a.createdAt).map(senderView) });
  }

  if (parts[0] === 'jobs') {
    if (m === 'POST' && parts.length === 1) return ok(201, senderView(createJob(body)));
    const job = getJob(parts[1]);
    if (m === 'POST' && parts[2] === 'cancel') {
      need(job.senderId === str(body.senderId, 60), 403, 'This is not your delivery');
      need(['open', 'agreed'].includes(job.status), 409, 'It is too late to cancel this delivery');
      job.status = 'cancelled';
      job.timeline.push({ status: 'cancelled', at: Date.now() });
      return ok(200, senderView(job));
    }
    if (m === 'POST' && parts[2] === 'rate') {
      need(job.senderId === str(body.senderId, 60), 403, 'This is not your delivery');
      need(job.status === 'delivered', 409, 'The delivery is not complete yet');
      need(!job.rating, 409, 'You already rated this delivery');
      const n = Number(body.rating);
      need(Number.isInteger(n) && n >= 1 && n <= 5, 400, 'Rating must be from 1 to 5');
      job.rating = n;
      const d = getDriver(job.driverId);
      d.rating = Math.round(((d.rating * d.ratingCount + n) / (d.ratingCount + 1)) * 100) / 100;
      d.ratingCount += 1;
      return ok(200, senderView(job));
    }
    if (m === 'POST' && parts[2] === 'sender') return ok(200, senderAction(job, parts[3], body));
    if (m === 'POST' && parts[2] === 'driver') return ok(200, driverAction(job, parts[3], body));
  }

  if (parts[0] === 'drivers') {
    if (m === 'GET' && parts.length === 1) return send(res, 200, { drivers: db.drivers.map(driverPub) });
    if (m === 'POST' && parts.length === 1) {
      const name = str(body.name, 60), phone = str(body.phone, 20), plate = str(body.plate, 15);
      need(name && plate, 400, 'Name and plate number are required');
      need(/^[+\d][\d\s-]{6,18}$/.test(phone), 400, 'Enter a valid phone number');
      need(VEHICLES[body.vehicle], 400, 'Choose a vehicle type');
      const d = { id: 'd' + db.nextDriverId++, name, phone, vehicle: body.vehicle, plate, status: 'offline', rating: 5, ratingCount: 0, completed: 0 };
      db.drivers.push(d);
      return ok(201, driverPub(d));
    }
    if (m === 'POST' && parts[2] === 'status') {
      const d = getDriver(parts[1]);
      need(['online', 'offline'].includes(body.status), 400, 'Status must be online or offline');
      need(!(body.status === 'offline' && isBusy(d)), 409, 'Finish your current delivery first');
      d.status = body.status;
      return ok(200, driverPub(d));
    }
  }
  if (parts[0] === 'driver' && m === 'GET') return send(res, 200, driverFeed(getDriver(parts[1])));

  if (parts[0] === 'admin') {
    need(adminOk(req), 401, 'Enter the admin PIN');
    if (m === 'GET') return send(res, 200, adminFeed());
    if (m === 'POST' && parts[1] === 'settings') {
      const c = Number(body.commissionPerDay);
      need(Number.isInteger(c) && c >= 0 && c <= 100000, 400, 'Commission must be a whole number from 0 to 100,000');
      db.settings.commissionPerDay = c;
      return ok(200, adminFeed());
    }
  }
  throw httpErr(404, 'Not found');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(file);
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      // The service worker and page shell must always revalidate so updates reach installed apps.
      if (ext === '.html' || path.basename(file) === 'sw.js' || ext === '.webmanifest') headers['Cache-Control'] = 'no-cache';
      if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
      res.writeHead(200, headers);
      res.end(buf);
    });
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});

load();
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`Bargo running at http://localhost:${PORT}`));
}
module.exports = server;
