const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

// This process intentionally runs WITHOUT Stripe credentials so we can assert
// the graceful "not configured" behaviour of the three payment endpoints.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

const { app, stripe } = require('../server');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function startApp() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeRequest(server, { method, path: requestPath, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method,
        path: requestPath,
        headers
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: data }));
      }
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function login(server, email, password) {
  const response = await makeRequest(server, {
    method: 'POST',
    path: '/api/auth/login',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200, `login failed: ${response.body}`);
  return JSON.parse(response.body).token;
}

function runConfiguredChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'payments-configured-child.js')], {
      env: {
        ...process.env,
        PROJ_DIR: PROJECT_ROOT,
        STRIPE_SECRET_KEY: 'sk_test_offline_mock_for_regression_tests',
        STRIPE_WEBHOOK_SECRET: 'whsec_regression_test_secret',
        DOTENV_CONFIG_QUIET: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith('RESULT '));
      if (code !== 0 || !resultLine) {
        reject(new Error(`configured-path child failed (code ${code})\n${stdout}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(resultLine.slice('RESULT '.length)));
    });
  });
}

test('payment endpoints report 503 while Stripe is unconfigured', async (t) => {
  if (stripe) {
    t.skip('Stripe credentials are present in this environment; unconfigured path not applicable');
    return;
  }

  const server = await startApp();
  try {
    const token = await login(server, 'admin@rzdispatch.local', 'Demo@12345');
    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    const checkout = await makeRequest(server, {
      method: 'POST',
      path: '/api/purchase/lifetime',
      headers: authHeaders,
      body: JSON.stringify({ email: 'buyer@example.com' })
    });
    assert.equal(checkout.status, 503);
    assert.match(checkout.body, /Payments are not configured/i);

    const verify = await makeRequest(server, {
      method: 'GET',
      path: '/api/purchase/license?session_id=cs_test_anything',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(verify.status, 503);
    assert.match(verify.body, /Payments are not configured/i);

    const webhook = await makeRequest(server, {
      method: 'POST',
      path: '/api/payments/webhook',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(webhook.status, 503);
    assert.match(webhook.body, /Webhook is not configured/i);

    const status = await makeRequest(server, { method: 'GET', path: '/api/license/status' });
    const statusPayload = JSON.parse(status.body);
    assert.equal(statusPayload.paymentsConfigured, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('checkout creation, paid-session verification, and webhook fulfillment work when configured', async () => {
  const results = await runConfiguredChild();

  // --- checkout session creation ---
  assert.equal(results.checkout.status, 200);
  assert.match(results.checkout.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  assert.match(results.checkout.sessionId, /^cs_/);
  assert.equal(results.checkout.mode, 'payment');
  assert.equal(results.checkout.currency, 'usd');
  assert.equal(results.checkout.unitAmount, 49900);
  assert.equal(results.checkout.metaProduct, 'rz-dispatch');
  assert.equal(results.checkout.metaLicense, 'lifetime');
  assert.equal(results.checkout.customerEmail, 'buyer@example.com');

  // --- paid / unpaid / malformed session verification ---
  assert.equal(results.sessionVerify.paidStatus, 200);
  assert.equal(results.sessionVerify.paidKeyPrefix, 'RZ-');
  assert.equal(results.sessionVerify.paidType, 'lifetime');
  assert.equal(results.sessionVerify.rowSource, 'stripe');
  assert.equal(results.sessionVerify.rowUserMatch, true);
  assert.equal(results.sessionVerify.rowsForSession, 1);
  assert.equal(results.sessionVerify.unpaidStatus, 402);
  assert.equal(results.sessionVerify.malformedStatus, 400);

  // --- webhook: signature verification + idempotent fulfillment ---
  assert.equal(results.webhook.validStatus, 200);
  assert.equal(results.webhook.rowsAfterFirst, 1);
  assert.equal(results.webhook.replayStatus, 200);
  assert.equal(results.webhook.rowsAfterReplay, 1);
  assert.equal(results.webhook.badSignatureStatus, 400);
  assert.equal(results.webhook.licenseSource, 'stripe');
  assert.equal(results.webhook.customerEmail, 'webhook-buyer@example.com');
});
