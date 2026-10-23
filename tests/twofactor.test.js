const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const { app } = require('../backend/server');
const db = require('../backend/db');
const twofactor = require('../backend/twofactor');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@rzdispatch.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Demo@12345';

function startApp() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { method, path: requestPath, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const requestHeaders = { ...headers };
    if (payload !== undefined && !requestHeaders['Content-Type']) requestHeaders['Content-Type'] = 'application/json';
    if (payload !== undefined) requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path: requestPath, headers: requestHeaders },
      (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: data, headers: response.headers }));
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function parse(response) {
  try {
    return JSON.parse(response.body);
  } catch (_) {
    return {};
  }
}

async function login(server, email, password) {
  const response = await request(server, { method: 'POST', path: '/api/auth/login', body: { email, password } });
  return { response, json: parse(response) };
}

test('TOTP generation and verification stay in sync', () => {
  const secret = twofactor.generateSecret();
  assert.match(secret, /^[A-Z2-7]+$/);
  const token = twofactor.generateToken(secret);
  assert.match(token, /^\d{6}$/);
  assert.equal(twofactor.verifyToken(secret, token), true);
  // Accept a code from one step in the past/future (clock drift).
  assert.equal(twofactor.verifyToken(secret, twofactor.generateToken(secret, { stepOffset: -1 })), true);
  assert.equal(twofactor.verifyToken(secret, twofactor.generateToken(secret, { stepOffset: 1 })), true);
  // Reject far-off or malformed values.
  assert.equal(twofactor.verifyToken(secret, twofactor.generateToken(secret, { stepOffset: 5 })), false);
  assert.equal(twofactor.verifyToken(secret, '000000'), false);
  assert.equal(twofactor.verifyToken(secret, 'abc'), false);
  // A different secret must not validate.
  assert.equal(twofactor.verifyToken(twofactor.generateSecret(), token), false);
});

test('backup codes are single-use and stored hashed', () => {
  const { codes, hashes } = twofactor.generateBackupCodes(3);
  assert.equal(codes.length, 3);
  assert.equal(hashes.length, 3);
  assert.ok(codes.every((code) => !hashes.includes(code)), 'raw codes must never equal stored hashes');
  const first = codes[0];
  const consumed = twofactor.consumeBackupCode(first, hashes);
  assert.equal(consumed.matched, true);
  assert.equal(consumed.remaining.length, hashes.length - 1);
  // Reusing the same code against the remaining hashes fails.
  assert.equal(twofactor.consumeBackupCode(first, consumed.remaining).matched, false);
});

test('CSRF tokens bind to a session and reject forgeries', () => {
  const token = twofactor.createCsrfToken('secret', 'session-123');
  assert.equal(twofactor.verifyCsrfToken('secret', 'session-123', token), true);
  assert.equal(twofactor.verifyCsrfToken('secret', 'session-999', token), false);
  assert.equal(twofactor.verifyCsrfToken('other-secret', 'session-123', token), false);
  assert.equal(twofactor.verifyCsrfToken('secret', 'session-123', 'garbage'), false);
});

