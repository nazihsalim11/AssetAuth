const { timingSafeEqual } = require('node:crypto');

/**
 * Authorises an external scheduler (Supabase pg_cron, GitHub Actions, curl) to run a
 * background job over HTTP.
 *
 * These endpoints are unauthenticated in the normal sense — there is no user session
 * behind a cron trigger — so the only thing standing between the internet and
 * "re-run every notification sweep" is this shared secret. Two rules follow:
 *
 *   1. An unset or short secret authorises nothing. Failing closed matters because
 *      the natural mistake is deploying without CRON_SECRET set, and a `===` check
 *      against '' would then let every caller through.
 *   2. The comparison is time-constant, so an attacker cannot recover the secret
 *      byte-by-byte from response timings.
 *
 * The length check leaks the secret's length. That is inherent to timingSafeEqual
 * (it throws on mismatched lengths) and is not worth defending against.
 */

const MIN_SECRET_LENGTH = 16;

function isAuthorizedCronRequest(provided, secret) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return false;
  if (typeof provided !== 'string' || provided.length !== secret.length) return false;

  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(secret, 'utf8'));
}

module.exports = { isAuthorizedCronRequest, MIN_SECRET_LENGTH };
