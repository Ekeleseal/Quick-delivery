'use strict';
// Settings come from environment variables so nothing secret lives in the code.
function configFromEnv(env = process.env) {
  return {
    adminPin: env.ADMIN_PIN || '',                         // PIN for the admin screen. Admin is switched off when empty.
    commissionPerDay: Number(env.COMMISSION_PER_DAY) || 500, // starting value; afterwards change it in the admin screen
    sessionSecret: env.SESSION_SECRET || '',               // optional; otherwise one is generated and kept in the database
  };
}
module.exports = { configFromEnv };
