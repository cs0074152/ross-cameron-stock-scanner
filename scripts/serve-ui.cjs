const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' };

function localUrl(value, protocol) {
  const url = new URL(value);
  if (url.protocol !== protocol || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('页面连接地址必须是本机地址。');
  return url.origin;
}

function createUIServer({ distRoot, apiBase, wsBase = apiBase.replace(/^http:/, 'ws:'), launchId, buildId }) {
  const directory = path.resolve(distRoot);
  const config = JSON.stringify({ apiBase: localUrl(apiBase, 'http:'), wsBase: localUrl(wsBase, 'ws:') }).replace(/</g, '\\u003c');
  const index = fs.readFileSync(path.join(directory, 'index.html'), 'utf8')
    .replace('</head>', `<script>globalThis.__SCANNER_CONFIG__=${config};</script></head>`);
  const resources = new Map();
  const cache = (url, buffer, type, immutable = false) => resources.set(url, {
    buffer, gzip: buffer.length >= 512 && /^(text\/|application\/json|image\/svg)/.test(type) ? gzipSync(buffer) : null,
    etag: 'W/"' + createHash('sha256').update(buffer).digest('hex') + '"', type, immutable
  });
  const walk = (folder, prefix = '') => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const file = path.join(folder, entry.name);
      const url = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(file, url);
      else if (entry.isFile() && entry.name !== 'index.html') cache(url, fs.readFileSync(file),
        TYPES[path.extname(file)] || 'application/octet-stream', /^\/assets\/.+-[\w-]{8,}\.[\w]+$/.test(url));
    }
  };
  walk(directory);
  cache('/', Buffer.from(index), TYPES['.html']);
  resources.set('/index.html', resources.get('/'));
  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${req.headers.host}`).hostname)) {
        res.writeHead(403); return res.end();
      }
    } catch { res.writeHead(403); return res.end(); }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    let route;
    try { route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); return res.end(); }
    if (route === '/__scanner_launcher__') {
      res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ service: 'ross-cameron-stock-scanner-frontend',
        launchId, buildId, mode: 'production' }));
    }
    const resource = resources.get(route);
    if (!resource) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', resource.type);
    res.setHeader('Cache-Control', resource.type.startsWith('text/html') ? 'no-store' :
      resource.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.setHeader('ETag', resource.etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match']?.split(',').map(value => value.trim()).includes(resource.etag)) {
      res.writeHead(304); return res.end();
    }
    const encodings = (req.headers['accept-encoding'] || '').split(',').map(part => part.trim().split(';'));
    const coding = encodings.find(([name]) => name === 'gzip') || encodings.find(([name]) => name === '*');
    const quality = coding?.slice(1).find(value => value.trim().startsWith('q='));
    const gzip = resource.gzip && coding && (!quality || Number(quality.trim().slice(2)) > 0);
    const body = gzip ? resource.gzip : resource.buffer;
    if (gzip) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', body.length);
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return { server, start(port = 0, host = 'localhost') {
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) return Promise.reject(new Error('页面仅允许绑定本机回环地址。'));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
    });
  }, stop: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (require.main === module) {
  try {
    const ui = createUIServer({ distRoot: path.join(__dirname, '../frontend/dist'), apiBase: process.env.VITE_API_BASE,
      wsBase: process.env.VITE_WS_BASE, launchId: process.env.SCANNER_LAUNCH_ID, buildId: process.env.SCANNER_BUILD_ID });
    ui.start(Number(process.env.UI_PORT), 'localhost').then(address => console.log(`页面服务 http://localhost:${address.port}`))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => ui.stop().catch(() => {}));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createUIServer };
