'use strict';

/**
 * Audit logging for RZ Dispatch.
 *
 * Every mutating API request that reaches the server is recorded with who did
 * it, what they did, which record it touched, and when. This is the
 * compliance/integrity trail professional fleet buyers expect ("who changed
 * this rate, who cancelled this job, who approved this driver").
 *
 * Design notes:
 *  - Recording is best-effort and never throws into the request path, so a
 *    transient database problem cannot break the operation being audited.
 *  - Response bodies are never stored; only request metadata and a REDACTED
 *    copy of the request body (password/token/secret fields are stripped).
 *  - Action names are derived from the route path + method (e.g.
 *    `POST /api/services` -> `service.create`), kept deliberately simple so
 *    new routes are covered automatically.
 */

const crypto = require('crypto');

const MAX_BODY_BYTES = 4000;
const REDACTED_KEYS = ['password', 'currentPassword', 'newPassword', 'token', 'refreshToken', 'authorization', 'secret', 'apiKey', 'licenseKey', 'code', 'data'];

/** Methods that mutate state and are therefore worth auditing. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const VERB_BY_METHOD = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

/**
 * Routes whose verb is not "create/update/delete" of a collection member.
 * The first matching pattern wins. Each pattern maps a path to a stable action.
 */
const ACTION_OVERRIDES = [
  [/^\/api\/auth\/login$/, 'auth.login'],
  [/^\/api\/auth\/register$/, 'auth.register'],
  [/^\/api\/auth\/logout$/, 'auth.logout'],
  [/^\/api\/auth\/logout-all$/, 'auth.logout_all'],
  [/^\/api\/auth\/session\/refresh$/, 'auth.session_refresh'],
  [/^\/api\/auth\/forgot-password$/, 'auth.forgot_password'],
  [/^\/api\/auth\/reset-password$/, 'auth.reset_password'],
  [/^\/api\/auth\/otp\/request$/, 'auth.otp_request'],
  [/^\/api\/auth\/otp\/verify$/, 'auth.otp_verify'],
  [/^\/api\/payments\/webhook$/, 'payment.webhook'],
  [/^\/api\/purchase\/(lifetime|license)$/, 'billing.purchase'],
  [/^\/api\/license\/activate$/, 'license.activate'],
  [/^\/api\/jobs\/([^/]+)\/assign$/, 'job.assign'],
  [/^\/api\/jobs\/([^/]+)\/dispatch$/, 'job.dispatch'],
  [/^\/api\/bookings\/([^/]+)\/dispatch$/, 'booking.dispatch'],
  [/^\/api\/operator\/jobs\/([^/]+)\/status$/, 'job.status_update'],
  [/^\/api\/operator\/jobs\/([^/]+)\/proof$/, 'job.proof_upload'],
  [/^\/api\/admin\/users\/([^/]+)\/approve$/, 'user.approve'],
  [/^\/api\/admin\/users\/([^/]+)\/reject$/, 'user.reject'],
  [/^\/api\/settings\/password$/, 'settings.password_change'],
  [/^\/api\/customer\/addresses\/([^/]+)$/, 'customer.address_update'],
  [/^\/api\/customer\/me$/, 'customer.profile_update'],
  [/^\/api\/portal\/company$/, 'company.update']
];

