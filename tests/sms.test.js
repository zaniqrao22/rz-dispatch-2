const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');

const { createSmsSender, normalizePhone, sms } = require('../backend/sms');

test('normalizePhone produces E.164-friendly values', () => {
  assert.equal(normalizePhone('+1 (415) 555-0100'), '+14155550100');
  assert.equal(normalizePhone('415-555-0100'), '+14155550100');
  assert.equal(normalizePhone('14155550100'), '+14155550100');
  assert.equal(normalizePhone('   '), '');
  assert.equal(normalizePhone('123'), '');
});

test('an unconfigured sender degrades to a dry run', async () => {
  const sender = createSmsSender({ provider: '', fetchImpl: () => { throw new Error('should not be called'); } });
  assert.equal(sender.enabled, false);
  const result = await sender.send('+14155550123', 'hello there');
  assert.equal(result.dryRun, true);
});

test('a configured Twilio sender posts the message with Basic auth', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 201, async json() { return { sid: 'SM123' }; } };
  };
  const sender = createSmsSender({
    provider: 'twilio',
    accountSid: 'ACxxxx',
    authToken: 'secret-token',
    from: '+14155550100',
    fetchImpl
  });

  assert.equal(sender.enabled, true);
  const result = await sender.send('415-555-0123', 'Your driver is on the way.');
  assert.equal(result.dryRun, false);
  assert.equal(result.sid, 'SM123');
  assert.match(captured.url, /\/Accounts\/ACxxxx\/Messages\.json$/);
  assert.equal(captured.options.method, 'POST');
  assert.match(captured.options.headers.Authorization, /^Basic /);
  const decoded = Buffer.from(captured.options.headers.Authorization.slice(6), 'base64').toString();
  assert.equal(decoded, 'ACxxxx:secret-token');
  const params = new URLSearchParams(captured.options.body);
  assert.equal(params.get('To'), '+14155550123');
  assert.equal(params.get('From'), '+14155550100');
  assert.equal(params.get('Body'), 'Your driver is on the way.');
});

test('a rejected provider response throws a descriptive error', async () => {
  const sender = createSmsSender({
    provider: 'twilio',
    accountSid: 'ACxxxx',
    authToken: 'tok',
    from: '+14155550100',
    fetchImpl: async () => ({ ok: false, status: 400, async text() { return 'bad number'; } })
  });
  await assert.rejects(() => sender.send('+14155550123', 'hi'), /rejected the message \(status 400\)/);
});

test('the shared sender reports unconfigured in this environment', () => {
  assert.equal(typeof sms.enabled, 'boolean');
});

test('the license status endpoint advertises SMS availability', async () => {
  const { app } = require('../backend/server');
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const body = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path: '/api/license/status' }, (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => resolve(data));
      });
      request.on('error', reject);
      request.end();
    });
    const payload = JSON.parse(body);
    assert.equal(payload.smsConfigured, sms.enabled);
    assert.equal(typeof payload.emailConfigured, 'boolean');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
