const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, RUMUOLA, MILE1, phone, PHOTO, APPLY, adminFor, approve } = require('./helpers');

let ctx;
test.before(async () => { ctx = await startServer({ config: { commissionActive: false } }); });
test.after(() => ctx.server.close());

const sender = async (name = 'Sender') => { const c = client(ctx.base); const r = await c.call('auth/register', { role: 'sender', name, phone: phone(), password: 'password123' }); c.user = r.json.user; return c; };
const courier = async (name = 'Courier', extra = {}) => { const c = client(ctx.base); const r = await c.call('auth/register', { role: 'driver', name, phone: phone(), password: 'password123', vehicle: 'bike', plate: 'RV-9-AA', ...APPLY, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.json)); c.user = r.json.user; await approve(ctx.base, c.user.id); return c; };
const body = (o = {}) => ({ pickup: RUMUOLA, drop: MILE1, vehicle: 'bike', itemType: 'Documents', quantity: 1, recipientName: 'Ada Obi', recipientPhone: '08123456789', payer: 'sender', payment: 'transfer', openingPrice: 3000, ...o });
const photo = (id, kind, cookie) => fetch(`${ctx.base}/api/photo/${id}?k=${kind}`, { headers: { cookie } });

test('couriers must also upload an ID document and a vehicle photo; the ID is private', async () => {
  for (const k of ['idPhoto', 'vehiclePhoto']) {
    const c = client(ctx.base);
    const r = await c.call('auth/register', { role: 'driver', name: 'No Docs', phone: phone(), password: 'password123', vehicle: 'bike', plate: 'RV-1-AA', ...APPLY, [k]: '' });
    assert.equal(r.status, 400, k);
  }
  const c = await courier('Docs Courier');
  const s = await sender('Docs Sender');
  const admin = await adminFor(ctx.base);
  assert.equal((await photo(c.user.id, 'id', c.cookie)).status, 200, 'the owner sees their own ID');
  assert.equal((await photo(c.user.id, 'id', admin.cookie)).status, 200, 'the admin sees it');
  // a sender who deals with the courier sees the vehicle photo, never the ID
  const j = (await s.call('jobs', body())).json;
  await c.call(`jobs/${j.id}/driver/accept`, {});
  assert.equal((await photo(c.user.id, 'vehicle', s.cookie)).status, 200);
  assert.equal((await photo(c.user.id, 'id', s.cookie)).status, 403);
  assert.equal((await photo(c.user.id, 'bogus', s.cookie)).status, 400);
  const feed = (await admin.call('admin')).json.drivers.find((d) => d.id === c.user.id);
  assert.ok(feed.idPhotoAt && feed.vehiclePhotoAt);
});

test('the admin can edit item types, areas, ID types, price limits, vehicles, support contacts and the announcement', async () => {
  const admin = await adminFor(ctx.base);
  const s = await sender('Settings Sender');
  assert.equal((await admin.call('admin/settings', { site: { items: ['Documents', 'Cake', 'Documents'] } })).status, 200);
  let meta = await fetch(ctx.base + '/api/meta').then((r) => r.json());
  assert.deepEqual(meta.items, ['Documents', 'Cake']);
  assert.equal((await s.call('jobs', body({ itemType: 'Clothing' }))).status, 400, 'a removed item type is refused');
  assert.equal((await s.call('jobs', body({ itemType: 'Cake' }))).status, 201);
  assert.equal((await admin.call('admin/settings', { site: { items: [] } })).status, 400);
  assert.equal((await admin.call('admin/settings', { site: { areas: ['Aba Road', 'Garrison'], idTypes: ['NIN'] } })).status, 200);
  meta = await fetch(ctx.base + '/api/meta').then((r) => r.json());
  assert.deepEqual([meta.areas, meta.idTypes], [['Aba Road', 'Garrison'], ['NIN']]);
  // price limits
  assert.equal((await admin.call('admin/settings', { site: { minPrice: 5000, maxPrice: 1000 } })).status, 400);
  await admin.call('admin/settings', { site: { minPrice: 2000, maxPrice: 20000 } });
  assert.equal((await s.call('jobs', body({ itemType: 'Cake', openingPrice: 1500 }))).status, 400);
  assert.equal((await s.call('jobs', body({ itemType: 'Cake', openingPrice: 2500 }))).status, 201);
  // vehicles can be switched off, but not all of them
  assert.equal((await admin.call('admin/settings', { site: { disabledVehicles: ['van'] } })).status, 200);
  assert.equal((await s.call('jobs', body({ itemType: 'Cake', vehicle: 'van', openingPrice: 5000 }))).status, 400);
  assert.equal((await admin.call('admin/settings', { site: { disabledVehicles: ['bike', 'car', 'van'] } })).status, 400);
  await admin.call('admin/settings', { site: { disabledVehicles: [] } });
  // support and the announcement
  assert.equal((await admin.call('admin/settings', { site: { supportPhone: '123' } })).status, 400);
  await admin.call('admin/settings', { site: { supportPhone: '08030000001', supportWhatsapp: '08030000002', announcement: { active: true, text: 'Public holiday: slower deliveries', audience: 'couriers' } } });
  meta = await fetch(ctx.base + '/api/meta').then((r) => r.json());
  assert.equal(meta.support.phone, '+2348030000001');
  assert.deepEqual(meta.announcement, { text: 'Public holiday: slower deliveries', audience: 'couriers' });
  await admin.call('admin/settings', { site: { announcement: { active: false, text: 'x', audience: 'all' }, items: ['Documents', 'Electronics/Gadgets', 'Food Items/Groceries', 'Clothing', 'Other'], minPrice: 100, maxPrice: 5000000 } });
  assert.equal((await fetch(ctx.base + '/api/meta').then((r) => r.json())).announcement, null);
});

