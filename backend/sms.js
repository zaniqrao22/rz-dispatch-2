'use strict';

/**
 * Pluggable SMS sender for RZ Dispatch.
 *
 * The product offers an "SMS alerts" preference, so this module makes that
 * preference real: when a provider is configured, customer-facing status
 * updates are delivered as text messages. When no provider is configured the
 * sender degrades to a logged dry-run (exactly like backend/mailer.js does for
 * email) so the rest of the app keeps working unchanged.
 *
 * Supported provider: Twilio (set SMS_PROVIDER=twilio plus TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER). A different provider can be added
 * by extending `send`.
 *
 * `createSmsSender` is exported separately from the shared singleton so it can
 * be unit-tested with an injected `fetchImpl`.
 */

const DEFAULT_COUNTRY_CODE = String(process.env.SMS_DEFAULT_COUNTRY_CODE || '1').replace(/\D/g, '');

/**
 * Best-effort normalisation to E.164. Twilio requires E.164, but operator
 * settings store whatever the user typed (e.g. "(415) 555-0100"). A leading
 * "+" is respected; otherwise a bare 10-digit number gets the default country
 * code. Returns '' when the value cannot be a phone number.
 */
function normalizePhone(value, defaultCountryCode = DEFAULT_COUNTRY_CODE) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10 && defaultCountryCode) return `+${defaultCountryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith(defaultCountryCode)) return `+${digits}`;
  return `+${digits}`;
}

function createSmsSender(options = {}) {
  const provider = String(options.provider ?? process.env.SMS_PROVIDER ?? '').trim().toLowerCase();
  const accountSid = String(options.accountSid ?? process.env.TWILIO_ACCOUNT_SID ?? '').trim();
  const authToken = String(options.authToken ?? process.env.TWILIO_AUTH_TOKEN ?? '').trim();
  const from = normalizePhone(options.from ?? process.env.TWILIO_FROM_NUMBER ?? process.env.SMS_FROM ?? '');
  const defaultCountryCode = options.defaultCountryCode ?? DEFAULT_COUNTRY_CODE;
  const fetchImpl = options.fetchImpl || global.fetch;
  const enabled = Boolean(provider === 'twilio' && accountSid && authToken && from && typeof fetchImpl === 'function');

  async function send(to, body) {
    const recipient = normalizePhone(to, defaultCountryCode);
    if (!recipient) throw new Error('A valid phone number is required to send an SMS.');
    const text = String(body ?? '').trim().slice(0, 1500);
    if (!text) throw new Error('An SMS body is required.');

    if (!enabled || provider !== 'twilio') {
      console.log(`[SMS:DRY-RUN] to=${recipient} body="${text.slice(0, 80)}" provider=${provider || 'none'}`);
      return { dryRun: true, to: recipient, provider: provider || 'none' };
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const params = new URLSearchParams({ To: recipient, From: from, Body: text });
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!response.ok) {
      let detail = '';
      try { detail = await response.text(); } catch (_) { /* ignore */ }
      throw new Error(`SMS provider rejected the message (status ${response.status})${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
    }

    let payload = {};
    try { payload = await response.json(); } catch (_) { /* provider may return no body */ }
    return { dryRun: false, sid: payload.sid || null, to: recipient, provider: 'twilio' };
  }

  return { enabled, provider: provider || 'none', from, send };
}

const sms = createSmsSender();

module.exports = { createSmsSender, normalizePhone, sms, enabled: sms.enabled };
