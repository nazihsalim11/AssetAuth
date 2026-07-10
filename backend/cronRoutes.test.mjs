import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCronRouter } = require('./cronRoutes.js');

const SECRET = 'x'.repeat(32);
const silent = { log() {}, error() {} };

const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const fakeReq = (secret) => ({ get: (h) => (h === 'x-cron-secret' ? secret : undefined) });

const deps = (overrides = {}) => ({
  secret: SECRET,
  log: silent,
  scheduler: { runDailyChecks: async () => 'daily', runSlaChecks: async () => 'sla' },
  notifications: { retryFailed: async () => 3 },
  ...overrides
});

test('exposes exactly the three jobs', () => {
  const routes = createCronRouter(deps());
  assert.deepEqual(Object.keys(routes).sort(), ['daily-checks', 'retry-failed', 'sla-checks']);
});

test('runs the job and returns its result with the right secret', async () => {
  const routes = createCronRouter(deps());
  const res = fakeRes();
  await routes['retry-failed'](fakeReq(SECRET), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.job, 'retry-failed');
  assert.equal(res.body.result, 3);
  assert.equal(typeof res.body.durationMs, 'number');
});

test('rejects a wrong secret without running the job', async () => {
  let ran = false;
  const routes = createCronRouter(deps({
    scheduler: { runDailyChecks: async () => { ran = true; }, runSlaChecks: async () => {} }
  }));
  const res = fakeRes();
  await routes['daily-checks'](fakeReq('y'.repeat(32)), res);
  assert.equal(res.statusCode, 401);
  assert.equal(ran, false, 'job must not run for an unauthorised caller');
});

test('rejects a missing header without running the job', async () => {
  const routes = createCronRouter(deps());
  const res = fakeRes();
  await routes['sla-checks'](fakeReq(undefined), res);
  assert.equal(res.statusCode, 401);
});

// The deployment mistake this guards: DISABLE_INTERNAL_CRON=true and no CRON_SECRET.
test('an unset secret authorises nobody', async () => {
  const routes = createCronRouter(deps({ secret: '' }));
  const res = fakeRes();
  await routes['sla-checks'](fakeReq(''), res);
  assert.equal(res.statusCode, 401);
});

test('a second concurrent trigger gets 409 rather than a second sweep', async () => {
  let running = 0;
  let peak = 0;
  let release;
  const gate = new Promise((r) => { release = r; });

  const routes = createCronRouter(deps({
    scheduler: {
      runSlaChecks: async () => { running += 1; peak = Math.max(peak, running); await gate; running -= 1; return 'ok'; },
      runDailyChecks: async () => {}
    }
  }));

  const first = routes['sla-checks'](fakeReq(SECRET), fakeRes());
  const second = fakeRes();
  await routes['sla-checks'](fakeReq(SECRET), second);
  assert.equal(second.statusCode, 409);

  release();
  await first;
  assert.equal(peak, 1, 'the sweep must never run twice at once');
});

test('the in-flight lock is released after a failure', async () => {
  let calls = 0;
  const routes = createCronRouter(deps({
    scheduler: {
      runDailyChecks: async () => { calls += 1; throw new Error('boom'); },
      runSlaChecks: async () => {}
    }
  }));

  const first = fakeRes();
  await routes['daily-checks'](fakeReq(SECRET), first);
  assert.equal(first.statusCode, 500);
  assert.equal(first.body.ok, false);
  assert.equal(first.body.error, 'boom');

  const second = fakeRes();
  await routes['daily-checks'](fakeReq(SECRET), second);
  assert.equal(second.statusCode, 500, 'a previous failure must not wedge the lock');
  assert.equal(calls, 2);
});

test('one job holding the lock does not block a different job', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const routes = createCronRouter(deps({
    scheduler: { runSlaChecks: async () => { await gate; return 'sla'; }, runDailyChecks: async () => 'daily' }
  }));

  const slow = routes['sla-checks'](fakeReq(SECRET), fakeRes());
  const other = fakeRes();
  await routes['daily-checks'](fakeReq(SECRET), other);
  assert.equal(other.statusCode, 200);

  release();
  await slow;
});
