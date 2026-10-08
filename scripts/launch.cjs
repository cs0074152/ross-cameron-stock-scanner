const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const net = require('node:net');
const { inputFingerprint, ensureFrontendBuild } = require('./frontend-build.cjs');
const root = path.resolve(__dirname, '..');
const runtimeDir = process.env.SCANNER_RUNTIME_DIR ? path.resolve(process.env.SCANNER_RUNTIME_DIR) : path.join(root, '.runtime');
const runtimeFile = path.join(runtimeDir, 'launcher.json');
const lockFile = path.join(runtimeDir, 'startup.lock');
const children = new Set();
let stopping = false;
let ready = false;
let failure = null;
let launchId;

function log(message, error = false) {
  (error ? console.error : console.log)(message);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.appendFileSync(path.join(runtimeDir, 'launch.log'), `${new Date().toISOString()} ${message}\n`);
  } catch { /* Keep console errors visible even when logging fails. */ }
}

async function assertPortAvailable(host, port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => {
      const failure = new Error(`Port ${host}:${port} is unavailable (${error.code}); existing services were not stopped.`);
      failure.code = error.code;
      reject(failure);
    });
    probe.listen(port, host, () => probe.close(resolve));
  });
}

async function findAvailablePort(host, preferredPort, attempts = 20) {
  for (let port = preferredPort; port < preferredPort + attempts && port <= 65535; port++) {
    try { await assertPortAvailable(host, port); return port; }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error(`找不到空闲端口（${host}:${preferredPort} 起）。请查看 .runtime/launch.log。`);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function validLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

async function readRunningInstance({ runtimeFile: file = runtimeFile, expectedRoot = root,
  fetchImpl = fetch, isAlive = processAlive, expectedBuildId } = {}) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.root !== expectedRoot || typeof record.launchId !== 'string' || !record.launchId ||
      !Number.isInteger(record.backendPid) || !Number.isInteger(record.frontendPid) ||
      !isAlive(record.backendPid) || !isAlive(record.frontendPid) ||
      !validLocalUrl(record.backendUrl) || !validLocalUrl(record.frontendUrl) ||
      (expectedBuildId && (record.frontendMode !== 'production' || record.buildId !== expectedBuildId))) return null;
    const check = async (base, route, service) => {
      const response = await fetchImpl(new URL(route, base), { signal: AbortSignal.timeout(1500), redirect: 'error' });
      if (!response.ok) return false;
      const body = await response.json();
      return body.service === service && body.launchId === record.launchId &&
        (service.endsWith('-frontend') ? !expectedBuildId || (body.mode === 'production' && body.buildId === expectedBuildId)
          : body.status === 'ok');
    };
    const checks = await Promise.all([
      check(record.backendUrl, '/api/health', 'ross-cameron-stock-scanner'),
      check(record.frontendUrl, '/__scanner_launcher__', 'ross-cameron-stock-scanner-frontend')
    ]);
    return checks.every(Boolean) ? record : null;
  } catch { return null; }
}

async function readRunningBackend({ runtimeFile: file = runtimeFile, expectedRoot = root,
  fetchImpl = fetch, isAlive = processAlive } = {}) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.root !== expectedRoot || typeof record.launchId !== 'string' || !record.launchId ||
      !Number.isInteger(record.backendPid) || !isAlive(record.backendPid) || !validLocalUrl(record.backendUrl)) return null;
    const response = await fetchImpl(new URL('/api/health', record.backendUrl), {
      signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) return null;
    const health = await response.json();
    return health.status === 'ok' && health.service === 'ross-cameron-stock-scanner' &&
      health.launchId === record.launchId ? record : null;
  } catch { return null; }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && !child.killed) child.kill();
  try {
    if (launchId && JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).launchId === launchId) fs.unlinkSync(runtimeFile);
  } catch { /* There may be no completed startup record. */ }
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());

