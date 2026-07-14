// Thin wrapper around the Convex HTTP client used by the backend to call native Convex
// functions (queries/mutations). This is the data-access entry point that replaces
// db.query as modules are migrated off SQL/PGlite.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { ConvexHttpClient } = require('convex/browser');

const url = process.env.CONVEX_URL;
if (!url) {
  console.warn('[Convex] CONVEX_URL is not set — Convex-backed routes will fail until it is configured.');
}
const client = url ? new ConvexHttpClient(url) : null;

function ensure() {
  if (!client) throw new Error('CONVEX_URL is not configured on the server.');
  return client;
}

// Run a Convex query, e.g. cq('users:list', {}).
async function cq(name, args = {}) {
  return ensure().query(name, args);
}

// Run a Convex mutation, e.g. cm('users:create', { doc }).
// Convex surfaces a thrown Error's message on the client, so route handlers can catch
// and map it to an HTTP status.
async function cm(name, args = {}) {
  return ensure().mutation(name, args);
}

module.exports = { client, cq, cm };
