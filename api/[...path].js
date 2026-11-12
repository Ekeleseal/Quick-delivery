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
