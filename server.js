// RideDispatch: a negotiated dispatch marketplace. Zero dependencies (Node 18+).
// Customers post a delivery with an opening price. Dispatch riders accept or counter.
// When one side accepts the other's latest price, the deal is sealed.
// The platform takes a flat commission per rider per active day (default 500 NGN).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TZ = 'Africa/Lagos';
const SESSION_MS = 30 * 24 * 3600 * 1000;

// ---------- Simulated city (0-100 grid) ----------
const PLACES = [
  { id: 'airport', name: 'Airport', x: 90, y: 12 },
  { id: 'station', name: 'Central Station', x: 50, y: 50 },
  { id: 'market', name: 'Main Market', x: 28, y: 62 },
  { id: 'univ', name: 'University', x: 15, y: 20 },
  { id: 'hospital', name: 'General Hospital', x: 70, y: 35 },
  { id: 'mall', name: 'City Mall', x: 78, y: 70 },
  { id: 'stadium', name: 'Stadium', x: 40, y: 15 },
  { id: 'harbor', name: 'Harbor', x: 55, y: 90 },
  { id: 'hotel', name: 'Grand Hotel', x: 62, y: 58 },
  { id: 'park', name: 'Riverside Park', x: 22, y: 88 },
];
const VEHICLES = { bike: { label: 'Motorbike', mult: 1 }, car: { label: 'Car', mult: 1.6 }, van: { label: 'Van', mult: 2.4 } };
const ITEMS = ['Electronics/Gadgets', 'Food items/Groceries', 'Documents', 'Clothing', 'Medicine', 'Other'];
const KM_PER_UNIT = 0.35;
const FARE = { base: 500, perKm: 150, perMin: 20, speedKmh: 30 };

// ---------- Persistence ----------
let db;
const blank = () => ({
  settings: { commissionPerDay: 500, minPrice: 300, maxPrice: 1000000 },
  next: { user: 1, delivery: 1, ledger: 1 },
  users: [], sessions: {}, deliveries: [], ledger: [],
});
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('save failed:', e.message); }
  }, 100);
}
function saveNow() { clearTimeout(saveTimer); fs.writeFileSync(DATA_FILE, JSON.stringify(db)); }

// ---------- Security helpers ----------
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const checkPin = (u, pin) => {
  const a = Buffer.from(hashPin(pin, u.salt), 'hex'), b = Buffer.from(u.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function makeUser(role, name, phone, pin, extra = {}) {
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: 'u' + db.next.user++, role, name, phone, salt, pinHash: hashPin(pin, salt), createdAt: Date.now(), ...extra };
  db.users.push(u);
  return u;
}
function newSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[sha(token)] = { userId: user.id, at: Date.now() };
  return token;
}

