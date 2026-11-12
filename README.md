# Bargo

Book a courier in Port Harcourt, agree the price, get it delivered. An installable web app (PWA) for phones and desktops.

- **Senders** pick pickup and drop-off on a real map, see the road distance, post a price. **Couriers** accept or counter. When both sides agree on a price the deal is sealed.
- **Platform commission**: 500 naira per courier per day (charged on the first delivery of the day). The admin can change it; past entries stay as they were.
- **Accounts**: register and log in with phone number + password (sender or courier accounts). Admin signs in with `ADMIN_PIN`.

No dependencies. Needs Node 18+.

## Features

- Negotiated price per delivery, deal sealed when both agree; daily commission per courier.
- Alerts: an Alerts tab with unread badge, sound and vibration while the app is open, and phone push alerts when it is closed (Android Chrome, desktop, and iPhone once added to the Home Screen). Couriers are alerted about new requests for their vehicle; senders about offers, sealed deals, pickup and delivery.
- Delivery code: the sender gets a 4-digit code to give the recipient (WhatsApp/SMS buttons); the courier must enter it to complete the delivery. Five wrong tries lock guessing for 5 minutes.
- Live tracking: while a courier has a delivery in progress and the app is open, the sender sees them on the map with an estimated arrival time.
- In-app chat between sender and courier during a delivery, with quick replies. Navigate buttons open Google Maps for the courier.
- Recent places in the location picker.

## Run locally

```
npm start            # http://localhost:3000
ADMIN_PIN=1234 npm start
npm test
```

Data is saved to `data.json` locally.

## Deploy on Vercel (recommended for phone testing)

Vercel has no permanent disk, so the app must store data in a database or **accounts and requests will disappear**. Bargo uses Upstash Redis (free tier is fine):

1. Push this repo to GitHub and import it in Vercel.
2. In the Vercel project: **Storage** (or Marketplace) -> add **Upstash Redis** and connect it to the project. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) automatically.
3. Add environment variables: `ADMIN_PIN` (required for the admin screen), optionally `SESSION_SECRET` (any long random text), `COMMISSION_PER_DAY` (default 500).
4. Redeploy. If storage is missing the app shows a red warning on the sign-in screen.

## Install on a phone

Open the Vercel link in **Chrome (Android)** or **Safari (iPhone)**, not inside WhatsApp, Facebook or another in-app browser.
- Android: menu -> Install app (or the Install button in Bargo's Profile).
- iPhone: Share -> Add to Home Screen.

If the sign-in screen still says data is not saved after you connected Upstash, open `/api/health` on your site: it lists the database-related setting names the server can see (never their values). Push alerts need no setup: the server makes its own keys and keeps them in the database.

## Maps

Tiles, place search and road routing use OpenStreetMap services (tile.openstreetmap.org, Nominatim, OSRM demo server), limited to the Port Harcourt area. These public servers are for testing and light use. Before launch, switch to a paid or self-hosted provider (tile URL in `public/tilemap.js`, search/route URLs in `public/app.js`).

## Other hosts

`npm start` runs `local.js` (works on Render, Railway, a VPS). Set `DATA_FILE` to a path on a persistent disk.

## Not built yet

Phone-number verification by SMS, courier document checks, in-app payments, push notifications, password reset by SMS (the admin can reset passwords for now).
