// Storage for Bargo. Two backends with the same tiny interface:
//   FileStore    one JSON file. For your own computer and any host with a real disk.
//   UpstashStore Redis over HTTPS. For Vercel, whose functions cannot keep files between requests.
// Writes are compare-and-set on a version number, so two people acting at the same moment
// never overwrite each other: the loser re-reads and tries again.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_KEY = 'bargo:db';
const VER_KEY = 'bargo:ver';

// Atomic "write only if the version is still what I read".
const CAS_LUA = `
local cur = redis.call('GET', KEYS[2])
if not cur then cur = '0' end
if cur ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
return 1`;

function newDb(commissionPerDay = 500) {
  return {
    settings: { commissionPerDay },
    secret: crypto.randomBytes(32).toString('hex'),
    nextUserId: 1,
    nextJobId: 1,
    users: [],
    jobs: [],
    ledger: [],
    throttle: {},
  };
}

class FileStore {
  constructor(file) { this.file = file; this.kind = 'file'; this.db = null; this.version = 0; this.loaded = false; }
  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.version = Number(this.db.__v) || 0;
    } catch { this.db = null; }
  }
  async read() { this.load(); return { db: this.db, version: this.version }; }
  async write(next, expected) {
    this.load();
    if (expected !== this.version) return false;
    next.__v = this.version + 1;
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, this.file);
    this.db = next;
    this.version = next.__v;
    return true;
  }
}

class UpstashStore {
  // cacheMs: reads inside one warm function instance are reused for a few seconds, which keeps
  // the number of Redis commands (and the free-plan quota) low while phones poll for updates.
  constructor(url, token, { cacheMs = 4000 } = {}) {
    this.url = url.replace(/\/+$/, ''); this.token = token; this.cacheMs = cacheMs;
    this.kind = 'upstash'; this.cache = null;
  }
  async cmd(args) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(`Storage error: ${json.error || res.status}`);
    return json.result;
  }
  async read({ fresh } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.val;
    const [raw, ver] = await this.cmd(['MGET', DB_KEY, VER_KEY]);
    const val = { db: raw ? JSON.parse(raw) : null, version: Number(ver) || 0 };
    this.cache = { at: Date.now(), val };
    return val;
  }
  async write(next, expected) {
    const ok = await this.cmd(['EVAL', CAS_LUA, '2', DB_KEY, VER_KEY, String(expected), JSON.stringify(next), String(expected + 1)]);
    if (Number(ok) === 1) { this.cache = { at: Date.now(), val: { db: next, version: expected + 1 } }; return true; }
    this.cache = null;
    return false;
  }
}

// Read, change, write. `fn` gets a private copy of the data and may change it freely.
// If it throws, nothing is written. If someone else wrote first, it runs again on fresh data.
async function mutate(store, fn, fresh = newDb()) {
  for (let i = 0; i < 12; i++) {
    const { db, version } = await store.read({ fresh: true });
    const work = db ? structuredClone(db) : fresh;
    const out = await fn(work);
    if (await store.write(work, version)) return out;
    await new Promise((r) => setTimeout(r, Math.random() * 25 * (i + 1))); // back off so colliding requests spread out
  }
  throw Object.assign(new Error('The server is busy. Please try again.'), { status: 503 });
}

function createStoreFromEnv(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashStore(url, token);
  const onVercel = !!(env.VERCEL || env.NOW_REGION);
  const file = env.DATA_FILE || (onVercel ? '/tmp/bargo-data.json' : path.join(__dirname, '..', 'data.json'));
  const store = new FileStore(file);
  // On Vercel a file does not survive between requests, so say so loudly instead of losing data quietly.
  store.ephemeral = onVercel;
  return store;
}

module.exports = { FileStore, UpstashStore, mutate, newDb, createStoreFromEnv, CAS_LUA };
