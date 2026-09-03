const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { setAppHandler, setHealthProvider, startKeepAlive } = require('./keepalive');

test('health server binds to all interfaces and returns OK', async (t) => {
  const server = startKeepAlive(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  assert.equal(address.address, '0.0.0.0');

  const response = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${address.port}/`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    }).on('error', reject);
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /^ALIVE \d{4}-\d{2}-\d{2}T/);
});

test('health server accepts uptime cache-busting query parameters', async (t) => {
  const server = startKeepAlive(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));

  for (const path of ['/?uptime=apps-script&ts=123', '/health?ts=123']) {
    const status = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${server.address().port}${path}`, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert.equal(status, 200);
  }
});

test('readiness health returns 503 while Discord is expected but unavailable', async (t) => {
  setHealthProvider(() => ({ ok: false, status: 'running', discord: { expectedOnline: true, ready: false } }));
  const server = startKeepAlive(0);
  t.after(() => {
    setHealthProvider(null);
    return new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.once('listening', resolve));
  const response = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/health`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
  assert.equal(response.status, 503);
  assert.equal(response.body.discord.ready, false);
});

test('health server delegates non-health routes to the configured app handler', async (t) => {
  setAppHandler(async (req, res) => {
    if (req.url !== '/intake/test') return false;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('portal');
    return true;
  });
  const server = startKeepAlive(0);
  t.after(() => {
    setAppHandler(null);
    return new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.once('listening', resolve));
  const response = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/intake/test`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.deepEqual(response, { status: 200, body: 'portal' });
});
