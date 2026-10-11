'use strict';

const crypto = require('crypto');
const path = require('path');

const SESSION_COOKIE = 'rz_session';
const SESSION_TTL_DAYS = 30;
const ACCESS_TTL = '7d';
const SESSION_TOUCH_MS = 5 * 60 * 1000;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_REQUESTS = 5;
const OTP_WINDOW_MINUTES = 15;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_FAILURES = 5;
const MAX_ACTIVE_SESSIONS = 10;
const TENANT_ROLES = ['shipper', 'broker', 'receiver'];

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS company_accounts (
    id TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'shipper',
    contact_email TEXT,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    refresh_token_hash TEXT NOT NULL,
    user_agent TEXT,
    ip TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS otp_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'portal_login',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    email TEXT PRIMARY KEY,
    failed_count INTEGER NOT NULL DEFAULT 0,
    first_failed_at TEXT NOT NULL,
    locked_until TEXT
  )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS company_account_id TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS company_role TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_account_id TEXT`,
  `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS company_account_id TEXT`,
  `ALTER TABLE quotes ADD COLUMN IF NOT EXISTS company_account_id TEXT`
];

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function userSelect() {
  return 'SELECT id, email, role, driver_id as driverId, status, company_account_id as companyAccountId, company_role as companyRole, account_status as accountStatus FROM users WHERE id = ?';
}

function create(deps) {
  const { db, jwt, signToken, sendMail, mailerEnabled, emailName, isEmail, getUserSettings, requireAuth } = deps;
  const secureCookies = /^https:/i.test(String(deps.PUBLIC_URL || '')) || process.env.NODE_ENV === 'production';

  function parseCookies(header) {
    const out = {};
    String(header || '').split(';').forEach((part) => {
      const index = part.indexOf('=');
      if (index === -1) return;
      const key = part.slice(0, index).trim();
      if (!key) return;
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    });
    return out;
  }

  function getSessionIdFromRequest(req) {
    const cookies = parseCookies(req.headers?.cookie);
    return cookies[SESSION_COOKIE] || '';
  }

  function setSessionCookie(res, sessionId) {
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/',
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
    });
  }

  function clearSessionCookie(res) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/' });
  }

  async function loadUser(userId) {
    return db.get(userSelect(), userId);
  }

  async function createSession(user, req) {
    const id = crypto.randomUUID();
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const forwarded = String(req.headers?.['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    await db.run(
      'INSERT INTO sessions (id, user_id, refresh_token_hash, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      user.id,
      sha256(refreshToken),
      String(req.headers?.['user-agent'] || '').slice(0, 300) || null,
      forwarded || null,
      now.toISOString(),
      now.toISOString(),
      expiresAt.toISOString(),
      null
    );
    await enforceSessionLimit(user.id);
    return { id, refreshToken, expiresAt: expiresAt.toISOString() };
  }

  async function enforceSessionLimit(userId) {
    const rows = await db.all('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', userId);
    if (rows.length <= MAX_ACTIVE_SESSIONS) return;
    for (const row of rows.slice(MAX_ACTIVE_SESSIONS)) {
      await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', nowIso(), row.id);
    }
  }

  async function validateSession(sessionId) {
    if (!sessionId) return null;
    const row = await db.get('SELECT * FROM sessions WHERE id = ?', sessionId);
    if (!row || row.revoked_at) return null;
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
    const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    if (Date.now() - lastSeen > SESSION_TOUCH_MS) {
      db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', nowIso(), sessionId).catch(() => {});
    }
    return row;
  }

  async function revokeSession(sessionId) {
    if (!sessionId) return;
    await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(), sessionId);
  }

  async function revokeAllSessions(userId) {
    await db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', nowIso(), userId);
  }

  async function listSessions(userId) {
    const rows = await db.all(
      'SELECT id, user_agent as userAgent, ip, created_at as createdAt, last_seen_at as lastSeenAt, expires_at as expiresAt FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      userId
    );
    return rows.filter((row) => !row.expiresAt || Date.parse(row.expiresAt) > Date.now());
  }

  function issueAccessToken(user, sessionId) {
    return signToken({
      id: user.id,
      email: user.email,
      role: user.role,
      driverId: user.driver_id ?? user.driverId ?? null,
      sid: sessionId,
      companyAccountId: user.company_account_id || user.companyAccountId || null
    });
  }

  function publicUser(user, account, settings) {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      driverId: user.driver_id ?? user.driverId ?? null,
      companyRole: user.company_role ?? user.companyRole ?? null,
      accountStatus: user.account_status ?? user.accountStatus ?? 'active',
      companyAccountId: account?.id || user.company_account_id || user.companyAccountId || null,
      name: settings?.name || undefined
    };
  }

  async function safeSettings(user) {
    if (typeof getUserSettings !== 'function') return null;
    try {
      return await getUserSettings({ id: user.id, email: user.email });
    } catch (_) {
      return null;
    }
  }

  async function ensureCompanyAccount(user, companyName) {
    if (!user) return null;
    // loadUser() aliases the column to companyAccountId, while raw SELECT *
    // rows expose company_account_id; accept either so the tenant is reused
    // instead of silently creating a duplicate account on every call.
    const existingId = user.company_account_id || user.companyAccountId;
    if (existingId) {
      const existing = await db.get('SELECT * FROM company_accounts WHERE id = ?', existingId);
      if (existing) {
        if (companyName && companyName !== existing.company_name) {
          await db.run('UPDATE company_accounts SET company_name = ?, updated_at = ? WHERE id = ?', companyName, nowIso(), existing.id);
          existing.company_name = companyName;
        }
        return existing;
      }
    }
    const settings = await safeSettings(user);
    const name = companyName || settings?.name || (user.email ? String(user.email).split('@')[1] : '') || 'Customer Account';
    const companyRole = user.company_role ?? user.companyRole ?? null;
    const accountType = TENANT_ROLES.includes(companyRole) ? companyRole : 'shipper';
    const id = crypto.randomUUID();
    await db.run(
      'INSERT INTO company_accounts (id, company_name, account_type, contact_email, phone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, name, accountType, user.email || null, settings?.phone || null, 'active', nowIso(), nowIso()
    );
    await db.run('UPDATE users SET company_account_id = ? WHERE id = ?', id, user.id);
    const created = await db.get('SELECT * FROM company_accounts WHERE id = ?', id);
    user.company_account_id = id;
    user.companyAccountId = id;
    return created;
  }

  async function checkLoginLock(email) {
    const row = await db.get('SELECT * FROM login_attempts WHERE email = ?', email);
    if (!row) return { locked: false, failedCount: 0, retryAfterSeconds: 0 };
    const now = Date.now();
    if (row.locked_until) {
      const until = Date.parse(row.locked_until);
      if (until > now) {
        return { locked: true, failedCount: row.failed_count, retryAfterSeconds: Math.ceil((until - now) / 1000) };
      }
      await db.run('UPDATE login_attempts SET failed_count = 0, locked_until = NULL WHERE email = ?', email);
      return { locked: false, failedCount: 0, retryAfterSeconds: 0 };
    }
    if (row.first_failed_at && now - Date.parse(row.first_failed_at) > LOGIN_WINDOW_MINUTES * 60 * 1000) {
      await db.run('UPDATE login_attempts SET failed_count = 0 WHERE email = ?', email);
      return { locked: false, failedCount: 0, retryAfterSeconds: 0 };
    }
    return { locked: false, failedCount: row.failed_count, retryAfterSeconds: 0 };
  }

  async function recordLoginFailure(email) {
    const now = new Date();
    const row = await db.get('SELECT * FROM login_attempts WHERE email = ?', email);
    if (!row) {
      await db.run('INSERT INTO login_attempts (email, failed_count, first_failed_at, locked_until) VALUES (?, ?, ?, ?)', email, 1, now.toISOString(), null);
      return { failedCount: 1, locked: false, retryAfterSeconds: 0 };
    }
    let count = Number(row.failed_count || 0) + 1;
    let firstFailed = row.first_failed_at;
    if (!firstFailed || now.getTime() - Date.parse(firstFailed) > LOGIN_WINDOW_MINUTES * 60 * 1000) {
      count = 1;
      firstFailed = now.toISOString();
    }
    let lockedUntil = null;
    if (count >= LOGIN_MAX_FAILURES) {
      lockedUntil = new Date(now.getTime() + LOGIN_WINDOW_MINUTES * 60 * 1000).toISOString();
    }
    await db.run('UPDATE login_attempts SET failed_count = ?, first_failed_at = ?, locked_until = ? WHERE email = ?', count, firstFailed, lockedUntil, email);
    return { failedCount: count, locked: Boolean(lockedUntil), retryAfterSeconds: lockedUntil ? LOGIN_WINDOW_MINUTES * 60 : 0 };
  }

  async function clearLoginFailures(email) {
    await db.run('DELETE FROM login_attempts WHERE email = ?', email);
  }

  function otpEmail(name, code, minutes) {
    return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;">
      <h2 style="color:#0f8f7f;">Your RZ Dispatch sign-in code</h2>
      <p>Hi ${name},</p>
      <p>Use the code below to sign in to your customer portal. It expires in ${minutes} minutes.</p>
      <p style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f2f7f5;padding:16px 20px;border-radius:10px;text-align:center;">${code}</p>
      <p style="color:#6b7c78;font-size:13px;">If you did not request this code, you can safely ignore this email.</p>
    </div>`;
  }

  async function requirePortalPage(req, res, next) {
    const sessionId = getSessionIdFromRequest(req);
    const session = sessionId ? await validateSession(sessionId) : null;
    if (!session) {
      clearSessionCookie(res);
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || '/portal'));
    }
    const user = await loadUser(session.user_id);
    if (!user || user.status === 'pending' || user.status === 'rejected' || user.accountStatus === 'suspended') {
      clearSessionCookie(res);
      return res.redirect('/login');
    }
    req.portalUser = user;
    req.sessionId = sessionId;
    next();
  }

  function registerRoutes(app) {
    app.post('/api/auth/logout', requireAuth, async (req, res) => {
      if (req.sessionId) await revokeSession(req.sessionId);
      clearSessionCookie(res);
      res.json({ success: true, message: 'Signed out of this device.' });
    });

    app.post('/api/auth/logout-all', requireAuth, async (req, res) => {
      await revokeAllSessions(req.user.id);
      clearSessionCookie(res);
      res.json({ success: true, message: 'Signed out of all devices.' });
    });

    app.get('/api/auth/sessions', requireAuth, async (req, res) => {
      const sessions = await listSessions(req.user.id);
      res.json({ sessions, currentSessionId: req.sessionId || null });
    });

    app.post('/api/auth/session/refresh', async (req, res) => {
      try {
        const sessionId = String(req.body?.sessionId || '').trim() || getSessionIdFromRequest(req) || '';
        const presented = String(req.body?.refreshToken || '').trim();
        if (!sessionId) return res.status(400).json({ error: 'A session id or session cookie is required.' });
        const session = await db.get('SELECT * FROM sessions WHERE id = ?', sessionId);
        if (!session || session.revoked_at || (session.expires_at && Date.parse(session.expires_at) < Date.now())) {
          return res.status(401).json({ error: 'Session is no longer valid. Please sign in again.' });
        }
        if (presented) {
          if (sha256(presented) !== session.refresh_token_hash) return res.status(401).json({ error: 'Invalid refresh token.' });
        } else if (getSessionIdFromRequest(req) !== sessionId) {
          return res.status(401).json({ error: 'A refresh token is required.' });
        }
        const user = await loadUser(session.user_id);
        if (!user) return res.status(401).json({ error: 'Account not found.' });
        if (user.status === 'pending' || user.status === 'rejected' || user.accountStatus === 'suspended') {
          await revokeSession(sessionId);
          return res.status(403).json({ error: 'Account is not active.' });
        }
        const rotated = crypto.randomBytes(32).toString('hex');
        await db.run('UPDATE sessions SET refresh_token_hash = ?, last_seen_at = ? WHERE id = ?', sha256(rotated), nowIso(), sessionId);
        setSessionCookie(res, sessionId);
        const account = await ensureCompanyAccount(user);
        const settings = await safeSettings(user);
        res.json({
          token: issueAccessToken(user, sessionId),
          refreshToken: rotated,
          sessionId,
          expiresIn: ACCESS_TTL,
          user: publicUser(user, account, settings)
        });
      } catch (error) {
        res.status(500).json({ error: 'Could not refresh the session.' });
      }
    });

    app.post('/api/auth/otp/request', async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!isEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
      const recent = await db.get(
        'SELECT COUNT(*) as count FROM otp_codes WHERE email = ? AND created_at > ?',
        email,
        new Date(Date.now() - OTP_WINDOW_MINUTES * 60 * 1000).toISOString()
      );
      if (Number(recent?.count || 0) >= OTP_MAX_REQUESTS) {
        return res.status(429).json({ error: 'Too many codes requested. Please wait a few minutes and try again.' });
      }
      const user = await db.get('SELECT * FROM users WHERE email = ?', email);
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await db.run(
        'INSERT INTO otp_codes (id, email, code_hash, purpose, attempts, max_attempts, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        crypto.randomUUID(), email, sha256(code), 'portal_login', 0, OTP_MAX_ATTEMPTS,
        new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString(), null, nowIso()
      );
      let emailed = false;
      if (user && mailerEnabled) {
        try {
          await sendMail(email, 'Your RZ Dispatch sign-in code', otpEmail(emailName(email), code, OTP_TTL_MINUTES));
          emailed = true;
        } catch (_) {
          emailed = false;
        }
      }
      const body = {
        success: true,
        message: 'If that email exists, a sign-in code has been sent.',
        emailed,
        emailConfigured: Boolean(mailerEnabled),
        expiresInMinutes: OTP_TTL_MINUTES
      };
      if (!mailerEnabled && process.env.NODE_ENV !== 'production') body.devCode = code;
      res.json(body);
    });

    app.post('/api/auth/otp/verify', async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const code = String(req.body?.code || '').trim();
      if (!isEmail(email) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'A valid email and 6-digit code are required.' });
      }
      const row = await db.get(
        'SELECT * FROM otp_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
        email, 'portal_login'
      );
      if (!row) return res.status(400).json({ error: 'No active code found. Request a new one.' });
      if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
        await db.run('UPDATE otp_codes SET consumed_at = ? WHERE id = ?', nowIso(), row.id);
        return res.status(400).json({ error: 'That code has expired. Request a new one.' });
      }
      if (Number(row.attempts) >= Number(row.max_attempts)) {
        await db.run('UPDATE otp_codes SET consumed_at = ? WHERE id = ?', nowIso(), row.id);
        return res.status(429).json({ error: 'Too many attempts on this code. Request a new one.' });
      }
      if (sha256(code) !== row.code_hash) {
        await db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
        return res.status(401).json({ error: 'That code is not correct.' });
      }
      await db.run('UPDATE otp_codes SET consumed_at = ? WHERE id = ?', nowIso(), row.id);
      const user = await db.get('SELECT * FROM users WHERE email = ?', email);
      if (!user) return res.status(404).json({ error: 'No account found for that email.' });
      if (user.status === 'pending') return res.status(403).json({ error: 'Your account is currently awaiting admin approval.' });
      if (user.status === 'rejected') return res.status(403).json({ error: 'Your registration request was declined.' });
      if (user.account_status === 'suspended') return res.status(403).json({ error: 'Your company account is suspended. Contact your dispatcher.' });
      const session = await createSession(user, req);
      setSessionCookie(res, session.id);
      const account = await ensureCompanyAccount(user);
      const settings = await safeSettings(user);
      res.json({
        token: issueAccessToken(user, session.id),
        refreshToken: session.refreshToken,
        sessionId: session.id,
        expiresIn: ACCESS_TTL,
        user: publicUser(user, account, settings)
      });
    });

    app.get('/api/portal/company', requireAuth, async (req, res) => {
      const user = await loadUser(req.user.id);
      if (!user) return res.status(404).json({ error: 'Account not found.' });
      const account = await ensureCompanyAccount(user);
      if (!account) return res.status(500).json({ error: 'Could not resolve the company account.' });
      const [jobs, bookings, quotes] = await Promise.all([
        db.get('SELECT COUNT(*) as count FROM jobs WHERE company_account_id = ?', account.id),
        db.get('SELECT COUNT(*) as count FROM bookings WHERE company_account_id = ?', account.id),
        db.get('SELECT COUNT(*) as count FROM quotes WHERE company_account_id = ?', account.id)
      ]);
      res.json({
        company: { id: account.id, companyName: account.company_name, accountType: account.account_type, status: account.status },
        role: user.companyRole || user.role,
        counters: {
          jobs: Number(jobs?.count || 0),
          bookings: Number(bookings?.count || 0),
          quotes: Number(quotes?.count || 0)
        }
      });
    });

    app.get('/login', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    app.use('/portal', requirePortalPage, (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
  }

  return {
    registerRoutes,
    requirePortalPage,
    validateSession,
    createSession,
    revokeSession,
    revokeAllSessions,
    listSessions,
    issueAccessToken,
    publicUser,
    ensureCompanyAccount,
    getSessionIdFromRequest,
    setSessionCookie,
    clearSessionCookie,
    checkLoginLock,
    recordLoginFailure,
    clearLoginFailures,
    safeSettings
  };
}

module.exports = { create, schemaStatements, SESSION_COOKIE };
