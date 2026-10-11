const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || 'no-reply@rzdispatch.local';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT) || 8000}`;

const enabled = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

let transporter = null;
if (enabled) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
} else {
  console.warn('WARNING: SMTP is not configured. Emails will be logged instead of sent. Set SMTP_HOST, SMTP_USER, SMTP_PASS to enable delivery.');
}

async function sendMail(to, subject, html) {
  const message = { from: MAIL_FROM, to, subject, html };
  if (!enabled || !transporter) {
    console.log(`[MAIL:DRY-RUN] to=${to} subject="${subject}"`);
    return { dryRun: true };
  }
  const info = await transporter.sendMail(message);
  return info;
}

function verificationLink(token) {
  return `${PUBLIC_URL}/api/auth/verify-email/${encodeURIComponent(token)}`;
}

function resetLink(token) {
  return `${PUBLIC_URL}/reset-password?token=${encodeURIComponent(token)}`;
}

module.exports = { sendMail, verificationLink, resetLink, enabled };