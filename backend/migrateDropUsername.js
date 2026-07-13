// One-off migration: remove the retired `username` field from every user document in
// Convex. Username has been replaced by email as the sole identifier. The backend also
// strips a stray `username` key defensively on load (see db.js), so this is belt-and-
// suspenders — run it once to clean the stored data immediately.
//
// Usage (run from anywhere):
//   node backend/migrateDropUsername.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { ConvexHttpClient } = require('convex/browser');

async function main() {
  const url = process.env.CONVEX_URL;
  if (!url) {
    console.error('CONVEX_URL is not set in backend/.env — nothing to migrate.');
    process.exit(1);
  }

  const convex = new ConvexHttpClient(url);
  const users = await convex.query('generic:list', { table: 'users' });
  const had = (users || []).filter((u) => 'username' in u).length;

  const cleaned = (users || []).map((u) => {
    const { username, ...rest } = u; // drop username; syncTable strips _id/_creationTime
    return rest;
  });

  await convex.mutation('generic:syncTable', { table: 'users', documents: cleaned });
  console.log(`Rewrote ${cleaned.length} user document(s); removed username from ${had}.`);
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
