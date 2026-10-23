const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const { app } = require('../backend/server');
const db = require('../backend/db');
const {
  generateApiKey,
  looksLikeApiKey,
  hashKey,
  normalizeScopes
} = require('../backend/api-keys');

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
        response.on('end', () => resolve({ status: response.statusCode, body: data }));
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

async function login(server) {
  const response = await request(server, { method: 'POST', path: '/api/auth/login', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  return parse(response);
}

test('API keys use a recognisable prefix and are stored hashed', () => {
  const { key, prefix, hash } = generateApiKey({ environment: 'live' });
  assert.ok(looksLikeApiKey(key));
  assert.ok(key.startsWith('rz_live_'));
  assert.equal(prefix, key.slice(0, 12));
  assert.notEqual(hash, key);
  assert.equal(hash, hashKey(key));
  assert.equal(looksLikeApiKey('not-a-key'), false);
  assert.equal(looksLikeApiKey(`Bearer ${key}`), false);
  assert.equal(generateApiKey({ environment: 'test' }).key.startsWith('rz_test_'), true);
});

test('scopes default sensibly and deduplicate', () => {
  assert.deepEqual(normalizeScopes(undefined), ['read', 'write']);
  assert.deepEqual(normalizeScopes('read, write, read'), ['read', 'write']);
  assert.deepEqual(normalizeScopes(['BOOK', 'book']), ['book']);
});

test('an API key authenticates API calls and stops working once revoked', async () => {
  const server = await startApp();
  try {
    const session = await login(server);
    const auth = { Authorization: `Bearer ${session.token}` };

    const created = await request(server, {
      method: 'POST',
      path: '/api/api-keys',
      headers: auth,
      body: { name: 'CI integration key', scopes: ['read', 'write'] }
    });
    assert.equal(created.status, 201, created.body);
    const createdJson = parse(created);
    assert.ok(createdJson.key, 'the raw key must be returned once');
    const rawKey = createdJson.key;
    const keyId = createdJson.apiKey.id;

    // The stored row must not contain the raw key.
    const stored = await db.get('SELECT key_hash as hash FROM api_keys WHERE id = ?', keyId);
    assert.equal(stored.hash, hashKey(rawKey));
    assert.notEqual(stored.hash, rawKey);

    // Authenticate with X-API-Key.
    const me = await request(server, { method: 'GET', path: '/api/auth/me', headers: { 'X-API-Key': rawKey } });
    assert.equal(me.status, 200, me.body);
    assert.equal(parse(me).user.email, ADMIN_EMAIL);

    // Also accept Authorization: Bearer <api key>.
    const meViaBearer = await request(server, { method: 'GET', path: '/api/settings', headers: { Authorization: `Bearer ${rawKey}` } });
    assert.equal(meViaBearer.status, 200, meViaBearer.body);

    // Listing shows the key but never the secret.
    const listed = await request(server, { method: 'GET', path: '/api/api-keys', headers: auth });
    const listedJson = parse(listed);
    assert.ok(listedJson.apiKeys.some((key) => key.id === keyId));
    assert.equal(JSON.stringify(listedJson).includes(rawKey), false, 'the raw key must never be listed');

    // Revoke, then the key must be rejected.
    const revoked = await request(server, { method: 'DELETE', path: `/api/api-keys/${keyId}`, headers: auth });
    assert.equal(revoked.status, 200);

    const afterRevoke = await request(server, { method: 'GET', path: '/api/auth/me', headers: { 'X-API-Key': rawKey } });
    assert.equal(afterRevoke.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a malformed or unknown API key is rejected', async () => {
  const server = await startApp();
  try {
    const fake = generateApiKey().key;
    const response = await request(server, { method: 'GET', path: '/api/auth/me', headers: { 'X-API-Key': fake } });
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