test('the admin can edit accounts, block a sender and cancel a delivery', async () => {
  const admin = await adminFor(ctx.base);
  const s = await sender('Edit Me');
  const c = await courier('Edit Courier');
  const e = await admin.call(`admin/users/${c.user.id}/edit`, { name: 'Edited Courier', plate: 'abc-123', vehicle: 'car' });
  assert.equal(e.status, 200);
  const row = e.json.drivers.find((d) => d.id === c.user.id);
  assert.deepEqual([row.name, row.plate, row.vehicle], ['Edited Courier', 'ABC-123', 'car']);
  const other = await sender('Taken');
  assert.equal((await admin.call(`admin/users/${s.user.id}/edit`, { phone: other.user.phone })).status, 409);
  assert.equal((await admin.call(`admin/users/${s.user.id}/edit`, { phone: '0803 999 0000' })).status, 200);
  // cancelling a live delivery tells both sides
  await admin.call(`admin/users/${c.user.id}/edit`, { vehicle: 'bike' });
  const j = (await s.call('jobs', body())).json;
  await c.call(`jobs/${j.id}/driver/accept`, {});
  assert.equal((await admin.call(`admin/jobs/${j.id}/cancel`, { reason: 'Customer called us' })).status, 200);
  assert.equal((await s.call('sender/jobs')).json.jobs.find((x) => x.id === j.id).status, 'cancelled');
  assert.equal((await c.call('driver/feed')).json.notes.items[0].type, 'cancelled');
  assert.equal((await admin.call(`admin/jobs/${j.id}/cancel`, {})).status, 409, 'finished already');
  // block
  assert.equal((await admin.call(`admin/users/${s.user.id}/block`, { blocked: true, reason: 'Abuse' })).status, 200);
  assert.equal((await s.call('sender/jobs')).status, 401, 'signed out everywhere');
  const again = client(ctx.base);
  assert.equal((await again.call('auth/login', { role: 'sender', phone: '08039990000', password: 'password123' })).status, 403);
  await admin.call(`admin/users/${s.user.id}/block`, { blocked: false });
  assert.equal((await again.call('auth/login', { role: 'sender', phone: '08039990000', password: 'password123' })).status, 200);
});

