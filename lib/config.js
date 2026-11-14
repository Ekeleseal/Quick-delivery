'use strict';
// Settings come from environment variables so nothing secret lives in the code.
function configFromEnv(env = process.env) {
  return {
    adminPin: env.ADMIN_PIN || '',                         // PIN for the admin screen. Admin is switched off when empty.
    commissionPerDay: Number(env.COMMISSION_PER_DAY) || 500, // starting value; afterwards change it in the admin screen
    commissionActive: env.COMMISSION_ACTIVE === '1',       // commission is free until the admin switches it on (or this is set to 1)
    mapsKey: env.GOOGLE_MAPS_KEY || '',                    // optional: better address search (Google Places); restrict the key to your website in Google Cloud
    sessionSecret: env.SESSION_SECRET || '',               // optional; otherwise one is generated and kept in the database
    turnUrls: (env.TURN_URLS || '').split(',').map((x) => x.trim()).filter(Boolean), // optional relay for voice calls on strict mobile networks
    turnUser: env.TURN_USERNAME || '',
    turnPass: env.TURN_CREDENTIAL || '',
  };
}
module.exports = { configFromEnv };
