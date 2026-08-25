// ============================================================
//  keepalive.js - tiny HTTP server so Render's free tier
//  never sleeps the bot. Uses Node's built-in http module
//  (no express) to keep RAM near zero.
//
//  In index.js:
//    const { startKeepAlive } = require('./keepalive');
//    startKeepAlive();
//
//  Then point a free UptimeRobot monitor (HTTP, 5-minute
//  interval) at your Render URL: https://<app>.onrender.com/
// ============================================================

const http = require('http');

let appHandler = null;

function setAppHandler(handler) {
  appHandler = typeof handler === 'function' ? handler : null;
}

function startKeepAlive(port = process.env.PORT || 3000) {
  const server = http.createServer(async (req, res) => {
    // Uptime monitors append cache-busting query parameters. Match the path,
    // not the raw URL, so /?uptime=... and /health?ts=... remain healthy.
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
    catch { pathname = req.url || ''; }
    if (pathname === '/' || pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK ' + new Date().toISOString());
      return;
    }
    try {
      if (appHandler && await appHandler(req, res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Not found');
    } catch (error) {
      console.error('[http] Request failed:', error.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      if (!res.writableEnded) res.end('Request failed');
    }
  });

  // Render only routes public traffic to services listening on 0.0.0.0.
  server.listen(port, '0.0.0.0', () => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : port;
    console.log(`[keepalive] HTTP server on 0.0.0.0:${listeningPort}`);
  });

  return server;
}

module.exports = { setAppHandler, startKeepAlive };
