// Web Push (RFC 8030 + 8291 payload encryption + 8292 VAPID) with Node's built-in crypto. No dependencies.
'use strict';
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

function makeVapid() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' }), prv = privateKey.export({ format: 'jwk' });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x), fromB64u(pub.y)])), privateJwk: prv };
}

function vapidHeader(vapid, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// RFC 8291 "aes128gcm" content coding.
function encrypt(sub, payload, opts = {}) {
  const uaPublic = fromB64u(sub.keys.p256dh), authSecret = fromB64u(sub.keys.auth);
  const ecdh = opts.ephemeral || crypto.createECDH('prime256v1');
  if (!opts.ephemeral) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt || crypto.randomBytes(16);
  const prk = hkdf(authSecret, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const data = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 ends the only record
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length; asPublic.copy(header, 21);
  return Buffer.concat([header, body]);
}

// Resolves { ok, gone } and never throws: one dead subscription must not break a delivery update.
async function sendPush(vapid, sub, message, subject = 'mailto:support@bargo.app', timeoutMs = 4000) {
  try {
    const body = encrypt(sub, JSON.stringify(message));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(sub.endpoint, {
        method: 'POST', body, signal: ctl.signal,
        headers: { Authorization: vapidHeader(vapid, sub.endpoint, subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' },
      });
      return { ok: r.ok, gone: r.status === 404 || r.status === 410 };
    } finally { clearTimeout(timer); }
  } catch { return { ok: false, gone: false }; }
}

module.exports = { makeVapid, vapidHeader, encrypt, sendPush, b64u, fromB64u };
