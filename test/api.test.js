const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bargo-')), 'data.json');
process.env.ADMIN_PIN = '4321';
const server = require('../server');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

const call = async (p, body, headers = {}) => {
  const res = await fetch(base + '/api/' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};
const ADMIN = { 'x-admin-pin': '4321' };

const newJob = (over = {}) => ({
  senderId: 's1', senderName: 'Chidi Eze', senderPhone: '08011112222',
  pickupAreaId: 'ikeja', pickupAddress: '32 Samwell Sq', dropAreaId: 'vi', dropAddress: '21b Karimu Kotun St',
  vehicle: 'bike', itemType: 'Electronics/Gadgets', quantity: 1,
  recipientName: 'Paul Pogba', recipientPhone: '08123456789', payer: 'sender', payment: 'cash',
  openingPrice: 4000, ...over,
});
const post = async (over) => (await call('jobs', newJob(over))).json;
const drv = (id, jobId, action, extra = {}) => call(`jobs/${jobId}/driver/${action}`, { driverId: id, ...extra });
const snd = (jobId, action, extra = {}) => call(`jobs/${jobId}/sender/${action}`, { senderId: 's1', ...extra });

test('serves the app and PWA files', async () => {
  for (const p of ['/', '/manifest.webmanifest', '/sw.js']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
  }
});

test('blocks path traversal', async () => {
  const res = await fetch(base + '/..%2fserver.js');
  assert.notEqual(res.status, 200);
});

test('meta exposes the commission and suggested fare grows with distance', async () => {
  const meta = (await call('meta')).json;
  assert.equal(meta.commissionPerDay, 500);
  const near = (await call('estimate', { pickupAreaId: 'ikeja', dropAreaId: 'maryland', vehicle: 'bike' })).json;
  const far = (await call('estimate', { pickupAreaId: 'ikeja', dropAreaId: 'ajah', vehicle: 'bike' })).json;
  assert.ok(far.fare > near.fare);
  const van = (await call('estimate', { pickupAreaId: 'ikeja', dropAreaId: 'ajah', vehicle: 'van' })).json;
  assert.ok(van.fare > far.fare);
});

test('validates new deliveries', async () => {
  assert.equal((await call('jobs', newJob({ senderName: '' }))).status, 400);
  assert.equal((await call('jobs', newJob({ recipientPhone: 'abc' }))).status, 400);
  assert.equal((await call('jobs', newJob({ vehicle: 'plane' }))).status, 400);
  assert.equal((await call('jobs', newJob({ openingPrice: 5 }))).status, 400);
  assert.equal((await call('jobs', newJob({ deliveryType: 'scheduled', scheduledAt: '2000-01-01T10:00' }))).status, 400);
});

test('a courier accepting the opening price seals the deal', async () => {
  const job = await post();
  assert.equal(job.status, 'open');
  const r = await drv('d1', job.id, 'accept');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'agreed');
  assert.equal(r.json.agreedPrice, 4000);
  assert.equal(r.json.recipientPhone, '08123456789'); // revealed after the deal
  const mine = (await call('sender/s1/jobs')).json.jobs.find((j) => j.id === job.id);
  assert.equal(mine.driver.id, 'd1');
});

test('contacts stay hidden from couriers until a deal is sealed', async () => {
  const job = await post({ senderId: 's2' });
  const feed = (await call('driver/d2')).json;
  const seen = feed.available.find((j) => j.id === job.id);
  assert.ok(seen);
  assert.equal(seen.recipientPhone, undefined);
  assert.equal(seen.senderPhone, undefined);
  await call(`jobs/${job.id}/cancel`, { senderId: 's2' });
});

