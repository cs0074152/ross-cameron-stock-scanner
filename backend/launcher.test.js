const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { assertPortAvailable, findAvailablePort, readRunningInstance, readRunningBackend, root } = require('../scripts/launch.cjs');

async function savedInstance(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-launcher-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtimeFile = path.join(directory, 'launcher.json');
  const record = {
    root,
    backendPid: 11001,
    frontendPid: 11002,
    backendUrl: 'http://127.0.0.1:43001',
    frontendUrl: 'http://localhost:43002',
    launchId: 'test-scanner-launch',
    ...overrides
  };
  await fs.writeFile(runtimeFile, JSON.stringify(record));
  return { runtimeFile, record };
}

function healthyInstanceFetch(record, overrides = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    let body;
    if (String(url) === `${record.backendUrl}/api/health`) {
      body = { status: 'ok', service: 'ross-cameron-stock-scanner', launchId: record.launchId, ...overrides.backend };
    } else if (String(url) === `${record.frontendUrl}/__scanner_launcher__`) {
      body = { service: 'ross-cameron-stock-scanner-frontend', launchId: record.launchId, ...overrides.frontend };
    } else {
      throw new Error(`Unexpected launcher request: ${url}`);
    }
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('launcher anchors project paths to its own directory, not caller cwd', () => {
  assert.equal(root, path.resolve(__dirname, '..'));
});
test('occupied ports fail before launching or stopping any existing service', async t => {
  const existing = net.createServer(socket => socket.end('still-alive'));
  await new Promise(resolve => existing.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => existing.close(resolve)));
  const { port } = existing.address();
  await assert.rejects(assertPortAvailable('127.0.0.1', port), /existing services were not stopped/);
  const output = await new Promise((resolve, reject) => {
    let data = '';
    const client = net.connect(port, '127.0.0.1');
    client.on('data', chunk => { data += chunk; });
    client.on('end', () => resolve(data));
    client.on('error', reject);
  });
  assert.equal(output, 'still-alive');
});

test('launcher selects an available port without stopping the existing listener', async t => {
  const existing = net.createServer(socket => socket.end('still-alive'));
  let port;
  do {
    await new Promise(resolve => existing.listen(0, '127.0.0.1', resolve));
    port = existing.address().port;
    if (port > 65515) await new Promise(resolve => existing.close(resolve));
  } while (port > 65515);
  t.after(() => new Promise(resolve => existing.close(resolve)));
  const selected = await findAvailablePort('127.0.0.1', port);
  assert.ok(selected > port && selected < port + 20, 'fallback stays within the configured search range');
  await assertPortAvailable('127.0.0.1', selected);
  const output = await new Promise((resolve, reject) => {
    let data = '';
    const client = net.connect(port, '127.0.0.1');
    client.on('data', chunk => { data += chunk; });
    client.on('end', () => resolve(data));
    client.on('error', reject);
  });
  assert.equal(output, 'still-alive');
});

test('launcher reuses an instance only when both live processes and service markers match', async t => {
  const { runtimeFile, record } = await savedInstance(t);
  const { calls, fetchImpl } = healthyInstanceFetch(record);
  const checkedPids = [];
  const result = await readRunningInstance({
    runtimeFile,
    fetchImpl,
    isAlive: pid => { checkedPids.push(pid); return true; }
  });
  assert.deepEqual(result, record);
  assert.deepEqual(new Set(checkedPids), new Set([record.backendPid, record.frontendPid]));
  assert.deepEqual(new Set(calls), new Set([
    `${record.backendUrl}/api/health`,
    `${record.frontendUrl}/__scanner_launcher__`
  ]));
});

test('desktop fast mode refuses a development instance or outdated build', async t => {
  const { runtimeFile, record } = await savedInstance(t);
  const { calls, fetchImpl } = healthyInstanceFetch(record);
  assert.equal(await readRunningInstance({ runtimeFile, fetchImpl, isAlive: () => true,
    expectedBuildId: 'current-build' }), null);
  assert.deepEqual(calls, []);
});

test('desktop fast mode checks both recorded and served build identities', async t => {
  const { runtimeFile, record } = await savedInstance(t, { frontendMode: 'production', buildId: 'current-build' });
  const options = { runtimeFile, isAlive: () => true, expectedBuildId: 'current-build' };
  const healthy = healthyInstanceFetch(record, { frontend: { mode: 'production', buildId: 'current-build' } });
  assert.deepEqual(await readRunningInstance({ ...options, fetchImpl: healthy.fetchImpl }), record);
  const wrong = healthyInstanceFetch(record, { frontend: { mode: 'production', buildId: 'old-build' } });
  assert.equal(await readRunningInstance({ ...options, fetchImpl: wrong.fetchImpl }), null);
});

