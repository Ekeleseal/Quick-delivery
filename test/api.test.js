const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rd-')), 'data.json');
const server = require('../server');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

const call = async (p, body) => {
  const res = await fetch(base + '/api/' + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

test('serves the frontend', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /RideDispatch/);
});

test('blocks path traversal', async () => {
  const res = await fetch(base + '/..%2fserver.js');
  assert.notEqual(res.status, 200);
});

test('estimates a fare', async () => {
  const { status, json } = await call('estimate', { pickupId: 'station', dropoffId: 'airport' });
  assert.equal(status, 200);
  assert.ok(json.fare >= 800 && json.km > 0);
});

test('validates ride requests', async () => {
  assert.equal((await call('rides', { riderName: '', pickupId: 'station', dropoffId: 'airport' })).status, 400);
  assert.equal((await call('rides', { riderName: 'A', pickupId: 'station', dropoffId: 'station' })).status, 400);
  assert.equal((await call('rides', { riderName: 'A', pickupId: 'nowhere', dropoffId: 'station' })).status, 400);
});

test('full ride lifecycle with auto-dispatch and rating', async () => {
  const { json: ride } = await call('rides', { riderName: 'Chidi', pickupId: 'station', dropoffId: 'mall' });
  assert.equal(ride.status, 'assigned');
  assert.equal(ride.driverId, 'd1'); // d1 is nearest to Central Station
  const driverId = ride.driverId;

  assert.equal((await call(`rides/${ride.id}/advance`, { driverId: 'd2' })).status, 403);
  for (const expected of ['accepted', 'arrived', 'in_progress', 'completed']) {
    const r = await call(`rides/${ride.id}/advance`, { driverId });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, expected);
  }
  assert.equal((await call(`rides/${ride.id}/advance`, { driverId })).status, 409);
  assert.equal((await call(`rides/${ride.id}/rate`, { rating: 9 })).status, 400);
  assert.equal((await call(`rides/${ride.id}/rate`, { rating: 5 })).status, 200);
  assert.equal((await call(`rides/${ride.id}/rate`, { rating: 5 })).status, 409);
});

test('decline re-dispatches to another driver', async () => {
  const { json: ride } = await call('rides', { riderName: 'Ngozi', pickupId: 'market', dropoffId: 'park' });
  const first = ride.driverId;
  assert.ok(first);
  const { json: after } = await call(`rides/${ride.id}/decline`, { driverId: first });
  assert.notEqual(after.driverId, first);
  assert.equal(after.status, 'assigned');
  await call(`rides/${ride.id}/cancel`, {});
});

test('manual dispatch when auto-dispatch is off', async () => {
  await call('settings', { autoDispatch: false });
  const { json: ride } = await call('rides', { riderName: 'Bola', pickupId: 'hospital', dropoffId: 'hotel' });
  assert.equal(ride.status, 'requested');
  assert.equal((await call(`rides/${ride.id}/assign`, { driverId: 'nope' })).status, 404);
  const a = await call(`rides/${ride.id}/assign`, { driverId: 'd3' });
  assert.equal(a.json.status, 'assigned');
  assert.equal(a.json.assignedBy, 'dispatcher');
  const c = await call(`rides/${ride.id}/cancel`, {});
  assert.equal(c.json.status, 'cancelled');
  await call('settings', { autoDispatch: true });
});

test('queued rides are dispatched when a driver frees up', async () => {
  const state = (await call('state')).json;
  for (const d of state.drivers) await call(`drivers/${d.id}/status`, { status: 'offline' });
  const { json: ride } = await call('rides', { riderName: 'Queued', pickupId: 'station', dropoffId: 'harbor' });
  assert.equal(ride.status, 'requested');
  await call('drivers/d4/status', { status: 'online' });
  const after = (await call('state')).json.rides.find((r) => r.id === ride.id);
  assert.equal(after.status, 'assigned');
  assert.equal(after.driverId, 'd4');
});

test('registers drivers and rejects bad input', async () => {
  assert.equal((await call('drivers', { name: 'X' })).status, 400);
  const { status, json } = await call('drivers', { name: 'New Driver', vehicle: 'Nissan', plate: 'ZZ-1' });
  assert.equal(status, 201);
  assert.equal(json.status, 'offline');
  assert.equal((await call(`drivers/${json.id}/location`, { x: 500, y: 1 })).status, 400);
});

test('unknown routes return 404 JSON', async () => {
  const r = await call('nothing');
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
});