async function acquireStartupLock() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  // Publish a fully written lock atomically; a crash cannot leave an empty lock.
  const candidate = path.join(runtimeDir, `startup-${process.pid}-${randomUUID()}.tmp`);
  fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid }));
  const deadline = Date.now() + 60000;
  try {
  while (!stopping) {
    try {
      fs.linkSync(candidate, lockFile);
      return () => {
        try { if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid === process.pid) fs.unlinkSync(lockFile); }
        catch { /* A failed startup may already have removed the lock. */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (!processAlive(owner.pid)) { fs.unlinkSync(lockFile); continue; }
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (error instanceof SyntaxError) throw new Error('启动锁已损坏。请删除 .runtime/startup.lock 后重试。');
      }
      if (Date.now() >= deadline) throw new Error('另一个窗口仍在启动。请稍候再点击桌面图标。');
      await delay(250);
    }
  }
  throw new Error('启动已取消。');
  } finally { fs.unlinkSync(candidate); }
}

async function install(folder, modulePath) {
  if (fs.existsSync(path.join(root, folder, 'node_modules', modulePath))) return;
  log(`正在安装 ${folder} 所需组件，请稍候……`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], {
      cwd: path.join(root, folder), stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true
    });
    children.add(child);
    child.on('error', reject);
    child.on('exit', code => {
      children.delete(child);
      code === 0 ? resolve() : reject(new Error(`${folder} 组件安装失败（${code}）。`));
    });
  });
}

function launch(name, folder, args, env) {
  const child = spawn(process.execPath, args, { cwd: path.join(root, folder), stdio: 'inherit', env, windowsHide: true });
  children.add(child);
  const fail = error => { failure = error; if (ready && !stopping) { log(error.message, true); stop(1); } };
  child.on('error', error => fail(new Error(`${name} 无法启动：${error.message}`)));
  child.on('exit', code => {
    children.delete(child);
    if (!stopping) fail(new Error(`${name} 已退出（${code}）。请查看启动窗口或 .runtime/launch.log。`));
  });
  return child;
}

async function waitReady(url, child, validate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !stopping) {
    if (failure) throw failure;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      if (response.ok && await validate(response)) {
        await delay(20);
        if (failure || child.exitCode !== null) throw failure || new Error('服务在启动过程中退出。');
        return;
      }
    } catch { if (failure) throw failure; }
    await delay(250);
  }
  throw new Error(`服务未能就绪：${url}`);
}