function bootstrap() {
  if (!db.users.some((u) => u.role === 'admin')) {
    const phone = process.env.ADMIN_PHONE || 'admin';
    const given = process.env.ADMIN_PIN;
    const pin = given || String(crypto.randomInt(100000, 999999));
    makeUser('admin', 'Admin', phone, pin);
    if (!given) console.log(`\n  Admin account created.\n  Phone: ${phone}\n  PIN:   ${pin}   (shown once; set ADMIN_PIN to choose your own)\n`);
    saveNow();
  }
  if (process.env.SEED_DEMO === '1' && !db.users.some((u) => u.role !== 'admin')) {
    makeUser('customer', 'Demo Customer', '08000000001', '1234');
    [['Emeka Obi', '08000000011', 'bike', 'RV-123-AA', 48, 45], ['Amina Yusuf', '08000000012', 'bike', 'RV-456-BB', 20, 60],
      ['Tunde Bello', '08000000013', 'car', 'RV-789-CC', 75, 30]].forEach(([n, p, v, pl, x, y]) =>
      makeUser('courier', n, p, '1234', { courier: { vehicle: v, plate: pl, online: true, x, y, rating: 4.8, ratingCount: 10, completed: 12 } }));
    saveNow();
    console.log('  SEED_DEMO=1: demo accounts created (customer 08000000001, riders 08000000011-13, PIN 1234). Do not use in production.');
  }
}
function load() {
  try { db = { ...blank(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch { db = blank(); }
  bootstrap();
}

// ---------- Helpers ----------
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const need = (cond, code, msg) => { if (!cond) throw httpErr(code, msg); };
const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const now = () => Date.now();
const dayKey = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));
const place = (id) => PLACES.find((p) => p.id === id);
const userById = (id) => db.users.find((u) => u.id === id);
const normPhone = (v) => String(v ?? '').replace(/[\s\-()]/g, '').toLowerCase();
const validPhone = (p) => /^\+?\d{7,15}$/.test(p);

function estimate(pickup, dropoff, vehicle) {
  const km = Math.hypot(pickup.x - dropoff.x, pickup.y - dropoff.y) * KM_PER_UNIT;
  const minutes = Math.max(1, Math.round((km / FARE.speedKmh) * 60));
  const raw = (FARE.base + km * FARE.perKm + minutes * FARE.perMin) * VEHICLES[vehicle].mult;
  const to50 = (n) => Math.max(db.settings.minPrice, Math.round(n / 50) * 50);
  return { km: round(km, 1), minutes, suggested: to50(raw), low: to50(raw * 0.8), high: to50(raw * 1.4) };
}
const parsePrice = (v) => {
  const n = Number(v);
  need(Number.isInteger(n) && n >= db.settings.minPrice && n <= db.settings.maxPrice, 400,
    `Price must be a whole number between ${db.settings.minPrice} and ${db.settings.maxPrice}`);
  return n;
};

const ACTIVE_JOB = ['sealed', 'picked_up'];
const activeJob = (courierId) => db.deliveries.find((d) => d.courierId === courierId && ACTIVE_JOB.includes(d.status));
const latest = (t) => t.history[t.history.length - 1];
const findDelivery = (id) => { const d = db.deliveries.find((x) => String(x.id) === String(id)); need(d, 404, 'Delivery not found'); return d; };

// ---------- Negotiation ----------
function courierCanBid(u, d) {
  need(u.courier.online, 409, 'Go online to send offers');
  need(u.courier.vehicle === d.vehicle, 403, 'This request needs a different vehicle');
  need(!activeJob(u.id), 409, 'Finish your current delivery first');
}
function threadFor(user, d, body, create) {
  if (user.role === 'courier') {
    let t = d.threads.find((x) => x.courierId === user.id);
    if (!t && create) {
      need(d.threads.filter((x) => x.status === 'active').length < 15, 409, 'Too many riders are negotiating on this request');
      t = { courierId: user.id, status: 'active', history: [{ by: 'customer', price: d.askPrice, at: d.createdAt }], updatedAt: now() };
      d.threads.push(t);
    }
    need(t, 404, 'No negotiation with this customer yet');
    return t;
  }
  need(d.customerId === user.id, 403, 'This is not your delivery');
  const t = d.threads.find((x) => x.courierId === body.courierId);
  need(t, 404, 'Rider not found on this request');
  return t;
}
const partyOf = (user) => (user.role === 'courier' ? 'courier' : 'customer');

function seal(d, thread, price, party) {
  const c = userById(thread.courierId);
  need(c && c.courier.online, 409, 'That rider is offline now. Pick another offer.');
  need(!activeJob(c.id), 409, 'That rider just took another delivery. Pick another offer.');
  const t = now();
  d.status = 'sealed'; d.courierId = c.id; d.agreedPrice = price; d.sealedAt = t;
  thread.status = 'accepted'; thread.updatedAt = t;
  thread.history.push({ by: party, price, at: t, accepted: true });
  d.threads.forEach((x) => { if (x !== thread && x.status === 'active') x.status = 'closed'; });
  // A rider can only run one delivery at a time, so their other open negotiations close.
  db.deliveries.forEach((o) => {
    if (o !== d && o.status === 'open') o.threads.forEach((x) => { if (x.courierId === c.id && x.status === 'active') x.status = 'closed'; });
  });
  d.timeline.push({ status: 'sealed', at: t, note: `Agreed at ${price}` });
}

function doOffer(user, d, body) {
  need(d.status === 'open', 409, 'This request is no longer open');
  const price = parsePrice(body.price);
  if (user.role === 'courier') courierCanBid(user, d);
  const thread = threadFor(user, d, body, user.role === 'courier');
  need(thread.status === 'active', 409, 'This negotiation has ended');
  need(thread.history.length < 20, 429, 'Negotiation limit reached. Accept or walk away.');
  const party = partyOf(user), last = latest(thread);
  if (last.by !== party && last.price === price) { seal(d, thread, price, party); return d; }
  thread.history.push({ by: party, price, at: now() });
  thread.updatedAt = now();
  return d;
}
function doAccept(user, d, body) {
  need(d.status === 'open', 409, 'This request is no longer open');
  if (user.role === 'courier') courierCanBid(user, d);
  const thread = threadFor(user, d, body, user.role === 'courier');
  need(thread.status === 'active', 409, 'This negotiation has ended');
  const party = partyOf(user), last = latest(thread);
  need(last.by !== party, 409, 'Wait for the other side to reply before accepting');
  seal(d, thread, last.price, party);
  return d;
}
function doLeave(user, d, body) {
  need(d.status === 'open', 409, 'This request is no longer open');
  const thread = threadFor(user, d, body, false);
  need(thread.status === 'active', 409, 'This negotiation has ended');
  thread.status = user.role === 'courier' ? 'withdrawn' : 'declined';
  thread.updatedAt = now();
  return d;
}

// ---------- Delivery lifecycle ----------
function advance(user, d) {
  need(d.courierId === user.id, 403, 'This is not your delivery');
  const t = now();
  if (d.status === 'sealed') {
    d.status = 'picked_up'; d.pickedUpAt = t; user.courier.x = d.pickup.x; user.courier.y = d.pickup.y;
  } else if (d.status === 'picked_up') {
    d.status = 'delivered'; d.deliveredAt = t; user.courier.x = d.dropoff.x; user.courier.y = d.dropoff.y; user.courier.completed += 1;
    const day = dayKey(t);
    if (!db.ledger.some((l) => l.courierId === user.id && l.date === day) && db.settings.commissionPerDay > 0) {
      db.ledger.push({ id: 'l' + db.next.ledger++, courierId: user.id, date: day, amount: db.settings.commissionPerDay, status: 'owed', deliveryId: d.id, createdAt: t });
    }
  } else throw httpErr(409, `Cannot advance a ${d.status} delivery`);
  d.timeline.push({ status: d.status, at: t });
}

// ---------- Serializers (privacy: recipient details only after sealing) ----------
const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, phone: u.phone, courier: u.courier || undefined });
const courierCard = (c, full) => ({
  id: c.id, name: c.name, vehicle: c.courier.vehicle, rating: c.courier.rating, ratingCount: c.courier.ratingCount, completed: c.courier.completed,
  ...(full ? { phone: c.phone, plate: c.courier.plate, x: c.courier.x, y: c.courier.y } : {}),
});
const threadView = (t) => {
  const c = userById(t.courierId), last = latest(t);
  return { courierId: t.courierId, status: t.status, history: t.history, price: last.price, turn: last.by === 'courier' ? 'customer' : 'courier', courier: c && courierCard(c, false) };
};
function deliveryBase(d) {
  return {
    id: d.id, status: d.status, pickup: d.pickup, dropoff: d.dropoff, vehicle: d.vehicle, item: d.item, quantity: d.quantity,
    payer: d.payer, payMethod: d.payMethod, note: d.note, askPrice: d.askPrice, suggested: d.suggested, km: d.km, minutes: d.minutes,
    agreedPrice: d.agreedPrice, createdAt: d.createdAt, timeline: d.timeline, rating: d.rating,
  };
}
const revealed = (d) => ['sealed', 'picked_up', 'delivered'].includes(d.status);
function forCustomer(d) {
  const c = d.courierId ? userById(d.courierId) : null;
  return {
    ...deliveryBase(d), recipientName: d.recipientName, recipientPhone: d.recipientPhone,
    threads: d.threads.map(threadView), courier: c && revealed(d) ? courierCard(c, true) : null,
  };
}
function forCourier(d, me) {
  const mine = d.courierId === me.id;
  const customer = userById(d.customerId);
  const t = d.threads.find((x) => x.courierId === me.id);
  return {
    ...deliveryBase(d), customerName: customer ? customer.name.split(' ')[0] : 'Customer',
    myThread: t ? threadView(t) : null,
    ...(mine && revealed(d) ? { recipientName: d.recipientName, recipientPhone: d.recipientPhone, customerPhone: customer && customer.phone } : {}),
  };
}

