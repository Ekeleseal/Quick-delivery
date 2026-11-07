# RideDispatch

E-hailing and dispatch in one web app. Riders book trips, drivers accept and run them, and a dispatcher watches the whole city on a live map and can assign drivers by hand.

No dependencies. It needs Node.js 18 or newer.

## Run it

```bash
npm start
# open http://localhost:3000
```

Set `PORT` to use a different port. Data is saved to `data.json` (ignored by git). Delete that file to reset to the demo drivers.

## Three views, one app

- **Rider**: choose a pickup and drop-off, see the fare before you book, follow your driver, cancel, and rate the trip.
- **Driver**: pick a profile, go online or offline, accept or decline requests, then mark arrived, start and complete. Tap the map to move your car. New drivers can register from this view.
- **Dispatcher**: see waiting and active rides, drivers and their status. Turn automatic dispatch on or off, assign any free driver (sorted by distance) or let the nearest one take it, reassign, and cancel.

Open each view in its own browser tab to try a full ride: book as a rider, accept as the driver, and watch it in the dispatch desk.

## How dispatch works

- With automatic dispatch on, a new ride goes to the nearest online driver who is not already on a ride.
- If a driver declines, the ride moves to the next nearest driver.
- Rides that cannot be assigned wait in a queue and are assigned when a driver goes online or finishes a trip.
- With automatic dispatch off, the dispatcher assigns every ride.

Ride lifecycle: `requested` → `assigned` → `accepted` → `arrived` → `in_progress` → `completed` (or `cancelled` before the trip starts).

## Fares

`max(₦800, ₦500 base + ₦150 per km + ₦20 per minute)`, rounded to the nearest ₦50. Change the numbers in `FARE` at the top of `server.js`.

The map is a simulated 10-place city on a 100 by 100 grid, so the app works offline. Real maps and live GPS are the natural next step.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state` | Places, drivers, recent rides, settings |
| POST | `/api/estimate` | Fare estimate for `pickupId`, `dropoffId` |
| POST | `/api/settings` | Turn `autoDispatch` on or off |
| POST | `/api/rides` | Request a ride |
| POST | `/api/rides/:id/cancel` | Cancel a ride |
| POST | `/api/rides/:id/assign` | Dispatcher assigns `driverId` |
| POST | `/api/rides/:id/auto-assign` | Assign the nearest free driver |
| POST | `/api/rides/:id/decline` | Driver declines an assigned ride |
| POST | `/api/rides/:id/advance` | Driver moves the ride to its next step |
| POST | `/api/rides/:id/rate` | Rider rates the trip from 1 to 5 |
| POST | `/api/drivers` | Register a driver |
| POST | `/api/drivers/:id/status` | Go `online` or `offline` |
| POST | `/api/drivers/:id/location` | Update position (`x`, `y` from 0 to 100) |

## Test

```bash
npm test
```

## Before real use

This is a working prototype. There is no sign-in, so anyone can act as any driver or dispatcher, and data lives in one JSON file. Add authentication, a database and real payments before putting it in front of the public.
