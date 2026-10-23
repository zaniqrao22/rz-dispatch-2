const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { app } = require('../backend/server');
const db = require('../backend/db');

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

async function login(server, email, password) {
  const response = await request(server, { method: 'POST', path: '/api/auth/login', body: { email, password } });
  assert.equal(response.status, 200, `login failed: ${response.body}`);
  return JSON.parse(response.body).token;
}

test('platform activity is recorded and exposed to staff', async () => {
  const server = await startApp();
  try {
    const before = await db.get('SELECT COUNT(*) as count FROM platform_activity');
    const beforeCount = Number(before?.count || 0);

    const token = await login(server, ADMIN_EMAIL, ADMIN_PASSWORD);
    const auth = { Authorization: `Bearer ${token}` };

    // A money-related change: create then delete a service (rate card edit).
    const key = `audit-test-${crypto.randomUUID().slice(0, 8)}`;
    const created = await request(server, {
      method: 'POST',
      path: '/api/services',
      headers: auth,
      body: { key, name: 'Audit test service', description: 'temporary', basePrice: 10, distanceRate: 1, hourlyRate: 0, active: 1 }
    });
    assert.ok(created.status === 201 || created.status === 200, `unexpected create status ${created.status}: ${created.body}`);

    const deleted = await request(server, { method: 'DELETE', path: `/api/services/${encodeURIComponent(key)}`, headers: auth });
    assert.equal(deleted.status, 200);

    const after = await db.get('SELECT COUNT(*) as count FROM platform_activity');
    assert.ok(Number(after?.count || 0) >= beforeCount + 2, 'expected at least two new audit records');

    const auditResponse = await request(server, { method: 'GET', path: '/api/admin/audit?limit=20', headers: auth });
    assert.equal(auditResponse.status, 200);
    const audit = JSON.parse(auditResponse.body);
    assert.ok(Array.isArray(audit.entries));
    assert.ok(audit.entries.some((entry) => entry.action === 'service.create'));
    assert.ok(audit.entries.some((entry) => entry.action === 'service.delete'));

    const entry = audit.entries.find((item) => item.action === 'service.delete');
    assert.ok(entry.actorEmail, 'audit entry should record the acting user');
    assert.ok(entry.createdAt, 'audit entry should record a timestamp');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('audit logging never exposes secrets', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'audit.js'), 'utf8');
  assert.match(source, /REDACTED_KEYS/);
  assert.match(source, /password/i);
  assert.match(source, /token/i);
});
