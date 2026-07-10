const { isAuthorizedCronRequest } = require('./cronAuth');

/**
 * HTTP triggers for the background jobs, for hosts where node-cron cannot run.
 *
 * A sleeping web service fires no cron, so on a free tier the schedules live in
 * Postgres (pg_cron) or CI and reach the jobs through these endpoints. See
 * backend/sql/supabase_cron.sql.
 *
 * Kept out of server.js so the request handling can be tested without booting the
 * server — which would run migrations against the real database.
 */

function createCronRouter({ scheduler, notifications, secret, log = console }) {
  // One run of a given job at a time. A cold-starting host can be hit by a retry
  // while the first request is still working, and these sweeps are not cheap.
  const inFlight = new Set();

  const handler = (name, run) => async (req, res) => {
    const provided = typeof req.get === 'function' ? req.get('x-cron-secret') : undefined;
    if (!isAuthorizedCronRequest(provided, secret)) {
      // Terse on purpose: do not tell an unauthorised caller whether the job exists.
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (inFlight.has(name)) {
      return res.status(409).json({ error: `${name} is already running` });
    }

    inFlight.add(name);
    const startedAt = Date.now();
    try {
      const result = await run();
      const durationMs = Date.now() - startedAt;
      log.log(`[cron] ${name} completed in ${durationMs}ms`);
      return res.json({ job: name, ok: true, durationMs, result: result ?? null });
    } catch (err) {
      log.error(`[cron] ${name} failed:`, err);
      return res.status(500).json({ job: name, ok: false, error: err.message });
    } finally {
      inFlight.delete(name);
    }
  };

  return {
    'daily-checks': handler('daily-checks', () => scheduler.runDailyChecks()),
    'sla-checks': handler('sla-checks', () => scheduler.runSlaChecks()),
    'retry-failed': handler('retry-failed', () => notifications.retryFailed())
  };
}

/** Mounts the routes. Must be registered before the /api 404 catch-all. */
function registerCronRoutes(app, deps) {
  const routes = createCronRouter(deps);
  for (const [path, handler] of Object.entries(routes)) {
    app.post(`/api/internal/cron/${path}`, handler);
  }
  return routes;
}

module.exports = { createCronRouter, registerCronRoutes };