async function openPage(url) {
  log(`扫描器已就绪：${url}`);
  if (process.argv.includes('--no-browser') || process.platform !== 'win32') return;
  try {
    await new Promise((resolve, reject) => {
      const browser = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'),
        ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true });
      browser.once('error', reject);
      browser.once('exit', code => code === 0 ? resolve() : reject(new Error(`浏览器启动返回 ${code}`)));
    });
  } catch (error) {
    log(`浏览器未能自动打开：${error.message}。请手动访问 ${url}`, true);
    process.exitCode = 1;
  }
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('需要 Node.js >=22.12.0，建议安装 Node 24。');
  const release = await acquireStartupLock();
  let url;
  try {
    const frontendRoot = path.join(root, 'frontend');
    const expectedBuildId = inputFingerprint(frontendRoot);
    const running = await readRunningInstance({ expectedBuildId });
    if (running) {
      log('扫描器已经运行，正在打开页面……');
      url = running.frontendUrl;
    } else {
      const previous = await readRunningBackend();
      if (previous) throw new Error('检测到仍在运行的旧版本。请关闭原启动窗口后重新启动，以应用性能优化。');
      await install('backend', 'express/package.json');
      await install('frontend', 'vite/package.json');
      if (stopping) return;
      const { buildId } = await ensureFrontendBuild({ frontendRoot,
        onBuild: () => log('正在准备快速打开所需的页面，完成后会自动缓存……'),
        build: () => new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(frontendRoot, 'node_modules/vite/bin/vite.js'), 'build'],
            { cwd: frontendRoot, stdio: 'inherit', windowsHide: true });
          children.add(child);
          child.once('error', reject);
          child.once('exit', code => {
            children.delete(child);
            code === 0 ? resolve() : reject(new Error(`页面构建失败（${code}）。`));
          });
        }) });
      if (stopping) return;
      const dotenv = require(path.join(root, 'backend/node_modules/dotenv'));
      const envPath = path.join(root, 'backend/.env');
      const settings = { ...(fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {}), ...process.env };
      const host = settings.HOST || '127.0.0.1';
      const requestedPort = Number(settings.PORT || 3001);
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('HOST 必须是本机回环地址。');
      if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) throw new Error('后端 PORT 无效。');
      const port = await findAvailablePort(host, requestedPort);
      let frontPort = await findAvailablePort('localhost', 5173);
      if (frontPort === port) frontPort = await findAvailablePort('localhost', frontPort + 1);
      const apiBase = `http://${host === '::1' ? '[::1]' : host}:${port}`;
      const frontendUrl = `http://localhost:${frontPort}`;
      if (port !== requestedPort || frontPort !== 5173) log('默认端口已被占用，已选择空闲端口。');
      log('正在启动扫描器，请稍候。按 Ctrl+C 可停止本次启动的服务。');
      launchId = randomUUID();
      const backend = launch('行情服务', 'backend', ['server.js'], {
        ...settings, HOST: host, PORT: String(port), SCANNER_LAUNCH_ID: launchId,
        ALLOWED_ORIGIN: [settings.ALLOWED_ORIGIN, frontendUrl, `http://127.0.0.1:${frontPort}`].filter(Boolean).join(',')
      });
      const frontend = launch('页面服务', 'frontend', [path.join(root, 'scripts/serve-ui.cjs')], {
        ...process.env, SCANNER_LAUNCH_ID: launchId, SCANNER_BUILD_ID: buildId, UI_PORT: String(frontPort),
        VITE_API_BASE: apiBase, VITE_WS_BASE: apiBase.replace(/^http:/, 'ws:')
      });
      await Promise.all([
        waitReady(`${apiBase}/api/health`, backend, async response => {
          const body = await response.json();
          return body.status === 'ok' && body.service === 'ross-cameron-stock-scanner' && body.launchId === launchId;
        }),
        waitReady(`${frontendUrl}/__scanner_launcher__`, frontend, async response => {
          const body = await response.json();
          return body.service === 'ross-cameron-stock-scanner-frontend' && body.launchId === launchId &&
            body.mode === 'production' && body.buildId === buildId;
        })
      ]);
      const page = await fetch(frontendUrl, { signal: AbortSignal.timeout(1500) });
      const html = await page.text();
      if (!page.ok || !html.includes('id="root"')) throw new Error('页面入口未就绪。');
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(match => match[1]);
      if (!assets.length) throw new Error('页面构建缺少资源。');
      await Promise.all(assets.map(async asset => {
        const response = await fetch(new URL(asset, frontendUrl), { signal: AbortSignal.timeout(1500) });
        if (!response.ok) throw new Error(`页面资源未就绪：${asset}`);
        await response.arrayBuffer();
      }));
      const record = { root, backendPid: backend.pid, frontendPid: frontend.pid, backendUrl: apiBase,
        frontendUrl, launchId, frontendMode: 'production', buildId };
      fs.writeFileSync(`${runtimeFile}.tmp`, JSON.stringify(record, null, 2));
      fs.renameSync(`${runtimeFile}.tmp`, runtimeFile);
      ready = true;
      url = frontendUrl;
    }
  } finally { release(); }
  await openPage(url);
}
if (require.main === module) main().catch(error => { log(`启动失败：${error.message}`, true); stop(1); });
module.exports = { assertPortAvailable, findAvailablePort, readRunningInstance, readRunningBackend, root };
