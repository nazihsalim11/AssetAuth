import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAuthorizedCronRequest, MIN_SECRET_LENGTH } = require('./cronAuth.js');

const SECRET = 'a'.repeat(32);

test('accepts the exact secret', () => {
  assert.equal(isAuthorizedCronRequest(SECRET, SECRET), true);
});

test('rejects a wrong secret of the same length', () => {
  assert.equal(isAuthorizedCronRequest('b'.repeat(32), SECRET), false);
});

test('rejects a secret with the right prefix but the wrong length', () => {
  assert.equal(isAuthorizedCronRequest('a'.repeat(31), SECRET), false);
  assert.equal(isAuthorizedCronRequest('a'.repeat(33), SECRET), false);
});

// The mistake this guards against: deploying without CRON_SECRET set. A naive
// `provided === secret` would then authorise every caller that omits the header.
test('fails closed when the configured secret is missing or empty', () => {
  assert.equal(isAuthorizedCronRequest('', ''), false);
  assert.equal(isAuthorizedCronRequest('', undefined), false);
  assert.equal(isAuthorizedCronRequest(undefined, undefined), false);
  assert.equal(isAuthorizedCronRequest('anything', ''), false);
  assert.equal(isAuthorizedCronRequest(null, null), false);
});

test('refuses to authorise against a guessably short secret', () => {
  const short = 'a'.repeat(MIN_SECRET_LENGTH - 1);
  assert.equal(isAuthorizedCronRequest(short, short), false);
});

test('accepts a secret exactly at the minimum length', () => {
  const min = 'x'.repeat(MIN_SECRET_LENGTH);
  assert.equal(isAuthorizedCronRequest(min, min), true);
});

test('rejects non-string headers without throwing', () => {
  assert.equal(isAuthorizedCronRequest(['a'.repeat(32)], SECRET), false);
  assert.equal(isAuthorizedCronRequest(42, SECRET), false);
  assert.equal(isAuthorizedCronRequest({}, SECRET), false);
});
