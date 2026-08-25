const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  buildAuthorizationUrl,
  allowRequest,
  createIntakePortalHandler,
  createOAuthState,
  escapeHtml,
  verifyOAuthState,
} = require('./intake-portal');
const {
  MINIMUM_INTAKE_BACKEND_VERSION,
  backendVersionNumber,
  normalizeSettings,
  portalConfigProblems,
  slugify,
  stateKey,
} = require('./intake-settings');

async function invoke(handler, { method = 'GET', url = '/', cookie = '', body = '' } = {}) {
  const req = new EventEmitter();
  Object.assign(req, {
    method, url, headers: cookie ? { cookie } : {}, socket: { remoteAddress: '127.0.0.1' },
    destroy() {},
  });
  const result = { status: 0, headers: {}, body: '' };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers || {};
      this.headersSent = true;
    },
    end(value = '') {
      result.body += String(value);
      this.writableEnded = true;
    },
  };
  const pending = handler(req, res);
  if (method === 'POST') {
    setTimeout(() => {
      if (body) req.emit('data', Buffer.from(body));
      req.emit('end');
    }, 0);
  }
  assert.equal(await pending, true);
  return result;
}

const env = {
  DISCORD_TOKEN: 'test-bot-token',
  DISCORD_CLIENT_ID: '1527624641760465007',
  DISCORD_CLIENT_SECRET: 'test-client-secret',
  INTAKE_SESSION_SECRET: 'a'.repeat(48),
  INTAKE_PUBLIC_URL: 'https://jp-admin-stride.onrender.com',
};

test('OAuth state is signed, expiring, and cohort-bound', () => {
  const now = 1_800_000_000_000;
  const token = createOAuthState('stride-2026', env.INTAKE_SESSION_SECRET, now);
  assert.equal(verifyOAuthState(token, env.INTAKE_SESSION_SECRET, now + 1000).slug, 'stride-2026');
  assert.equal(verifyOAuthState(`${token}x`, env.INTAKE_SESSION_SECRET, now + 1000), null);
  assert.equal(verifyOAuthState(token, env.INTAKE_SESSION_SECRET, now + 11 * 60 * 1000), null);
});

test('Discord authorization requests identify and guilds.join with the exact callback', () => {
  const url = new URL(buildAuthorizationUrl('stride-2026', env));
  assert.equal(url.origin, 'https://discord.com');
  assert.equal(url.searchParams.get('client_id'), env.DISCORD_CLIENT_ID);
  assert.equal(url.searchParams.get('scope'), 'identify guilds.join');
  assert.equal(url.searchParams.get('redirect_uri'), `${env.INTAKE_PUBLIC_URL}/intake/oauth/callback`);
});

test('intake settings are guild-namespaced and environment validation is secret-safe', () => {
  const cohort = { guildId: '1527624228830969967', registryKey: 'stride', name: 'STRIDE' };
  assert.equal(stateKey(cohort), 'intake_portal_v1_1527624228830969967');
  assert.deepEqual(normalizeSettings(cohort, { enabled: true, slug: 'STRIDE 2026' }), {
    enabled: true, slug: 'stride-2026',
  });
  assert.equal(slugify(' EJP 14 / Night '), 'ejp-14-night');
  assert.deepEqual(portalConfigProblems(env), []);
  assert.ok(portalConfigProblems({}).length >= 4);
});

test('intake backend compatibility accepts current versions without allowing pre-intake backends', () => {
  assert.equal(MINIMUM_INTAKE_BACKEND_VERSION, 36);
  assert.equal(backendVersionNumber('v36'), 36);
  assert.equal(backendVersionNumber('v54'), 54);
  assert.equal(backendVersionNumber('old'), null);
  assert.ok(backendVersionNumber('v54') >= MINIMUM_INTAKE_BACKEND_VERSION);
  assert.ok(backendVersionNumber('v35') < MINIMUM_INTAKE_BACKEND_VERSION);
});

test('portal output escapes student and template HTML', () => {
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});

test('intake request limiter allows a bounded number of attempts per window', () => {
  const key = `test:${Date.now()}:${Math.random()}`;
  assert.equal(allowRequest(key, 2, 1000, 100), true);
  assert.equal(allowRequest(key, 2, 1000, 101), true);
  assert.equal(allowRequest(key, 2, 1000, 102), false);
  assert.equal(allowRequest(key, 2, 1000, 1101), true);
});