test('negotiation: counter, counter back, accept; turns are enforced', async () => {
  const job = await post({ senderId: 's1' });
  // courier d2 asks for more
  assert.equal((await drv('d2', job.id, 'counter', { price: 6000 })).status, 200);
  // courier cannot counter twice in a row, or accept their own price
  assert.equal((await drv('d2', job.id, 'counter', { price: 7000 })).status, 409);
  assert.equal((await drv('d2', job.id, 'accept')).status, 409);
  // sender may not act for a different sender
  assert.equal((await call(`jobs/${job.id}/sender/accept`, { senderId: 'intruder', driverId: 'd2' })).status, 403);
  // sender counters; courier accepts the sender's counter
  assert.equal((await snd(job.id, 'counter', { driverId: 'd2', price: 5000 })).status, 200);
  assert.equal((await snd(job.id, 'counter', { driverId: 'd2', price: 4500 })).status, 409);
  const done = await drv('d2', job.id, 'accept');
  assert.equal(done.status, 200);
  assert.equal(done.json.agreedPrice, 5000);
  assert.equal(done.json.status, 'agreed');
});

test('sender accepting a counter seals it and closes other offers', async () => {
  const job = await post({ senderId: 's1' });
  await drv('d1', job.id, 'counter', { price: 5500 }); // d1 is busy from earlier test? handled below
  const r1 = await snd(job.id, 'accept', { driverId: 'd1' });
  // d1 already has an active delivery from the earlier test, so this must be refused
  assert.equal(r1.status, 409);
  await call(`jobs/${job.id}/cancel`, { senderId: 's1' });

  const j2 = await post({ senderId: 's1', vehicle: 'car' });
  await drv('d3', j2.id, 'counter', { price: 7000 });
  await drv('d4', j2.id, 'counter', { price: 6500 });
  const sealed = await snd(j2.id, 'accept', { driverId: 'd4' });
  assert.equal(sealed.status, 200);
  assert.equal(sealed.json.agreedPrice, 6500);
  assert.equal(sealed.json.driver.id, 'd4');
  const loser = sealed.json.negotiations.find((n) => n.driverId === 'd3');
  assert.equal(loser.status, 'closed');
  // the losing courier can no longer act
  assert.equal((await drv('d3', j2.id, 'accept')).status, 409);
});

test('couriers only see deliveries for their vehicle and can reject', async () => {
  const job = await post({ senderId: 's3', vehicle: 'van' });
  assert.ok((await call('driver/d5')).json.available.some((j) => j.id === job.id));
  assert.ok(!(await call('driver/d1')).json.available.some((j) => j.id === job.id));
  assert.equal((await drv('d1', job.id, 'accept')).status, 409); // wrong vehicle
  await drv('d5', job.id, 'reject');
  assert.ok(!(await call('driver/d5')).json.available.some((j) => j.id === job.id));
  await call(`jobs/${job.id}/cancel`, { senderId: 's3' });
});

test('full delivery: pickup, deliver, rate; commission is charged once per day', async () => {
  const a = await post({ senderId: 's4', vehicle: 'car', openingPrice: 8000 });
  const b = await post({ senderId: 's4', vehicle: 'car', openingPrice: 3000 });
  // d3 takes job a (d3 is not busy: lost the earlier negotiation)
  assert.equal((await drv('d3', a.id, 'accept')).json.agreedPrice, 8000);
  assert.equal((await drv('d3', b.id, 'accept')).status, 409); // one delivery at a time
  assert.equal((await drv('d3', a.id, 'deliver')).status, 409); // must pick up first
  assert.equal((await drv('d3', a.id, 'pickup')).json.status, 'picked_up');
  assert.equal((await drv('d3', a.id, 'deliver')).json.status, 'delivered');
  let e = (await call('driver/d3')).json.earnings;
  assert.equal(e.gross, 8000);
  assert.equal(e.commission, 500);
  assert.equal(e.net, 7500);
  // second delivery the same day: no extra commission
  assert.equal((await drv('d3', b.id, 'accept')).json.agreedPrice, 3000);
  await drv('d3', b.id, 'pickup');
  await drv('d3', b.id, 'deliver');
  e = (await call('driver/d3')).json.earnings;
  assert.equal(e.gross, 11000);
  assert.equal(e.commission, 500);
  assert.equal(e.net, 10500);
  assert.equal(e.commissionDueToday, 0);
  // rating
  assert.equal((await call(`jobs/${a.id}/rate`, { senderId: 's4', rating: 9 })).status, 400);
  assert.equal((await call(`jobs/${a.id}/rate`, { senderId: 's4', rating: 5 })).status, 200);
  assert.equal((await call(`jobs/${a.id}/rate`, { senderId: 's4', rating: 5 })).status, 409);
});

