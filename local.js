// Run Bargo on your own computer or any host with a Node process: `node local.js`
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createApp } = require('./lib/app');
const { createStoreFromEnv } = require('./lib/storage');
const { configFromEnv } = require('./lib/config');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function createServer(app) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return app.handle(req, res);
    let rel;
    try { rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(file);
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      // The page shell, service worker and manifest must always revalidate so updates reach installed apps.
      if (ext === '.html' || ext === '.webmanifest' || path.basename(file) === 'sw.js') headers['Cache-Control'] = 'no-cache';
      if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
      res.writeHead(200, headers);
      res.end(buf);
    });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const store = createStoreFromEnv();
  const app = createApp(store, configFromEnv());
  const port = process.env.PORT || 3000;
  createServer(app).listen(port, '0.0.0.0', () => {
    console.log(`Bargo running at http://localhost:${port} (storage: ${store.kind})`);
    if (!configFromEnv().adminPin) console.log('Admin is switched off. Set ADMIN_PIN to turn it on.');
  });
}
