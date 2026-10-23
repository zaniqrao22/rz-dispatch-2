const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const crypto = require('node:crypto');

const { app, webhooks } = require('../backend/server');
const db = require('../backend/db');
const {
  createWebhooks,
  signPayload,
  normalizeEvents,
  isValidUrl
} = require('../backend/webhooks');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(server) {
  const response = await request(server, { method: 'POST', path: '/api/auth/login', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  return parse(response);
}

test('webhook signatures verify and tampering is detected', () => {
  const body = JSON.stringify({ hello: 'world' });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload('whsec_test', timestamp, body);
  assert.match(signature, /^[a-f0-9]{64}$/);
  assert.equal(webhooks.verifySignature('whsec_test', `t=${timestamp},v1=${signature}`, body), true);
  assert.equal(webhooks.verifySignature('whsec_wrong', `t=${timestamp},v1=${signature}`, body), false);
  assert.equal(webhooks.verifySignature('whsec_test', `t=${timestamp},v1=${signature}`, body + 'x'), false);
  assert.equal(webhooks.verifySignature('whsec_test', 'garbage', body), false);
});

test('event subscriptions and URLs are validated', () => {
  assert.deepEqual(normalizeEvents(undefined), ['*']);
  assert.deepEqual(normalizeEvents('quote.created, booking.created'), ['quote.created', 'booking.created']);
  assert.deepEqual(normalizeEvents(['job.assigned', 'job.assigned']), ['job.assigned']);
  assert.equal(isValidUrl('https://example.com/hook'), true);
  assert.equal(isValidUrl('http://localhost:9000/hook'), true);
  assert.equal(isValidUrl('ftp://example.com'), false);
  assert.equal(isValidUrl('not a url'), false);
});

test('failed deliveries are retried and recorded', async () => {
  let calls = 0;
  const manager = createWebhooks(db, {
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 500, json: async () => ({}) };
    },
    maxAttempts: 2,
    retryDelayMs: 0,
    sleep: async () => {}
  });
  const userId = `wh-test-${crypto.randomUUID().slice(0, 8)}`;
  const { webhook } = await manager.register({ id: userId }, { url: 'https://example.com/failing-hook', events: ['test.event'] });
  const results = await manager.emit('test.event', { ok: true }, { userId });
  assert.equal(calls, 2, 'the delivery should be attempted twice');
  assert.equal(results.length, 1);
  assert.equal(results[0].delivered, false);
  assert.equal(results[0].attempts, 2);

  const recorded = await manager.deliveries({ id: userId }, webhook.id);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].statusCode, 500);
  assert.equal(recorded[0].deliveredAt, null);

  await manager.remove({ id: userId }, webhook.id);
});

test('a registered webhook receives a signed event when a quote is created', async () => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

  const server = await startApp();
  try {
    const session = await login(server);
    const auth = { Authorization: `Bearer ${session.token}` };

    const created = await request(server, {
      method: 'POST',
      path: '/api/webhooks',
      headers: auth,
      body: { url: receiverUrl, events: ['quote.created'], description: 'test receiver' }
    });
    assert.equal(created.status, 201, created.body);
    const registered = parse(created);
    const webhookId = registered.webhook.id;
    const secret = registered.secret;

    const quote = await request(server, {
      method: 'POST',
      path: '/api/quotes',
      headers: auth,
      body: { customerName: 'Webhook Tester', email: 'hook@example.com', pickupAddress: 'A St', dropoffAddress: 'B St', miles: 5 }
    });
    assert.equal(quote.status, 201, quote.body);

    // The delivery is fire-and-forget; poll briefly for it to arrive.
    for (let i = 0; i < 40 && received.length === 0; i += 1) await sleep(50);
    assert.equal(received.length, 1, 'the webhook receiver should have been called');

    const delivery = received[0];
    assert.equal(delivery.headers['x-rz-event'], 'quote.created');
    const parsedBody = JSON.parse(delivery.body);
    assert.equal(parsedBody.event, 'quote.created');
    assert.ok(parsedBody.data.quote.id);
    assert.equal(
      webhooks.verifySignature(secret, delivery.headers['x-rz-signature'], delivery.body),
      true,
      'the signature must validate against the webhook secret'
    );

    // The delivery is recorded and visible through the API.
    let deliveries = [];
    for (let i = 0; i < 20; i += 1) {
      const listing = await request(server, { method: 'GET', path: `/api/webhooks/${webhookId}/deliveries`, headers: auth });
      deliveries = parse(listing).deliveries || [];
      if (deliveries.length) break;
      await sleep(50);
    }
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].statusCode, 200);
    assert.ok(deliveries[0].deliveredAt);

    // Remove the webhook so it cannot affect other tests.
    const removed = await request(server, { method: 'DELETE', path: `/api/webhooks/${webhookId}`, headers: auth });
    assert.equal(removed.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => receiver.close(resolve));
  }
});
