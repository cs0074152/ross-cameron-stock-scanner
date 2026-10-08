const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { inputFingerprint, hasCachedBuild, ensureFrontendBuild } = require('../scripts/frontend-build.cjs');

async function fixture(t) {
  const frontendRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-build-test-'));
  t.after(() => fs.rm(frontendRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(frontendRoot, 'src'));
  await fs.mkdir(path.join(frontendRoot, 'public'));
  await Promise.all([
    fs.writeFile(path.join(frontendRoot, 'src/main.js'), 'export const value = 1;\n'),
    fs.writeFile(path.join(frontendRoot, 'src/helper.js'), 'export const helper = true;\n'),
    fs.writeFile(path.join(frontendRoot, 'public/icon.svg'), '<svg></svg>'),
    fs.writeFile(path.join(frontendRoot, 'index.html'), '<div id="root"></div>'),
    fs.writeFile(path.join(frontendRoot, 'package.json'), '{"name":"temporary-scanner","private":true}'),
    fs.writeFile(path.join(frontendRoot, 'package-lock.json'), '{"lockfileVersion":3}'),
    fs.writeFile(path.join(frontendRoot, 'vite.config.js'), 'export default {};\n'),
    fs.writeFile(path.join(frontendRoot, '.env'), 'VITE_EXAMPLE=initial\n')
  ]);
  let builds = 0;
  let notifications = 0;
  const build = async () => {
    builds++;
    const distRoot = path.join(frontendRoot, 'dist');
    await fs.rm(distRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(distRoot, 'assets'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(distRoot, 'index.html'), '<html><head></head><body><div id="root"></div><script src="/assets/app-12345678.js"></script></body></html>'),
      fs.writeFile(path.join(distRoot, 'assets/app-12345678.js'), await fs.readFile(path.join(frontendRoot, 'src/main.js')))
    ]);
  };
  const ensure = () => ensureFrontendBuild({ frontendRoot, build, onBuild: () => { notifications++; } });
  return { frontendRoot, build, ensure, counts: () => ({ builds, notifications }) };
}

test('unchanged inputs reuse a complete cached frontend without rebuilding', async t => {
  const { frontendRoot, ensure, counts } = await fixture(t);
  const initial = await ensure();
  assert.deepEqual(initial, { buildId: inputFingerprint(frontendRoot), built: true });
  assert.equal(hasCachedBuild(frontendRoot, initial.buildId), true);
  assert.deepEqual(await ensure(), { buildId: initial.buildId, built: false });
  assert.deepEqual(counts(), { builds: 1, notifications: 1 });
});

test('source content changes invalidate the cache even when length and mtime remain identical', async t => {
  const { frontendRoot, ensure, counts } = await fixture(t);
  const source = path.join(frontendRoot, 'src/main.js');
  const fixedTime = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(source, fixedTime, fixedTime);
  const before = await ensure();
  const original = await fs.stat(source);
  await fs.writeFile(source, 'export const value = 2;\n');
  await fs.utimes(source, fixedTime, fixedTime);
  const changed = await fs.stat(source);
  assert.equal(changed.size, original.size);
  assert.equal(changed.mtimeMs, original.mtimeMs);
  assert.notEqual(inputFingerprint(frontendRoot), before.buildId);
  const after = await ensure();
  assert.equal(after.built, true);
  assert.notEqual(after.buildId, before.buildId);
  assert.deepEqual(counts(), { builds: 2, notifications: 2 });
});

test('mtime changes alone do not invalidate unchanged source contents', async t => {
  const { frontendRoot, ensure, counts } = await fixture(t);
  const initial = await ensure();
  const changedTime = new Date('2021-01-01T00:00:00Z');
  await fs.utimes(path.join(frontendRoot, 'src/main.js'), changedTime, changedTime);
  assert.equal(inputFingerprint(frontendRoot), initial.buildId);
  assert.deepEqual(await ensure(), { buildId: initial.buildId, built: false });
  assert.deepEqual(counts(), { builds: 1, notifications: 1 });
});

test('build configuration imported from the config directory invalidates cached output', async t => {
  const { frontendRoot, ensure } = await fixture(t);
  await fs.mkdir(path.join(frontendRoot, 'config'));
  const configuration = path.join(frontendRoot, 'config/build-options.js');
  await fs.writeFile(configuration, 'export const minify = true;');
  const initial = await ensure();
  await fs.writeFile(configuration, 'export const minify = false;');
  assert.notEqual(inputFingerprint(frontendRoot), initial.buildId);
  assert.equal((await ensure()).built, true);
});

