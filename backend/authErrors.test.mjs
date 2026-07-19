import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isTransportFailure } = require('./src/routes/auth.js');

/**
 * Classifying a WorkOS failure as "the request never landed" vs "WorkOS said no".
 *
 * This is the difference between telling a user the auth service is unreachable and telling
 * them their password is wrong. The second is a lie during an outage: it sends people to
 * reset a password that was never wrong, and hides the real fault behind a login form.
 *
 * The shapes below are the real ones, taken from @workos-inc/node 10.7.0: a timed-out call
 * surfaces as an OauthException with status 408 and message "Error: Request timeout",
 * because the SDK synthesises an HTTP response for its own AbortError.
 */

// Exactly what the SDK threw when api.workos.com stopped answering.
const workosTimeout = () => Object.assign(new Error('Error: Request timeout'), {
  name: 'OauthException', status: 408, rawData: { error: 'Request timeout' },
});

test('a WorkOS request timeout is a transport failure, not a bad password', () => {
  assert.equal(isTransportFailure(workosTimeout()), true);
});

test('a genuine credential rejection is not a transport failure', () => {
  // WorkOS answered: 400 with invalid_credentials. The password really is wrong.
  const err = Object.assign(new Error('Invalid credentials'), {
    name: 'OauthException', status: 400, rawData: { code: 'invalid_credentials' },
  });
  assert.equal(isTransportFailure(err), false);
});

test('a 401 from WorkOS is a real rejection, not a transport failure', () => {
  const err = Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedException', status: 401 });
  assert.equal(isTransportFailure(err), false);
});

test('server-side faults are transport failures — WorkOS never decided anything', () => {
  for (const status of [500, 502, 503, 504]) {
    const err = Object.assign(new Error('Internal Server Error'), { name: 'GenericServerException', status });
    assert.equal(isTransportFailure(err), true, `status ${status} must not read as bad credentials`);
  }
});

test('raw transport errors with no status are transport failures', () => {
  for (const name of ['AbortError', 'TimeoutError', 'FetchError', 'TypeError']) {
    assert.equal(isTransportFailure(Object.assign(new Error('boom'), { name })), true, name);
  }
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.equal(isTransportFailure(Object.assign(new Error('boom'), { code })), true, code);
  }
});

test('an error carrying status on .response is read too', () => {
  // HttpClientError keeps the status on .response, not on .status.
  assert.equal(isTransportFailure({ name: 'HttpClientError', response: { status: 408 } }), true);
  assert.equal(isTransportFailure({ name: 'HttpClientError', response: { status: 400 } }), false);
});

test('4xx that are not 408 stay credential/validation failures', () => {
  // The bug this guards against is the mirror image: sweeping real rejections into
  // "service unavailable" would stop telling users their password is actually wrong.
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    const err = Object.assign(new Error('nope'), { status });
    assert.equal(isTransportFailure(err), false, `status ${status} must stay a real rejection`);
  }
});

test('a nullish error is not a transport failure', () => {
  assert.equal(isTransportFailure(null), false);
  assert.equal(isTransportFailure(undefined), false);
});
