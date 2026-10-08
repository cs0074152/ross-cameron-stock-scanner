const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { gunzipSync } = require('node:zlib');
const { createUIServer } = require('../scripts/serve-ui.cjs');

async function fixture(t, start = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-ui-test-'));
  const distRoot = path.join(directory, 'dist');
  await fs.mkdir(path.join(distRoot, 'assets'), { recursive: true });
  await fs.mkdir(path.join(distRoot, '.hidden'), { recursive: true });
  const asset = 'console.log("scanner asset");\n'.repeat(100);
  await Promise.all([
    fs.writeFile(path.join(distRoot, 'index.html'), '<html><head></head><body><div id="root"></div><script type="module" src="/assets/app-12345678.js"></script></body></html>'),
    fs.writeFile(path.join(distRoot, 'assets/app-12345678.js'), asset),
    fs.writeFile(path.join(distRoot, 'style.css'), 'body { color: black; }'),
    fs.writeFile(path.join(distRoot, '.env'), 'PRIVATE_TOKEN=should-not-be-served'),
    fs.writeFile(path.join(distRoot, '.hidden/secret.json'), '{"private":true}'),
    fs.writeFile(path.join(directory, 'outside.txt'), 'outside-build-directory')
  ]);
  const options = { distRoot, apiBase: 'http://127.0.0.1:43001', launchId: 'ui-test-launch', buildId: 'ui-test-build' };
  const ui = createUIServer(options);
  t.after(async () => {
    if (ui.server.listening) await ui.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const address = start ? await ui.start(0, '127.0.0.1') : null;
  return { ui, options, asset, request: (route, settings = {}) => request(address.port, route, settings) };
}

function request(port, route, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('production UI identifies its exact launch and build without caching the identity', async t => {
  const { request } = await fixture(t);
  const result = await request('/__scanner_launcher__');
  assert.equal(result.status, 200);
  assert.match(result.headers['content-type'], /^application\/json/);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(result.body), { service: 'ross-cameron-stock-scanner-frontend', launchId: 'ui-test-launch', buildId: 'ui-test-build', mode: 'production' });
  const head = await request('/__scanner_launcher__', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test('HTML injects the actual API and WebSocket addresses before loading the application', async t => {
  const { request } = await fixture(t);
  const result = await request('/');
  assert.equal(result.status, 200);
  assert.match(result.headers['content-type'], /^text\/html/);
  const html = result.body.toString();
  assert.equal(result.headers['cache-control'], 'no-store');
  const assignment = html.match(/globalThis\.__SCANNER_CONFIG__=(.*?);<\/script>/);
  assert.ok(assignment, 'runtime configuration is injected into the document');
  assert.deepEqual(JSON.parse(assignment[1]), { apiBase: 'http://127.0.0.1:43001', wsBase: 'ws://127.0.0.1:43001' });
  assert.ok(html.indexOf('__SCANNER_CONFIG__') < html.indexOf('src="/assets/app-12345678.js"'));
  const alias = await request('/index.html');
  assert.deepEqual(alias.body, result.body);
});

test('GET and HEAD serve assets with matching lengths, MIME types and immutable hashed assets', async t => {
  const { request, asset } = await fixture(t);
  const get = await request('/assets/app-12345678.js', { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(get.status, 200);
  assert.equal(get.body.toString(), asset);
  assert.match(get.headers['content-type'], /^text\/javascript/);
  assert.match(get.headers['cache-control'], /immutable/);
  const head = await request('/assets/app-12345678.js', { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.equal(head.headers.etag, get.headers.etag);
  const css = await request('/style.css');
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.doesNotMatch(css.headers['cache-control'], /immutable/);
});

test('conditional asset requests return 304 without a body', async t => {
  const { request } = await fixture(t);
  const first = await request('/assets/app-12345678.js');
  assert.ok(first.headers.etag);
  const cached = await request('/assets/app-12345678.js', { headers: { 'If-None-Match': `"unrelated", ${first.headers.etag}` } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  assert.equal(cached.headers.etag, first.headers.etag);
});

test('gzip assets decompress to the original contents and vary by encoding', async t => {
  const { request, asset } = await fixture(t);
  const result = await request('/assets/app-12345678.js', { headers: { 'Accept-Encoding': 'br, gzip;q=0.8' } });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.match(result.headers.vary, /Accept-Encoding/i);
  assert.equal(gunzipSync(result.body).toString(), asset);
  assert.equal(Number(result.headers['content-length']), result.body.length);
});

for (const accepted of ['gzip;q=0', 'gzip;q=0, *;q=1']) {
  test(`explicit gzip q=0 prevents compression for ${accepted}`, async t => {
    const { request, asset } = await fixture(t);
    const result = await request('/assets/app-12345678.js', { headers: { 'Accept-Encoding': accepted } });
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-encoding'], undefined);
    assert.equal(result.body.toString(), asset);
  });
}

test('missing assets, dotfiles and directory traversal never expose private files or return application HTML', async t => {
  const { request } = await fixture(t);
  for (const route of ['/assets/missing.js', '/.env', '/.hidden/secret.json', '/%2eenv', '/..%2foutside.txt', '/assets/..%2f..%2foutside.txt', '/assets/..%5c..%5coutside.txt']) {
    const result = await request(route);
    assert.equal(result.status, 404, route);
    assert.doesNotMatch(result.body.toString(), /PRIVATE_TOKEN|outside-build-directory|id="root"/);
  }
});

test('UI rejects methods that could mutate resources', async t => {
  const { request } = await fixture(t);
  const result = await request('/', { method: 'POST' });
  assert.equal(result.status, 405);
  assert.equal(result.headers.allow, 'GET, HEAD');
});

test('UI does not serve its local application under a remote Host header', async t => {
  const { request } = await fixture(t);
  const result = await request('/', { headers: { Host: 'remote.example:5173' } });
  assert.equal(result.status, 403);
  assert.doesNotMatch(result.body.toString(), /__SCANNER_CONFIG__|id="root"/);
});

test('UI rejects non-loopback bindings without starting a listener', async t => {
  const { ui } = await fixture(t, false);
  for (const host of ['0.0.0.0', '192.168.1.2', '::']) {
    await assert.rejects(ui.start(0, host), /本机/);
    assert.equal(ui.server.listening, false);
  }
});

test('UI rejects remote, credentialed or otherwise invalid API and WebSocket targets', async t => {
  const { options } = await fixture(t, false);
  for (const apiBase of ['http://example.com:3001', 'http://192.168.1.2:3001', 'https://127.0.0.1:3001', 'http://user:secret@127.0.0.1:3001', 'http://127.0.0.1:3001/api', 'http://127.0.0.1:3001/?other=1']) {
    assert.throws(() => createUIServer({ ...options, apiBase }), /本机/, apiBase);
  }
  for (const wsBase of ['ws://example.com:3001', 'wss://127.0.0.1:3001', 'ws://127.0.0.1:3001/path']) {
    assert.throws(() => createUIServer({ ...options, wsBase }), /本机/, wsBase);
  }
});
