const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { cm } = require('./convexApi');
const storage = require('./storage');
const notifications = require('./notifications');
const scheduler = require('./notifications/scheduler');
const { registerCronRoutes } = require('./cronRoutes');
const permissionModel = require('./permissionModel');
const knowledgeBase = require('./knowledgeBase');
const purchaseOrders = require('./purchaseOrders');
const slaRoutes = require('./slaRoutes');
const dashboards = require('./dashboards');
const reports = require('./reports');
const createAuth = require('./src/middleware/auth');
const assetsRoutes = require('./src/routes/assets');
const amcRoutes = require('./src/routes/amc');
const invoicesRoutes = require('./src/routes/invoices');
const movementsRoutes = require('./src/routes/movements');
const documentsRoutes = require('./src/routes/documents');
const logsRoutes = require('./src/routes/logs');
const notificationsRoutes = require('./src/routes/notifications');
const permissionsRoutes = require('./src/routes/permissions');
const importsRoutes = require('./src/routes/imports');
const assignmentsRoutes = require('./src/routes/assignments');
const ticketsRoutes = require('./src/routes/tickets');
const authRoutes = require('./src/routes/auth');
const usersRoutes = require('./src/routes/users');
const filesRoutes = require('./src/routes/files');
const mastersRoutes = require('./src/routes/masters');
const createActorOf = require('./src/utils/actor');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === frontendUrl || origin.startsWith('http://localhost:') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(null, false);
  },
  credentials: true
}));

app.use(express.json());

// Liveness probe. Unauthenticated and touches no database, so it can serve as a
// health check for the host, a warm-up ping to wake a sleeping free-tier instance,
// and the frontend's connectivity test — none of which should need a token or log a
// 401. Kept before the auth middleware for exactly that reason.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'assetflow-api', time: new Date().toISOString() });
});

// Middleware to recursively map snake_case request body keys to camelCase
function normalizeSnakeToCamel(obj) {
  if (Array.isArray(obj)) {
    return obj.map(v => normalizeSnakeToCamel(v));
  } else if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const keys = Object.keys(obj);
    for (const key of keys) {
      const val = normalizeSnakeToCamel(obj[key]);
      obj[key] = val;
      if (key.includes('_')) {
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        if (obj[camelKey] === undefined) {
          obj[camelKey] = val;
        }
      }
    }
  }
  return obj;
}

app.use((req, res, next) => {
  if (req.body) {
    normalizeSnakeToCamel(req.body);
  }
  next();
});