test('full portal flow stores structured intake before admission and activates afterward', async () => {
  const calls = [];
  const cohort = {
    name: 'TEST', guildId: '1527624228830969967',
    appsScriptUrl: 'https://example.invalid/exec', apiKey: 'private-test-key',
  };
  const fields = [
    ['name', 'Your Name', 'text'], ['enrollmentEmail', 'Email', 'email'],
    ['phone', 'Phone', 'text'], ['region', 'Region', 'text'],
    ['subregion', 'Area', 'text'],
  ].map(([key, title, type]) => ({ key, title, type, required: true }));
  const handler = createIntakePortalHandler({
    env,
    resolveEnabledCohort: async slug => slug === 'test' ? {
      cohort, settings: { enabled: true, slug: 'test' },
    } : null,
    loadTemplatePair: async () => ({ enrollment: { fields } }),
    exchangeDiscordCode: async () => 'short-lived-user-token',
    fetchDiscordUser: async () => ({ id: '785818245977735169', username: 'student', global_name: 'Student Name' }),
    addGuildMember: async () => { calls.push('admit'); return { added: true, alreadyMember: false }; },
    backendPost: async (_cohort, payload) => {
      calls.push(payload.action);
      return payload.action === 'submitStudentProfile' ? { saved: true } : { saved: true };
    },
  });

  const start = await invoke(handler, { url: '/intake/test/start' });
  const state = new URL(start.headers.Location).searchParams.get('state');
  const callback = await invoke(handler, { url: `/intake/oauth/callback?code=one-time&state=${encodeURIComponent(state)}` });
  const cookie = callback.headers['Set-Cookie'].split(';')[0];
  const form = await invoke(handler, { url: '/intake/test/form', cookie });
  const csrf = form.body.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const params = new URLSearchParams({
    csrf, consent: 'yes', name: 'Student Name', enrollmentemail: 'student@example.com',
    phone: '+8801700000000', region: 'Dhaka', subregion: 'Mirpur',
  });
  const submitted = await invoke(handler, {
    method: 'POST', url: '/intake/test/submit', cookie, body: params.toString(),
  });
  assert.equal(submitted.status, 200, submitted.body);
  assert.deepEqual(calls, [
    'submitIntakeApplication', 'admit', 'submitStudentProfile', 'updateIntakeApplicationStatus',
  ]);
});

test('intake backend transport allows slow idempotent Sheet writes', () => {
  const source = require('node:fs').readFileSync(require.resolve('./intake-portal'), 'utf8');
  assert.match(source, /const BACKEND_REQUEST_TIMEOUT_MS = 90000/);
  assert.match(source, /appsScriptPost\(cohort, payload, \{/);
  assert.match(source, /idempotent: true/);
  assert.match(source, /attempts: 2/);
  assert.match(source, /timeoutMs: BACKEND_REQUEST_TIMEOUT_MS/);
});

test('supervisor intake tests are stored without creating student tracking rows', async () => {
  const calls = [];
  const supervisorId = '688079587728556043';
  const cohort = {
    name: 'TEST', guildId: '1527624228830969967', supervisorIds: [supervisorId],
    appsScriptUrl: 'https://example.invalid/exec', apiKey: 'private-test-key',
  };
  const fields = [
    ['name', 'Your Name', 'text'], ['enrollmentEmail', 'Email', 'email'],
    ['phone', 'Phone', 'text'], ['region', 'Region', 'text'],
    ['subregion', 'Area', 'text'],
  ].map(([key, title, type]) => ({ key, title, type, required: true }));
  const handler = createIntakePortalHandler({
    env,
    resolveEnabledCohort: async slug => slug === 'test' ? {
      cohort, settings: { enabled: true, slug: 'test' },
    } : null,
    loadTemplatePair: async () => ({ enrollment: { fields } }),
    exchangeDiscordCode: async () => 'short-lived-user-token',
    fetchDiscordUser: async () => ({ id: supervisorId, username: 'supervisor', global_name: 'Supervisor' }),
    addGuildMember: async () => { calls.push({ action: 'admit' }); return { added: false, alreadyMember: true }; },
    backendPost: async (_cohort, payload) => {
      calls.push(payload);
      return { saved: true };
    },
  });

  const start = await invoke(handler, { url: '/intake/test/start' });
  const state = new URL(start.headers.Location).searchParams.get('state');
  const callback = await invoke(handler, { url: `/intake/oauth/callback?code=one-time&state=${encodeURIComponent(state)}` });
  const cookie = callback.headers['Set-Cookie'].split(';')[0];
  const form = await invoke(handler, { url: '/intake/test/form', cookie });
  const csrf = form.body.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const params = new URLSearchParams({
    csrf, consent: 'yes', name: 'Supervisor', enrollmentemail: 'supervisor@example.com',
    phone: '+8801700000000', region: 'Dhaka', subregion: 'Mirpur',
  });
  const submitted = await invoke(handler, {
    method: 'POST', url: '/intake/test/submit', cookie, body: params.toString(),
  });

  assert.equal(submitted.status, 200, submitted.body);
  assert.deepEqual(calls.map(call => call.action), [
    'submitIntakeApplication', 'admit', 'updateIntakeApplicationStatus',
  ]);
  assert.equal(calls[2].status, 'SUPERVISOR TEST - STORED, NOT TRACKED');
  assert.match(submitted.body, /without creating an active student tracking profile/);
});