test('transfer payments: courier bank details, "I have paid", "payment received"; cash is confirmed by the courier', async () => {
  const s = await sender('Payer');
  const c = await courier('Payee');
  assert.equal((await c.call('driver/bank', { bankName: 'GTBank', accountNumber: '123', accountName: 'Payee' })).status, 400);
  assert.equal((await c.call('driver/bank', { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Payee Courier' })).status, 200);
  const j = (await s.call('jobs', body())).json;
  assert.equal((await s.call(`jobs/${j.id}/payment`, { action: 'sent' })).status, 409, 'not before a deal');
  await c.call(`jobs/${j.id}/driver/accept`, {});
  let v = (await s.call('sender/jobs')).json.jobs.find((x) => x.id === j.id);
  assert.deepEqual(v.driver.bank, { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Payee Courier' });
  assert.equal((await c.call(`jobs/${j.id}/payment`, { action: 'sent' })).status, 403, 'only the sender says sent');
  assert.equal((await s.call(`jobs/${j.id}/payment`, { action: 'confirm' })).status, 403, 'only the courier confirms');
  assert.equal((await s.call(`jobs/${j.id}/payment`, { action: 'sent' })).json.paymentStatus, 'sent');
  assert.equal((await s.call(`jobs/${j.id}/payment`, { action: 'sent' })).status, 409);
  assert.equal((await c.call('driver/feed')).json.notes.items[0].type, 'payment');
  assert.equal((await c.call(`jobs/${j.id}/payment`, { action: 'confirm' })).json.paymentStatus, 'confirmed');
  assert.equal((await s.call('sender/jobs')).json.notes.items[0].type, 'payment');
  // cash job: no bank details shown, only the courier confirms
  const k = (await s.call('jobs', body({ payment: 'cash' }))).json;
  await c.call(`jobs/${k.id}/driver/accept`, {}).catch(() => {});
  const c2 = await courier('Cash Courier');
  await c2.call(`jobs/${k.id}/driver/accept`, {});
  const kv = (await s.call('sender/jobs')).json.jobs.find((x) => x.id === k.id);
  assert.equal(kv.driver.bank, null);
  assert.equal((await s.call(`jobs/${k.id}/payment`, { action: 'sent' })).status, 409, 'cash is not "sent"');
  assert.equal((await c2.call(`jobs/${k.id}/payment`, { action: 'confirm' })).json.paymentStatus, 'confirmed');
});

test('the recipient tracking link works without logging in and hides private details', async () => {
  const s = await sender('Tracked Sender');
  const c = await courier('Tracked Courier');
  const j = (await s.call('jobs', body({ payer: 'recipient', pickup: { ...RUMUOLA }, drop: { ...MILE1, details: 'Yellow gate' } }))).json;
  assert.ok(j.trackToken && j.trackToken.length >= 10);
  const driverFeed = (await c.call('driver/feed')).json.available.find((x) => x.id === j.id);
  assert.equal(driverFeed.trackToken, undefined, 'couriers never see the token');
  let t = await fetch(`${ctx.base}/api/track/${j.trackToken}`);
  assert.equal(t.status, 200);
  let tj = await t.json();
  assert.equal(tj.status, 'open');
  assert.equal(tj.courier, null);
  assert.equal(tj.drop.details, 'Yellow gate');
  await c.call('driver/bank', { bankName: 'Access', accountNumber: '0011223344', accountName: 'Tracked Courier' });
  await c.call(`jobs/${j.id}/driver/accept`, {});
  await c.call('driver/location', { lat: 4.82, lng: 7.03 });
  tj = await (await fetch(`${ctx.base}/api/track/${j.trackToken}`)).json();
  assert.equal(tj.courier.firstName, 'Tracked');
  assert.deepEqual([tj.courierLoc.lat, tj.courierLoc.lng], [4.82, 7.03]);
  assert.equal(tj.pay.bank.accountNumber, '0011223344', 'the recipient pays, so they see how');
  const text = JSON.stringify(tj);
  for (const secret of ['+234', '08123456789', 'deliveryCode', 'senderPhone', 'recipientPhone']) assert.ok(!text.includes(secret), secret);
  assert.equal((await fetch(`${ctx.base}/api/track/not-a-real-token`)).status, 404);
  // a sender-pays delivery does not reveal bank details on the public page
  const j2 = (await s.call('jobs', body({ payer: 'sender' }))).json;
  const c2 = await courier('Other Courier');
  await c2.call('driver/bank', { bankName: 'Access', accountNumber: '9988776655', accountName: 'Other' });
  await c2.call(`jobs/${j2.id}/driver/accept`, {});
  assert.equal((await (await fetch(`${ctx.base}/api/track/${j2.trackToken}`)).json()).pay, null);
});

test('problem reports: both sides can report, the admin resolves, the reporter is told', async () => {
  const s = await sender('Reporter');
  const c = await courier('Reported');
  const stranger = await sender('Stranger');
  const j = (await s.call('jobs', body())).json;
  await c.call(`jobs/${j.id}/driver/accept`, {});
  assert.equal((await stranger.call(`jobs/${j.id}/report`, { text: 'I am not part of this' })).status, 403);
  assert.equal((await s.call(`jobs/${j.id}/report`, { text: 'no' })).status, 400);
  assert.equal((await s.call(`jobs/${j.id}/report`, { text: 'Courier is not answering the phone' })).status, 200);
  assert.equal((await c.call(`jobs/${j.id}/report`, { text: 'Sender gave a wrong address' })).status, 200);
  const admin = await adminFor(ctx.base);
  const feed = (await admin.call('admin')).json;
  assert.ok(feed.totals.reports >= 2);
  const rep = feed.reports.find((r) => r.userId === s.user.id);
  assert.equal(rep.status, 'open');
  const done = await admin.call(`admin/reports/${rep.id}/resolve`, { note: 'We called the courier.' });
  assert.equal(done.json.reports.find((r) => r.id === rep.id).status, 'resolved');
  assert.equal((await s.call('sender/jobs')).json.notes.items[0].body, 'We called the courier.');
});

test('proof photos: the courier adds them at pickup and delivery, the sender sees them', async () => {
  const s = await sender('Proof Sender');
  const c = await courier('Proof Courier');
  const j = (await s.call('jobs', body())).json;
  await c.call(`jobs/${j.id}/driver/accept`, {});
  assert.equal((await c.call(`jobs/${j.id}/photo`, { kind: 'delivery', photo: PHOTO })).status, 409, 'not before pickup');
  assert.equal((await c.call(`jobs/${j.id}/photo`, { kind: 'pickup', photo: 'nope' })).status, 400);
  assert.equal((await s.call(`jobs/${j.id}/photo`, { kind: 'pickup', photo: PHOTO })).status, 403);
  assert.equal((await c.call(`jobs/${j.id}/photo`, { kind: 'pickup', photo: PHOTO })).status, 200);
  const sj = (await s.call('sender/jobs')).json.jobs.find((x) => x.id === j.id);
  assert.ok(sj.photos.pickup);
  assert.equal((await fetch(`${ctx.base}/api/jobphoto/${j.id}/pickup`, { headers: { cookie: s.cookie } })).status, 200);
  const stranger = await sender('Nosy');
  assert.equal((await fetch(`${ctx.base}/api/jobphoto/${j.id}/pickup`, { headers: { cookie: stranger.cookie } })).status, 403);
  await c.call(`jobs/${j.id}/driver/pickup`, {});
  assert.equal((await c.call(`jobs/${j.id}/photo`, { kind: 'delivery', photo: PHOTO })).status, 200);
});

test('nothing returns a server error for odd input (fuzz)', async () => {
  const s = await sender('Fuzz Sender');
  const c = await courier('Fuzz Courier');
  const admin = await adminFor(ctx.base);
  const j = (await s.call('jobs', body({ payment: 'cash' }))).json;
  await c.call(`jobs/${j.id}/driver/accept`, {});
  const odd = [undefined, {}, { text: 5 }, { price: -1 }, { price: 'abc' }, { photo: 5 }, { kind: {} }, { action: [] }, { lat: 'x', lng: null }, { pickup: 5, drop: [] }, { items: 'x' }, { site: 5 }, { site: { items: 5 } }, { pricing: 'x' }, { pricing: { bike: 5 } }, { subscription: 5 }, { subscription: { endpoint: 5 } }, { reason: {} }, { blocked: 'yes' }, { ids: 'x' }, { sdp: 5, action: 'start' }, { code: {} }, { bankName: 5, accountNumber: [] }, { name: [], phone: {} }];
  const paths = ['jobs', `jobs/${j.id}/cancel`, `jobs/${j.id}/rate`, `jobs/${j.id}/messages`, `jobs/${j.id}/call`, `jobs/${j.id}/payment`, `jobs/${j.id}/report`, `jobs/${j.id}/photo`, `jobs/${j.id}/sender/counter`, `jobs/${j.id}/sender/accept`, `jobs/${j.id}/driver/counter`, `jobs/${j.id}/driver/deliver`, `jobs/${j.id}/driver/withdraw`, 'driver/status', 'driver/location', 'driver/bank', 'driver/application', 'me/password', 'me/photo', 'me/push', 'me/notifications', 'estimate', 'admin/settings', `admin/users/${c.user.id}/edit`, `admin/users/${c.user.id}/approval`, `admin/users/${s.user.id}/block`, `admin/jobs/${j.id}/cancel`, 'admin/reports/1/resolve', 'auth/login', 'auth/register', 'auth/admin', 'nope/nope', `track/${'x'.repeat(30)}`];
  const who = [s, c, admin, client(ctx.base)];
  let bad = [];
  for (const p of paths) for (const o of odd) for (const w of who) {
    const r = await w.call(p, o).catch((e) => ({ status: -1, err: String(e) }));
    if (r.status >= 500 || r.status === -1) bad.push(`${p} ${JSON.stringify(o)} -> ${r.status} ${r.err || JSON.stringify(r.json).slice(0, 80)}`);
  }
  assert.deepEqual(bad.slice(0, 5), []);
});
