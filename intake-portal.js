// Cohort-aware pre-entry enrollment portal. Discord OAuth supplies immutable
// identity; Apps Script stores the structured application before Discord access.

const crypto = require('node:crypto');
const { appsScriptPost } = require('./apps-script-api');
const { loadTemplatePair } = require('./cohort-admin');
const { portalFieldsFromTemplate, validateIntakeSubmission } = require('./intake-schema');
const {
  portalBaseUrl,
  portalConfigProblems,
  resolveEnabledCohort,
} = require('./intake-settings');

const SESSION_COOKIE = 'jp_intake';
const SESSION_TTL_MS = 30 * 60 * 1000;
const DISCORD_REQUEST_TIMEOUT_MS = 20000;
// Intake writes may wait behind another student's Apps Script lock and then
// synchronize several Sheet tabs. Twenty seconds caused false failures during
// live arrival bursts even though Google continued processing the request.
const BACKEND_REQUEST_TIMEOUT_MS = 90000;
const MAX_BODY_BYTES = 64 * 1024;
const TEMPLATE_CACHE_MS = 2 * 60 * 1000;
const sessions = new Map();
const requestLimits = new Map();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createOAuthState(slug, secret, now = Date.now()) {
  const payload = base64url(JSON.stringify({
    slug,
    exp: now + 10 * 60 * 1000,
    nonce: crypto.randomBytes(16).toString('hex'),
  }));
  return `${payload}.${sign(payload, secret)}`;
}

function verifyOAuthState(token, secret, now = Date.now()) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra) return null;
  const expected = sign(payload, secret);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.slug || !data.exp || now > Number(data.exp)) return null;
    return data;
  } catch {
    return null;
  }
}

