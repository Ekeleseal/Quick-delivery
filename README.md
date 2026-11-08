# Bargo

Book a courier, agree the price, get it delivered.

A sender posts a delivery with their own opening price. Couriers can accept it or send a counter-offer, and the two sides go back and forth until one accepts the other's price. That moment seals the deal. The platform earns a flat daily commission from each courier.

It is a Progressive Web App: it installs on phones and desktops and opens offline. There are no dependencies. It needs Node.js 18 or newer.

## Run it

```bash
npm start
# open http://localhost:3000
```

| Setting | What it does | Default |
| --- | --- | --- |
| `PORT` | Port to listen on | `3000` |
| `ADMIN_PIN` | PIN required to open the admin screen. Leave empty to leave admin open (fine for local testing only) | none |
| `COMMISSION_PER_DAY` | Starting daily commission in naira. Afterwards change it in the admin screen | `500` |
| `DATA_FILE` | Where data is saved | `data.json` |

## The three roles

- **Sender**: choose pickup, delivery, vehicle and item, set an opening price (a suggestion is shown), then negotiate with couriers. Accept, counter or decline each offer. Instant or scheduled.
- **Courier**: go online, see requests for your vehicle type, then accept, counter or reject. After a deal: picked up, then delivered. Earnings are shown by day.
- **Admin**: totals, every courier's earnings, the commission ledger, and the daily commission setting. Open it from the small "Admin" link on the welcome screen.

Try it with two browser windows: book as a sender in one, and choose a courier profile (for example Emeka Obi, who rides a bike) in the other.

## How a deal works

1. The sender posts a delivery with an opening price.
2. Each courier can accept that price (deal sealed), counter, or reject. Each courier has their own conversation with the sender.
3. Offers go back and forth, one side at a time. Whoever accepts the other's latest price seals the deal at that price.
4. Once sealed, other offers close and the courier and sender see each other's phone numbers. The recipient's contact is hidden from couriers until then.
5. The courier marks picked up, then delivered. The sender can rate the courier.
6. A sender can cancel until pickup. A courier can pull out before pickup, which reopens the delivery.

Payment of the agreed price happens between sender and courier, in cash or by bank transfer. The app does not handle money.

## Commission

A flat **₦500 per courier per working day**, charged when the courier completes their first delivery of the day (Lagos time), however many deliveries they do after that. A cancelled delivery costs the courier nothing.

Change the amount in the admin screen. The new amount applies to later days. Past charges are kept exactly as they were.

## Install it as an app (PWA)

Installing needs HTTPS (or `localhost`). A plain `http://` address on your local network will not offer the install option on phones.

1. Deploy it (see below) so you get an `https://` address.
2. **Android / Chrome**: open the address, then use the "Install app" button on the welcome screen, or Chrome's menu, Install app.
3. **iPhone / Safari**: open the address, tap Share, then Add to Home Screen.
4. **Desktop Chrome or Edge**: click the install icon at the right of the address bar.

The app shell is cached, so it opens without a connection. Prices and deals always need to be online.

## Deploy

On [Render](https://render.com): New, then Blueprint, pick this repo. `render.yaml` sets it up and asks for an `ADMIN_PIN`. Any host that runs Node works too: run `node server.js` and set `PORT`.

The free Render plan has no persistent disk, so data resets when the service restarts. For real use, attach a disk and set `DATA_FILE=/var/data/data.json`, or move storage to a database.

## Test

```bash
npm test
```

## Before real use

This is a working prototype. Senders and couriers have no sign-in: anyone who opens the app can pick a courier profile. Add real accounts (phone verification), a database and identity checks for couriers before putting it in front of the public.

## API

All JSON under `/api`. Main routes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/meta` | Areas, vehicles, item types, current commission |
| POST | `/estimate` | Suggested price for a trip |
| POST | `/jobs` | Post a delivery |
| GET | `/sender/:id/jobs` | A sender's deliveries with offers |
| POST | `/jobs/:id/sender/{counter,accept,decline}` | Sender replies to a courier's offer |
| POST | `/jobs/:id/driver/{accept,counter,reject,pickup,deliver,withdraw}` | Courier actions |
| POST | `/jobs/:id/{cancel,rate}` | Cancel, or rate after delivery |
| GET | `/driver/:id` | Courier feed: requests, offers, current job, earnings |
| GET, POST | `/drivers`, `/drivers/:id/status` | List, register, go online or offline |
| GET, POST | `/admin`, `/admin/settings` | Admin overview and commission (header `x-admin-pin`) |
