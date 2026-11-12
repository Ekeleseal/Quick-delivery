// Vercel entry point: every /api/* request lands here.
'use strict';
let app, initError;
try {
  const { createApp } = require('../lib/app');
  const { createStoreFromEnv } = require('../lib/storage');
  const { configFromEnv } = require('../lib/config');
  app = createApp(createStoreFromEnv(), configFromEnv());
} catch (e) { initError = e; console.error(e); }

module.exports = async (req, res) => {
  try {
    if (initError) throw initError;
    // vercel.json rewrites /api/<anything> to this file as /api/index?__p=<anything>; restore the real path.
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/index' && u.searchParams.has('__p')) {
      const p = u.searchParams.get('__p'); u.searchParams.delete('__p');
      const q = u.searchParams.toString();
      req.url = '/api/' + p + (q ? '?' + q : '');
    }
    await app.handle(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'Server error: ' + String((e && e.message) || e).slice(0, 160) }));
  }
};