// The development fallback below is committed to this repository, so anyone who
// reads it could forge a token for any user. Refuse to boot without a real secret
// once we are running for real.
if (IS_PRODUCTION && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production. Refusing to start with the public default.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_assetflow_token';

// --- CUSTOM AUTH / JWT USER EXTRACTOR HELPER ---
// Trusting `x-user-role`/`x-user-id` headers let any unauthenticated caller act as
// any user (e.g. create tickets as Super Admin id=1). The frontend never sends them,
// so the fallback is opt-in via env for local integration testing only.
const ALLOW_HEADER_AUTH = process.env.ALLOW_HEADER_AUTH === 'true';

// Authentication + the permission gate live in src/middleware/auth.js. Bound here once
// and destructured into locals so every route below (inline or in a route module) uses
// the same JWT wiring and short-lived role caches.
const auth = createAuth({ jwt, permissionModel, JWT_SECRET, ALLOW_HEADER_AUTH });
const {
  loadRolePermissions,
  roleAllows,
  authenticateRequest,
  requireUser,
  invalidateUserRole,
  requirePermission,
  roleCan,
  isEmployee,
  EMPLOYEE_ASSET_IDS,
  requireUserWithDepartment,
} = auth;

// Who performed the request, for notification payloads. Shared by the invoices and
// tickets routes; defined in src/utils/actor.js.
const actorOf = createActorOf(authenticateRequest);

// Serves files written by the local-disk fallback. In production nothing is
// written here — objects live in the private bucket and are reached via signed URLs.
if (!storage.isRemote) {
  app.use('/uploads', express.static(storage.uploadDir));
}

// --- ASSETS API ---
// Extracted verbatim to src/routes/assets.js. Registered here — not at the bottom with
// the other modules — to preserve the original route-registration order exactly.
assetsRoutes.register(app, { requireUser, requirePermission, isEmployee, EMPLOYEE_ASSET_IDS });

// --- AMCS API ---
// Extracted verbatim to src/routes/amc.js; registered in place to keep route order.
amcRoutes.register(app, { requirePermission });


// --- INVOICES API ---
// Extracted verbatim to src/routes/invoices.js (routes + the invoice⇆asset mapping
// helpers); registered in place to preserve route-registration order.
invoicesRoutes.register(app, { requirePermission, actorOf });

// --- MOVEMENTS / DOCUMENTS / LOGS APIs ---
// Extracted verbatim to src/routes/{movements,documents,logs}.js; registered in
// place to preserve route-registration order.
movementsRoutes.register(app, { requireUser, requirePermission, isEmployee, EMPLOYEE_ASSET_IDS });
documentsRoutes.register(app, { requireUser, roleAllows });
logsRoutes.register(app);


// --- NOTIFICATIONS + ROLE-PERMISSIONS APIs ---
// Extracted verbatim to src/routes/{notifications,permissions}.js; registered in
// place. notifications.js covers notifications, the email inbox, and notification
// administration (settings/preferences/history/retry).
notificationsRoutes.register(app, { requireUser, requirePermission, authenticateRequest });
permissionsRoutes.register(app, {
  requireUser,
  roleCan,
  loadRolePermissions,
  invalidateRolePermissions: auth.invalidateRolePermissions,
});

// Auth extractor, the role caches, the permission gate (requirePermission/roleCan),
// isEmployee/EMPLOYEE_ASSET_IDS and requireUserWithDepartment are defined in
// src/middleware/auth.js and bound into locals near the top via createAuth().

// createSingleUser and validateAndFormatPhone now live in src/routes/users.js
// and src/utils/phone.js respectively.

// --- BULK IMPORT APIS ---
// Extracted verbatim to src/routes/imports.js (employee + asset import, the
// background-job runner, and multi-row insert batching). No auth gate, as before.
importsRoutes.register(app);

// --- QUANTITY BASED ASSIGNMENT APIS ---
// Extracted verbatim to src/routes/assignments.js; registered in place.
assignmentsRoutes.register(app, { requireUser, requirePermission, isEmployee });

// --- DEPARTMENTAL TICKETING SYSTEM APIS ---
// Extracted verbatim to src/routes/tickets.js (queue, bulk ops, detail, comments,
// assignment/auto-assign, status/priority/category/department, analytics + SLA).
ticketsRoutes.register(app, { requireUser, requireUserWithDepartment, roleCan });

// --- AUTHENTICATION API ---
// Extracted verbatim to src/routes/auth.js; registered in place to keep route order.
authRoutes.register(app, { JWT_SECRET });

// --- USER MANAGEMENT API ---
// Extracted verbatim to src/routes/users.js (departments + user CRUD + bulk ops),
// including the createSingleUser helper. Registered in place to keep route order.
usersRoutes.register(app, { requireUser, invalidateUserRole, actorOf, roleCan });

// --- DEPARTMENT & LOCATION MASTERS ---
// Database-driven master data; the dropdowns across every module read from these.
// Registered here so its GET /api/departments supersedes the retired directory-derived one.
mastersRoutes.register(app, { requirePermission, requireUser });

// --- FILE UPLOAD API ---
// Extracted verbatim to src/routes/files.js (upload + signed-url); the multer
// setup moved there too. Registered in place to keep route order.
filesRoutes.register(app, { requireUser });

// --- SCHEDULED NOTIFICATION JOBS ---
//
// Expiry reminders change once a day, so a daily sweep is enough. SLA deadlines are
// measured in hours, so a daily job would report most breaches long after the fact —
// that check runs hourly. Failed email/SMS deliveries are retried on their own timer.
//
// node-cron only fires while this process is alive. On a host that sleeps an idle
// web service (Render's free tier, for one) the schedules simply stop, silently —
// no notifications, no SLA escalations, and nothing in the logs to say so. There
// the jobs are driven over HTTP instead, by Supabase pg_cron or GitHub Actions:
// set DISABLE_INTERNAL_CRON=true and CRON_SECRET, and see backend/sql/supabase_cron.sql.
const INTERNAL_CRON_ENABLED = process.env.DISABLE_INTERNAL_CRON !== 'true';
const CRON_SECRET = process.env.CRON_SECRET || '';

registerCronRoutes(app, { scheduler, notifications, reports, secret: CRON_SECRET });

// Cron scheduler is initialized after the routes are registered (see the bottom of file).

// --- KNOWLEDGE BASE + HELPDESK OPTIONS ---
// Registered before the catch-all so its routes are reachable.
knowledgeBase.register(app, { requireUser });
purchaseOrders.register(app, { requirePermission, requireUser, roleCan });
slaRoutes.register(app, { requireUser, requirePermission });
dashboards.register(app, { requirePermission });
reports.register(app, { requireUser, requirePermission });

// --- SYSTEM RESET ENDPOINT ---
app.post('/api/admin/reset', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Access denied: Only Super Admin can perform system reset.' });
  }

  // The frontend still sends a confirmation password. WorkOS owns credentials now, so there
  // is no local hash to verify against — the destructive action is gated by the Super Admin
  // session (requirePermission above) plus the explicit role check. Keep requiring the field
  // so the confirm dialog contract is unchanged.
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password confirmation is required.' });
  }

  try {
    console.log('=== SYSTEM RESET INITIATED BY SUPER ADMIN ===');
    await cm('system:reset', { actor: user.name || user.email });
    console.log('=== SYSTEM RESET COMPLETED SUCCESSFULLY ===');
    res.json({ success: true, message: 'System reset completed successfully. All data wiped.' });
  } catch (err) {
    console.error('System reset failed:', err);
    res.status(500).json({ error: `System reset failed: ${err.message}` });
  }
});

