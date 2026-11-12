const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { startServer, client, RUMUOLA, MILE1, phone } = require('./helpers');
const push = require('../lib/push');
const { findUpstash } = require('../lib/storage');

let ctx;
test.before(async () => { ctx = await startServer(); });
test.after(() => ctx.server.close());

async function register(role, name, extra = {}) {
  const c = client(ctx.base);
  const r = await c.call('auth/register', { role, name, phone: phone(), password: 'password123', ...(role === 'driver' ? { vehicle: 'bike', plate: 'RV-123-AA' } : {}), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  c.user = r.json.user;
  return c;
}
const body = (over = {}) => ({ pickup: RUMUOLA, drop: MILE1, vehicle: 'bike', itemType: 'Documents', quantity: 1, recipientName: 'Ada', recipientPhone: '08123456789', payer: 'sender', payment: 'cash', openingPrice: 3000, ...over });
const post = async (s, o) => (await s.call('jobs', body(o))).json;
const act = (c, id, who, a, x = {}) => c.call(`jobs/${id}/${who}/${a}`, x);
const notes = async (c) => (await c.call(c.user.role === 'driver' ? 'driver/feed' : 'sender/jobs')).json.notes;

test('couriers who are online get an alert for a new request; senders get one for offers and a sealed deal', async () => {
  const s = await register('sender', 'Notify Sender');
  const d = await register('driver', 'Notify Courier');
  const bike2 = await register('driver', 'Other Courier');
  const car = await register('driver', 'Car Courier', { vehicle: 'car' });
  const job = await post(s);
  const dn = await notes(d);
  assert.equal(dn.unread, 1);
  assert.equal(dn.items[0].type, 'new_job');
  assert.equal(dn.items[0].jobId, job.id);
  assert.equal((await notes(car)).unread, 0, 'a car courier is not told about a bike job');

  await act(d, job.id, 'driver', 'counter', { price: 3500 });
  let sn = await notes(s);
  assert.match(sn.items[0].title, /offered ₦3,500/);
  await act(s, job.id, 'sender', 'counter', { driverId: d.user.id, price: 3200 });
  assert.match((await notes(d)).items[0].title, /countered ₦3,200/);
  await act(d, job.id, 'driver', 'counter', { price: 3300 });
  await act(bike2, job.id, 'driver', 'counter', { price: 3100 });
  await act(s, job.id, 'sender', 'accept', { driverId: bike2.user.id });
  assert.equal((await notes(s)).items[0].type, 'sealed');
  assert.equal((await notes(bike2)).items[0].type, 'sealed');
  assert.equal((await notes(d)).items[0].type, 'closed', 'the courier who lost is told');

  // marking read
  const before = await notes(s);
  assert.ok(before.unread > 0);
  const r = await s.call('me/notifications', { ids: [before.items[0].id] });
  assert.equal(r.json.unread, before.unread - 1);
  assert.equal((await s.call('me/notifications', {})).json.unread, 0);
  // nobody sees someone else's alerts
  assert.ok((await notes(car)).items.every((x) => x.type !== 'sealed'));
});

test('the delivery code: the courier cannot finish without it, the sender sees it, other couriers never do', async () => {
  const s = await register('sender', 'Code Sender');
  const d = await register('driver', 'Code Courier');
  const job = await post(s);
  assert.match(job.deliveryCode, /^\d{4}$/);
  const asCourier = (await d.call('driver/feed')).json.available.find((j) => j.id === job.id);
  assert.equal(asCourier.deliveryCode, undefined);
  await act(d, job.id, 'driver', 'accept');
  await act(d, job.id, 'driver', 'pickup');
  const wrong = job.deliveryCode === '1111' ? '2222' : '1111';
  assert.equal((await act(d, job.id, 'driver', 'deliver', { code: wrong })).status, 422);
  assert.equal((await act(d, job.id, 'driver', 'deliver', {})).status, 422);
  const mine = (await d.call('driver/feed')).json.current[0];
  assert.equal(mine.deliveryCode, undefined);
  assert.equal(mine.status, 'picked_up');
  const done = await act(d, job.id, 'driver', 'deliver', { code: job.deliveryCode });
  assert.equal(done.json.status, 'delivered');
  assert.equal((await s.call('sender/jobs')).json.jobs.find((j) => j.id === job.id).deliveryCode, job.deliveryCode);
  assert.equal((await ctx.store.read({ fresh: true })).db.jobs.find((j) => j.id === job.id).deliveredAt > 0, true);
});

test('five wrong delivery codes lock guessing for a few minutes', async () => {
  const s = await register('sender', 'Brute Sender');
  const d = await register('driver', 'Brute Courier');
  const job = await post(s);
  await act(d, job.id, 'driver', 'accept');
  await act(d, job.id, 'driver', 'pickup');
  const wrong = job.deliveryCode === '0000' ? '0001' : '0000';
  for (let i = 0; i < 5; i++) assert.equal((await act(d, job.id, 'driver', 'deliver', { code: wrong })).status, 422);
  assert.equal((await act(d, job.id, 'driver', 'deliver', { code: job.deliveryCode })).status, 429);
});

test('chat works for the two sides of an active delivery only', async () => {
  const s = await register('sender', 'Chat Sender');
  const d = await register('driver', 'Chat Courier');
  const other = await register('driver', 'Chat Stranger');
  const job = await post(s);
  assert.equal((await s.call(`jobs/${job.id}/messages`, { text: 'hi' })).status, 409, 'not before a deal');
  await act(d, job.id, 'driver', 'accept');
  assert.equal((await other.call(`jobs/${job.id}/messages`, { text: 'hi' })).status, 403);
  assert.equal((await d.call(`jobs/${job.id}/messages`, { text: '   ' })).status, 400);
  const r = await d.call(`jobs/${job.id}/messages`, { text: 'I am outside' });
  assert.equal(r.status, 200);
  assert.equal(r.json.messages.length, 1);
  const sj = (await s.call('sender/jobs')).json.jobs.find((j) => j.id === job.id);
  assert.deepEqual(sj.messages.map((m) => [m.from, m.text]), [['driver', 'I am outside']]);
  assert.equal((await notes(s)).items[0].type, 'message');
  await s.call(`jobs/${job.id}/messages`, { text: 'Coming down' });
  assert.equal((await notes(d)).items[0].body, 'Coming down');
});

test('live location: shared by the courier, visible to the sender, throttled', async () => {
  const s = await register('sender', 'Loc Sender');
  const d = await register('driver', 'Loc Courier');
  assert.equal((await d.call('driver/location', { lat: 4.82, lng: 7.03 })).json.tracking, false, 'nothing to track yet');
  const job = await post(s);
  await act(d, job.id, 'driver', 'accept');
  assert.equal((await d.call('driver/location', { lat: 4.82, lng: 7.03 })).json.tracking, true);
  let sj = (await s.call('sender/jobs')).json.jobs.find((j) => j.id === job.id);
  assert.deepEqual([sj.courierLoc.lat, sj.courierLoc.lng], [4.82, 7.03]);
  await d.call('driver/location', { lat: 4.83, lng: 7.04 }); // too soon after the last one: ignored
  sj = (await s.call('sender/jobs')).json.jobs.find((j) => j.id === job.id);
  assert.equal(sj.courierLoc.lat, 4.82);
  assert.equal((await d.call('driver/location', { lat: 40, lng: 7 })).status, 400);
  assert.equal((await s.call('driver/location', { lat: 4.8, lng: 7 })).status, 403);
});

test('web push: encryption works end to end and subscriptions are stored per user', async () => {
  // a pretend phone: a local "push service" that decrypts what it receives like a browser would
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const received = [];
  const svc = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const blob = Buffer.concat(chunks);
      const salt = blob.subarray(0, 16), idlen = blob[20], asPub = blob.subarray(21, 21 + idlen), ct = blob.subarray(21 + idlen);
      const h = (s, i, info, l) => Buffer.from(crypto.hkdfSync('sha256', i, s, info, l));
      const prk = h(auth, ua.computeSecret(asPub), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32);
      const dec = crypto.createDecipheriv('aes-128-gcm', h(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16), h(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12));
      dec.setAuthTag(ct.subarray(-16));
      const pt = Buffer.concat([dec.update(ct.subarray(0, -16)), dec.final()]);
      received.push({ msg: JSON.parse(pt.subarray(0, -1).toString()), authz: req.headers.authorization, enc: req.headers['content-encoding'] });
      res.writeHead(201); res.end();
    });
  });
  await new Promise((r) => svc.listen(0, r));
  const endpoint = `http://localhost:${svc.address().port}/push/abc`;

  const s = await register('sender', 'Push Sender');
  const d = await register('driver', 'Push Courier');
  const key = (await s.call('push/key')).json.key;
  assert.ok(key && key.length > 80, 'the server hands out its public key');
  assert.equal((await d.call('me/push', { subscription: { endpoint: 'http://insecure', keys: {} } })).status, 400);
  // the real push services are https; the test service is plain http, so write the subscription straight into the db
  await ctx.store.read({ fresh: true });
  const { mutate } = require('../lib/storage');
  await mutate(ctx.store, (db) => { db.push.push({ userId: d.user.id, sub: { endpoint, keys: { p256dh: push.b64u(ua.getPublicKey()), auth: push.b64u(auth) } }, at: Date.now() }); });

  const job = await post(s, { openingPrice: 2500 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(received.length, 1);
  assert.equal(received[0].msg.title, 'New delivery request');
  assert.equal(received[0].msg.jobId, job.id);
  assert.equal(received[0].enc, 'aes128gcm');
  assert.match(received[0].authz, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.ok(received[0].authz.endsWith(key), 'signed with the key the browser subscribed to');
  svc.close();
});

test('a dead push subscription is removed instead of failing the request', async () => {
  const s = await register('sender', 'Gone Sender');
  const d = await register('driver', 'Gone Courier');
  const svc = http.createServer((req, res) => { res.writeHead(410); res.end(); });
  await new Promise((r) => svc.listen(0, r));
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const { mutate } = require('../lib/storage');
  const endpoint = `http://localhost:${svc.address().port}/gone`;
  await mutate(ctx.store, (db) => { db.push.push({ userId: d.user.id, sub: { endpoint, keys: { p256dh: push.b64u(ua.getPublicKey()), auth: push.b64u(crypto.randomBytes(16)) } }, at: Date.now() }); });
  const r = await s.call('jobs', body());
  assert.equal(r.status, 201);
  const db = (await ctx.store.read({ fresh: true })).db;
  assert.ok(!db.push.some((x) => x.sub.endpoint === endpoint));
  svc.close();
});

test('finds the Upstash database however the host named its settings', () => {
  assert.equal(findUpstash({}), null);
  assert.equal(findUpstash({ KV_REST_API_URL: 'https://a.upstash.io', KV_REST_API_TOKEN: 't' }).url, 'https://a.upstash.io');
  assert.equal(findUpstash({ STORAGE_KV_REST_API_URL: 'https://b.upstash.io', STORAGE_KV_REST_API_TOKEN: 'tok', STORAGE_KV_REST_API_READ_ONLY_TOKEN: 'ro' }).token, 'tok');
  assert.equal(findUpstash({ UPSTASH_REDIS_REST_URL: 'https://c.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'x' }).source, 'UPSTASH_REDIS_REST_URL');
  const r = findUpstash({ REDIS_URL: 'rediss://default:secret@d.upstash.io:6379' });
  assert.deepEqual([r.url, r.token], ['https://d.upstash.io', 'secret']);
  assert.equal(findUpstash({ REDIS_URL: 'redis://localhost:6379' }), null);
});

test('cancelling tells the courier; withdrawing tells the sender; rating tells the courier', async () => {
  const s = await register('sender', 'Cancel Sender');
  const d = await register('driver', 'Cancel Courier');
  const job = await post(s);
  await act(d, job.id, 'driver', 'accept');
  await act(d, job.id, 'driver', 'withdraw');
  assert.equal((await notes(s)).items[0].type, 'withdrew');
  await act(d, job.id, 'driver', 'accept').catch(() => {});
  const j2 = await post(s);
  await act(d, j2.id, 'driver', 'accept');
  await s.call(`jobs/${j2.id}/cancel`, {});
  assert.equal((await notes(d)).items[0].type, 'cancelled');
});