test('a 2FA-enabled account cannot sign in with password alone', async () => {
  const server = await startApp();
  const email = `twofa-${crypto.randomUUID().slice(0, 8)}@rzdispatch.local`;
  const password = 'Str0ng-Pass-1';
  const secret = twofactor.generateSecret();
  try {
    await db.run(
      'INSERT INTO users (id, email, password_hash, role, status, created_at, totp_secret, totp_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(), email, bcrypt.hashSync(password, 10), 'customer', 'approved', new Date().toISOString(), secret, 1
    );

    const first = await login(server, email, password);
    assert.equal(first.response.status, 200);
    assert.equal(first.json.twoFactorRequired, true);
    assert.ok(first.json.challenge, 'a challenge token should be issued');
    assert.equal(first.json.token, undefined, 'no session token until the second factor is provided');

    // Wrong code is rejected, then a valid TOTP completes the sign-in.
    const wrong = await request(server, { method: 'POST', path: '/api/auth/2fa/verify', body: { challenge: first.json.challenge, code: '000000' } });
    assert.equal(wrong.status, 401);

    const code = twofactor.generateToken(secret);
    const done = await request(server, { method: 'POST', path: '/api/auth/2fa/verify', body: { challenge: first.json.challenge, code } });
    assert.equal(done.status, 200);
    const doneJson = parse(done);
    assert.ok(doneJson.token, 'a session token is issued after 2FA');
    assert.ok(doneJson.csrfToken, 'a CSRF token accompanies the session');
  } finally {
    await db.run('DELETE FROM users WHERE email = ?', email);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an enrolled user can complete TOTP setup, log in with 2FA, and use backup codes', async () => {
  const server = await startApp();
  const email = `enrol-${crypto.randomUUID().slice(0, 8)}@rzdispatch.local`;
  const password = 'Str0ng-Pass-2';
  const userId = crypto.randomUUID();
  try {
    await db.run(
      'INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      userId, email, bcrypt.hashSync(password, 10), 'customer', 'approved', new Date().toISOString()
    );

    const login1 = await login(server, email, password);
    assert.equal(login1.response.status, 200);
    const auth = { Authorization: `Bearer ${login1.json.token}` };

    const setup = await request(server, { method: 'POST', path: '/api/auth/2fa/setup', headers: auth });
    assert.equal(setup.status, 200);
    const setupJson = parse(setup);
    assert.ok(setupJson.secret);
    assert.match(setupJson.otpauthUrl, /^otpauth:\/\/totp\//);

    const enable = await request(server, { method: 'POST', path: '/api/auth/2fa/enable', headers: auth, body: { code: twofactor.generateToken(setupJson.secret) } });
    assert.equal(enable.status, 200);
    const enableJson = parse(enable);
    assert.equal(enableJson.backupCodes.length, 10);

    const status = await request(server, { method: 'GET', path: '/api/auth/2fa/status', headers: auth });
    assert.equal(parse(status).enabled, true);

    // Now password-only login must challenge.
    const challenged = await login(server, email, password);
    assert.equal(challenged.json.twoFactorRequired, true);

    // A backup code should complete sign-in and be consumed.
    const backupCode = enableJson.backupCodes[0];
    const viaBackup = await request(server, { method: 'POST', path: '/api/auth/2fa/verify', body: { challenge: challenged.json.challenge, code: backupCode } });
    assert.equal(viaBackup.status, 200);
    assert.ok(parse(viaBackup).token);

    // The same backup code must not work twice.
    const challenged2 = await login(server, email, password);
    const reuse = await request(server, { method: 'POST', path: '/api/auth/2fa/verify', body: { challenge: challenged2.json.challenge, code: backupCode } });
    assert.equal(reuse.status, 401);
  } finally {
    await db.run('DELETE FROM users WHERE id = ?', userId);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cookie-authenticated mutating requests require a CSRF token', async () => {
  const server = await startApp();
  try {
    const loginResponse = await request(server, { method: 'POST', path: '/api/auth/login', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    assert.equal(loginResponse.status, 200);
    const cookie = String(loginResponse.headers['set-cookie'] || '').split(';')[0];
    const json = parse(loginResponse);
    assert.ok(cookie, 'a session cookie is set');
    assert.ok(json.csrfToken, 'login returns a CSRF token');

    // Cookie without CSRF header is rejected on a mutating endpoint.
    const withoutCsrf = await request(server, { method: 'POST', path: '/api/settings/password', headers: { Cookie: cookie }, body: { currentPassword: 'x', newPassword: 'yyyyyyyy' } });
    assert.equal(withoutCsrf.status, 403);

    // With the matching header it proceeds (400 here because the old password is wrong).
    const withCsrf = await request(server, { method: 'POST', path: '/api/settings/password', headers: { Cookie: cookie, 'X-CSRF-Token': json.csrfToken }, body: { currentPassword: 'x', newPassword: 'yyyyyyyy' } });
    assert.notEqual(withCsrf.status, 403);

    // Bearer-token callers are unaffected by CSRF (they cannot be forged).
    const viaBearer = await request(server, { method: 'POST', path: '/api/settings/password', headers: { Authorization: `Bearer ${json.token}` }, body: { currentPassword: 'x', newPassword: 'yyyyyyyy' } });
    assert.notEqual(viaBearer.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
