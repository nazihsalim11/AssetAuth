// One-off helper: make an email a Super Admin.
//
// Usage (run from anywhere):
//   node backend/createAdmin.js <email> <password>
//
// It does two things:
//   1. Ensures a WorkOS login exists for <email> with <password> (creates it, or
//      resets the password if the user already exists). WorkOS owns the credential;
//      no password is stored in the app.
//   2. Writes/updates that user's application profile with role "Super Admin" in the
//      shared Convex database, so the account has full access on next sign-in —
//      regardless of BOOTSTRAP_ADMIN_EMAIL.
//
// You must also enable Email + Password in the WorkOS dashboard
// (Configuration > Authentication) or sign-in will be rejected.
//
// After it runs, RESTART the backend so it reloads the profile from Convex, then sign
// in on the app login page with this email + password.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { WorkOS } = require('@workos-inc/node');
const { ConvexHttpClient } = require('convex/browser');

async function ensureWorkosUser(workos, email, password) {
  const existing = await workos.userManagement.listUsers({ email, limit: 1 });
  if (existing.data && existing.data.length > 0) {
    const u = existing.data[0];
    console.log(`• WorkOS user already exists for ${email} (id: ${u.id}).`);
    try {
      await workos.userManagement.updateUser({ userId: u.id, password, emailVerified: true });
      console.log('  Reset its password to the one provided.');
    } catch (e) {
      console.warn('  Could not reset the password automatically:', e.message);
      console.warn('  Use "Forgot Password?" on the login page if you do not know it.');
    }
    return u.id;
  }
  const created = await workos.userManagement.createUser({
    email,
    password,
    emailVerified: true,
    firstName: 'Admin',
    lastName: 'Operations',
  });
  console.log(`• Created WorkOS user ${email} (id: ${created.id}).`);
  return created.id;
}

async function upsertAdminProfile(convex, email, workosUserId) {
  const users = await convex.query('generic:list', { table: 'users' });
  const match = (users || []).find((u) => (u.email || '').toLowerCase() === email.toLowerCase());

  if (match) {
    await convex.mutation('generic:update', {
      table: 'users',
      idField: '_id',
      idVal: match._id,
      patch: { role: 'Super Admin', workos_user_id: workosUserId, status: 'Active' },
    });
    console.log(`• Updated existing profile "${match.name || email}" to Super Admin.`);
  } else {
    await convex.mutation('generic:insert', {
      table: 'users',
      document: {
        workos_user_id: workosUserId,
        name: 'Admin Operations',
        role: 'Super Admin',
        email,
        status: 'Active',
        notification_preferences: { email: true, push: true },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
    console.log(`• Created Super Admin profile for ${email}.`);
  }
}

async function main() {
  const apiKey = process.env.WORKOS_API_KEY;
  const convexUrl = process.env.CONVEX_URL;
  if (!apiKey) {
    console.error('WORKOS_API_KEY is not set in backend/.env.');
    process.exit(1);
  }
  if (!convexUrl) {
    console.error('CONVEX_URL is not set in backend/.env — cannot write the admin profile.');
    process.exit(1);
  }

  const [emailArg, password] = process.argv.slice(2);
  const email = (emailArg || '').trim();
  if (!email || !email.includes('@')) {
    console.error('Usage: node backend/createAdmin.js <email> <password>');
    process.exit(1);
  }
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const workos = new WorkOS(apiKey);
  const convex = new ConvexHttpClient(convexUrl);

  try {
    const workosUserId = await ensureWorkosUser(workos, email, password);
    await upsertAdminProfile(convex, email, workosUserId);

    console.log('\n✓ Done. Next steps:');
    console.log('  1. Enable Configuration > Authentication > Email + Password in the WorkOS dashboard.');
    console.log('  2. Restart the backend (so it reloads the profile from Convex).');
    console.log('  3. Sign in on the app login page with this email + password — you will be Super Admin.\n');
  } catch (err) {
    console.error('\nFailed:', err.message);
    if (err.rawData) console.error(JSON.stringify(err.rawData, null, 2));
    process.exit(1);
  }
}

main();
