// Shared test helpers: a tiny HTTP client that keeps cookies, and a ready-to-use server.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../lib/app');
const { FileStore } = require('../lib/storage');
const { createServer } = require('../local');

async function startServer({ store, config } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bargo-')), 'data.json');
  store = store || new FileStore(file);
  const app = createApp(store, { adminPin: '4321', ...config });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  return { server, base, store, file };
}

// A browser-like client: remembers the session cookie.
function client(base) {
  let cookie = '';
  const c = {
    async call(p, body, headers = {}) {
      const res = await fetch(base + '/api/' + p, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.getSetCookie?.() || [];
      for (const s of set) {
        const pair = s.split(';')[0];
        if (/Max-Age=0/i.test(s)) cookie = ''; else cookie = pair;
      }
      return { status: res.status, json: await res.json(), setCookie: set };
    },
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
  return c;
}

// Two points inside Port Harcourt, about 6 km apart.
const RUMUOLA = { lat: 4.8315, lng: 7.0194, label: 'Rumuola', address: '12 Rumuola Road' };
const MILE1 = { lat: 4.787, lng: 7.0013, label: 'Mile 1', address: 'Mile 1 Market' };

let counter = 0;
const phone = () => '0803' + String(1000000 + ++counter).slice(-7);

module.exports = { startServer, client, RUMUOLA, MILE1, phone };
