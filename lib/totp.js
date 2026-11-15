'use strict';
// Time-based one-time codes (RFC 6238) for admin two-step sign-in. Works with Google Authenticator, Authy, Microsoft Authenticator.
const crypto = require('crypto');
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) { val = (val << 5) | ALPHA.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const newSecret = () => b32encode(crypto.randomBytes(20));
function code(secret, t = Date.now()) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function verify(secret, given, t = Date.now()) {
  const g = String(given ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(g)) return false;
  let ok = false;
  for (const d of [-1, 0, 1]) { const c = code(secret, t + d * 30000); if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(g))) ok = true; }
  return ok;
}
const uri = (secret, label) => `otpauth://totp/${encodeURIComponent('Bargo:' + label)}?secret=${secret}&issuer=Bargo&digits=6&period=30`;
module.exports = { newSecret, code, verify, uri };
