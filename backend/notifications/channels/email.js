/**
 * Email channel.
 *
 * With SMTP_HOST set, mail goes out through nodemailer. Without it the channel
 * degrades to a log transport: the message is still recorded in the `emails` table
 * (which the in-app Email Alerts Inbox renders) and printed, but nothing leaves the
 * server. That keeps local development and the existing demo accounts — whose
 * addresses are fictional — from generating bounces or hard failures.
 */

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || 'AssetFlow <no-reply@assetflow.local>';

const isConfigured = Boolean(SMTP_HOST);

let transporter = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    // 465 is implicit TLS; everything else negotiates STARTTLS.
    secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  });
}

const name = 'email';

/** The address to deliver to, or null when this recipient cannot receive email. */
const addressFor = (user) => (user && user.email ? user.email : null);

async function send({ to, subject, body }) {
  if (!to) throw new Error('No email address on file for this recipient');

  if (!isConfigured) {
    console.log(`[notifications] email (log transport) -> ${to}: ${subject}`);
    return { transport: 'log' };
  }

  const info = await transporter.sendMail({ from: MAIL_FROM, to, subject, text: body });
  return { transport: 'smtp', messageId: info.messageId };
}

/** Surfaced by the settings endpoint so the admin UI can explain why a channel is off. */
function describe() {
  return isConfigured
    ? `SMTP via ${SMTP_HOST}:${SMTP_PORT}`
    : 'Not configured — messages are logged and stored in the Email Alerts Inbox only. Set SMTP_HOST to deliver.';
}

module.exports = { name, isConfigured, send, addressFor, describe };
