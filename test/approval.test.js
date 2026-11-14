const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, RUMUOLA, MILE1, phone, PHOTO, APPLY, adminFor } = require('./helpers');

let ctx;
test.before(async () => { ctx = await startServer({ config: { commissionActive: false } }); });
test.after(() => ctx.server.close());

const apply = async (over = {}) => {
  const c = client(ctx.base);
  const r = await c.call('auth/register', { role: 'driver', name: 'New Rider', phone: phone(), password: 'password123', vehicle: 'bike', plate: 'RV-1-AB', ...APPLY, ...over });
  return { c, r };
};
const job = { pickup: RUMUOLA, drop: MILE1, vehicle: 'bike', itemType: 'Documents', quantity: 1, recipientName: 'Ada', recipientPhone: '08123456789', payer: 'sender', payment: 'cash', openingPrice: 3000 };

test('a courier application needs a photo, an ID and a guarantor', async () => {
  for (const missing of ['photo', 'area', 'idType', 'idNumber', 'guarantorName', 'guarantorPhone']) {
    const { r } = await apply({ [missing]: '' });
    assert.equal(r.status, 400, missing);
  }
  assert.equal((await apply({ photo: 'data:text/html;base64,PHNjcmlwdD4=' })).r.status, 400, 'only pictures');
  assert.equal((await apply({ idType: 'Library card' })).r.status, 400);
  assert.equal((await apply({ guarantorPhone: '12' })).r.status, 400);
  const { r } = await apply();
  assert.equal(r.status, 201);
  assert.equal(r.json.user.approval, 'pending');
  assert.equal(r.json.user.status, 'offline');
  assert.ok(r.json.user.photoAt);
});

test('a pending courier cannot go online or see requests; the admin approves and they can', async () => {
  const s = client(ctx.base);
  await s.call('auth/register', { role: 'sender', name: 'Sender One', phone: phone(), password: 'password123' });
  const created = (await s.call('jobs', job)).json;
  const { c, r } = await apply();
  assert.equal((await c.call('driver/status', { status: 'online' })).status, 403);
  const feed = (await c.call('driver/feed')).json;
  assert.equal(feed.driver.approval, 'pending');
  assert.deepEqual([feed.available.length, feed.offers.length, feed.current.length], [0, 0, 0]);
  assert.equal((await c.call(`jobs/${created.id}/driver/accept`, {})).status, 403);
  assert.equal((await c.call('driver/location', { lat: 4.8, lng: 7 })).status, 403);

  const admin = await adminFor(ctx.base);
  const list = (await admin.call('admin')).json;
  assert.ok(list.totals.pending >= 1);
  const row = list.drivers.find((d) => d.id === r.json.user.id);
  assert.equal(row.application.idType, 'NIN');
  assert.equal(row.application.guarantorPhone, '+2348031234567');
  // the admin can see the photo; a stranger cannot
  const pic = await fetch(`${ctx.base}/api/photo/${row.id}`, { headers: { cookie: admin.cookie } });
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('content-type'), 'image/jpeg');
  const stranger = client(ctx.base);
  await stranger.call('auth/register', { role: 'sender', name: 'Nosy', phone: phone(), password: 'password123' });
  assert.equal((await fetch(`${ctx.base}/api/photo/${row.id}`, { headers: { cookie: stranger.cookie } })).status, 403);
  assert.equal((await fetch(`${ctx.base}/api/photo/${row.id}`)).status, 401);

  assert.equal((await admin.call(`admin/users/${row.id}/approval`, { action: 'approve' })).status, 200);
  const after = (await c.call('driver/feed')).json;
  assert.equal(after.driver.approval, 'approved');
  assert.equal(after.driver.status, 'online');
  assert.ok(after.available.some((j) => j.id === created.id));
  assert.equal(after.notes.items[0].type, 'approved');
  assert.equal((await c.call(`jobs/${created.id}/driver/accept`, {})).status, 200);
});

test('a rejected applicant sees the reason, fixes the form and applies again', async () => {
  const { c, r } = await apply();
  const admin = await adminFor(ctx.base);
  const id = r.json.user.id;
  assert.equal((await admin.call(`admin/users/${id}/approval`, { action: 'reject' })).status, 400, 'a reason is needed');
  assert.equal((await admin.call(`admin/users/${id}/approval`, { action: 'reject', reason: 'The photo is blurry' })).status, 200);
  const me = (await c.call('me')).json.user;
  assert.deepEqual([me.approval, me.approvalNote], ['rejected', 'The photo is blurry']);
  assert.equal((await c.call('driver/application', { idNumber: '' })).status, 400);
  const again = await c.call('driver/application', { photo: PHOTO, idNumber: '10987654321' });
  assert.equal(again.status, 200);
  assert.equal(again.json.user.approval, 'pending');
  assert.equal(again.json.user.application.idNumber, '10987654321');
  assert.equal((await admin.call(`admin/users/${id}/approval`, { action: 'approve' })).status, 200);
  assert.equal((await c.call('driver/application', { area: 'Elsewhere' })).status, 409, 'approved couriers cannot reapply');
});

