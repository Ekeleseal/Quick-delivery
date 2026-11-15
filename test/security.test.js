const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../lib/totp');
const { startServer, client, RUMUOLA, MILE1, phone, APPLY, approve } = require('./helpers');

let ctx;
test.before(async () => { ctx = await startServer({ config: { commissionActive: false } }); });
test.after(() => ctx.server.close());

const pinAdmin = async () => { const a = client(ctx.base); const r = await a.call('auth/admin', { pin: '4321' }); assert.equal(r.status, 200); return a; };
const sender = async (extra = {}) => { const c = client(ctx.base); const r = await c.call('auth/register', { role: 'sender', name: 'Sender', phone: phone(), password: 'password123', ...extra }); assert.equal(r.status, 201, JSON.stringify(r.json)); c.user = r.json.user; return c; };
const courier = async (extra = {}) => { const c = client(ctx.base); const r = await c.call('auth/register', { role: 'driver', name: 'Courier', phone: phone(), password: 'password123', vehicle: 'bike', plate: 'RV-9-AA', ...APPLY, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.json)); c.user = r.json.user; return c; };
const body = (o = {}) => ({ pickup: RUMUOLA, drop: MILE1, vehicle: 'bike', itemType: 'Documents', quantity: 1, recipientName: 'Ada Obi', recipientPhone: '08123456789', payer: 'sender', payment: 'cash', openingPrice: 3000, ...o });

test('two-step codes match the RFC 6238 test vector', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII "12345678901234567890"
  assert.equal(totp.code(secret, 59000), '287082');
  assert.equal(totp.code(secret, 1111111109000), '081804');
  assert.ok(totp.verify(secret, '287082', 59000));
  assert.ok(!totp.verify(secret, '000000', 59000));
  assert.ok(!totp.verify(secret, 'abc', 59000));
});

test('named admins: owner and support roles, passwords, and a two-step code', async () => {
  const pin = await pinAdmin();
  assert.equal((await pin.call('admin/admins', { username: 'ab', name: 'X', password: 'password123', adminRole: 'owner' })).status, 400);
  assert.equal((await pin.call('admin/admins', { username: 'chief', name: 'Chief', password: 'short', adminRole: 'owner' })).status, 400);
  assert.equal((await pin.call('admin/admins', { username: 'chief', name: 'Chief', password: 'password123', adminRole: 'boss' })).status, 400);
  const made = await pin.call('admin/admins', { username: 'chief', name: 'Chief', password: 'password123', adminRole: 'owner' });
  assert.equal(made.status, 200);
  assert.equal((await pin.call('admin/admins', { username: 'chief', name: 'Dup', password: 'password123', adminRole: 'owner' })).status, 409);
  assert.equal((await pin.call('admin/admins', { username: 'agent', name: 'Agent', password: 'password123', adminRole: 'support' })).status, 200);
  assert.ok(!JSON.stringify(made.json).includes('passHash'), 'no hashes leak to the screen');

  const bad = client(ctx.base);
  assert.equal((await bad.call('auth/admin', { username: 'chief', password: 'wrongwrong' })).status, 401);
  assert.equal((await bad.call('auth/admin', { username: 'nobody', password: 'password123' })).status, 401);

  const chief = client(ctx.base);
  const li = await chief.call('auth/admin', { username: 'CHIEF', password: 'password123' });
  assert.equal(li.status, 200);
  assert.equal(li.json.user.adminRole, 'owner');
  // two-step setup
  const begin = await chief.call('admin/me/2fa', { action: 'begin' });
  assert.equal(begin.status, 200);
  assert.ok(begin.json.uri.startsWith('otpauth://totp/'));
  assert.equal((await chief.call('admin/me/2fa', { action: 'enable', code: '000000' })).status, 400, 'a wrong code does not switch it on');
  assert.equal((await chief.call('admin/me/2fa', { action: 'enable', code: totp.code(begin.json.secret) })).status, 200);
  const again = client(ctx.base);
  const need = await again.call('auth/admin', { username: 'chief', password: 'password123' });
  assert.equal(need.status, 401); assert.equal(need.json.needCode, true);
  assert.equal((await again.call('auth/admin', { username: 'chief', password: 'password123', code: '000000' })).status, 401);
  assert.equal((await again.call('auth/admin', { username: 'chief', password: 'password123', code: totp.code(begin.json.secret) })).status, 200);
  assert.equal((await again.call('admin')).status, 200);

  // support can work but not change settings, admins or broadcast
  const agent = client(ctx.base);
  assert.equal((await agent.call('auth/admin', { username: 'agent', password: 'password123' })).status, 200);
  const feed = (await agent.call('admin')).json;
  assert.deepEqual(feed.admins, [], 'support does not see the admin list');
  assert.equal((await agent.call('admin/settings', { commissionActive: true })).status, 403);
  assert.equal((await agent.call('admin/broadcast', { title: 'Hi', body: 'There' })).status, 403);
  assert.equal((await agent.call('admin/admins', { username: 'x1x', name: 'X', password: 'password123', adminRole: 'owner' })).status, 403);
  const c = await courier();
  assert.equal((await agent.call(`admin/users/${c.user.id}/approval`, { action: 'approve' })).status, 200, 'support can approve');

  // audit trail
  const log = (await again.call('admin')).json.audit.map((x) => x.action + ' ' + x.detail);
  assert.ok(log.some((l) => /Added admin/.test(l)) && log.some((l) => /Courier approve/.test(l)) && log.some((l) => /Failed admin sign-in/.test(l)));
  // turning two-step off needs the password
  assert.equal((await again.call('admin/me/2fa', { action: 'disable', password: 'nope-nope' })).status, 401);
  assert.equal((await again.call('admin/me/2fa', { action: 'disable', password: 'password123' })).status, 200);
});

