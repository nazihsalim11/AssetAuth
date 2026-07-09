/**
 * SMS channel (optional).
 *
 * Inert unless all three TWILIO_* variables are present. When unconfigured the
 * dispatcher skips it entirely — deliveries are recorded as 'Skipped', never
 * 'Failed', so an unconfigured channel does not pollute the audit log with errors
 * or trigger the retry job.
 */

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

const isConfigured = Boolean(ACCOUNT_SID && AUTH_TOKEN && FROM_NUMBER);

// Required lazily: the package is only loaded when it will actually be used.
let client = null;
if (isConfigured) {
  client = require('twilio')(ACCOUNT_SID, AUTH_TOKEN);
}

const name = 'sms';

// Phone numbers are stored E.164-normalised by validateAndFormatPhone on import.
const addressFor = (user) => (user && user.phone_number ? user.phone_number : null);

async function send({ to, body }) {
  if (!isConfigured) throw new Error('SMS is not configured');
  if (!to) throw new Error('No phone number on file for this recipient');

  const message = await client.messages.create({ from: FROM_NUMBER, to, body });
  return { transport: 'twilio', messageId: message.sid };
}

function describe() {
  return isConfigured
    ? `Twilio from ${FROM_NUMBER}`
    : 'Not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER to enable.';
}

module.exports = { name, isConfigured, send, addressFor, describe };
