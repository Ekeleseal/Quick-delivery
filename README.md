# RideDispatch

A dispatch marketplace where the price is negotiated. A customer posts a delivery with the price they want to pay. Dispatch riders can accept it or counter. They go back and forth until one side accepts the other's latest price, and that seals the deal.

The platform earns a flat **₦500 per rider per active day**, however many deliveries the rider completes. The amount is a setting, so it can change later.

No dependencies. Needs Node.js 18 or newer.

## Run it

```bash
npm start
# open http://localhost:3000
```

On first start an admin account is created and its PIN is printed once in the terminal. To choose your own, set `ADMIN_PHONE` and `ADMIN_PIN` before starting. Set `PORT` to change the port. Data is saved to `data.json` (ignored by git).

To try it with sample accounts, start with `SEED_DEMO=1 npm start`. That adds a customer (`08000000001`) and three riders (`08000000011` to `08000000013`), all with PIN `1234`. Never use this in production.

Open the customer and the rider in two browser windows (use a private window for the second so sign-ins do not clash) and run a delivery from request to rating.

## How it works

1. **Customer** signs up, picks pickup and drop-off areas with street addresses, the vehicle type (motorbike, car or van), what is being sent, who pays, and the recipient. They set an opening price. A suggested range is shown as a guide.
2. **Riders** with a matching vehicle who are online see the request. They can accept the asking price, counter, or skip it. They never see the recipient's name or phone number at this stage.
3. **Negotiation** happens in a thread per rider. Either side can counter as often as they like (up to 20 messages per thread). You can only accept the other side's latest price. If a counter matches the other side's last price, the deal seals on the spot.
4. **Sealed**: the customer and the chosen rider see each other's contact details, the other riders' threads close, and the rider's other open negotiations close too. A rider runs one delivery at a time.
5. The rider marks **picked up** and **delivered**. The customer rates the rider.

Payment between customer and rider (cash or transfer) happens outside the app. RideDispatch does not handle the money.

## Commission

- Flat ₦500 per rider per active day, charged when the rider completes their **first delivery of the day** (Africa/Lagos time). The second, third and later deliveries that day cost nothing extra.
- A rider who completes nothing in a day pays nothing.
- Charges go into a ledger as **owed**. The admin marks a rider's balance **paid** once collected.
- The admin can change the amount under Settings. Existing ledger entries keep the amount they were charged at.

## Roles

| Role | What they can do |
| --- | --- |
| Customer | Request deliveries, negotiate, accept or decline offers, cancel before pickup, rate riders |
| Rider | Go online or offline, send offers, accept, run the delivery, see earnings after commission |
| Admin | See all deliveries, riders and the commission ledger, mark commission paid, change commission and minimum price |

Accounts use a phone number and a 4 to 6 digit PIN (stored hashed with scrypt). Sessions are random tokens valid for 30 days. Five wrong PIN attempts lock that phone number for 5 minutes.

## Fares and the map

The suggested price is `(₦500 + ₦150 per km + ₦20 per minute)`, times 1 for a motorbike, 1.6 for a car and 2.4 for a van, rounded to the nearest ₦50. The range shown is 0.8 to 1.4 times that. Edit the `FARE` and `VEHICLES` values at the top of `server.js`.

The map is a simulated city of 10 areas on a 100 by 100 grid, so the app works offline. Customers choose an area plus a free-text street address. Real maps, geocoding and live GPS are the natural next step.

## API

All endpoints are under `/api`. Send `Authorization: Bearer <token>` for signed-in routes.

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/register` | anyone | Create a customer or rider account |
| POST | `/auth/login` | anyone | Sign in |
| POST | `/auth/logout` | signed in | End the session |
| GET | `/me` | signed in | Current user |
| GET | `/config` | anyone | Areas, vehicles, items, commission and price limits |
| POST | `/estimate` | anyone | Suggested price and range |
| GET | `/feed` | signed in | Role-specific data: own deliveries, available requests, or the admin overview |
| POST | `/deliveries` | customer | Post a delivery request |
| POST | `/deliveries/:id/offer` | customer, rider | Send or counter a price |
| POST | `/deliveries/:id/accept` | customer, rider | Accept the other side's latest price |
| POST | `/deliveries/:id/leave` | customer, rider | Decline a rider, or walk away |
| POST | `/deliveries/:id/cancel` | customer | Cancel before pickup |
| POST | `/deliveries/:id/advance` | rider | Picked up, then delivered |
| POST | `/deliveries/:id/rate` | customer | Rate the rider from 1 to 5 |
| POST | `/me/courier` | rider | Go online or offline, update position |
| POST | `/admin/settings` | admin | Commission per day and minimum price |
| POST | `/admin/ledger/:id/paid` | admin | Mark one commission entry paid |
| POST | `/admin/couriers/:id/settle` | admin | Mark all of a rider's commission paid |

## Test

```bash
npm test
```

14 API tests cover sign-in and throttling, role checks, input validation, privacy of recipient details, the full negotiation flow, one-job-at-a-time, cancel rules, ratings, and the once-per-day commission.

## Before real use

This is a working prototype. Before putting it in front of the public:

- Serve it over HTTPS (PINs and tokens travel in requests).
- Replace the JSON file with a database, and add backups.
- Verify phone numbers with an SMS code, and add rider identity checks.
- Add real maps and live location, and push notifications (the app currently refreshes every 3 seconds).
- Decide how commission is collected from riders (for example a payment link) instead of marking it paid by hand.