test('admin sign-in locks after repeated wrong tries; PIN login can be turned off safely', async () => {
  const pin = await pinAdmin();
  const lock = client(ctx.base);
  for (let i = 0; i < 5; i++) await lock.call('auth/admin', { username: 'agent', password: 'wrongwrong1' });
  assert.equal((await lock.call('auth/admin', { username: 'agent', password: 'password123' })).status, 429);

  assert.equal((await pin.call('admin/pin', { disabled: true })).status, 409, 'the PIN session cannot switch the PIN off');
  const chief = client(ctx.base);
  assert.equal((await chief.call('auth/admin', { username: 'chief', password: 'password123' })).status, 200);
  assert.equal((await chief.call('admin/pin', { disabled: true })).status, 200);
  assert.equal((await client(ctx.base).call('auth/admin', { pin: '4321' })).status, 503, 'PIN login is refused');
  assert.equal((await pin.call('admin')).status, 401, 'the old PIN session stops working');
  assert.equal((await chief.call('admin/pin', { disabled: false })).status, 200);
  assert.equal((await client(ctx.base).call('auth/admin', { pin: '4321' })).status, 200);
});

test('sign out everywhere ends every admin session; own password change keeps this one', async () => {
  const chief = client(ctx.base); await chief.call('auth/admin', { username: 'chief', password: 'password123' });
  const pin = await pinAdmin();
  assert.equal((await chief.call('admin/me/password', { current: 'wrong', next: 'password456' })).status, 401);
  assert.equal((await chief.call('admin/me/password', { current: 'password123', next: 'password456' })).status, 200);
  assert.equal((await chief.call('admin')).status, 200, 'still signed in after changing the password');
  assert.equal((await client(ctx.base).call('auth/admin', { username: 'chief', password: 'password123' })).status, 401);
  const other = client(ctx.base); assert.equal((await other.call('auth/admin', { username: 'chief', password: 'password456' })).status, 200);
  assert.equal((await pin.call('admin/signout-all', {})).status, 200);
  assert.equal((await chief.call('admin')).status, 401);
  assert.equal((await other.call('admin')).status, 401);
  assert.equal((await pin.call('admin')).status, 401);
  assert.equal((await pinAdmin()).call && 1, 1, 'signing in again works');
});