function buildAuthorizationUrl(slug, env = process.env) {
  const redirectUri = `${portalBaseUrl(env)}/intake/oauth/callback`;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify guilds.join');
  url.searchParams.set('state', createOAuthState(slug, env.INTAKE_SESSION_SECRET));
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#111318;--card:#1b1e25;--line:#343944;--text:#f2f3f5;--muted:#b5bac1;--brand:#5865f2;--danger:#ed4245;--ok:#23a55a}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#20243a,var(--bg) 42%);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(900px,100%);margin:auto;padding:32px 18px 70px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:clamp(20px,4vw,42px);box-shadow:0 20px 60px #0007}
h1{margin:0 0 8px;font-size:clamp(28px,5vw,44px)}h2{margin-top:34px}.muted,.help{color:var(--muted)}.identity{margin:24px 0;padding:16px;border-radius:12px;background:#111318;border:1px solid var(--line)}
.field{margin:24px 0}.field>label,.legend{font-weight:700;display:block;margin-bottom:8px}.required{color:#ff7b7e}input,textarea,select{width:100%;border:1px solid #4b5260;border-radius:9px;background:#111318;color:var(--text);padding:12px 13px;font:inherit}textarea{min-height:120px;resize:vertical}
.option{display:flex;gap:10px;align-items:flex-start;margin:9px 0;padding:10px;border:1px solid var(--line);border-radius:9px}.option input{width:auto;margin-top:4px}.other{margin-top:9px}.help{font-size:14px;margin-top:6px}
button,.button{display:inline-block;border:0;border-radius:9px;background:var(--brand);color:#fff;font-weight:700;padding:13px 20px;text-decoration:none;cursor:pointer}.submit{width:100%;font-size:17px;margin-top:22px}.errors{background:#3b1d20;border:1px solid var(--danger);border-radius:10px;padding:14px}.success{background:#153824;border:1px solid var(--ok);border-radius:10px;padding:18px}
footer{color:var(--muted);font-size:13px;margin-top:24px;text-align:center}@media(max-width:560px){main{padding:12px 8px 40px}.card{border-radius:12px;padding:20px 14px}}
</style></head><body><main>${body}<footer>JP ADMIN secure cohort intake · Never enter your Discord password in this form.</footer></main></body></html>`;
}

function renderLanding(cohort, settings, env) {
  return page(`${cohort.name} intake`, `<section class="card">
    <div class="muted">JP ADMIN · ${escapeHtml(cohort.name)}</div>
    <h1>Bootcamp intake</h1>
    <p>Complete the enrollment form before entering the Discord server. Discord sign-in attaches your correct account automatically; your password is handled only by Discord.</p>
    <p><a class="button" href="${escapeHtml(`${portalBaseUrl(env)}/intake/${settings.slug}/start`)}">Continue with Discord</a></p>
    <p class="help">Your enrollment email, phone number, location and placement information are stored privately in the cohort Google Sheet.</p>
  </section>`);
}

function renderField(field, previous = new URLSearchParams()) {
  const required = field.required ? ' <span class="required">*</span>' : '';
  const help = field.help ? `<div class="help">${escapeHtml(field.help)}</div>` : '';
  const common = `name="${escapeHtml(field.id)}"${field.required ? ' required' : ''}`;
  let control = '';
  if (field.type === 'paragraph') {
    control = `<textarea ${common}>${escapeHtml(previous.get(field.id) || '')}</textarea>`;
  } else if (field.type === 'choice' || field.type === 'checkbox') {
    const inputType = field.type === 'checkbox' ? 'checkbox' : 'radio';
    const selected = new Set(previous.getAll(field.id));
    control = field.choices.map((choice, index) => {
      const required = field.required && inputType === 'radio' ? ' required' : '';
      return `<label class="option"><input type="${inputType}" name="${escapeHtml(field.id)}"${required} value="${escapeHtml(choice)}"${selected.has(choice) ? ' checked' : ''}><span>${escapeHtml(choice)}</span></label>`;
    }).join('');
    if (field.other) {
      control += `<label class="option"><input type="${inputType}" name="${escapeHtml(field.id)}" value="__other__"${selected.has('__other__') ? ' checked' : ''}><span>Other</span></label>` +
        `<input class="other" name="${escapeHtml(field.id)}__other" placeholder="Please specify" value="${escapeHtml(previous.get(`${field.id}__other`) || '')}">`;
    }
  } else if (field.type === 'scale') {
    const options = [];
    for (let score = field.min; score <= field.max; score++) {
      options.push(`<option value="${score}"${previous.get(field.id) === String(score) ? ' selected' : ''}>${score}</option>`);
    }
    control = `<select ${common}><option value="">Choose a score</option>${options.join('')}</select><div class="help">${escapeHtml(field.lowLabel || field.min)} → ${escapeHtml(field.highLabel || field.max)}</div>`;
  } else {
    const type = ['email', 'date', 'time'].includes(field.type) ? field.type : 'text';
    control = `<input type="${type}" ${common} value="${escapeHtml(previous.get(field.id) || '')}">`;
  }
  return `<div class="field"><label>${escapeHtml(field.title)}${required}</label>${control}${help}</div>`;
}

function renderForm(cohort, session, fields, csrf, errors = [], previous = new URLSearchParams(), env = process.env) {
  const errorBlock = errors.length
    ? `<div class="errors"><strong>Please correct the following:</strong><ul>${errors.map(error => `<li>${escapeHtml(error)}</li>`).join('')}</ul></div>`
    : '';
  return page(`${cohort.name} enrollment`, `<section class="card">
    <div class="muted">JP ADMIN · ${escapeHtml(cohort.name)}</div><h1>Bootcamp data collection</h1>
    <p>Complete every required field accurately. This replaces the enrollment Google Form.</p>
    <div class="identity"><strong>Discord account</strong><br>${escapeHtml(session.user.global_name || session.user.username)} · @${escapeHtml(session.user.username)}<br><span class="help">Discord ID: ${escapeHtml(session.user.id)}</span></div>
    ${errorBlock}
    <form method="post" action="${escapeHtml(`${portalBaseUrl(env)}/intake/${session.slug}/submit`)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      ${fields.map(field => renderField(field, previous)).join('')}
      <label class="option"><input type="checkbox" name="consent" value="yes" required><span>I confirm the information is accurate and may be used for bootcamp operations, attendance and placement support.</span></label>
      <button class="submit" type="submit">Submit and enter Discord</button>
    </form>
  </section>`);
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https://cdn.discordapp.com data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(html);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return '';
}

function sessionCookie(id, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  return `${SESSION_COOKIE}=${encodeURIComponent(id)}; Path=/intake; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function pruneSessions(now = Date.now()) {
  for (const [id, session] of sessions) if (now > session.expires) sessions.delete(id);
  for (const [key, item] of requestLimits) if (now > item.resetAt) requestLimits.delete(key);
}

function requestIdentity(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim().slice(0, 80);
}

function allowRequest(key, limit, windowMs, now = Date.now()) {
  const current = requestLimits.get(key);
  if (!current || now > current.resetAt) {
    requestLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('The submitted form is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

async function backendPost(cohort, payload) {
  return appsScriptPost(cohort, payload, {
    idempotent: true,
    attempts: 2,
    timeoutMs: BACKEND_REQUEST_TIMEOUT_MS,
    label: 'Cohort intake',
  });
}

async function exchangeDiscordCode(code, env) {
  const redirectUri = `${portalBaseUrl(env)}/intake/oauth/callback`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
  });
  const response = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error('Discord authorization could not be completed');
  return data.access_token;
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const user = await response.json().catch(() => ({}));
  if (!response.ok || !/^\d{15,22}$/.test(String(user.id || ''))) {
    throw new Error('Discord identity could not be verified');
  }
  return user;
}

async function addGuildMember(cohort, user, accessToken, env) {
  const response = await fetch(`https://discord.com/api/v10/guilds/${cohort.guildId}/members/${user.id}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (![201, 204].includes(response.status)) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`Discord server admission failed${data.message ? `: ${String(data.message).slice(0, 160)}` : ''}`);
  }
  return { added: response.status === 201, alreadyMember: response.status === 204 };
}

function submissionPayload(cohort, session, result) {
  return {
    action: 'submitIntakeApplication',
    submissionId: session.submissionId,
    cohort: cohort.name,
    guildId: cohort.guildId,
    discordId: session.user.id,
    username: session.user.username,
    globalName: session.user.global_name || '',
    displayName: session.user.global_name || session.user.username,
    answers: result.answers,
    profile: result.profile,
  };
}

function createIntakePortalHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const resolveCohort = dependencies.resolveEnabledCohort || resolveEnabledCohort;
  const loadTemplate = dependencies.loadTemplatePair || loadTemplatePair;
  const postBackend = dependencies.backendPost || backendPost;
  const exchangeCode = dependencies.exchangeDiscordCode || exchangeDiscordCode;
  const getUser = dependencies.fetchDiscordUser || fetchDiscordUser;
  const addMember = dependencies.addGuildMember || addGuildMember;
  const templateCache = new Map();

  async function getPortalTemplate(cohort) {
    const cached = templateCache.get(cohort.guildId);
    if (cached && Date.now() - cached.at < TEMPLATE_CACHE_MS) return cached.value;
    const value = await loadTemplate(cohort);
    templateCache.set(cohort.guildId, { at: Date.now(), value });
    return value;
  }

  return async function intakePortalHandler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/intake')) return false;
    pruneSessions();
    const problems = portalConfigProblems(env);
    if (problems.length) {
      sendHtml(res, 503, page('Intake unavailable', `<section class="card"><h1>Intake portal is not configured</h1><p>A mentor must finish the secure portal setup.</p></section>`));
      return true;
    }

    if (url.pathname === '/intake/oauth/callback' && req.method === 'GET') {
      const state = verifyOAuthState(url.searchParams.get('state'), env.INTAKE_SESSION_SECRET);
      if (!state || !url.searchParams.get('code')) {
        sendHtml(res, 400, page('Invalid authorization', `<section class="card"><h1>Authorization expired</h1><p>Return to your cohort intake link and try again.</p></section>`));
        return true;
      }
      const resolved = await resolveCohort(state.slug);
      if (!resolved) {
        sendHtml(res, 404, page('Intake closed', `<section class="card"><h1>This cohort intake is closed</h1></section>`));
        return true;
      }
      try {
        const accessToken = await exchangeCode(url.searchParams.get('code'), env);
        const user = await getUser(accessToken);
        const id = crypto.randomBytes(32).toString('hex');
        sessions.set(id, {
          accessToken,
          csrf: crypto.randomBytes(24).toString('hex'),
          expires: Date.now() + SESSION_TTL_MS,
          slug: resolved.settings.slug,
          guildId: resolved.cohort.guildId,
          submissionId: crypto.randomUUID(),
          user,
        });
        redirect(res, `${portalBaseUrl(env)}/intake/${resolved.settings.slug}/form`, {
          'Set-Cookie': sessionCookie(id),
        });
      } catch (error) {
        sendHtml(res, 502, page('Discord authorization failed', `<section class="card"><h1>Could not verify Discord</h1><p>${escapeHtml(error.message)}</p></section>`));
      }
      return true;
    }

    const match = url.pathname.match(/^\/intake\/([a-z0-9-]+)(?:\/(start|form|submit))?$/);
    if (!match) {
      sendHtml(res, 404, page('Not found', `<section class="card"><h1>Intake link not found</h1><p>Use the link provided by your bootcamp mentor.</p></section>`));
      return true;
    }
    const resolved = await resolveCohort(match[1]);
    if (!resolved) {
      sendHtml(res, 404, page('Intake closed', `<section class="card"><h1>This cohort intake is closed</h1></section>`));
      return true;
    }
    const { cohort, settings } = resolved;
    const action = match[2] || 'landing';
    if (action === 'landing' && req.method === 'GET') {
      sendHtml(res, 200, renderLanding(cohort, settings, env));
      return true;
    }
    if (action === 'start' && req.method === 'GET') {
      if (!allowRequest(`start:${requestIdentity(req)}`, 20, 10 * 60 * 1000)) {
        sendHtml(res, 429, page('Please wait', `<section class="card"><h1>Too many attempts</h1><p>Wait a few minutes, then use the intake link again.</p></section>`), { 'Retry-After': '600' });
        return true;
      }
      redirect(res, buildAuthorizationUrl(settings.slug, env));
      return true;
    }

    const sessionId = cookieValue(req, SESSION_COOKIE);
    const session = sessions.get(sessionId);
    if (!session || session.expires < Date.now() || session.guildId !== cohort.guildId || session.slug !== settings.slug) {
      redirect(res, `${portalBaseUrl(env)}/intake/${settings.slug}`,
        { 'Set-Cookie': sessionCookie('', 0) });
      return true;
    }
    const template = await getPortalTemplate(cohort);
    const fields = portalFieldsFromTemplate(template);
    if (action === 'form' && req.method === 'GET') {
      sendHtml(res, 200, renderForm(cohort, session, fields, session.csrf, [], new URLSearchParams(), env));
      return true;
    }
    if (action === 'submit' && req.method === 'POST') {
      if (!allowRequest(`submit:${session.user.id}`, 6, 15 * 60 * 1000)) {
        sendHtml(res, 429, page('Please wait', `<section class="card"><h1>Too many submissions</h1><p>Your earlier response may already have been saved. Wait 15 minutes or contact your mentor.</p></section>`), { 'Retry-After': '900' });
        return true;
      }
      let params;
      try { params = await readBody(req); }
      catch (error) {
        sendHtml(res, 413, page('Form too large', `<section class="card"><h1>Submission rejected</h1><p>${escapeHtml(error.message)}</p></section>`));
        return true;
      }
      const result = validateIntakeSubmission(fields, params);
      if (params.get('csrf') !== session.csrf) result.errors.unshift('Your form session expired. Please restart the intake.');
      if (params.get('consent') !== 'yes') result.errors.push('You must confirm the information is accurate.');
      if (result.errors.length) {
        sendHtml(res, 400, renderForm(cohort, session, fields, session.csrf, result.errors, params, env));
        return true;
      }
      try {
        await postBackend(cohort, submissionPayload(cohort, session, result));
        const admission = await addMember(cohort, session.user, session.accessToken, env);
        const supervisorTest = (cohort.supervisorIds || []).map(String).includes(String(session.user.id));
        if (!supervisorTest) {
          const activation = await postBackend(cohort, {
            action: 'submitStudentProfile',
            guildId: cohort.guildId,
            discordId: session.user.id,
            username: session.user.username,
            displayName: session.user.global_name || session.user.username,
            fields: result.profile,
            onboarding: result.onboarding,
          });
          if (!activation.saved) throw new Error('Discord access succeeded, but the tracking profile could not be activated');
        }
        await postBackend(cohort, {
          action: 'updateIntakeApplicationStatus',
          submissionId: session.submissionId,
          status: supervisorTest
            ? 'SUPERVISOR TEST - STORED, NOT TRACKED'
            : (admission.alreadyMember ? 'ALREADY MEMBER · SYNCHRONIZED' : 'ADMITTED · SYNCHRONIZED'),
          detail: '',
        }).catch(() => null);
        sessions.delete(sessionId);
        const supervisorNote = supervisorTest
          ? '<p>This supervisor test was stored without creating an active student tracking profile.</p>'
          : '<p>You can now open Discord and continue with the server rules and onboarding.</p>';
        sendHtml(res, 200, page('Enrollment complete', `<section class="card"><div class="success"><h1>Enrollment complete</h1><p>Your data was saved and your Discord account is linked to <strong>${escapeHtml(cohort.name)}</strong>.</p></div>${supervisorNote}<p><a class="button" href="https://discord.com/channels/${escapeHtml(cohort.guildId)}">Open Discord server</a></p></section>`), {
          'Set-Cookie': sessionCookie('', 0),
        });
      } catch (error) {
        await postBackend(cohort, {
          action: 'updateIntakeApplicationStatus',
          submissionId: session.submissionId,
          status: 'ACTION REQUIRED',
          detail: String(error.message || '').slice(0, 300),
        }).catch(() => null);
        sendHtml(res, 502, page('Enrollment needs attention', `<section class="card"><h1>Your answers were retained</h1><p>Automatic Discord admission or tracking synchronization could not finish. A mentor can retry safely using your Discord ID.</p><div class="errors">${escapeHtml(error.message)}</div></section>`));
      }
      return true;
    }
    sendHtml(res, 405, page('Method not allowed', `<section class="card"><h1>Method not allowed</h1></section>`), { Allow: 'GET, POST' });
    return true;
  };
}

module.exports = {
  buildAuthorizationUrl,
  createIntakePortalHandler,
  createOAuthState,
  escapeHtml,
  allowRequest,
  verifyOAuthState,
};
