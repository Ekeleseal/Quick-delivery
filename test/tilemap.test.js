const test = require('node:test');
const assert = require('node:assert/strict');
const { project, unproject } = require('../public/tilemap.js');
const { haversineKm } = require('../lib/app');

test('map maths: known points on the world map', () => {
  const o = project(0, 0, 0);
  assert.ok(Math.abs(o.x - 128) < 1e-9 && Math.abs(o.y - 128) < 1e-9); // the equator and prime meridian are the centre of the zoom-0 tile
  assert.ok(Math.abs(project(0, -180, 0).x) < 1e-9);
  assert.ok(Math.abs(project(0, 180, 0).x - 256) < 1e-9);
  assert.ok(project(85.05, 0, 0).y < 0.1); // the top edge of the map
});

test('map maths: projecting and back returns the same place (Port Harcourt)', () => {
  for (const z of [10, 13, 16, 18]) {
    const p = project(4.8156, 7.0498, z);
    const back = unproject(p.x, p.y, z);
    assert.ok(Math.abs(back.lat - 4.8156) < 1e-9 && Math.abs(back.lng - 7.0498) < 1e-9);
  }
});

test('map maths: pixel distances match real distances', () => {
  // One kilometre due east near Port Harcourt should be (1 km / metres-per-pixel) pixels at zoom 16.
  const a = { lat: 4.8156, lng: 7.0498 };
  const km = 1, dLng = km / (111.32 * Math.cos((a.lat * Math.PI) / 180));
  const p = project(a.lat, a.lng, 16), q = project(a.lat, a.lng + dLng, 16);
  const metresPerPx = (156543.03392 * Math.cos((a.lat * Math.PI) / 180)) / 2 ** 16;
  assert.ok(Math.abs((q.x - p.x) * metresPerPx - 1000) < 5);
});

test('straight-line distance: Port Harcourt landmarks are about the right distance apart', () => {
  // Port Harcourt centre to the airport (Omagwa) is about 24-25 km as the crow flies.
  const centre = { lat: 4.8156, lng: 7.0498 }, airport = { lat: 5.0155, lng: 6.9496 };
  const d = haversineKm(centre, airport);
  assert.ok(d > 23 && d < 26, 'got ' + d);
  assert.ok(haversineKm(centre, centre) === 0);
});
