const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rd-')), 'data.json');
process.env.ADMIN_PHONE = 'admin';
process.env.ADMIN_PIN = '999999';
const server = require('../server');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

const call = async (p, body, token) => {
  const res = await fetch(base + '/api/' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

let counter = 0;
const phone = () => '0803' + String(1000000 + ++counter);
async function customer(name = 'Chidi Okeke') {
  const r = await call('auth/register', { role: 'customer', name, phone: phone(), pin: '1234' });
  assert.equal(r.status, 201);
  return { token: r.json.token, id: r.json.user.id };
}
async function courier(vehicle = 'bike', name = 'Rider One') {
  const r = await call('auth/register', { role: 'courier', name, phone: phone(), pin: '1234', vehicle, plate: 'RV-' + (100 + counter) });
  assert.equal(r.status, 201);
  await call('me/courier', { online: true }, r.json.token);
  return { token: r.json.token, id: r.json.user.id };
}
const order = (over = {}) => ({
  pickupId: 'station', dropoffId: 'mall', pickupAddress: '32 Samwell Sq', dropoffAddress: '21b Karimu Kotun St',
  vehicle: 'bike', item: 'Electronics/Gadgets', quantity: 1, payer: 'sender', payMethod: 'cash',
  recipientName: 'Donald Duck', recipientPhone: '08123456789', askPrice: 1500, ...over,
});
async function post(cust, over) {
  const r = await call('deliveries', order(over), cust.token);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
const feed = async (u) => (await call('feed', undefined, u.token)).json;
const adminLogin = async () => (await call('auth/login', { phone: 'admin', pin: '999999' })).json.token;

test('serves the app and blocks path traversal', async () => {
  const ok = await fetch(base + '/');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /RideDispatch/);
  assert.notEqual((await fetch(base + '/..%2fserver.js')).status, 200);
});

test('registration and sign-in validation', async () => {
  assert.equal((await call('auth/register', { role: 'admin', name: 'X', phone: '08011111111', pin: '1234' })).status, 400);
  assert.equal((await call('auth/register', { role: 'customer', name: 'Ab', phone: 'abc', pin: '1234' })).status, 400);
  assert.equal((await call('auth/register', { role: 'customer', name: 'Ab', phone: '08011111111', pin: '12' })).status, 400);
  assert.equal((await call('auth/register', { role: 'courier', name: 'Ab', phone: '08011111111', pin: '1234', vehicle: 'boat', plate: 'ABC' })).status, 400);
  const p = phone();
  assert.equal((await call('auth/register', { role: 'customer', name: 'Ada', phone: p, pin: '4321' })).status, 201);
  assert.equal((await call('auth/register', { role: 'customer', name: 'Ada', phone: p, pin: '4321' })).status, 409);
  assert.equal((await call('auth/login', { phone: p, pin: '0000' })).status, 401);
  const ok = await call('auth/login', { phone: p, pin: '4321' });
  assert.equal(ok.status, 200);
  assert.equal((await call('me', undefined, ok.json.token)).json.name, 'Ada');
  assert.equal(ok.json.user.pinHash, undefined);
  assert.equal(ok.json.user.salt, undefined);
});

test('PIN guessing is throttled', async () => {
  const p = phone();
  await call('auth/register', { role: 'customer', name: 'Lock Me', phone: p, pin: '1234' });
  for (let i = 0; i < 5; i++) await call('auth/login', { phone: p, pin: '0000' });
  assert.equal((await call('auth/login', { phone: p, pin: '1234' })).status, 429);
});

test('endpoints require the right role', async () => {
  const c = await customer(), r = await courier();
  assert.equal((await call('feed')).status, 401);
  assert.equal((await call('deliveries', order(), r.token)).status, 403);
  assert.equal((await call('me/courier', { online: true }, c.token)).status, 403);
  assert.equal((await call('admin/settings', { commissionPerDay: 1 }, c.token)).status, 403);
});

test('validates delivery requests', async () => {
  const c = await customer();
  const bad = async (over, code = 400) => assert.equal((await call('deliveries', order(over), c.token)).status, code, JSON.stringify(over));
  await bad({ askPrice: 10 });
  await bad({ askPrice: 1500.5 });
  await bad({ dropoffId: 'station' });
  await bad({ pickupAddress: '' });
  await bad({ vehicle: 'plane' });
  await bad({ quantity: 0 });
  await bad({ recipientPhone: 'nope' });
  await bad({ payer: 'nobody' });
});

test('riders only see matching requests and never the recipient before a deal', async () => {
  const c = await customer(), bike = await courier('bike'), van = await courier('van');
  const d = await post(c, { vehicle: 'bike' });
  const seen = (await feed(bike)).available.find((x) => x.id === d.id);
  assert.ok(seen);
  assert.equal(seen.recipientName, undefined);
  assert.equal(seen.recipientPhone, undefined);
  assert.equal(JSON.stringify(seen).includes('08123456789'), false);
  assert.equal((await feed(van)).available.some((x) => x.id === d.id), false);
  assert.equal((await call(`deliveries/${d.id}/offer`, { price: 1800 }, van.token)).status, 403);
});

test('negotiation: counters go back and forth until someone accepts', async () => {
  const c = await customer(), a = await courier('bike', 'Rider A'), b = await courier('bike', 'Rider B');
  const d = await post(c, { askPrice: 1500 });
  assert.equal((await call(`deliveries/${d.id}/offer`, { price: 2000 }, a.token)).status, 200);
  assert.equal((await call(`deliveries/${d.id}/offer`, { price: 2200 }, b.token)).status, 200);

  let cf = (await feed(c)).deliveries.find((x) => x.id === d.id);
  assert.equal(cf.threads.length, 2);
  const ta = cf.threads.find((t) => t.courierId === a.id);
  assert.equal(ta.price, 2000);
  assert.equal(ta.turn, 'customer');

  assert.equal((await call(`deliveries/${d.id}/offer`, { courierId: a.id, price: 1700 }, c.token)).status, 200);
  // A cannot accept their own latest offer, and the customer cannot accept their own counter
  assert.equal((await call(`deliveries/${d.id}/accept`, { courierId: a.id }, c.token)).status, 409);
  assert.equal((await call(`deliveries/${d.id}/offer`, { price: 1800 }, a.token)).status, 200);
  const acc = await call(`deliveries/${d.id}/accept`, { courierId: a.id }, c.token);
  assert.equal(acc.status, 200);
  assert.equal(acc.json.status, 'sealed');

  cf = (await feed(c)).deliveries.find((x) => x.id === d.id);
  assert.equal(cf.agreedPrice, 1800);
  assert.equal(cf.courier.name, 'Rider A');
  assert.ok(cf.courier.phone && cf.courier.plate);
  assert.equal(cf.threads.find((t) => t.courierId === b.id).status, 'closed');
  assert.equal((await feed(b)).available.some((x) => x.id === d.id), false);
  assert.equal((await call(`deliveries/${d.id}/offer`, { price: 1000 }, b.token)).status, 409);

  const af = (await feed(a)).mine.find((x) => x.id === d.id);
  assert.equal(af.recipientName, 'Donald Duck');
  assert.equal(af.recipientPhone, '08123456789');
});

test('accepting the opening price seals immediately, and so does matching it', async () => {
  const c = await customer(), a = await courier(), b = await courier();
  const d1 = await post(c, { askPrice: 1200 });
  const r1 = await call(`deliveries/${d1.id}/accept`, {}, a.token);
  assert.equal(r1.json.status, 'sealed');
  const d2 = await post(c, { askPrice: 1300 });
  const r2 = await call(`deliveries/${d2.id}/offer`, { price: 1300 }, b.token);
  assert.equal(r2.json.status, 'sealed');
  assert.equal((await feed(c)).deliveries.find((x) => x.id === d2.id).agreedPrice, 1300);
});

test('a rider can run only one delivery at a time', async () => {
  const c = await customer(), a = await courier();
  const d1 = await post(c, { askPrice: 1000 }), d2 = await post(c, { askPrice: 1000 }), d3 = await post(c, { askPrice: 1000 });
  await call(`deliveries/${d2.id}/offer`, { price: 1400 }, a.token);
  assert.equal((await call(`deliveries/${d1.id}/accept`, {}, a.token)).json.status, 'sealed');
  // their open negotiation on d2 closed when they took d1
  assert.equal((await call(`deliveries/${d2.id}/accept`, { courierId: a.id }, c.token)).status, 409);
  assert.equal((await call(`deliveries/${d3.id}/offer`, { price: 1200 }, a.token)).status, 409);
  assert.equal((await call('me/courier', { online: false }, a.token)).status, 409);
});

test('offline riders cannot bid', async () => {
  const c = await customer(), a = await courier();
  await call('me/courier', { online: false }, a.token);
  const d = await post(c);
  assert.equal((await call(`deliveries/${d.id}/offer`, { price: 1800 }, a.token)).status, 409);
});

test('walking away and declining end a negotiation', async () => {
  const c = await customer(), a = await courier(), b = await courier();
  const d = await post(c);
  await call(`deliveries/${d.id}/offer`, { price: 2000 }, a.token);
  await call(`deliveries/${d.id}/offer`, { price: 2100 }, b.token);
  assert.equal((await call(`deliveries/${d.id}/leave`, {}, a.token)).status, 200);
  assert.equal((await call(`deliveries/${d.id}/leave`, { courierId: b.id }, c.token)).status, 200);
  assert.equal((await call(`deliveries/${d.id}/accept`, { courierId: b.id }, c.token)).status, 409);
  const cf = (await feed(c)).deliveries.find((x) => x.id === d.id);
  assert.deepEqual(cf.threads.map((t) => t.status).sort(), ['declined', 'withdrawn']);
  assert.equal((await feed(a)).available.some((x) => x.id === d.id), false);
});

test('delivery lifecycle, cancel rules and rating', async () => {
  const c = await customer(), a = await courier(), other = await courier();
  const d = await post(c);
  await call(`deliveries/${d.id}/accept`, {}, a.token);
  assert.equal((await call(`deliveries/${d.id}/advance`, {}, other.token)).status, 403);
  assert.equal((await call(`deliveries/${d.id}/advance`, {}, a.token)).json.status, 'picked_up');
  assert.equal((await call(`deliveries/${d.id}/cancel`, {}, c.token)).status, 409);
  assert.equal((await call(`deliveries/${d.id}/rate`, { rating: 5 }, c.token)).status, 409);
  assert.equal((await call(`deliveries/${d.id}/advance`, {}, a.token)).json.status, 'delivered');
  assert.equal((await call(`deliveries/${d.id}/advance`, {}, a.token)).status, 409);
  assert.equal((await call(`deliveries/${d.id}/rate`, { rating: 9 }, c.token)).status, 400);
  assert.equal((await call(`deliveries/${d.id}/rate`, { rating: 4 }, c.token)).status, 200);
  assert.equal((await call(`deliveries/${d.id}/rate`, { rating: 4 }, c.token)).status, 409);
  assert.equal((await call('me', undefined, a.token)).json.courier.completed, 1);

  const d2 = await post(c);
  await call(`deliveries/${d2.id}/accept`, {}, a.token);
  assert.equal((await call(`deliveries/${d2.id}/cancel`, {}, c.token)).status, 200);
  const d3 = await post(c);
  assert.equal((await call(`deliveries/${d3.id}/accept`, {}, a.token)).json.status, 'sealed');
});

test('commission is a flat daily amount, charged once however many deliveries', async () => {
  const c = await customer(), a = await courier();
  const admin = await adminLogin();
  for (let i = 0; i < 3; i++) {
    const d = await post(c, { askPrice: 1000 + i * 100 });
    await call(`deliveries/${d.id}/accept`, {}, a.token);
    await call(`deliveries/${d.id}/advance`, {}, a.token);
    await call(`deliveries/${d.id}/advance`, {}, a.token);
  }
  const entries = (await feed({ token: admin })).ledger.filter((l) => l.courierId === a.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, 500);
  assert.equal(entries[0].status, 'owed');

  const e = (await feed(a)).earnings;
  assert.equal(e.today.deliveries, 3);
  assert.equal(e.today.gross, 3300);
  assert.equal(e.today.commission, 500);
  assert.equal(e.today.net, 2800);
  assert.equal(e.owed, 500);
});

test('admin can change the commission, see totals, and settle', async () => {
  const admin = await adminLogin();
  assert.equal((await call('admin/settings', { commissionPerDay: -5 }, admin)).status, 400);
  assert.equal((await call('admin/settings', { commissionPerDay: 700 }, admin)).json.commissionPerDay, 700);
  assert.equal((await call('config')).json.settings.commissionPerDay, 700);

  const c = await customer(), a = await courier();
  const d = await post(c);
  await call(`deliveries/${d.id}/accept`, {}, a.token);
  await call(`deliveries/${d.id}/advance`, {}, a.token);
  await call(`deliveries/${d.id}/advance`, {}, a.token);

  const f = await feed({ token: admin });
  const mine = f.ledger.find((l) => l.courierId === a.id);
  assert.equal(mine.amount, 700);
  assert.ok(f.totals.owed >= 700);
  const settled = await call(`admin/couriers/${a.id}/settle`, {}, admin);
  assert.equal(settled.json.settled, 1);
  const after = await feed({ token: admin });
  assert.equal(after.ledger.find((l) => l.id === mine.id).status, 'paid');
  assert.ok(after.totals.collected >= 700);
  await call('admin/settings', { commissionPerDay: 500 }, admin);
});
