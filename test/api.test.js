const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, RUMUOLA, MILE1, phone } = require('./helpers');
const { createApp } = require('../lib/app');
const { FileStore } = require('../lib/storage');
const { createServer } = require('../local');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(() => ctx.server.close());

const newClient = () => client(ctx.base);
async function register(role, name, extra = {}) {
  const c = newClient();
  const p = extra.phone || phone();
  const r = await c.call('auth/register', { role, name, phone: p, password: 'password123', ...(role === 'driver' ? { vehicle: 'bike', plate: 'RV-123-AA' } : {}), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  c.user = r.json.user; c.phone = p;
  return c;
}
async function courier(vehicle = 'bike') {
  const c = await register('driver', 'Courier ' + phone().slice(-4), { vehicle });
  assert.equal((await c.call('driver/status', { status: 'online' })).status, 200);
  return c;
}
const jobBody = (over = {}) => ({
  pickup: RUMUOLA, drop: MILE1, vehicle: 'bike', itemType: 'Electronics/Gadgets', quantity: 1,
  recipientName: 'Paul Pogba', recipientPhone: '08123456789', payer: 'sender', payment: 'cash', openingPrice: 4000, ...over,
});
const post = async (sender, over) => { const r = await sender.call('jobs', jobBody(over)); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json; };
const act = (c, jobId, who, action, extra = {}) => c.call(`jobs/${jobId}/${who}/${action}`, extra);

test('serves the app and PWA files', async () => {
  for (const p of ['/', '/manifest.webmanifest', '/sw.js', '/app.js', '/tilemap.js', '/icons/icon-192.png', '/icons/icon-512.png']) {
    const res = await fetch(ctx.base + p);
    assert.equal(res.status, 200, p);
  }
});

test('blocks path traversal', async () => {
  const res = await fetch(ctx.base + '/..%2flocal.js');
  assert.notEqual(res.status, 200);
});

test('meta says Port Harcourt, not Lagos', async () => {
  const meta = (await newClient().call('meta')).json;
  assert.equal(meta.city, 'Port Harcourt');
  assert.equal(meta.commissionPerDay, 500);
  assert.equal(meta.adminEnabled, true);
  assert.ok(meta.areas.includes('Rumuola'));
  assert.ok(!JSON.stringify(meta).includes('Lagos'));
  assert.ok(meta.bounds.south < 4.8 && meta.bounds.north > 4.9);
});

test('registration validates input and normalises phone numbers', async () => {
  const c = newClient();
  const ok = { role: 'sender', name: 'Ada Obi', phone: '08031234567', password: 'longenough1' };
  assert.equal((await c.call('auth/register', { ...ok, phone: '123' })).status, 400);
  assert.equal((await c.call('auth/register', { ...ok, password: 'short' })).status, 400);
  assert.equal((await c.call('auth/register', { ...ok, name: '' })).status, 400);
  assert.equal((await c.call('auth/register', { ...ok, role: 'admin' })).status, 400);
  assert.equal((await c.call('auth/register', { role: 'driver', name: 'Bayo', phone: '08031230099', password: 'longenough1' })).status, 400); // needs vehicle
  const r = await c.call('auth/register', ok);
  assert.equal(r.status, 201);
  assert.equal(r.json.user.phone, '+2348031234567');
  assert.ok(/HttpOnly/i.test(r.setCookie[0]) && /SameSite=Lax/i.test(r.setCookie[0]));
  assert.ok(!JSON.stringify(r.json).includes('passHash'));
  // the same number written another way is a duplicate
  assert.equal((await newClient().call('auth/register', { ...ok, phone: '+2348031234567' })).status, 409);
  // the same number can hold a sender account and a courier account
  assert.equal((await newClient().call('auth/register', { role: 'driver', name: 'Ada Obi', phone: '08031234567', password: 'longenough1', vehicle: 'car', plate: 'ABC-1' })).status, 201);
});

test('login works, wrong credentials share one message, and repeated failures lock the account', async () => {
  const a = await register('sender', 'Login Tester');
  const c = newClient();
  assert.equal((await c.call('me')).status, 401);
  const bad1 = await c.call('auth/login', { role: 'sender', phone: a.phone, password: 'wrong-password' });
  const bad2 = await c.call('auth/login', { role: 'sender', phone: '08099990000', password: 'password123' });
  assert.equal(bad1.status, 401);
  assert.equal(bad2.status, 401);
  assert.equal(bad1.json.error, bad2.json.error); // does not reveal which numbers have accounts
  const good = await c.call('auth/login', { role: 'sender', phone: a.phone, password: 'password123' });
  assert.equal(good.status, 200);
  assert.equal(good.json.user.name, 'Login Tester');
  assert.equal((await c.call('me')).json.user.role, 'sender');
  // wrong role for this phone number
  assert.equal((await newClient().call('auth/login', { role: 'driver', phone: a.phone, password: 'password123' })).status, 401);
  // lockout
  const victim = await register('sender', 'Locked Out');
  const attacker = newClient();
  for (let i = 0; i < 5; i++) assert.equal((await attacker.call('auth/login', { role: 'sender', phone: victim.phone, password: 'nope-nope-1' })).status, 401);
  const locked = await attacker.call('auth/login', { role: 'sender', phone: victim.phone, password: 'password123' });
  assert.equal(locked.status, 429);
  assert.match(locked.json.error, /Try again/);
});

test('sessions: logout, tampered cookies and role checks', async () => {
  const s = await register('sender', 'Session Sender');
  const d = await courier();
  assert.equal((await s.call('me')).status, 200);
  assert.equal((await s.call('driver/feed')).status, 403); // sender cannot use courier screens
  assert.equal((await d.call('sender/jobs')).status, 403);
  assert.equal((await d.call('admin')).status, 403);
  const forged = newClient();
  forged.cookie = s.cookie.slice(0, -3) + 'abc';
  assert.equal((await forged.call('me')).status, 401);
  const stolenBody = newClient();
  stolenBody.cookie = 'bargo_session=' + Buffer.from(JSON.stringify({ uid: 'u1', role: 'sender', tv: 0, exp: Date.now() + 1e9 })).toString('base64url') + '.AAAA';
  assert.equal((await stolenBody.call('me')).status, 401);
  assert.equal((await s.call('auth/logout', {})).status, 200);
  assert.equal((await s.call('me')).status, 401);
});

test('changing a password signs out other devices; old password stops working', async () => {
  const a = await register('sender', 'Pw Changer');
  const other = newClient();
  await other.call('auth/login', { role: 'sender', phone: a.phone, password: 'password123' });
  assert.equal((await a.call('me/password', { current: 'bad-current', next: 'newpassword1' })).status, 401);
  assert.equal((await a.call('me/password', { current: 'password123', next: 'short' })).status, 400);
  assert.equal((await a.call('me/password', { current: 'password123', next: 'newpassword1' })).status, 200);
  assert.equal((await a.call('me')).status, 200); // this device stays signed in
  assert.equal((await other.call('me')).status, 401); // the other one is signed out
  assert.equal((await newClient().call('auth/login', { role: 'sender', phone: a.phone, password: 'password123' })).status, 401);
  assert.equal((await newClient().call('auth/login', { role: 'sender', phone: a.phone, password: 'newpassword1' })).status, 200);
});

test('service area and distance: Port Harcourt only, road distance used only when plausible', async () => {
  const s = await register('sender', 'Distance Sender');
  const lagos = { lat: 6.45, lng: 3.39, label: 'Lagos' };
  assert.equal((await s.call('estimate', { pickup: lagos, drop: MILE1, vehicle: 'bike' })).status, 400);
  assert.equal((await s.call('jobs', jobBody({ pickup: lagos }))).status, 400);
  const base = (await s.call('estimate', { pickup: RUMUOLA, drop: MILE1, vehicle: 'bike' })).json;
  assert.ok(base.straight > 4 && base.straight < 8, 'straight-line distance should be about 5-6 km, got ' + base.straight);
  assert.equal(base.approx, true);
  assert.ok(Math.abs(base.km - base.straight * 1.35) < 0.15);
  const real = (await s.call('estimate', { pickup: RUMUOLA, drop: MILE1, vehicle: 'bike', routeKm: 7.4 })).json;
  assert.equal(real.km, 7.4);
  assert.equal(real.approx, false);
  const silly = (await s.call('estimate', { pickup: RUMUOLA, drop: MILE1, vehicle: 'bike', routeKm: 900 })).json;
  assert.equal(silly.approx, true); // an absurd distance from a phone is ignored
  const impossible = (await s.call('estimate', { pickup: RUMUOLA, drop: MILE1, vehicle: 'bike', routeKm: 0.2 })).json;
  assert.equal(impossible.approx, true);
  const car = (await s.call('estimate', { pickup: RUMUOLA, drop: MILE1, vehicle: 'car', routeKm: 7.4 })).json;
  const van = (await s.call('estimate', { pickup: RUMUOLA, drop: MILE1, vehicle: 'van', routeKm: 7.4 })).json;
  assert.ok(real.fare < car.fare && car.fare < van.fare);
  const far = (await s.call('estimate', { pickup: RUMUOLA, drop: { lat: 5.0155, lng: 6.9496, label: 'Airport' }, vehicle: 'bike' })).json;
  assert.ok(far.km > 20 && far.fare > base.fare);
});

test('validates new deliveries and needs a login', async () => {
  const s = await register('sender', 'Validator');
  assert.equal((await newClient().call('jobs', jobBody())).status, 401);
  assert.equal((await s.call('jobs', jobBody({ recipientName: '' }))).status, 400);
  assert.equal((await s.call('jobs', jobBody({ recipientPhone: 'abc' }))).status, 400);
  assert.equal((await s.call('jobs', jobBody({ vehicle: 'plane' }))).status, 400);
  assert.equal((await s.call('jobs', jobBody({ openingPrice: 5 }))).status, 400);
  assert.equal((await s.call('jobs', jobBody({ itemType: 'Weapons' }))).status, 400);
  assert.equal((await s.call('jobs', jobBody({ deliveryType: 'scheduled', scheduledAt: '2000-01-01T10:00' }))).status, 400);
  const ok = await s.call('jobs', jobBody({ routeKm: 7.4, routeGeo: [[4.8315, 7.0194], [4.81, 7.01], [4.787, 7.0013]] }));
  assert.equal(ok.status, 201);
  assert.equal(ok.json.km, 7.4);
  assert.equal(ok.json.routeGeo.length, 3);
  const noGeo = await s.call('jobs', jobBody({ routeKm: 7.4, routeGeo: [[1, 1], [2, 2]] })); // outside the area, dropped
  assert.equal(noGeo.json.routeGeo, null);
});

test('a courier accepting the opening price seals the deal; contacts stay hidden until then', async () => {
  const s = await register('sender', 'Chidi Eze');
  const c = await courier('bike');
  const job = await post(s);
  const feed = (await c.call('driver/feed')).json;
  const seen = feed.available.find((j) => j.id === job.id);
  assert.ok(seen);
  assert.equal(seen.recipientPhone, undefined);
  assert.equal(seen.senderPhone, undefined);
  assert.equal(seen.senderName, 'Chidi');
  const r = await act(c, job.id, 'driver', 'accept');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'agreed');
  assert.equal(r.json.agreedPrice, 4000);
  assert.equal(r.json.recipientPhone, '08123456789');
  assert.equal(r.json.senderName, 'Chidi Eze');
  const mine = (await s.call('sender/jobs')).json.jobs.find((j) => j.id === job.id);
  assert.equal(mine.driver.id, c.user.id);
  assert.ok(mine.driver.phone);
});

test('negotiation: counter, counter back, accept; turns and ownership are enforced', async () => {
  const s = await register('sender', 'Negotiator');
  const intruder = await register('sender', 'Intruder');
  const c = await courier('bike');
  const job = await post(s);
  assert.equal((await act(c, job.id, 'driver', 'counter', { price: 6000 })).status, 200);
  assert.equal((await act(c, job.id, 'driver', 'counter', { price: 7000 })).status, 409);
  assert.equal((await act(c, job.id, 'driver', 'accept')).status, 409);
  assert.equal((await act(intruder, job.id, 'sender', 'accept', { driverId: c.user.id })).status, 403);
  assert.equal((await act(s, job.id, 'sender', 'counter', { driverId: c.user.id, price: 5000 })).status, 200);
  assert.equal((await act(s, job.id, 'sender', 'counter', { driverId: c.user.id, price: 4500 })).status, 409);
  const done = await act(c, job.id, 'driver', 'accept');
  assert.equal(done.status, 200);
  assert.equal(done.json.agreedPrice, 5000);
});

test('sender accepting a counter seals it and closes other offers; busy couriers are refused', async () => {
  const s = await register('sender', 'Chooser');
  const c1 = await courier('car'), c2 = await courier('car');
  const j = await post(s, { vehicle: 'car' });
  await act(c1, j.id, 'driver', 'counter', { price: 7000 });
  await act(c2, j.id, 'driver', 'counter', { price: 6500 });
  const sealed = await act(s, j.id, 'sender', 'accept', { driverId: c2.user.id });
  assert.equal(sealed.status, 200);
  assert.equal(sealed.json.agreedPrice, 6500);
  assert.equal(sealed.json.negotiations.find((n) => n.driverId === c1.user.id).status, 'closed');
  assert.equal((await act(c1, j.id, 'driver', 'accept')).status, 409);
  // c2 is now busy and cannot take a second delivery
  const j2 = await post(s, { vehicle: 'car' });
  assert.equal((await act(c2, j2.id, 'driver', 'accept')).status, 409);
});

test('couriers only see deliveries for their vehicle and can reject', async () => {
  const s = await register('sender', 'Van Sender');
  const van = await courier('van'), bike = await courier('bike');
  const job = await post(s, { vehicle: 'van' });
  assert.ok((await van.call('driver/feed')).json.available.some((j) => j.id === job.id));
  assert.ok(!(await bike.call('driver/feed')).json.available.some((j) => j.id === job.id));
  assert.equal((await act(bike, job.id, 'driver', 'accept')).status, 409);
  await act(van, job.id, 'driver', 'reject');
  assert.ok(!(await van.call('driver/feed')).json.available.some((j) => j.id === job.id));
});

test('full delivery: pickup, deliver, rate; commission is charged once per day', async () => {
  const s = await register('sender', 'Full Flow');
  const c = await courier('car');
  const a = await post(s, { vehicle: 'car', openingPrice: 8000 });
  const b = await post(s, { vehicle: 'car', openingPrice: 3000 });
  assert.equal((await act(c, a.id, 'driver', 'accept')).json.agreedPrice, 8000);
  assert.equal((await act(c, b.id, 'driver', 'accept')).status, 409);
  assert.equal((await act(c, a.id, 'driver', 'deliver')).status, 409);
  assert.equal((await act(c, a.id, 'driver', 'pickup')).json.status, 'picked_up');
  assert.equal((await act(c, a.id, 'driver', 'deliver', { code: a.deliveryCode })).json.status, 'delivered');
  let e = (await c.call('driver/feed')).json.earnings;
  assert.deepEqual([e.gross, e.commission, e.net], [8000, 500, 7500]);
  await act(c, b.id, 'driver', 'accept');
  await act(c, b.id, 'driver', 'pickup');
  await act(c, b.id, 'driver', 'deliver', { code: b.deliveryCode });
  e = (await c.call('driver/feed')).json.earnings;
  assert.deepEqual([e.gross, e.commission, e.net, e.commissionDueToday], [11000, 500, 10500, 0]);
  assert.equal((await s.call(`jobs/${a.id}/rate`, { rating: 9 })).status, 400);
  assert.equal((await s.call(`jobs/${a.id}/rate`, { rating: 5 })).status, 200);
  assert.equal((await s.call(`jobs/${a.id}/rate`, { rating: 5 })).status, 409);
});

test('a courier can pull out before pickup; senders cannot cancel after pickup', async () => {
  const s = await register('sender', 'Puller');
  const c = await courier('bike');
  const j = await post(s);
  await act(c, j.id, 'driver', 'accept');
  assert.equal((await c.call('driver/status', { status: 'offline' })).status, 409);
  assert.equal((await act(c, j.id, 'driver', 'withdraw')).json.status, 'open');
  assert.equal((await act(c, j.id, 'driver', 'accept')).status, 409);
  const j2 = await post(s);
  const c2 = await courier('bike');
  await act(c2, j2.id, 'driver', 'accept');
  await act(c2, j2.id, 'driver', 'pickup');
  assert.equal((await s.call(`jobs/${j2.id}/cancel`, {})).status, 409);
});

test('admin: PIN login, commission change applies to later days, password reset for forgotten passwords', async () => {
  const admin = newClient();
  assert.equal((await admin.call('admin')).status, 401);
  assert.equal((await admin.call('auth/admin', { pin: 'wrong' })).status, 401);
  assert.equal((await admin.call('auth/admin', { pin: '4321' })).status, 200);
  const before = (await admin.call('admin')).json;
  assert.equal(before.settings.commissionPerDay, 500);
  assert.equal((await admin.call('admin/settings', { commissionPerDay: -5 })).status, 400);
  assert.equal((await admin.call('admin/settings', { commissionPerDay: 750 })).json.settings.commissionPerDay, 750);
  // a courier who has not delivered yet pays the new rate
  const s = await register('sender', 'Admin Test Sender');
  const c = await courier('bike');
  const j = await post(s, { openingPrice: 2000 });
  await act(c, j.id, 'driver', 'accept');
  await act(c, j.id, 'driver', 'pickup');
  await act(c, j.id, 'driver', 'deliver', { code: j.deliveryCode });
  const e = (await c.call('driver/feed')).json.earnings;
  assert.deepEqual([e.commission, e.net], [750, 1250]);
  await admin.call('admin/settings', { commissionPerDay: 500 });
  // forgotten password: admin resets it, old sessions end
  const reset = await admin.call(`admin/users/${s.user.id}/reset`, {});
  assert.equal(reset.status, 200);
  assert.ok(reset.json.tempPassword.length >= 8);
  assert.equal((await s.call('me')).status, 401);
  assert.equal((await newClient().call('auth/login', { role: 'sender', phone: s.phone, password: 'password123' })).status, 401);
  assert.equal((await newClient().call('auth/login', { role: 'sender', phone: s.phone, password: reset.json.tempPassword })).status, 200);
});

test('admin is switched off when no PIN is configured', async () => {
  const off = await startServer({ config: { adminPin: '' } });
  const c = client(off.base);
  assert.equal((await c.call('auth/admin', { pin: '' })).status, 503);
  assert.equal((await c.call('meta')).json.adminEnabled, false);
  off.server.close();
});

test('data survives a server restart (this is what broke on Vercel)', async () => {
  const first = await startServer();
  const s = client(first.base);
  const reg = await s.call('auth/register', { role: 'sender', name: 'Persistent Pat', phone: '08051112222', password: 'password123' });
  assert.equal(reg.status, 201);
  const posted = await s.call('jobs', jobBody());
  assert.equal(posted.status, 201);
  first.server.close();
  // a brand-new process pointed at the same storage
  const again = await startServer({ store: new FileStore(first.file) });
  const back = client(again.base);
  back.cookie = s.cookie; // the old session cookie still works
  assert.equal((await back.call('me')).json.user.name, 'Persistent Pat');
  const jobs = (await back.call('sender/jobs')).json.jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, posted.json.id);
  assert.equal((await client(again.base).call('auth/login', { role: 'sender', phone: '08051112222', password: 'password123' })).status, 200);
  again.server.close();
});

test('simultaneous actions never lose data', async () => {
  const s = await register('sender', 'Busy Sender');
  const jobs = await Promise.all(Array.from({ length: 6 }, () => s.call('jobs', jobBody())));
  assert.ok(jobs.every((r) => r.status === 201));
  const ids = new Set(jobs.map((r) => r.json.id));
  assert.equal(ids.size, 6);
  assert.equal((await s.call('sender/jobs')).json.jobs.length, 6);
});

test('unknown routes and bad input return JSON errors', async () => {
  const c = newClient();
  const r = await c.call('nothing');
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
  const res = await fetch(ctx.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(res.status, 400);
  const form = await fetch(ctx.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
});
