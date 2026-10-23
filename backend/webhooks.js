'use strict';

/**
 * Outbound webhooks: let external systems (a customer's TMS, an accounting
 * tool, a Slack relay) subscribe to RZ Dispatch events.
 *
 * Each webhook has a signing secret. Deliveries are POSTed as JSON with an
 * `X-RZ-Signature` header of the form `t=<unix>,v1=<hex hmac>` where the HMAC
 * is SHA-256 over `${t}.${rawBody}`. Receivers can verify authenticity and
 * reject replays by checking the timestamp. Failed deliveries are retried with
 * exponential backoff and every attempt is recorded for inspection.
 *
 * Delivery is best-effort and never blocks or fails the originating API call.
 */

const crypto = require('crypto');

const DEFAULT_EVENTS = ['*'];
const MAX_ATTEMPTS = 3;
const BASE_RETRY_MS = 400;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    company_account_id TEXT,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    event TEXT NOT NULL,
    payload TEXT,
    status_code INTEGER,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at DESC)`
];

function parseJson(value, fallback) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function normalizeEvents(events) {
  const list = Array.isArray(events)
    ? events
    : String(events || '')
        .split(/[\s,]+/)
        .filter(Boolean);
  const cleaned = [...new Set(list.map((event) => String(event).trim()).filter(Boolean))];
  return cleaned.length ? cleaned : DEFAULT_EVENTS;
}

function signPayload(secret, timestamp, body) {
  return crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${body}`).digest('hex');
}

function isValidUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function createWebhooks(db, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : global.fetch;
  const logger = options.logger || console;
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || MAX_ATTEMPTS);
  const baseRetryMs = Number.isFinite(options.retryDelayMs) ? Math.max(0, options.retryDelayMs) : BASE_RETRY_MS;
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 8000);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  function publicRow(row) {
    if (!row) return null;
    const events = parseJson(row.events, DEFAULT_EVENTS);
    return {
      id: row.id,
      url: row.url,
      events: Array.isArray(events) ? events : DEFAULT_EVENTS,
      description: row.description || '',
      active: Number(row.active) === 1,
      createdAt: row.created_at || row.createdAt || null
    };
  }

  async function list(user) {
    const rows = await db.all(
      'SELECT id, url, events, description, active, created_at FROM webhooks WHERE user_id = ? ORDER BY created_at DESC',
      user.id
    );
    return rows.map(publicRow);
  }

  async function register(user, { url, events, description } = {}) {
    const target = String(url || '').trim();
    if (!isValidUrl(target)) throw new Error('A valid http(s) webhook URL is required.');
    const id = crypto.randomUUID();
    const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
    const now = new Date().toISOString();
    const companyAccountId = user.companyAccountId || user.company_account_id || null;
    const eventList = normalizeEvents(events);
    await db.run(
      'INSERT INTO webhooks (id, user_id, company_account_id, url, secret, events, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, user.id, companyAccountId, target, secret, JSON.stringify(eventList), String(description || '').slice(0, 200), 1, now, now
    );
    return { webhook: publicRow({ id, url: target, events: JSON.stringify(eventList), description, active: 1, created_at: now }), secret };
  }

  async function remove(user, id) {
    const row = await db.get('SELECT id, user_id FROM webhooks WHERE id = ?', id);
    if (!row || row.user_id !== user.id) return false;
    await db.run('DELETE FROM webhooks WHERE id = ?', id);
    return true;
  }

  async function deliveries(user, id, limit = 50) {
    const hook = await db.get('SELECT id, user_id FROM webhooks WHERE id = ?', id);
    if (!hook || hook.user_id !== user.id) return null;
    const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await db.all(
      'SELECT id, event, status_code, error, attempts, created_at, delivered_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?',
      id, capped
    );
    return rows.map((row) => ({
      id: row.id,
      event: row.event,
      statusCode: row.status_code,
      error: row.error || null,
      attempts: row.attempts,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at || null
    }));
  }

  function matches(subscriptions, event) {
    return subscriptions.includes('*') || subscriptions.includes(event);
  }

  async function deliverOne(hook, event, payload) {
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify({ event, data: payload, id: deliveryId, createdAt: new Date().toISOString() });
    let attempts = 0;
    let lastError = null;
    let statusCode = null;
    let deliveredAt = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = signPayload(hook.secret, timestamp, body);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(hook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'RZDispatch-Webhooks/2.0',
            'X-RZ-Event': event,
            'X-RZ-Delivery': deliveryId,
            'X-RZ-Signature': `t=${timestamp},v1=${signature}`
          },
          body,
          signal: controller.signal
        });
        statusCode = response?.status ?? null;
        const ok = response?.ok !== false && (!statusCode || (statusCode >= 200 && statusCode < 300));
        if (ok) {
          deliveredAt = new Date().toISOString();
          lastError = null;
          break;
        }
        lastError = `HTTP ${statusCode}`;
      } catch (error) {
        lastError = error?.message || String(error);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttempts) await sleep(baseRetryMs * 2 ** (attempt - 1));
    }

    try {
      await db.run(
        'INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status_code, error, attempts, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        deliveryId, hook.id, event, body, statusCode, deliveredAt ? null : lastError, attempts, new Date().toISOString(), deliveredAt
      );
    } catch (error) {
      logger.error?.('[webhooks] failed to record delivery:', error?.message || error);
    }

    return { deliveryId, webhookId: hook.id, event, statusCode, delivered: Boolean(deliveredAt), attempts, error: lastError };
  }

  /**
   * Emit an event to every active webhook owned by the given tenant/user that
   * subscribed to it. Returns a promise resolving to delivery summaries. The
   * caller should not await it on a hot path; use `.catch(() => {})`.
   */
  async function emit(event, data, { companyAccountId, userId } = {}) {
    let rows;
    try {
      if (companyAccountId) {
        rows = await db.all(
          'SELECT id, url, secret, events FROM webhooks WHERE active = 1 AND (company_account_id = ? OR user_id = ?)',
          companyAccountId, userId || ''
        );
      } else if (userId) {
        rows = await db.all('SELECT id, url, secret, events FROM webhooks WHERE active = 1 AND user_id = ?', userId);
      } else {
        rows = await db.all('SELECT id, url, secret, events FROM webhooks WHERE active = 1');
      }
    } catch (error) {
      logger.error?.('[webhooks] failed to load subscribers:', error?.message || error);
      return [];
    }

    const targets = rows.filter((row) => matches(parseJson(row.events, DEFAULT_EVENTS), event));
    if (!targets.length) return [];
    const results = await Promise.all(targets.map((hook) => deliverOne(hook, event, data)));
    return results;
  }

  function verifySignature(secret, header, body) {
    const match = /t=(\d+),v1=([a-f0-9]{64})/i.exec(String(header || ''));
    if (!match) return false;
    const timestamp = Number(match[1]);
    const expected = signPayload(secret, timestamp, body);
    const left = Buffer.from(expected, 'hex');
    const right = Buffer.from(match[2], 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  return { list, register, remove, deliveries, emit, verifySignature, signPayload };
}

module.exports = {
  createWebhooks,
  schemaStatements,
  signPayload,
  normalizeEvents,
  isValidUrl,
  DEFAULT_EVENTS
};