test('independent backend ownership remains valid when the recorded frontend process is dead', async t => {
  const { runtimeFile, record } = await savedInstance(t);
  const { calls, fetchImpl } = healthyInstanceFetch(record);
  const checkedPids = [];
  const result = await readRunningBackend({ runtimeFile, fetchImpl, isAlive: pid => {
    checkedPids.push(pid);
    return pid === record.backendPid;
  } });
  assert.deepEqual(result, record);
  assert.deepEqual(checkedPids, [record.backendPid]);
  assert.deepEqual(calls, [`${record.backendUrl}/api/health`]);
});

test('independent backend ownership rejects a dead backend without fetching', async t => {
  const { runtimeFile, record } = await savedInstance(t);
  const { calls, fetchImpl } = healthyInstanceFetch(record);
  assert.equal(await readRunningBackend({ runtimeFile, fetchImpl, isAlive: () => false }), null);
  assert.deepEqual(calls, []);
});

test('independent backend ownership rejects another project without fetching', async t => {
  const { runtimeFile, record } = await savedInstance(t, { root: path.join(root, 'another-project') });
  const { calls, fetchImpl } = healthyInstanceFetch(record);
  assert.equal(await readRunningBackend({ runtimeFile, fetchImpl, isAlive: () => true }), null);
  assert.deepEqual(calls, []);
});

test('independent backend ownership rejects a non-loopback URL without fetching', async t => {
  const { runtimeFile, record } = await savedInstance(t, { backendUrl: 'http://example.com:43001' });
  const { calls, fetchImpl } = healthyInstanceFetch(record);
  assert.equal(await readRunningBackend({ runtimeFile, fetchImpl, isAlive: () => true }), null);
  assert.deepEqual(calls, []);
});

for (const [name, backend] of [
  ['the launch identity differs', { launchId: 'another-launch' }],
  ['the service identity differs', { service: 'another-app' }],
  ['the backend is not healthy', { status: 'starting' }]
]) {
  test(`independent backend ownership rejects reuse when ${name}`, async t => {
    const { runtimeFile, record } = await savedInstance(t);
    const { calls, fetchImpl } = healthyInstanceFetch(record, { backend });
    assert.equal(await readRunningBackend({ runtimeFile, fetchImpl, isAlive: () => true }), null);
    assert.deepEqual(calls, [`${record.backendUrl}/api/health`]);
  });
}

for (const missing of ['backendPid', 'frontendPid']) {
  test(`launcher refuses reuse when the ${missing} process no longer exists`, async t => {
    const { runtimeFile, record } = await savedInstance(t);
    const { calls, fetchImpl } = healthyInstanceFetch(record);
    const result = await readRunningInstance({ runtimeFile, fetchImpl, isAlive: pid => pid !== record[missing] });
    assert.equal(result, null);
    assert.deepEqual(calls, [], 'dead process records do not trigger network requests');
  });
}

test('launcher refuses a record belonging to another project without fetching its URLs', async t => {
  const { runtimeFile, record } = await savedInstance(t, { root: path.join(root, 'another-project') });
  const { calls, fetchImpl } = healthyInstanceFetch(record);
  assert.equal(await readRunningInstance({ runtimeFile, fetchImpl, isAlive: () => true }), null);
  assert.deepEqual(calls, []);
});

for (const [name, overrides] of [
  ['backend launch identity differs', { backend: { launchId: 'another-launch' } }],
  ['frontend launch identity differs', { frontend: { launchId: 'another-launch' } }],
  ['backend is an unrelated service', { backend: { service: 'another-app' } }],
  ['frontend is an unrelated service', { frontend: { service: 'another-app-frontend' } }],
  ['backend health is not ready', { backend: { status: 'starting' } }]
]) {
  test(`launcher refuses reuse when ${name}`, async t => {
    const { runtimeFile, record } = await savedInstance(t);
    const { fetchImpl } = healthyInstanceFetch(record, overrides);
    assert.equal(await readRunningInstance({ runtimeFile, fetchImpl, isAlive: () => true }), null);
  });
}

for (const invalidUrl of [
  'http://example.com:43001',
  'http://192.168.1.2:43001',
  'https://127.0.0.1:43001',
  'http://name:password@127.0.0.1:43001',
  'http://127.0.0.1:43001/another-app',
  'http://127.0.0.1:43001/?app=other',
  'http://127.0.0.1:43001/#other',
  'not-a-url'
]) {
  for (const field of ['backendUrl', 'frontendUrl']) {
    test(`launcher rejects invalid ${field} ${invalidUrl} before fetching`, async t => {
      const { runtimeFile, record } = await savedInstance(t, { [field]: invalidUrl });
      const { calls, fetchImpl } = healthyInstanceFetch(record);
      assert.equal(await readRunningInstance({ runtimeFile, fetchImpl, isAlive: () => true }), null);
      assert.deepEqual(calls, []);
    });
  }
}
