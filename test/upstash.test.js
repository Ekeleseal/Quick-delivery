// Tests the Vercel storage path against a local stand-in for Upstash Redis's HTTP API.
// It checks our side of the protocol (request shapes, auth, version checks, retries).
// It is not a test of Upstash itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../lib/app');
const { UpstashStore, CAS_LUA } = require('../lib/storage');
const { createServer } = require('../local');
const { client, RUMUOLA, MILE1, phone, APPLY } = require('./helpers');

const TOKEN = 'test-token';
function startMockRedis() {
  const data = new Map();
  const stats = { calls: 0, mget: 0, eval: 0 };
  const server = http.createServer((req, res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: 'Unauthorized' });
      const [cmd, ...a] = JSON.parse(s);
      stats.calls += 1;
      if (cmd === 'MGET') { stats.mget += 1; return reply(200, { result: a.map((k) => (data.has(k) ? data.get(k) : null)) }); }
      if (cmd === 'EVAL') {
        stats.eval += 1;
        // EVAL <script> <numkeys> <key1> <key2> <arg1> <arg2> <arg3>
        if (a[0] !== CAS_LUA || a[1] !== '2') return reply(400, { error: 'ERR unexpected script' }); // we must run exactly the compare-and-set script
        const [, , k1, k2, expected, value, nextVersion] = a;
        const cur = data.has(k2) ? data.get(k2) : '0';
        if (cur !== expected) return reply(200, { result: 0 });
        data.set(k1, value); data.set(k2, nextVersion);
        return reply(200, { result: 1 });
      }
      if (cmd === 'SET') { data.set(a[0], a[1]); return reply(200, { result: 'OK' }); }
      if (cmd === 'GET') return reply(200, { result: data.has(a[0]) ? data.get(a[0]) : null });
      return reply(400, { error: `ERR unknown command ${cmd}` });
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, url: `http://localhost:${server.address().port}`, data, stats })));
}

// One "serverless instance": its own store object, its own app, its own HTTP server, sharing only the database.
async function instance(url, opts) {
  const store = new UpstashStore(url, TOKEN, opts);
  const server = createServer(createApp(store, { adminPin: '4321' }));
  await new Promise((r) => server.listen(0, r));
  return { store, server, base: `http://localhost:${server.address().port}` };
}

let redis;
test.before(async () => { redis = await startMockRedis(); });
test.after(() => redis.server.close());

test('a second instance sees accounts and deliveries made on the first', async () => {
  const A = await instance(redis.url), B = await instance(redis.url);
  const a = client(A.base);
  const p = phone();
  assert.equal((await a.call('auth/register', { role: 'sender', name: 'Cross Instance', phone: p, password: 'password123' })).status, 201);
  const posted = await a.call('jobs', { pickup: RUMUOLA, drop: MILE1, vehicle: 'bike', itemType: 'Documents', quantity: 1, recipientName: 'Kemi', recipientPhone: '08123456789', payer: 'sender', payment: 'cash', openingPrice: 2500 });
  assert.equal(posted.status, 201);
  // the other instance has never seen this data, and the session cookie was signed with the shared secret
  const b = client(B.base);
  b.cookie = a.cookie;
  const me = await b.call('me?fresh=1');
  assert.equal(me.json.user.name, 'Cross Instance');
  assert.equal((await b.call('sender/jobs?fresh=1')).json.jobs.length, 1);
  assert.equal((await client(B.base).call('auth/login', { role: 'sender', phone: p, password: 'password123' })).status, 200);
  A.server.close(); B.server.close();
});

test('data lives in the shared database, not in the function', async () => {
  const A = await instance(redis.url);
  const c = client(A.base);
  await c.call('auth/register', { role: 'sender', name: 'Stored Sam', phone: phone(), password: 'password123' });
  const stored = JSON.parse(redis.data.get('bargo:db'));
  assert.ok(stored.users.some((u) => u.name === 'Stored Sam'));
  assert.ok(!JSON.stringify(stored).includes('password123')); // only hashes are stored
  assert.ok(Number(redis.data.get('bargo:ver')) >= 1);
  A.server.close();
  // brand-new instance after the old one is gone
  const B = await instance(redis.url);
  const again = await client(B.base).call('meta');
  assert.equal(again.status, 200);
  B.server.close();
});

test('two instances writing at once never lose each other\'s data', async () => {
  const A = await instance(redis.url), B = await instance(redis.url);
  const ca = client(A.base), cb = client(B.base);
  await ca.call('auth/register', { role: 'sender', name: 'Racer A', phone: phone(), password: 'password123' });
  await cb.call('auth/register', { role: 'sender', name: 'Racer B', phone: phone(), password: 'password123' });
  const body = { pickup: RUMUOLA, drop: MILE1, vehicle: 'bike', itemType: 'Documents', quantity: 1, recipientName: 'Kemi', recipientPhone: '08123456789', payer: 'sender', payment: 'cash', openingPrice: 2500 };
  const results = await Promise.all([
    ...Array.from({ length: 6 }, () => ca.call('jobs', body)),
    ...Array.from({ length: 6 }, () => cb.call('jobs', body)),
  ]);
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
  assert.equal(new Set(results.map((r) => r.json.id)).size, 12); // 12 distinct job numbers
  assert.equal((await ca.call('sender/jobs?fresh=1')).json.jobs.length, 6);
  assert.equal((await cb.call('sender/jobs?fresh=1')).json.jobs.length, 6);
  A.server.close(); B.server.close();
});

test('polling is cheap: repeated reads share one storage call', async () => {
  const A = await instance(redis.url, { cacheMs: 60000 });
  const c = client(A.base);
  await c.call('auth/register', { role: 'driver', name: 'Poller', phone: phone(), password: 'password123', vehicle: 'bike', plate: 'RV-1', ...APPLY });
  const before = redis.stats.mget;
  for (let i = 0; i < 10; i++) assert.equal((await c.call('driver/feed')).status, 200);
  assert.equal(redis.stats.mget - before, 0); // served from the instance's short cache after the write
  const fresh = redis.stats.mget;
  await c.call('driver/feed?fresh=1');
  assert.equal(redis.stats.mget - fresh, 1); // ?fresh=1 skips the cache
  A.server.close();
});

test('a wrong storage token gives a clean error, not a crash', async () => {
  const bad = new UpstashStore(redis.url, 'wrong-token');
  const server = createServer(createApp(bad, {}));
  await new Promise((r) => server.listen(0, r));
  const c = client(`http://localhost:${server.address().port}`);
  const r = await c.call('auth/register', { role: 'sender', name: 'Nope Nope', phone: phone(), password: 'password123' });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /Server error/);
  server.close();
});
