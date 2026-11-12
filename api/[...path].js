// Vercel entry point: every /api/* request lands here.
'use strict';
const { createApp } = require('../lib/app');
const { createStoreFromEnv } = require('../lib/storage');
const { configFromEnv } = require('../lib/config');

const app = createApp(createStoreFromEnv(), configFromEnv());
module.exports = (req, res) => app.handle(req, res);
