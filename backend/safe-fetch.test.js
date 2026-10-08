const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSafeFetch, assertSafeUrl } = require('./safe-fetch');

test('URL validation blocks reserved hosts, credentials, alternate ports and protocol tricks', () => {
  for (const url of ['http://127.1/', 'http://2130706433/', 'http://10.0.0.1/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'https://a.local/',
    'ftp://stockanalysis.com/', 'https://user:pass@stockanalysis.com/',
    'https://stockanalysis.com:8443/', 'https://stockanalysis.com.attacker.invalid/']) {
    assert.throws(() => assertSafeUrl(url), /blocked/);
  }
  assert.equal(assertSafeUrl('https://STOCKANALYSIS.com/x'), 'https://stockanalysis.com/x');
});

test('every redirect is checked before network access; no cookie leakage on host change', async () => {
  const requests = [];
  const safe = createSafeFetch({ fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://query1.finance.yahoo.com/x' } }) : new Response('ok');
  }});
  await safe('https://stockanalysis.com/x', { headers: { Cookie: 'secret', Authorization: 'secret', Accept: 'application/json' } });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers.has('cookie'), false);
  assert.equal(requests[1].options.headers.has('authorization'), false);
  assert.equal(requests[1].options.headers.get('accept'), 'application/json');
  let attempts = 0;
  const bad = createSafeFetch({ fetchImpl: async () => { attempts++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }); } });
  await assert.rejects(bad('https://stockanalysis.com'), /blocked/);
  assert.equal(attempts, 1);
});

test('three redirects maximum and manual cookie/error modes retain their contracts', async () => {
  let attempts = 0;
  const safe = createSafeFetch({ fetchImpl: async () => { attempts++; return new Response(null, { status: 302, headers: { location: '/again', 'set-cookie': 'A=B' } }); } });
  await assert.rejects(safe('https://stockanalysis.com'), /too many redirects/);
  assert.equal(attempts, 4);
  assert.equal((await safe('https://fc.yahoo.com', { redirect: 'manual' })).headers.get('set-cookie'), 'A=B');
  await assert.rejects(safe('https://stockanalysis.com', { redirect: 'error' }), /redirect blocked/);
});

test('default deadline and caller cancellation both abort a stalled request', async () => {
  const hanging = async (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // AbortSignal timers are unref'ed; a short test timer keeps the process alive.
  const keepAlive = setTimeout(() => {}, 250);
  try {
    await assert.rejects(createSafeFetch({ fetchImpl: hanging, timeoutMs: 15 })('https://stockanalysis.com'), { name: 'TimeoutError' });
    const caller = new AbortController();
    const pending = createSafeFetch({ fetchImpl: hanging })('https://stockanalysis.com', { signal: caller.signal });
    caller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(createSafeFetch({ fetchImpl: hanging })('https://stockanalysis.com', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  } finally { clearTimeout(keepAlive); }
});

test('deadline stays active after response headers and cancels a hanging body', async () => {
  const safe = createSafeFetch({ timeoutMs: 15, fetchImpl: async (_, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); }
  })) });
  const keepAlive = setTimeout(() => {}, 250);
  try {
    const response = await safe('https://stockanalysis.com');
    await assert.rejects(response.text(), { name: 'TimeoutError' });
  } finally { clearTimeout(keepAlive); }
});
