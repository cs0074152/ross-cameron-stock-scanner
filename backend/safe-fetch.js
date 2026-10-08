const net = require('node:net');
const DEFAULT_ALLOWLIST = new Set([
  'stockanalysis.com', 'query1.finance.yahoo.com', 'fc.yahoo.com', 'push2.eastmoney.com'
]);

function reservedAddress(host) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return true;
  if (net.isIP(host) === 4) {
    const [a, b, c] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  if (net.isIP(host) === 6) {
    // 仅接受全球单播范围；同时拒绝文档地址。IPv4 映射、链路本地、ULA、环回均不在此范围。
    return !/^[23][\da-f]{3}:/.test(host) || /^2001:db8:/.test(host);
  }
  return false;
}

function assertSafeUrl(input, allowlist = DEFAULT_ALLOWLIST) {
  let url;
  try { url = new URL(input); } catch { throw new Error('invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('non-http(s) protocol blocked');
  if (url.username || url.password) throw new Error('URL credentials blocked');
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new Error('non-standard port blocked');
  if (reservedAddress(url.hostname)) throw new Error('internal or reserved address blocked');
  if (!allowlist.has(url.hostname.toLowerCase())) throw new Error(`non-allowlisted host blocked: ${url.hostname}`);
  return url.toString();
}

function createSafeFetch({ fetchImpl = globalThis.fetch, allowlist = DEFAULT_ALLOWLIST, timeoutMs = 8000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid request timeout');
  const hosts = new Set([...allowlist].map(host => String(host).toLowerCase()));
  return async function safeFetch(input, options = {}) {
    let url = assertSafeUrl(input, hosts);
    const mode = options.redirect || 'follow';
    if (!['manual', 'follow', 'error'].includes(mode)) throw new Error('Invalid redirect mode');
    const deadline = AbortSignal.timeout(Math.ceil(timeoutMs));
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    signal.throwIfAborted();
    let request = { ...options, signal, redirect: 'manual' };
    for (let redirects = 0; ; redirects++) {
      const response = await fetchImpl(url, request);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (mode === 'manual') return response; // Yahoo cookie 入口需要原始 Set-Cookie。
      await response.body?.cancel();
      if (mode === 'error') throw new Error('redirect blocked');
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect missing location');
      if (redirects >= 3) throw new Error('too many redirects');
      const next = assertSafeUrl(new URL(location, url).toString(), hosts);
      const headers = new Headers(request.headers);
      if (new URL(next).origin !== new URL(url).origin) {
        for (const name of ['authorization', 'cookie', 'proxy-authorization', 'host']) headers.delete(name);
      }
      const method = (request.method || 'GET').toUpperCase();
      if ((response.status === 303 && method !== 'HEAD') || ([301, 302].includes(response.status) && method === 'POST')) {
        request = { ...request, method: 'GET', body: undefined };
        headers.delete('content-type');
        headers.delete('content-length');
      }
      request = { ...request, headers };
      url = next;
      signal.throwIfAborted();
    }
  };
}

module.exports = { DEFAULT_ALLOWLIST, assertSafeUrl, createSafeFetch };
