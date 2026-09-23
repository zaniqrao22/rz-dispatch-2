'use strict';

// Exercises the three Stripe payment endpoints end-to-end WITHOUT touching the
// Stripe network: the checkout `create`/`retrieve` calls are swapped for
// in-process mocks, and the webhook is signed locally with a throwaway secret.
// Spawned by tests/payments.test.js; prints one `RESULT <json>` line.

const http = require('node:http');
const path = require('node:path');

function finish(code, payload) {
  const line = payload === undefined ? ('CHILD_ERROR ' + code) : ('RESULT ' + JSON.stringify(payload) + '\n');
  process.stdout.write(line, () => process.exit(code));
}

async function main() {
  const PROJ = process.env.PROJ_DIR;
  const serverModule = require(path.join(PROJ, 'server'));
  const db = require(path.join(PROJ, 'db'));
  const Stripe = require(path.join(PROJ, 'node_modules', 'stripe'));
  const { app, stripe } = serverModule;
  if (!stripe) throw new Error('stripe was not constructed with STRIPE_SECRET_KEY');

  const out = { checkout: {}, sessionVerify: {}, webhook: {} };

  // Offline mocks: capture checkout-session parameters; control retrieve state.
  const createCalls = [];
  stripe.checkout.sessions.create = async function (params) {
    createCalls.push(params);
    return { id: 'cs_test_mock_create', url: 'https://checkout.stripe.com/c/pay/cs_test_mock_create' };
  };
  stripe.checkout.sessions.retrieve = async function (id) {
    if (String(id).indexOf('unpaid') !== -1) {
      return { id: id, payment_status: 'unpaid', metadata: { product: 'rz-dispatch', licenseType: 'lifetime' } };
    }
    if (String(id).indexOf('wrongproduct') !== -1) {
      return { id: id, payment_status: 'paid', metadata: { product: 'other', licenseType: 'lifetime' } };
    }
    return {
      id: id,
      payment_status: 'paid',
      customer_email: 'paid-buyer@example.com',
      customer_details: { email: 'paid-buyer@example.com' },
      metadata: { product: 'rz-dispatch', licenseType: 'lifetime' }
    };
  };

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  async function call(method, urlPath, body, headers) {
    const response = await fetch(base + urlPath, {
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: body === undefined ? undefined : body
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
    return { status: response.status, json: json, text: text };
  }

  const login = await call('POST', '/api/auth/login', JSON.stringify({ email: 'admin@rzdispatch.local', password: 'Demo@12345' }));
  if (login.status !== 200) throw new Error('child login failed: ' + login.status + ' ' + login.text);
  const token = login.json.token;
  const auth = { Authorization: 'Bearer ' + token };
  const me = await call('GET', '/api/auth/me', undefined, auth);
  if (!me.json || !me.json.user) throw new Error('child /api/auth/me failed: ' + me.text);
  const userId = me.json.user.id;

  // 1) Checkout session creation and its parameters.
  const checkout = await call('POST', '/api/purchase/lifetime', JSON.stringify({ email: 'buyer@example.com' }), auth);
  out.checkout.status = checkout.status;
  out.checkout.checkoutUrl = checkout.json && checkout.json.checkoutUrl;
  out.checkout.sessionId = checkout.json && checkout.json.sessionId;
  const item = createCalls[0] || {};
  const priceData = item.line_items && item.line_items[0] && item.line_items[0].price_data;
  out.checkout.mode = item.mode;
  out.checkout.currency = priceData && priceData.currency;
  out.checkout.unitAmount = priceData && priceData.unit_amount;
  out.checkout.metaProduct = item.metadata && item.metadata.product;
  out.checkout.metaLicense = item.metadata && item.metadata.licenseType;
  out.checkout.customerEmail = item.customer_email;

  // 2) Paid session → license issued and bound to the requesting user.
  const paid = await call('GET', '/api/purchase/license?session_id=cs_test_paid', undefined, auth);
  out.sessionVerify.paidStatus = paid.status;
  out.sessionVerify.paidKeyPrefix = paid.json && paid.json.licenseKey && String(paid.json.licenseKey).slice(0, 3);
  out.sessionVerify.paidType = paid.json && paid.json.type;
  const paidRow = await db.get('SELECT source, user_id FROM licenses WHERE stripe_session_id = ?', 'cs_test_paid');
  out.sessionVerify.rowSource = paidRow && paidRow.source;
  out.sessionVerify.rowUserMatch = Boolean(paidRow && paidRow.user_id === userId);
  out.sessionVerify.rowsForSession = (await db.all('SELECT id FROM licenses WHERE stripe_session_id = ?', 'cs_test_paid')).length;

  // Unpaid session → 402; malformed session id → 400.
  const unpaid = await call('GET', '/api/purchase/license?session_id=cs_test_unpaid', undefined, auth);
  out.sessionVerify.unpaidStatus = unpaid.status;
  const malformed = await call('GET', '/api/purchase/license?session_id=nope', undefined, auth);
  out.sessionVerify.malformedStatus = malformed.status;

  // 3) Webhook: valid signature fulfills, replays are idempotent, bad sig is rejected.
  const webhookSession = {
    id: 'cs_test_webhook_child',
    payment_status: 'paid',
    customer_details: { email: 'webhook-buyer@example.com' },
    metadata: { product: 'rz-dispatch', licenseType: 'lifetime' }
  };
  const payload = JSON.stringify({ id: 1, type: 'checkout.session.completed', data: { object: webhookSession } });
  const signer = Stripe('sk_test_irrelevant_for_signing');
  const signature = signer.webhooks.generateTestHeaderString({
    payload: payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET
  });

  async function postWebhook(bodyText, sig) {
    const response = await fetch(base + '/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
      body: bodyText
    });
    return { status: response.status, text: await response.text() };
  }

  const first = await postWebhook(payload, signature);
  out.webhook.validStatus = first.status;
  out.webhook.rowsAfterFirst = (await db.all('SELECT id FROM licenses WHERE stripe_session_id = ?', webhookSession.id)).length;

  const replay = await postWebhook(payload, signature);
  out.webhook.replayStatus = replay.status;
  const rowsAfterReplay = await db.all('SELECT id FROM licenses WHERE stripe_session_id = ?', webhookSession.id);
  out.webhook.rowsAfterReplay = rowsAfterReplay.length;
  const webhookRow = await db.get('SELECT source, customer_email FROM licenses WHERE stripe_session_id = ?', webhookSession.id);
  out.webhook.licenseSource = webhookRow && webhookRow.source;
  out.webhook.customerEmail = webhookRow && webhookRow.customer_email;

  const bad = await postWebhook(payload, signature + 'tampered');
  out.webhook.badSignatureStatus = bad.status;

  // Cleanup the rows created by this test so it is safe to run repeatedly.
  await db.run('DELETE FROM licenses WHERE stripe_session_id = ?', 'cs_test_paid');
  await db.run('DELETE FROM licenses WHERE stripe_session_id = ?', webhookSession.id);

  server.close(function () { finish(0, out); });
}

main().catch(function (error) {
  const message = error && error.stack ? error.stack : String(error);
  process.stderr.write('CHILD_ERROR ' + message + '\n', () => process.exit(1));
});