function earnings(me) {
  const done = db.deliveries.filter((d) => d.courierId === me.id && d.status === 'delivered');
  const days = [];
  for (let i = 0; i < 7; i++) {
    const key = dayKey(now() - i * 86400000);
    const ds = done.filter((d) => dayKey(d.deliveredAt) === key);
    const gross = ds.reduce((s, d) => s + d.agreedPrice, 0);
    const l = db.ledger.find((x) => x.courierId === me.id && x.date === key);
    const commission = l ? l.amount : 0;
    days.push({ date: key, deliveries: ds.length, gross, commission, net: gross - commission });
  }
  return {
    today: days[0], week: days, commissionPerDay: db.settings.commissionPerDay,
    owed: db.ledger.filter((l) => l.courierId === me.id && l.status === 'owed').reduce((s, l) => s + l.amount, 0),
    totalDelivered: done.length,
  };
}

function feedFor(user) {
  const ds = db.deliveries;
  if (user.role === 'customer') {
    return { deliveries: ds.filter((d) => d.customerId === user.id).slice(-60).reverse().map(forCustomer) };
  }
  if (user.role === 'courier') {
    const available = ds.filter((d) => d.status === 'open' && d.vehicle === user.courier.vehicle &&
      !d.threads.some((t) => t.courierId === user.id && t.status !== 'active')).slice(-40).reverse().map((d) => forCourier(d, user));
    const mine = ds.filter((d) => d.courierId === user.id).slice(-60).reverse().map((d) => forCourier(d, user));
    return { available, mine, earnings: earnings(user), me: publicUser(user) };
  }
  const couriers = db.users.filter((u) => u.role === 'courier').map((u) => ({ ...courierCard(u, true), online: u.courier.online }));
  const owedBy = {};
  db.ledger.forEach((l) => { if (l.status === 'owed') owedBy[l.courierId] = (owedBy[l.courierId] || 0) + l.amount; });
  return {
    deliveries: ds.slice(-100).reverse().map((d) => ({ ...deliveryBase(d), customer: (userById(d.customerId) || {}).name, courier: d.courierId ? (userById(d.courierId) || {}).name : null, threadCount: d.threads.length })),
    couriers: couriers.map((c) => ({ ...c, owed: owedBy[c.id] || 0 })),
    ledger: db.ledger.slice(-200).reverse().map((l) => ({ ...l, courier: (userById(l.courierId) || {}).name })),
    totals: {
      customers: db.users.filter((u) => u.role === 'customer').length, couriers: couriers.length, online: couriers.filter((c) => c.online).length,
      open: ds.filter((d) => d.status === 'open').length, active: ds.filter((d) => ACTIVE_JOB.includes(d.status)).length,
      delivered: ds.filter((d) => d.status === 'delivered').length,
      owed: db.ledger.filter((l) => l.status === 'owed').reduce((s, l) => s + l.amount, 0),
      collected: db.ledger.filter((l) => l.status === 'paid').reduce((s, l) => s + l.amount, 0),
    },
    settings: db.settings,
  };
}

