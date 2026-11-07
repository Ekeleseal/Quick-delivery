// RideDispatch: e-hailing + dispatch in one. Zero dependencies (Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Simulated city map (0-100 grid) ----------
const PLACES = [
  { id: 'airport', name: 'Airport', x: 90, y: 12 },
  { id: 'station', name: 'Central Station', x: 50, y: 50 },
  { id: 'market', name: 'Main Market', x: 28, y: 62 },
  { id: 'univ', name: 'University', x: 15, y: 20 },
  { id: 'hospital', name: 'General Hospital', x: 70, y: 35 },
  { id: 'mall', name: 'City Mall', x: 78, y: 70 },
  { id: 'stadium', name: 'Stadium', x: 40, y: 15 },
  { id: 'harbor', name: 'Harbor', x: 55, y: 90 },
  { id: 'hotel', name: 'Grand Hotel', x: 62, y: 58 },
  { id: 'park', name: 'Riverside Park', x: 22, y: 88 },
];
const KM_PER_UNIT = 0.35;
const FARE = { base: 500, perKm: 150, perMin: 20, currency: 'NGN', minFare: 800 };
const AVG_SPEED_KMH = 30;

// ---------- Persistence ----------
let db;
function seed() {
  const mk = (id, name, vehicle, plate, x, y) => ({
    id, name, vehicle, plate, status: 'online', x, y, rating: 4.8, ratingCount: 10, completed: 0,
  });
  return {
    settings: { autoDispatch: true },
    nextRideId: 1,
    nextDriverId: 6,
    drivers: [
      mk('d1', 'Emeka Obi', 'Toyota Corolla', 'RV-123-AA', 48, 45),
      mk('d2', 'Amina Yusuf', 'Honda Accord', 'RV-456-BB', 20, 60),
      mk('d3', 'Tunde Bello', 'Kia Rio', 'RV-789-CC', 75, 30),
      mk('d4', 'Grace Okon', 'Toyota Camry', 'RV-321-DD', 60, 80),
      mk('d5', 'Ibrahim Musa', 'Hyundai Elantra', 'RV-654-EE', 35, 20),
    ],
    rides: [],
  };
}
function load() {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { db = seed(); save(); }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('save failed', e.message); }
  }, 100);
}

// ---------- Helpers ----------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * KM_PER_UNIT;
const place = (id) => PLACES.find((p) => p.id === id);
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

function estimate(pickup, dropoff) {
  const km = dist(pickup, dropoff);
  const minutes = (km / AVG_SPEED_KMH) * 60;
  const fare = Math.max(FARE.minFare, FARE.base + km * FARE.perKm + minutes * FARE.perMin);
  return { km: round(km, 1), minutes: Math.max(1, Math.round(minutes)), fare: Math.round(fare / 50) * 50 };
}

const ACTIVE = ['assigned', 'accepted', 'arrived', 'in_progress'];
const driverBusy = (d) => db.rides.some((r) => r.driverId === d.id && ACTIVE.includes(r.status));

function nearestDrivers(ride) {
  return db.drivers
    .filter((d) => d.status === 'online' && !driverBusy(d) && !(ride.declinedBy || []).includes(d.id))
    .map((d) => ({ d, km: dist(d, ride.pickup) }))
    .sort((a, b) => a.km - b.km);
}

function assign(ride, driver, by) {
  ride.driverId = driver.id;
  ride.status = 'assigned';
  ride.assignedBy = by;
  ride.etaMin = Math.max(1, Math.round((dist(driver, ride.pickup) / AVG_SPEED_KMH) * 60));
  ride.timeline.push({ status: 'assigned', at: Date.now(), note: `${driver.name} (${by})` });
}

function autoAssign(ride) {
  const c = nearestDrivers(ride)[0];
  if (!c) return false;
  assign(ride, c.d, 'auto');
  return true;
}

function dispatchPending() {
  for (const r of db.rides.filter((r) => r.status === 'requested')) {
    if (!autoAssign(r)) break;
  }
}

// ---------- Ride state machine ----------
const NEXT = { assigned: 'accepted', accepted: 'arrived', arrived: 'in_progress', in_progress: 'completed' };

function advance(ride, driver) {
  const next = NEXT[ride.status];
  if (!next) throw httpErr(409, `Cannot advance from ${ride.status}`);
  ride.status = next;
  ride.timeline.push({ status: next, at: Date.now() });
  if (next === 'completed') { driver.completed += 1; ride.finalFare = ride.estimate.fare; }
}