test('a courier can pull out before pickup and the delivery reopens', async () => {
  const job = await post({ senderId: 's5', vehicle: 'bike' });
  await drv('d2', job.id, 'counter', { price: 5000 }).catch(() => {});
  const j = await post({ senderId: 's5', vehicle: 'bike' });
  // d1 and d2 may be busy; register a fresh bike courier
  const nd = (await call('drivers', { name: 'Seun Ade', phone: '08099998888', vehicle: 'bike', plate: 'LSR-1' })).json;
  assert.equal(nd.status, 'offline');
  assert.equal((await drv(nd.id, j.id, 'accept')).status, 409); // offline
  await call(`drivers/${nd.id}/status`, { status: 'online' });
  assert.equal((await drv(nd.id, j.id, 'accept')).json.status, 'agreed');
  assert.equal((await call(`drivers/${nd.id}/status`, { status: 'offline' })).status, 409); // busy
  assert.equal((await drv(nd.id, j.id, 'withdraw')).json.status, 'open');
  const again = (await call('sender/s5/jobs')).json.jobs.find((x) => x.id === j.id);
  assert.equal(again.status, 'open');
  assert.equal(again.driverId, null);
  assert.equal((await drv(nd.id, j.id, 'accept')).status, 409); // cannot take it again
  await call(`jobs/${job.id}/cancel`, { senderId: 's5' });
  await call(`jobs/${j.id}/cancel`, { senderId: 's5' });
});

test('cancelling is blocked once the package is picked up', async () => {
  const j = await post({ senderId: 's6', vehicle: 'van' });
  await drv('d5', j.id, 'accept');
  await drv('d5', j.id, 'pickup');
  assert.equal((await call(`jobs/${j.id}/cancel`, { senderId: 's6' })).status, 409);
  await drv('d5', j.id, 'deliver');
});

test('admin needs the PIN; changing the commission applies to later days only', async () => {
  assert.equal((await call('admin')).status, 401);
  assert.equal((await call('admin', undefined, { 'x-admin-pin': 'wrong' })).status, 401);
  const before = (await call('admin', undefined, ADMIN)).json;
  assert.equal(before.settings.commissionPerDay, 500);
  assert.ok(before.totals.commission >= 1000); // d3 and d5 each charged once
  assert.equal((await call('admin/settings', { commissionPerDay: -5 }, ADMIN)).status, 400);
  const changed = (await call('admin/settings', { commissionPerDay: 750 }, ADMIN)).json;
  assert.equal(changed.settings.commissionPerDay, 750);
  // existing charges are unchanged
  const d3 = changed.drivers.find((d) => d.id === 'd3').earnings;
  assert.equal(d3.commission, 500);
  // a courier who has not delivered today pays the new rate on their first delivery
  const j = await post({ senderId: 's7', vehicle: 'bike', openingPrice: 2000 });
  const fresh = (await call('drivers', { name: 'Kemi Ola', phone: '08077776666', vehicle: 'bike', plate: 'LSR-9' })).json;
  await call(`drivers/${fresh.id}/status`, { status: 'online' });
  assert.equal((await drv(fresh.id, j.id, 'accept')).status, 200);
  await drv(fresh.id, j.id, 'pickup');
  await drv(fresh.id, j.id, 'deliver');
  const e = (await call(`driver/${fresh.id}`)).json.earnings;
  assert.equal(e.commission, 750);
  assert.equal(e.net, 1250);
});

test('unknown routes return 404 JSON', async () => {
  const r = await call('nothing');
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
});