// ---------- Routes ----------
const routes = [];
const route = (method, pattern, roles, fn) =>
  routes.push({ method, roles, fn, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

const attempts = new Map();
route('POST', '/api/auth/register', null, ({ body }) => {
  const role = body.role;
  need(['customer', 'courier'].includes(role), 400, 'Choose customer or rider');
  const name = str(body.name, 60), phone = normPhone(body.phone), pin = String(body.pin ?? '');
  need(name.length >= 2, 400, 'Enter your full name');
  need(validPhone(phone), 400, 'Enter a valid phone number');
  need(/^\d{4,6}$/.test(pin), 400, 'PIN must be 4 to 6 digits');
  need(!db.users.some((u) => u.phone === phone), 409, 'An account with this phone number already exists. Sign in instead.');
  const extra = {};
  if (role === 'courier') {
    const plate = str(body.plate, 15).toUpperCase();
    need(VEHICLES[body.vehicle], 400, 'Choose your vehicle');
    need(plate.length >= 3, 400, 'Enter your plate number');
    const p = PLACES[Math.floor(Math.random() * PLACES.length)];
    extra.courier = { vehicle: body.vehicle, plate, online: false, x: p.x, y: p.y, rating: 5, ratingCount: 0, completed: 0 };
  }
  const user = makeUser(role, name, phone, pin, extra);
  const token = newSession(user);
  save();
  return [201, { token, user: publicUser(user) }];
});
route('POST', '/api/auth/login', null, ({ body }) => {
  const phone = normPhone(body.phone);
  const a = attempts.get(phone) || { fails: 0, until: 0 };
  need(a.until < now(), 429, 'Too many attempts. Try again in a few minutes.');
  const user = db.users.find((u) => u.phone === phone);
  if (!user || !checkPin(user, body.pin ?? '')) {
    a.fails += 1;
    if (a.fails >= 5) { a.fails = 0; a.until = now() + 5 * 60000; }
    attempts.set(phone, a);
    throw httpErr(401, 'Wrong phone number or PIN');
  }
  attempts.delete(phone);
  for (const [k, s] of Object.entries(db.sessions)) if (now() - s.at > SESSION_MS) delete db.sessions[k];
  const token = newSession(user);
  save();
  return { token, user: publicUser(user) };
});
route('POST', '/api/auth/logout', 'any', ({ token }) => { delete db.sessions[sha(token)]; save(); return { ok: true }; });
route('GET', '/api/me', 'any', ({ user }) => publicUser(user));

route('GET', '/api/config', null, () => ({
  places: PLACES, vehicles: VEHICLES, items: ITEMS,
  settings: { commissionPerDay: db.settings.commissionPerDay, minPrice: db.settings.minPrice, maxPrice: db.settings.maxPrice },
}));
route('POST', '/api/estimate', null, ({ body }) => {
  const a = place(body.pickupId), b = place(body.dropoffId);
  need(a && b && VEHICLES[body.vehicle], 400, 'Choose pickup, drop-off and vehicle');
  return estimate(a, b, body.vehicle);
});
route('GET', '/api/feed', 'any', ({ user }) => feedFor(user));

route('POST', '/api/deliveries', ['customer'], ({ user, body }) => {
  const a = place(body.pickupId), b = place(body.dropoffId);
  need(a && b, 400, 'Choose a pickup and drop-off area');
  need(a.id !== b.id, 400, 'Pickup and drop-off must be different areas');
  need(VEHICLES[body.vehicle], 400, 'Choose a vehicle type');
  const pickupAddress = str(body.pickupAddress, 120), dropoffAddress = str(body.dropoffAddress, 120);
  need(pickupAddress && dropoffAddress, 400, 'Enter the street address for pickup and drop-off');
  need(ITEMS.includes(body.item), 400, 'Choose what you are sending');
  const quantity = Number(body.quantity);
  need(Number.isInteger(quantity) && quantity >= 1 && quantity <= 99, 400, 'Quantity must be between 1 and 99');
  need(['sender', 'recipient'].includes(body.payer), 400, 'Choose who pays');
  need(['cash', 'transfer'].includes(body.payMethod), 400, 'Choose a payment method');
  const recipientName = str(body.recipientName, 60), recipientPhone = normPhone(body.recipientPhone);
  need(recipientName.length >= 2, 400, 'Enter the recipient name');
  need(validPhone(recipientPhone), 400, 'Enter a valid recipient phone number');
  const askPrice = parsePrice(body.askPrice);
  need(db.deliveries.filter((d) => d.customerId === user.id && d.status === 'open').length < 5, 409, 'You already have 5 open requests. Cancel one first.');
  const est = estimate(a, b, body.vehicle);
  const d = {
    id: db.next.delivery++, customerId: user.id,
    pickup: { ...a, address: pickupAddress }, dropoff: { ...b, address: dropoffAddress },
    vehicle: body.vehicle, item: body.item, quantity, payer: body.payer, payMethod: body.payMethod,
    recipientName, recipientPhone, note: str(body.note, 200),
    askPrice, suggested: est.suggested, km: est.km, minutes: est.minutes,
    status: 'open', threads: [], courierId: null, agreedPrice: null, rating: null,
    createdAt: now(), timeline: [{ status: 'open', at: now(), note: `Asking ${askPrice}` }],
  };
  db.deliveries.push(d);
  save();
  return [201, forCustomer(d)];
});
route('POST', '/api/deliveries/:id/offer', ['customer', 'courier'], ({ user, params, body }) => { const d = doOffer(user, findDelivery(params.id), body); save(); return { ok: true, status: d.status }; });
route('POST', '/api/deliveries/:id/accept', ['customer', 'courier'], ({ user, params, body }) => { const d = doAccept(user, findDelivery(params.id), body); save(); return { ok: true, status: d.status }; });
route('POST', '/api/deliveries/:id/leave', ['customer', 'courier'], ({ user, params, body }) => { const d = doLeave(user, findDelivery(params.id), body); save(); return { ok: true, status: d.status }; });
route('POST', '/api/deliveries/:id/cancel', ['customer'], ({ user, params }) => {
  const d = findDelivery(params.id);
  need(d.customerId === user.id, 403, 'This is not your delivery');
  need(['open', 'sealed'].includes(d.status), 409, d.status === 'picked_up' ? 'The package is already on its way' : 'This delivery can no longer be cancelled');
  d.status = 'cancelled';
  d.threads.forEach((t) => { if (t.status === 'active') t.status = 'closed'; });
  d.timeline.push({ status: 'cancelled', at: now() });
  save();
  return { ok: true };
});
route('POST', '/api/deliveries/:id/advance', ['courier'], ({ user, params }) => { const d = findDelivery(params.id); advance(user, d); save(); return { ok: true, status: d.status }; });
route('POST', '/api/deliveries/:id/rate', ['customer'], ({ user, params, body }) => {
  const d = findDelivery(params.id);
  need(d.customerId === user.id, 403, 'This is not your delivery');
  need(d.status === 'delivered', 409, 'You can rate after delivery');
  need(!d.rating, 409, 'Already rated');
  const n = Number(body.rating);
  need(Number.isInteger(n) && n >= 1 && n <= 5, 400, 'Rating must be 1 to 5');
  d.rating = n;
  const c = userById(d.courierId).courier;
  c.rating = round((c.rating * c.ratingCount + n) / (c.ratingCount + 1), 2);
  c.ratingCount += 1;
  save();
  return { ok: true };
});

route('POST', '/api/me/courier', ['courier'], ({ user, body }) => {
  const c = user.courier;
  if (typeof body.online === 'boolean') {
    need(body.online || !activeJob(user.id), 409, 'Finish your current delivery before going offline');
    c.online = body.online;
  }
  if (body.x !== undefined || body.y !== undefined) {
    const x = Number(body.x), y = Number(body.y);
    need(x >= 0 && x <= 100 && y >= 0 && y <= 100, 400, 'Location must be inside the map');
    c.x = x; c.y = y;
  }
  save();
  return publicUser(user);
});

route('POST', '/api/admin/settings', ['admin'], ({ body }) => {
  const s = db.settings;
  if (body.commissionPerDay !== undefined) { const n = Number(body.commissionPerDay); need(Number.isInteger(n) && n >= 0 && n <= 100000, 400, 'Commission must be a whole number from 0 to 100000'); s.commissionPerDay = n; }
  if (body.minPrice !== undefined) { const n = Number(body.minPrice); need(Number.isInteger(n) && n >= 50 && n < s.maxPrice, 400, 'Minimum price must be at least 50'); s.minPrice = n; }
  save();
  return s;
});
route('POST', '/api/admin/ledger/:id/paid', ['admin'], ({ params }) => {
  const l = db.ledger.find((x) => x.id === params.id);
  need(l, 404, 'Entry not found');
  l.status = 'paid'; l.paidAt = now();
  save();
  return l;
});
route('POST', '/api/admin/couriers/:id/settle', ['admin'], ({ params }) => {
  let n = 0;
  db.ledger.forEach((l) => { if (l.courierId === params.id && l.status === 'owed') { l.status = 'paid'; l.paidAt = now(); n++; } });
  save();
  return { settled: n };
});

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e5) { reject(httpErr(413, 'Request too large')); req.destroy(); } });
    req.on('end', () => { try { const j = s ? JSON.parse(s) : {}; resolve(j && typeof j === 'object' ? j : {}); } catch { reject(httpErr(400, 'Invalid JSON')); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function authenticate(req) {
  const m = /^Bearer (\w{20,})$/.exec(req.headers.authorization || '');
  if (!m) return {};
  const s = db.sessions[sha(m[1])];
  if (!s || now() - s.at > SESSION_MS) return {};
  const user = userById(s.userId);
  return user ? { user, token: m[1] } : {};
}

async function api(req, res, url) {
  const r = routes.map((rt) => ({ rt, m: rt.method === req.method && rt.re.exec(url.pathname) })).find((x) => x.m);
  need(r, 404, 'Not found');
  const { user, token } = authenticate(req);
  if (r.rt.roles) {
    need(user, 401, 'Please sign in');
    need(r.rt.roles === 'any' || r.rt.roles.includes(user.role), 403, 'This action is not available for your account');
  }
  const body = req.method === 'POST' ? await readBody(req) : {};
  const out = r.rt.fn({ user, token, body, params: r.m.groups || {} });
  Array.isArray(out) ? send(res, out[0], out[1]) : send(res, 200, out);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { rel = '/'; }
    const file = path.join(PUBLIC_DIR, path.normalize(rel === '/' ? '/index.html' : rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...HEADERS });
      res.end(buf);
    });
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    if (!e.status) console.error(e);
  }
});

load();
if (require.main === module) {
  server.listen(PORT, () => console.log(`RideDispatch running at http://localhost:${PORT}`));
  process.on('SIGINT', () => { try { saveNow(); } catch { /* ignore */ } process.exit(0); });
}
module.exports = server;