// ---------- HTTP ----------
const httpErr = (status, message) => Object.assign(new Error(message), { status });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) { reject(httpErr(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(httpErr(400, 'Invalid JSON')); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const need = (cond, code, msg) => { if (!cond) throw httpErr(code, msg); };
const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);

const findRide = (id) => { const r = db.rides.find((r) => String(r.id) === String(id)); need(r, 404, 'Ride not found'); return r; };
const findDriver = (id) => { const d = db.drivers.find((d) => d.id === id); need(d, 404, 'Driver not found'); return d; };

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop 'api'
  const m = req.method;
  const body = m === 'POST' ? await readBody(req) : {};

  if (m === 'GET' && parts[0] === 'state') {
    return send(res, 200, { places: PLACES, fare: FARE, settings: db.settings, drivers: db.drivers, rides: db.rides.slice(-100), now: Date.now() });
  }
  if (m === 'POST' && parts[0] === 'estimate') {
    const a = place(body.pickupId), b = place(body.dropoffId);
    need(a && b, 400, 'Invalid pickup or dropoff');
    return send(res, 200, estimate(a, b));
  }
  if (m === 'POST' && parts[0] === 'settings') {
    if (typeof body.autoDispatch === 'boolean') db.settings.autoDispatch = body.autoDispatch;
    if (db.settings.autoDispatch) dispatchPending();
    save();
    return send(res, 200, db.settings);
  }

  // Rides
  if (parts[0] === 'rides') {
    if (m === 'POST' && parts.length === 1) {
      const a = place(body.pickupId), b = place(body.dropoffId);
      need(a && b, 400, 'Invalid pickup or dropoff');
      need(a.id !== b.id, 400, 'Pickup and dropoff must differ');
      const riderName = str(body.riderName);
      need(riderName, 400, 'Rider name is required');
      const ride = {
        id: db.nextRideId++, riderName, riderPhone: str(body.riderPhone, 20),
        pickup: a, dropoff: b, estimate: estimate(a, b),
        status: 'requested', driverId: null, declinedBy: [], createdAt: Date.now(),
        timeline: [{ status: 'requested', at: Date.now() }],
      };
      db.rides.push(ride);
      if (db.settings.autoDispatch) autoAssign(ride);
      save();
      return send(res, 201, ride);
    }
    const ride = findRide(parts[1]);
    const action = parts[2];
    if (m === 'POST' && action === 'cancel') {
      need(['requested', 'assigned', 'accepted'].includes(ride.status), 409, 'Ride can no longer be cancelled');
      ride.status = 'cancelled';
      ride.timeline.push({ status: 'cancelled', at: Date.now() });
      if (db.settings.autoDispatch) dispatchPending();
      save();
      return send(res, 200, ride);
    }
    if (m === 'POST' && action === 'assign') {
      need(['requested', 'assigned'].includes(ride.status), 409, 'Ride cannot be (re)assigned now');
      const d = findDriver(body.driverId);
      need(d.status === 'online', 409, 'Driver is offline');
      need(!driverBusy(d) || ride.driverId === d.id, 409, 'Driver is busy');
      assign(ride, d, 'dispatcher');
      save();
      return send(res, 200, ride);
    }
    if (m === 'POST' && action === 'auto-assign') {
      need(['requested', 'assigned'].includes(ride.status), 409, 'Ride cannot be (re)assigned now');
      need(autoAssign(ride), 409, 'No available drivers');
      save();
      return send(res, 200, ride);
    }
    if (m === 'POST' && action === 'decline') {
      need(ride.status === 'assigned' && ride.driverId === body.driverId, 409, 'Not assigned to this driver');
      ride.declinedBy.push(ride.driverId);
      ride.timeline.push({ status: 'declined', at: Date.now(), note: ride.driverId });
      ride.driverId = null; ride.status = 'requested';
      if (db.settings.autoDispatch) autoAssign(ride);
      save();
      return send(res, 200, ride);
    }
    if (m === 'POST' && action === 'advance') {
      need(ride.driverId === body.driverId, 403, 'Not your ride');
      const d = findDriver(ride.driverId);
      advance(ride, d);
      if (ride.status === 'completed') { d.x = ride.dropoff.x; d.y = ride.dropoff.y; if (db.settings.autoDispatch) dispatchPending(); }
      save();
      return send(res, 200, ride);
    }
    if (m === 'POST' && action === 'rate') {
      need(ride.status === 'completed', 409, 'Ride not completed');
      need(!ride.rating, 409, 'Already rated');
      const n = Number(body.rating);
      need(n >= 1 && n <= 5, 400, 'Rating must be 1-5');
      ride.rating = n;
      const d = findDriver(ride.driverId);
      d.rating = round((d.rating * d.ratingCount + n) / (d.ratingCount + 1), 2);
      d.ratingCount += 1;
      save();
      return send(res, 200, ride);
    }
  }

  // Drivers
  if (parts[0] === 'drivers') {
    if (m === 'POST' && parts.length === 1) {
      const name = str(body.name), vehicle = str(body.vehicle), plate = str(body.plate, 15);
      need(name && vehicle && plate, 400, 'name, vehicle and plate are required');
      const p = PLACES[Math.floor(Math.random() * PLACES.length)];
      const d = { id: 'd' + db.nextDriverId++, name, vehicle, plate, status: 'offline', x: p.x, y: p.y, rating: 5, ratingCount: 0, completed: 0 };
      db.drivers.push(d); save();
      return send(res, 201, d);
    }
    const d = findDriver(parts[1]);
    if (m === 'POST' && parts[2] === 'status') {
      need(['online', 'offline'].includes(body.status), 400, 'status must be online or offline');
      need(!(body.status === 'offline' && driverBusy(d)), 409, 'Finish your active ride first');
      d.status = body.status;
      if (d.status === 'online' && db.settings.autoDispatch) dispatchPending();
      save();
      return send(res, 200, d);
    }
    if (m === 'POST' && parts[2] === 'location') {
      const x = Number(body.x), y = Number(body.y);
      need(x >= 0 && x <= 100 && y >= 0 && y <= 100, 400, 'x,y must be within 0-100');
      d.x = x; d.y = y; save();
      return send(res, 200, d);
    }
  }
  throw httpErr(404, 'Not found');
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    send(res, e.status || 500, { error: e.message || 'Server error' });
  }
});

load();
if (require.main === module) {
  server.listen(PORT, () => console.log(`RideDispatch running at http://localhost:${PORT}`));
}
module.exports = server;