/** Collection routes map to a singular resource name + verb from the method. */
const COLLECTION_VERB_OVERRIDES = [
  [/^\/api\/services(?:\/([^/]+))?$/, 'service'],
  [/^\/api\/coverage\/zones(?:\/([^/]+))?$/, 'coverage_zone'],
  [/^\/api\/drivers(?:\/([^/]+))?$/, 'driver'],
  [/^\/api\/vehicles(?:\/([^/]+))?$/, 'vehicle'],
  [/^\/api\/jobs(?:\/([^/]+))?$/, 'job'],
  [/^\/api\/bookings(?:\/([^/]+))?$/, 'booking'],
  [/^\/api\/quotes(?:\/([^/]+))?$/, 'quote'],
  [/^\/api\/messages(?:\/([^/]+))?$/, 'message'],
  [/^\/api\/support\/tickets?$/, 'support_ticket'],
  [/^\/api\/customer\/addresses$/, 'customer_address']
];

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (REDACTED_KEYS.includes(key) || /password|token|secret|api[_-]?key/i.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

function summarizeBody(body) {
  if (body == null) return null;
  try {
    const json = JSON.stringify(redact(body));
    if (json.length <= MAX_BODY_BYTES) return json;
    return `${json.slice(0, MAX_BODY_BYTES)}...[truncated]`;
  } catch (_) {
    return null;
  }
}

/**
 * Derive a stable action name for a request. Exported for unit testing.
 * Returns null for requests that should not be audited (GET/OPTIONS, unknown).
 */
function deriveAction(method, rawPath) {
  const verb = String(method || '').toUpperCase();
  if (!MUTATING_METHODS.has(verb)) return null;
  const path = String(rawPath || '').replace(/\/+$/, '') || '/';

  for (const [pattern, action] of ACTION_OVERRIDES) {
    if (pattern.test(path)) return action;
  }
  for (const [pattern, resource] of COLLECTION_VERB_OVERRIDES) {
    if (pattern.test(path)) return `${resource}.${VERB_BY_METHOD[verb] || 'mutate'}`;
  }
  // Fallback: derive from the last two path segments.
  const segments = path.split('/').filter(Boolean);
  const resource = segments[1] || 'api';
  return `${resource}.${VERB_BY_METHOD[verb] || 'mutate'}`;
}

function deriveTarget(path) {
  return String(path || '').replace(/\/+$/, '') || '/';
}

function actorFromRequest(req) {
  const user = req.user || {};
  return {
    userId: user.id || null,
    email: user.email || null,
    role: user.role || null,
    ip: String(req.headers?.['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || null
  };
}

/**
 * Best-effort actor extraction from the request. `req.user` is set by
 * requireAuth, but Express error middleware / response events do not always
 * preserve it, so we also decode the bearer token payload (the signature was
 * already verified by requireAuth on this same request) to recover the actor.
 * `verifyToken` is optional and only used to be certain the payload is genuine.
 */
function actorFromTokenOrRequest(req, verifyToken) {
  const actor = actorFromRequest(req);
  if (actor.email && actor.userId) return actor;

  const header = String(req.headers?.authorization || '');
  if (!header.startsWith('Bearer ')) return actor;
  let payload = null;
  try {
    if (typeof verifyToken === 'function') {
      payload = verifyToken(header.slice(7));
    } else {
      payload = JSON.parse(Buffer.from(header.slice(7).split('.')[1] || '', 'base64').toString('utf8'));
    }
  } catch (_) {
    return actor;
  }
  if (!payload) return actor;
  return {
    userId: actor.userId || payload.id || payload.sub || null,
    email: actor.email || payload.email || null,
    role: actor.role || payload.role || null,
    ip: actor.ip
  };
}

/** Create the audit recorder bound to a database handle. */
function createAudit(db, options = {}) {
  const verifyToken = typeof options.verifyToken === 'function' ? options.verifyToken : null;
  async function record(entry) {
    try {
      await db.run(
        'INSERT INTO platform_activity (id, actor_user_id, actor_email, actor_role, action, target, method, path, ip, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        crypto.randomUUID(),
        entry.actorUserId || entry.userId || null,
        entry.actorEmail || entry.email || null,
        entry.actorRole || entry.role || null,
        entry.action,
        entry.target || null,
        entry.method || null,
        entry.path || null,
        entry.ip || null,
        entry.status == null ? null : String(entry.status),
        entry.detail || null,
        new Date().toISOString()
      );
    } catch (error) {
      console.error('[audit] failed to record activity:', error?.message || error);
    }
  }

  /**
   * Express middleware. Hooks res 'finish' so the real status code is stored,
   * and only writes rows for mutating requests (or failed logins).
   */
  function middleware(req, res, next) {
    const fullPath = `${req.baseUrl || ''}${req.path || ''}`;
    const action = deriveAction(req.method, fullPath);
    if (!action) return next();

    const detail = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? summarizeBody(req.body) : null;

    res.on('finish', () => {
      // req.user is populated by requireAuth, which runs AFTER this middleware,
      // so the actor must be read here (at response time), not up front.
      const actor = actorFromTokenOrRequest(req, verifyToken);
      record({
        ...actor,
        action,
        target: deriveTarget(`${req.baseUrl || ''}${req.path || ''}`),
        method: req.method,
        path: req.originalUrl || fullPath,
        status: res.statusCode,
        detail
      }).catch(() => {});
    });
    return next();
  }

  async function list({ limit = 100, action, actorEmail } = {}) {
    const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = await db.all(
      `SELECT id, actor_user_id as actorUserId, actor_email as actorEmail, actor_role as actorRole, action, target, method, path, ip, status, detail, created_at as createdAt
       FROM platform_activity ORDER BY created_at DESC LIMIT ?`,
      capped
    );
    return rows.filter((row) => {
      if (action && row.action !== action) return false;
      if (actorEmail && String(row.actorEmail || '').toLowerCase() !== String(actorEmail).toLowerCase()) return false;
      return true;
    });
  }

  async function count() {
    return Number((await db.get('SELECT COUNT(*) as count FROM platform_activity'))?.count || 0);
  }

  return { middleware, record, list, count };
}

module.exports = { createAudit, deriveAction, redact, summarizeBody, MUTATING_METHODS, actorFromTokenOrRequest };