test('the admin can suspend and reinstate a courier, but not mid-delivery', async () => {
  const { c, r } = await apply();
  const admin = await adminFor(ctx.base);
  const id = r.json.user.id;
  await admin.call(`admin/users/${id}/approval`, { action: 'approve' });
  const s = client(ctx.base);
  await s.call('auth/register', { role: 'sender', name: 'Sender Two', phone: phone(), password: 'password123' });
  const j = (await s.call('jobs', job)).json;
  await c.call(`jobs/${j.id}/driver/accept`, {});
  assert.equal((await admin.call(`admin/users/${id}/approval`, { action: 'suspend', reason: 'Complaints' })).status, 409);
  await c.call(`jobs/${j.id}/driver/pickup`, {});
  await c.call(`jobs/${j.id}/driver/deliver`, { code: j.deliveryCode });
  assert.equal((await admin.call(`admin/users/${id}/approval`, { action: 'suspend', reason: 'Complaints' })).status, 200);
  assert.equal((await c.call('driver/status', { status: 'online' })).status, 403);
  assert.equal((await admin.call(`admin/users/${id}/approval`, { action: 'reinstate' })).status, 200);
  assert.equal((await c.call('driver/status', { status: 'online' })).status, 200);
});

test('profile photos: optional for senders, shown to the other side of a deal, removable by senders only', async () => {
  const s = client(ctx.base);
  const reg = await s.call('auth/register', { role: 'sender', name: 'Pic Sender', phone: phone(), password: 'password123' });
  assert.equal(reg.json.user.photoAt, null);
  assert.equal((await s.call('me/photo', { photo: 'nope' })).status, 400);
  const up = await s.call('me/photo', { photo: PHOTO });
  assert.ok(up.json.user.photoAt);
  assert.equal((await fetch(`${ctx.base}/api/photo/${reg.json.user.id}`, { headers: { cookie: s.cookie } })).status, 200);
  assert.equal((await s.call('me/photo/remove', {})).json.user.photoAt, null);
  const { c, r } = await apply();
  assert.equal((await c.call('me/photo/remove', {})).status, 403, 'couriers must keep a photo');
  // a courier's photo is visible to a sender who got an offer from them
  const admin = await adminFor(ctx.base);
  await admin.call(`admin/users/${r.json.user.id}/approval`, { action: 'approve' });
  const j = (await s.call('jobs', job)).json;
  assert.equal((await fetch(`${ctx.base}/api/photo/${r.json.user.id}`, { headers: { cookie: s.cookie } })).status, 403, 'not before they are involved');
  await c.call(`jobs/${j.id}/driver/counter`, { price: 3500 });
  assert.equal((await fetch(`${ctx.base}/api/photo/${r.json.user.id}`, { headers: { cookie: s.cookie } })).status, 200);
});

test('commission is free by default and can be switched on later; prices are editable', async () => {
  const admin = await adminFor(ctx.base);
  let feed = (await admin.call('admin')).json;
  assert.equal(feed.settings.commissionActive, false);
  assert.equal(feed.settings.commissionPerDay, 500, 'the amount is kept for later');
  // a courier delivers while commission is off: nothing is charged
  const { c, r } = await apply();
  await admin.call(`admin/users/${r.json.user.id}/approval`, { action: 'approve' });
  const s = client(ctx.base);
  await s.call('auth/register', { role: 'sender', name: 'Free Sender', phone: phone(), password: 'password123' });
  const j = (await s.call('jobs', job)).json;
  await c.call(`jobs/${j.id}/driver/accept`, {}); await c.call(`jobs/${j.id}/driver/pickup`, {});
  await c.call(`jobs/${j.id}/driver/deliver`, { code: j.deliveryCode });
  const e = (await c.call('driver/feed')).json.earnings;
  assert.deepEqual([e.commission, e.commissionActive, e.commissionDueToday, e.net], [0, false, 0, 3000]);
  // switching it on charges the next day's first delivery
  assert.equal((await admin.call('admin/settings', { commissionActive: true, commissionPerDay: 700 })).json.settings.commissionActive, true);
  const j2 = (await s.call('jobs', job)).json;
  await c.call(`jobs/${j2.id}/driver/accept`, {}); await c.call(`jobs/${j2.id}/driver/pickup`, {});
  await c.call(`jobs/${j2.id}/driver/deliver`, { code: j2.deliveryCode });
  assert.equal((await c.call('driver/feed')).json.earnings.commission, 700);
  // prices
  const before = (await s.call('estimate', { pickup: RUMUOLA, drop: MILE1, vehicle: 'bike' })).json.fare;
  assert.equal((await admin.call('admin/settings', { pricing: { bike: { base: 2000, perKm: 400 } } })).status, 200);
  const after = (await s.call('estimate', { pickup: RUMUOLA, drop: MILE1, vehicle: 'bike' })).json.fare;
  assert.ok(after > before, `${after} should be more than ${before}`);
  assert.equal((await admin.call('admin/settings', { pricing: { bike: { base: -5, perKm: 1 } } })).status, 400);
  assert.equal((await fetch(ctx.base + '/api/meta').then((x) => x.json())).vehicles.bike.base, 2000);
});

test('default prices are higher than before and addresses keep the landmark details', async () => {
  const fresh = await startServer();
  const s = client(fresh.base);
  await s.call('auth/register', { role: 'sender', name: 'Price Check', phone: phone(), password: 'password123' });
  const e = (await s.call('estimate', { pickup: RUMUOLA, drop: MILE1, vehicle: 'bike' })).json;
  assert.ok(e.fare >= 1500, `bike fare ${e.fare}`);
  const meta = await fetch(fresh.base + '/api/meta').then((x) => x.json());
  assert.deepEqual([meta.vehicles.bike.base, meta.vehicles.car.base, meta.vehicles.van.base], [1000, 2000, 4000]);
  const j = (await s.call('jobs', { ...job, pickup: { ...RUMUOLA, details: 'Flat 3, opposite First Bank' } })).json;
  assert.equal(j.pickup.details, 'Flat 3, opposite First Bank');
  fresh.server.close();
});
