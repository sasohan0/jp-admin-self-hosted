const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_RETRY_ATTEMPTS,
  REMOTE_COMPLETION_GRACE_MS,
  RETRY_DELAYS_MS,
  appsScriptGet,
  appsScriptPost,
  retryDelayFor,
} = require('./apps-script-api');

const cohort = {
  appsScriptUrl: 'https://script.google.com/macros/s/test/exec',
  apiKey: 'private-test-key',
};

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return body; },
  };
}

test('GET retries a transient HTML 404 and returns later JSON', async () => {
  const replies = [
    response(404, '<!DOCTYPE html><title>Not found</title>'),
    response(200, JSON.stringify({ version: 'v35', ok: true })),
  ];
  let calls = 0;
  const data = await appsScriptGet(cohort, { action: 'health' }, {
    fetchImpl: async () => replies[calls++],
    sleepImpl: async () => {},
    label: 'Health check',
  });
  assert.equal(calls, 2);
  assert.equal(data.version, 'v35');
});

test('GET does not retry a JSON application error', async () => {
  let calls = 0;
  await assert.rejects(
    appsScriptGet(cohort, { action: 'health' }, {
      fetchImpl: async () => { calls++; return response(200, JSON.stringify({ error: 'unknown action' })); },
      sleepImpl: async () => {},
      label: 'Health check',
    }),
    /unknown action/,
  );
  assert.equal(calls, 1);
});

test('safe requests confirm one isolated authorization rejection', async () => {
  const replies = [
    response(200, JSON.stringify({ error: 'unauthorized' })),
    response(200, JSON.stringify({ ok: true })),
  ];
  const delays = [];
  let calls = 0;
  const result = await appsScriptPost(cohort, { action: 'logOutreach', messageId: '123' }, {
    idempotent: true,
    fetchImpl: async () => replies[calls++],
    sleepImpl: async delay => { delays.push(delay); },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [RETRY_DELAYS_MS[0]]);
});

test('safe request can recover after several stale-deployment authorization rejections', async () => {
  let calls = 0;
  const result = await appsScriptGet(cohort, { action: 'health' }, {
    fetchImpl: async () => {
      calls++;
      return calls < 4
        ? response(200, JSON.stringify({ error: 'unauthorized' }))
        : response(200, JSON.stringify({ ok: true }));
    },
    sleepImpl: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 4);
});

test('persistent authorization rejection remains bounded', async () => {
  let calls = 0;
  await assert.rejects(
    appsScriptGet(cohort, { action: 'health' }, {
      fetchImpl: async () => { calls++; return response(200, JSON.stringify({ error: 'unauthorized' })); },
      sleepImpl: async () => {},
    }),
    /unauthorized.*after 5 attempts/,
  );
  assert.equal(calls, DEFAULT_RETRY_ATTEMPTS);
});

test('idempotent writes retry transient Apps Script lock errors with a completion grace', async () => {
  const replies = [
    response(200, JSON.stringify({ error: 'AppsScript: Exception: Lock timeout: another process was holding the lock for too long.' })),
    response(200, JSON.stringify({ saved: 1 })),
  ];
  const delays = [];
  let calls = 0;
  const result = await appsScriptPost(cohort, { action: 'backfillOutreachDaily' }, {
    idempotent: true,
    fetchImpl: async () => replies[calls++],
    sleepImpl: async delay => { delays.push(delay); },
  });
  assert.equal(result.saved, 1);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [REMOTE_COMPLETION_GRACE_MS]);
});

test('non-idempotent writes never retry an Apps Script lock error', async () => {
  let calls = 0;
  await assert.rejects(
    appsScriptPost(cohort, { action: 'createForms' }, {
      fetchImpl: async () => {
        calls++;
        return response(200, JSON.stringify({ error: 'AppsScript: Exception: Lock timeout' }));
      },
      sleepImpl: async () => {},
    }),
    /Lock timeout/,
  );
  assert.equal(calls, 1);
});

test('timeout retries wait for the remote Apps Script execution to finish', () => {
  const error = new Error('timed out');
  error.name = 'TimeoutError';
  assert.equal(retryDelayFor(error, 1), REMOTE_COMPLETION_GRACE_MS);
});

test('POST retries only when explicitly marked idempotent', async () => {
  let normalCalls = 0;
  await assert.rejects(
    appsScriptPost(cohort, { action: 'createForms' }, {
      fetchImpl: async () => { normalCalls++; return response(503, '<html>busy</html>'); },
      sleepImpl: async () => {},
    }),
    /HTTP 503/,
  );
  assert.equal(normalCalls, 1);

  let safeCalls = 0;
  const result = await appsScriptPost(cohort, { action: 'setState' }, {
    idempotent: true,
    fetchImpl: async () => ++safeCalls === 1
      ? response(503, '<html>busy</html>')
      : response(200, JSON.stringify({ ok: true })),
    sleepImpl: async () => {},
  });
  assert.equal(safeCalls, 2);
  assert.equal(result.ok, true);
});

test('idempotent requests use five paced cache-busted attempts for transient HTML 404s', async () => {
  const urls = [];
  const delays = [];
  let caught;
  try {
    await appsScriptPost(cohort, { action: 'syncDiscordRoster' }, {
      idempotent: true,
      fetchImpl: async url => {
        urls.push(new URL(url));
        return response(404, '<!DOCTYPE html><title>temporary edge miss</title>');
      },
      sleepImpl: async delay => { delays.push(delay); },
      label: 'Roster write',
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(urls.length, DEFAULT_RETRY_ATTEMPTS);
  assert.deepEqual(delays, RETRY_DELAYS_MS);
  assert.equal(urls[0].searchParams.has('_jpAttempt'), false);
  assert.equal(urls[1].searchParams.get('_jpAttempt'), '2');
  assert.equal(urls[4].searchParams.get('_jpAttempt'), '5');
  assert.equal(caught.transient, true);
  assert.equal(caught.attempts, DEFAULT_RETRY_ATTEMPTS);
  assert.match(caught.message, /after 5 attempts/);
});

test('mutating requests for one cohort are serialized instead of competing for the Apps Script lock', async () => {
  let releaseFirst;
  let calls = 0;
  const firstMayFinish = new Promise(resolve => { releaseFirst = resolve; });
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) await firstMayFinish;
    return response(200, JSON.stringify({ ok: true, call: calls }));
  };

  const first = appsScriptPost(cohort, { action: 'syncDiscordRoster' }, { fetchImpl });
  const second = appsScriptPost(cohort, { action: 'backfillInterviews' }, { fetchImpl });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'second write must wait for the first write');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test('attendance GET shares the same serialized mutation lane', async () => {
  let releaseFirst;
  let calls = 0;
  const firstMayFinish = new Promise(resolve => { releaseFirst = resolve; });
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) await firstMayFinish;
    return response(200, JSON.stringify({ ok: true }));
  };
  const write = appsScriptPost(cohort, { action: 'syncDiscordRoster' }, { fetchImpl });
  const attendance = appsScriptGet(cohort, { action: 'attendance' }, { fetchImpl });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([write, attendance]);
  assert.equal(calls, 2);
});
