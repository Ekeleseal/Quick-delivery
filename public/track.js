'use strict';
// Public tracking page for the person receiving a package. No login: the link is the key.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
const token = new URLSearchParams(location.search).get('t') || '';
const VEH = { bike: 'bike', car: 'car', van: 'van' };
let map = null, sig = '', timer = null, failed = 0;

const hav = (a, b) => { const R = 6371, r = (x) => (x * Math.PI) / 180, dLa = r(b.lat - a.lat), dLn = r(b.lng - a.lng); const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

function headline(t) {
  if (t.status === 'open') return ['Finding a courier', `${t.senderFirstName} has asked couriers to collect your package. It will be assigned soon.`];
  if (t.status === 'agreed') return ['Courier assigned', `${t.courier ? t.courier.firstName : 'A courier'} is heading to ${t.senderFirstName} to pick up your package.`];
  if (t.status === 'picked_up') return ['On the way to you', `${t.courier ? t.courier.firstName : 'Your courier'} has your package. Have your 4-digit delivery code ready.`];
  if (t.status === 'delivered') return ['Delivered', 'Your package has been handed over. Thank you for using Bargo.'];
  return ['Delivery cancelled', 'This delivery was cancelled. Contact the sender if you were expecting it.'];
}

function draw(t) {
  const [h1, sub] = headline(t), order = ['open', 'agreed', 'picked_up', 'delivered'], at = order.indexOf(t.status);
  const labels = ['Requested', 'Courier assigned', 'On the way', 'Delivered'];
  let eta = '';
  if (t.courierLoc && ['agreed', 'picked_up'].includes(t.status)) {
    const km = hav(t.courierLoc, t.status === 'agreed' ? t.pickup : t.drop) * 1.35, min = Math.max(1, Math.round((km / 25) * 60));
    const age = Math.round((Date.now() - t.courierLoc.at) / 60000);
    eta = `<p class="eta"><span class="live"></span>About <b>${min} min</b> ${t.status === 'agreed' ? 'from the pickup' : 'from you'}${age >= 2 ? `<small class="muted"> (last seen ${age} min ago)</small>` : ''}</p>`;
  }
  const pay = t.pay && t.status !== 'delivered' && t.status !== 'cancelled' && t.status !== 'open' ? `<div class="panel pay"><div class="row between"><p class="sub">You pay the courier</p><b class="price">${money(t.pay.amount)}</b></div>
    ${t.pay.method === 'cash' ? '<p class="small">Pay in cash when the package arrives.</p>'
      : t.pay.bank ? `<p class="small">Bank transfer to:</p><div class="bank"><div><small>Bank</small><b>${esc(t.pay.bank.bankName)}</b></div><div><small>Account number</small><b>${esc(t.pay.bank.accountNumber)}</b></div><div><small>Account name</small><b>${esc(t.pay.bank.accountName)}</b></div></div>` : '<p class="small">Pay by bank transfer. The courier will share account details.</p>'}</div>` : '';
  const scr = $('#screen');
  if (map) { map.destroy(); map = null; }
  scr.innerHTML = `<div class="brandbar"><b>Bargo</b><small>Delivery #${t.id}</small></div>
    <h2 class="title">${esc(h1)}</h2><p class="sub" style="margin:.3rem 0 .8rem">${esc(sub)}</p>
    ${t.status !== 'cancelled' ? `<div class="progress">${labels.map((l, i) => `<div class="${i <= at ? 'done' : ''}"><i></i>${l}</div>`).join('')}</div>` : ''}
    <div class="routebox"><div class="lmap" id="tmap" role="img" aria-label="Map of the delivery"></div><p><b>${t.km} km</b> by road</p>${eta}</div>
    ${t.courier ? `<div class="panel"><p class="sub">Your courier</p><b>${esc(t.courier.firstName)}</b>${t.courier.verified ? ' <span class="vbadge">&#10003; Verified</span>' : ''} <span class="muted small">${esc(VEH[t.courier.vehicle] || t.courier.vehicle)}, ${esc(t.courier.plate)}, ${Number(t.courier.rating || 0).toFixed(1)} stars</span></div>` : ''}
    <div class="kv"><div><small>Item</small><span>${esc(t.itemType)}</span></div><div><small>From</small><span>${esc(t.senderFirstName)}, ${esc(t.pickup.label)}</span></div><div class="full"><small>Delivering to</small><span>${esc(t.drop.label)}${t.drop.details ? `<br><small class="detail">${esc(t.drop.details)}</small>` : ''}</span></div></div>
    ${pay}
    ${['agreed', 'picked_up'].includes(t.status) ? '<p class="notice">Only give your delivery code to the courier when you are holding the package.</p>' : ''}
    <p class="small muted" style="text-align:center;margin-top:1rem">This page updates by itself.</p>`;
  const el = $('#tmap');
  if (el && window.TileMap) {
    map = new TileMap(el, { interactive: false });
    const line = t.routeGeo && t.routeGeo.length > 1 ? t.routeGeo : [[t.pickup.lat, t.pickup.lng], [t.drop.lat, t.drop.lng]];
    map.addLine(line, { dashed: !(t.routeGeo && t.routeGeo.length > 1) });
    map.addMarker(t.pickup.lat, t.pickup.lng, 'pickup', t.pickup.label);
    map.addMarker(t.drop.lat, t.drop.lng, 'drop', t.drop.label);
    if (t.courierLoc) map.addMarker(t.courierLoc.lat, t.courierLoc.lng, 'courier', 'Courier');
    map.fitBounds([...line, t.pickup, t.drop, ...(t.courierLoc ? [t.courierLoc] : [])]);
  }
}

async function tick() {
  clearTimeout(timer);
  let next = 8000;
  try {
    const res = await fetch('/api/track/' + encodeURIComponent(token), { headers: { Accept: 'application/json' } });
    const t = await res.json().catch(() => ({}));
    if (!res.ok) { $('#screen').innerHTML = `<div class="brandbar"><b>Bargo</b></div><h2 class="title">${res.status === 404 ? 'Link not found' : 'Something went wrong'}</h2><p class="sub" style="margin-top:.5rem">${esc(t.error || 'Please try again.')}</p>`; return; }
    failed = 0;
    const s = JSON.stringify({ ...t, now: 0 });
    if (s !== sig) { sig = s; draw(t); }
    if (['delivered', 'cancelled'].includes(t.status)) next = 60000;
  } catch { failed += 1; if (failed > 2 && !sig) $('#screen').innerHTML = '<p class="empty">No connection. We will keep trying.</p>'; next = 12000; }
  if (!document.hidden) timer = setTimeout(tick, next);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
if (!token) $('#screen').innerHTML = '<div class="brandbar"><b>Bargo</b></div><h2 class="title">Link not valid</h2><p class="sub">Ask the sender to share the tracking link again.</p>';
else tick();