// --- 404 handler for unmatched API routes (JSON, not Express's default HTML page) ---
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
});

// --- Global error handler (safety net; JSON, not HTML) ---
// The 4-argument signature is what marks this as an Express error handler, so `_next`
// must stay even though it is unused.
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

// Convex is the datastore — there is no local schema to create/migrate/seed and nothing to
// hydrate on boot, so the server starts immediately. convexApi connects lazily on first use.
if (INTERNAL_CRON_ENABLED) {
  const runStartupChecks = async () => {
    await scheduler.runDailyChecks();
    await scheduler.runSlaChecks();
  };

  runStartupChecks().catch((err) => console.error('Startup notification checks failed:', err));

  cron.schedule('0 0 * * *', () => scheduler.runDailyChecks());   // 00:00 daily
  cron.schedule('0 * * * *', () => scheduler.runSlaChecks());     // hourly, on the hour
  cron.schedule('*/15 * * * *', () => {                            // retry failed sends
    notifications.retryFailed().catch((err) => console.error('Notification retry failed:', err));
  });
  cron.schedule('0 6 * * *', () => {                               // 06:00 daily: email due reports
    reports.runDueScheduledReports().catch((err) => console.error('Scheduled reports failed:', err));
  });
} else if (!CRON_SECRET) {
  // Loud, because the alternative is a deployment where nothing is scheduled at all and the
  // first anyone hears of it is a missed SLA.
  console.error('[cron] DISABLE_INTERNAL_CRON=true but CRON_SECRET is unset: no job can run, in-process or over HTTP.');
} else {
  console.log('[cron] in-process scheduler disabled; expecting external triggers on /api/internal/cron/*');
}

app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