test('inherited VITE build settings participate in cache invalidation', async t => {
  const { frontendRoot, ensure } = await fixture(t);
  const key = 'VITE_SCANNER_BUILD_TEST';
  const previous = process.env[key];
  try {
    process.env[key] = 'initial';
    const initial = await ensure();
    process.env[key] = 'changed';
    assert.notEqual(inputFingerprint(frontendRoot), initial.buildId);
    assert.equal((await ensure()).built, true);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

for (const [name, mutate] of [
  ['a new source file', root => fs.writeFile(path.join(root, 'src/new-file.js'), 'export const added = true;')],
  ['a removed source file', root => fs.unlink(path.join(root, 'src/helper.js'))],
  ['an environment file change', root => fs.writeFile(path.join(root, '.env'), 'VITE_EXAMPLE=changed\n')],
  ['a production environment file addition', root => fs.writeFile(path.join(root, '.env.production.local'), 'VITE_EXAMPLE=production\n')],
  ['a dependency lockfile change', root => fs.writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}')],
  ['a Vite configuration change', root => fs.writeFile(path.join(root, 'vite.config.js'), 'export default {build:{minify:false}};\n')],
  ['an HTML entry change', root => fs.writeFile(path.join(root, 'index.html'), '<main id="root"></main>')],
  ['a public asset change', root => fs.writeFile(path.join(root, 'public/icon.svg'), '<svg><path /></svg>')]
]) {
  test(`frontend cache is invalidated by ${name}`, async t => {
    const { frontendRoot, ensure, counts } = await fixture(t);
    const before = await ensure();
    await mutate(frontendRoot);
    const fingerprint = inputFingerprint(frontendRoot);
    assert.notEqual(fingerprint, before.buildId);
    assert.equal(hasCachedBuild(frontendRoot, fingerprint), false);
    assert.deepEqual(await ensure(), { buildId: fingerprint, built: true });
    assert.deepEqual(counts(), { builds: 2, notifications: 2 });
  });
}

for (const [name, damage] of [
  ['missing HTML', root => fs.unlink(path.join(root, 'dist/index.html'))],
  ['missing JavaScript asset', root => fs.unlink(path.join(root, 'dist/assets/app-12345678.js'))],
  ['corrupted JavaScript asset', root => fs.writeFile(path.join(root, 'dist/assets/app-12345678.js'), 'corrupted output')],
  ['corrupted cache record', root => fs.writeFile(path.join(root, 'dist/.scanner-build.json'), '{broken-json')]
]) {
  test(`frontend rebuilds after ${name}`, async t => {
    const { frontendRoot, ensure, counts } = await fixture(t);
    const before = await ensure();
    await damage(frontendRoot);
    assert.equal(hasCachedBuild(frontendRoot, before.buildId), false);
    assert.deepEqual(await ensure(), { buildId: before.buildId, built: true });
    assert.equal(hasCachedBuild(frontendRoot, before.buildId), true);
    assert.deepEqual(counts(), { builds: 2, notifications: 2 });
  });
}

test('a failed build never publishes a reusable cache even when partial output exists', async t => {
  const { frontendRoot, build, ensure } = await fixture(t);
  await assert.rejects(ensureFrontendBuild({ frontendRoot, build: async () => { await build(); throw new Error('simulated compiler failure'); } }), /simulated compiler failure/);
  assert.equal(hasCachedBuild(frontendRoot, inputFingerprint(frontendRoot)), false);
  await assert.rejects(fs.access(path.join(frontendRoot, 'dist/.scanner-build.json')), { code: 'ENOENT' });
  assert.equal((await ensure()).built, true);
});

test('inputs changed during a build cannot be published under the earlier fingerprint', async t => {
  const { frontendRoot, build } = await fixture(t);
  await assert.rejects(ensureFrontendBuild({ frontendRoot, build: async () => {
    await build();
    await fs.writeFile(path.join(frontendRoot, 'src/main.js'), 'export const value = 3;\n');
  } }), /发生变化/);
  assert.equal(hasCachedBuild(frontendRoot, inputFingerprint(frontendRoot)), false);
});