test('broadcast goes to the chosen group, shows in alerts, and can set the banner', async () => {
  const a = await pinAdmin();
  const s1 = await sender(), s2 = await sender(), d1 = await courier();
  assert.equal((await a.call('admin/broadcast', { title: '', body: 'x' })).status, 400);
  assert.equal((await a.call('admin/broadcast', { title: 'Hello', body: 'Hi there', audience: 'everyone' })).status, 400);
  const r = await a.call('admin/broadcast', { title: 'Weekend promo', body: 'Free pickup on Saturday', audience: 'senders', banner: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.broadcasts[0].count >= 2, true);
  const alerts = async (c) => (await c.call(c.user.role === 'driver' ? 'driver/feed' : 'sender/jobs')).json.notes.items;
  assert.ok((await alerts(s1)).some((n) => n.title === 'Weekend promo'));
  assert.ok((await alerts(s2)).some((n) => n.title === 'Weekend promo'));
  assert.ok(!(await alerts(d1)).some((n) => n.title === 'Weekend promo'), 'couriers were not in the audience');
  const meta = (await client(ctx.base).call('meta')).json;
  assert.equal(meta.announcement.text, 'Free pickup on Saturday'); assert.equal(meta.announcement.audience, 'senders');
});

test('panic button: alert reaches admin with location and the other party, can be closed', async () => {
  const s = await sender(), d = await courier(); await approve(ctx.base, d.user.id);
  const j = (await s.call('jobs', body())).json;
  assert.equal((await d.call(`jobs/${j.id}/panic`, {})).status, 403, 'not allowed before the deal is sealed');
  await d.call(`jobs/${j.id}/driver/accept`, {});
  const other = await sender();
  assert.equal((await other.call(`jobs/${j.id}/panic`, {})).status, 403, 'strangers cannot raise it');
  const r = await s.call(`jobs/${j.id}/panic`, { lat: 4.82, lng: 7.02 });
  assert.equal(r.status, 200);
  await s.call(`jobs/${j.id}/panic`, { lat: 4.8201, lng: 7.0201 }); // pressing twice updates, not duplicates
  const a = await pinAdmin();
  const feed = (await a.call('admin')).json;
  const mine = feed.sos.filter((x) => x.jobId === j.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'open'); assert.equal(mine[0].lat, 4.8201); assert.equal(mine[0].role, 'sender');
  assert.equal(mine[0].other.name, 'Courier');
  assert.equal(mine[0].job.pickup, RUMUOLA.label);
  // the other person is not told
  assert.ok(!(await d.call('driver/feed')).json.notes.items.some((n) => /emergency|panic/i.test(n.title + n.body)));
  assert.equal((await a.call(`admin/sos/${mine[0].id}/resolve`, { note: 'Called both, all fine' })).status, 200);
  assert.equal((await a.call('admin')).json.sos.find((x) => x.id === mine[0].id).status, 'resolved');
  assert.equal((await a.call('admin/sos/9999/resolve', {})).status, 404);
});

test('verified badge: given on approval when documents exist, admin can toggle it', async () => {
  const a = await pinAdmin();
  const d = await courier(); await approve(ctx.base, d.user.id);
  let row = (await a.call('admin')).json.drivers.find((x) => x.id === d.user.id);
  assert.equal(row.verified, true);
  await a.call(`admin/users/${d.user.id}/verify`, { verified: false });
  row = (await a.call('admin')).json.drivers.find((x) => x.id === d.user.id);
  assert.equal(row.verified, false);
  await a.call(`admin/users/${d.user.id}/verify`, { verified: true });
  const s = await sender();
  const j = (await s.call('jobs', body())).json;
  await d.call(`jobs/${j.id}/driver/accept`, {});
  const view = (await s.call('sender/jobs')).json.jobs.find((x) => x.id === j.id);
  assert.equal(view.driver.verified, true, 'the sender sees the badge');
  assert.equal((await a.call('admin/users/zzz/verify', { verified: true })).status, 404);
});

test('referral codes: everyone gets one, signing up with it credits the inviter', async () => {
  const s = await sender();
  const code = s.user.refCode;
  assert.match(code, /^BG[A-Z2-9]{5}$/);
  const friend = await sender({ ref: code.toLowerCase() });
  assert.equal(friend.user.refCode === code, false);
  const me = (await s.call('me')).json.user;
  assert.equal(me.refCount, 1);
  assert.ok((await s.call('sender/jobs')).json.notes.items.some((n) => n.type === 'referral'));
  await sender({ ref: 'NOPE123' }); // an unknown code is ignored, not an error
  await courier({ ref: code });
  assert.equal((await s.call('me')).json.user.refCount, 2);
  const a = await pinAdmin();
  assert.ok((await a.call('admin')).json.referrals.some((x) => x.refCode === code && x.refCount === 2));
});

test('an older database without the newer fields still works on reads and writes', async () => {
  const fs = require('fs');
  const { FileStore } = require('../lib/storage');
  const s0 = await startServer({ config: { commissionActive: false } });
  const a = client(s0.base);
  const r = await a.call('auth/register', { role: 'sender', name: 'Old Timer', phone: phone(), password: 'password123' });
  assert.equal(r.status, 201);
  s0.server.close();
  const raw = JSON.parse(fs.readFileSync(s0.file, 'utf8'));
  for (const k of ['admins', 'audit', 'sos', 'nextSosId', 'broadcasts', 'nextBroadcastId']) delete raw[k];
  for (const u of raw.users) delete u.refCode;
  delete raw.settings.adminTv;
  fs.writeFileSync(s0.file, JSON.stringify(raw));
  const s1 = await startServer({ store: new FileStore(s0.file), config: { commissionActive: false } });
  try {
    const c = client(s1.base);
    assert.equal((await c.call('meta')).status, 200, 'a read on old data works');
    const meta = (await c.call('meta')).json; assert.equal(meta.adminAccounts, false);
    const p1 = await c.call('auth/admin', { pin: '4321' }); assert.equal(p1.status, 200);
    const feed = await c.call('admin'); assert.equal(feed.status, 200);
    assert.deepEqual(feed.json.sos, []);
    const code1 = (await c.call('me')).json.user.role === 'admin';
    assert.ok(code1);
    const u = client(s1.base); const li = await u.call('auth/login', { role: 'sender', phone: r.json.user.phone, password: 'password123' });
    assert.equal(li.status, 200);
    const ref1 = li.json.user.refCode; assert.match(ref1, /^BG[A-Z2-9]{5}$/);
    assert.equal((await u.call('me')).json.user.refCode, ref1, 'the same code on every request, saved or not');
    assert.equal((await c.call('admin/broadcast', { title: 'Hello', body: 'World' })).status, 200);
    assert.equal((await u.call('me')).json.user.refCode, ref1, 'and after a write');
  } finally { s1.server.close(); }
});
