const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { app } = require('../backend/server');

const FRONTEND = path.join(__dirname, '..', 'frontend');

function startApp() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(server, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: server.address().port, method: 'GET', path: requestPath },
      (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: data }));
      }
    );
    request.on('error', reject);
    request.end();
  });
}

test('Terms of Service is served at /terms and /terms.html', async () => {
  const server = await startApp();
  try {
    for (const requestPath of ['/terms', '/terms.html']) {
      const response = await get(server, requestPath);
      assert.equal(response.status, 200, `${requestPath} should be served`);
      assert.match(response.body, /<h1>Terms of Service<\/h1>/i);
      assert.match(response.body, /Last updated:/i);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Privacy Policy is served at /privacy and /privacy.html', async () => {
  const server = await startApp();
  try {
    for (const requestPath of ['/privacy', '/privacy.html']) {
      const response = await get(server, requestPath);
      assert.equal(response.status, 200, `${requestPath} should be served`);
      assert.match(response.body, /<h1>Privacy Policy<\/h1>/i);
      assert.match(response.body, /Data we collect/i);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the app footer links to the legal pages', () => {
  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  assert.match(html, /href="\/terms"/);
  assert.match(html, /href="\/privacy"/);
});

test('the legal pages cross-link to each other', () => {
  const terms = fs.readFileSync(path.join(FRONTEND, 'terms.html'), 'utf8');
  const privacy = fs.readFileSync(path.join(FRONTEND, 'privacy.html'), 'utf8');
  assert.match(terms, /href="\/privacy"/);
  assert.match(privacy, /href="\/terms"/);
});
