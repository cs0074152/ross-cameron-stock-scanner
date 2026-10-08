const DAY = 86400000;
const text = value => typeof value === 'string' ? require('cheerio').load(value, null, false).text().replace(/\s+/g, ' ').trim().slice(0, 500) : '';
function safeLink(value, official = false) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const yahooArticle = /^\/news\/[\w%-]+(?:\.html)?$/.test(u.pathname) ||
      /^\/m\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\/[\w%-]+\.html$/i.test(u.pathname) ||
      /^\/(?:[a-z][a-z0-9-]*\/){1,3}articles?\/[\w%-]+\.html$/.test(u.pathname);
    if (official ? u.hostname !== 'static.cninfo.com.cn' || !/^\/finalpage\/[\w/.-]+\.PDF$/i.test(u.pathname) || u.pathname.includes('..') : u.hostname !== 'finance.yahoo.com' || !yahooArticle) return null;
    u.hash = ''; return u.toString();
  } catch { return null; }
}
function dateParts(value, now, precision = 'second', beijingDate = false) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8640000000000000) return { publishedAt: null, publishedDate: null, timePrecision: 'unknown', timeStatus: 'unknown' };
  const publishedDate = precision === 'day' || beijingDate ? new Date(ms + 8 * 3600000).toISOString().slice(0, 10) : new Date(ms).toISOString().slice(0, 10);
  const timestamp = precision === 'day' ? Date.parse(`${publishedDate}T00:00:00+08:00`) : ms;
  const fields = { publishedAt: new Date(timestamp).toISOString(), publishedDate, timePrecision: precision };
  return { ...fields, timeStatus: classifyTime(fields, now) };
}
function classifyTime(item, now) {
  const day = item.timePrecision === 'day';
  const timestamp = day ? Date.parse(`${item.publishedDate}T00:00:00+08:00`) : item.timePrecision === 'second' ? Date.parse(item.publishedAt) : NaN;
  if (!Number.isFinite(timestamp)) return 'unknown';
  const current = day ? Date.parse(`${new Date(now + 8 * 3600000).toISOString().slice(0, 10)}T00:00:00+08:00`) : now;
  return timestamp > current ? 'future' : current - timestamp < 7 * DAY ? 'recent' : 'older';
}
function dedupe(items) {
  const ids = new Set(), urls = new Set(), titles = new Set();
  return items.filter(item => {
    const title = item.title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (ids.has(item.id) || urls.has(item.url) || titles.has(title)) return false;
    ids.add(item.id); urls.add(item.url); titles.add(title); return true;
  }).slice(0, 10);
}
function parseYahoo(data, symbol, now) {
  if (!data || !Array.isArray(data.news)) throw new Error('新闻来源返回结构异常');
  return dedupe(data.news.filter(row => Array.isArray(row.relatedTickers) && row.relatedTickers.includes(symbol)).flatMap(row => {
    const title = text(row.title), url = safeLink(row.link);
    if (!title || !url) return [];
    return [{ id: `yahoo:${text(row.uuid) || url}`, title, url, source: 'Yahoo 财经', publisher: text(row.publisher) || 'Yahoo 财经',
      ...dateParts(typeof row.providerPublishTime === 'number' ? row.providerPublishTime * 1000 : NaN, now), evidenceType: 'media', stale: false }];
  }));
}
function parseCninfo(data, symbol, now) {
  if (data?.announcements === null && data.totalAnnouncement === 0) return [];
  if (!data || !Array.isArray(data.announcements)) throw new Error('公告来源返回结构异常');
  return dedupe(data.announcements.filter(row => row.secCode === symbol).flatMap(row => {
    const title = text(row.announcementTitle), path = row.adjunctUrl;
    const url = typeof path === 'string' && /^finalpage\/[\w/.-]+\.PDF$/i.test(path) ? safeLink(`https://static.cninfo.com.cn/${path}`, true) : null;
    if (!title || !url) return [];
    return [{ id: `cninfo:${text(row.announcementId) || url}`, title, url, source: '巨潮资讯', publisher: '公司公告',
      ...dateParts(row.announcementTime, now, (Number(row.announcementTime) + 8 * 3600000) % DAY === 0 ? 'day' : 'second', true), evidenceType: 'announcement', stale: false }];
  }));
}
async function readJson(response, signal, limit = 2 * 1024 * 1024) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`来源 HTTP ${response.status}`); }
  if (!/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel(); throw new Error('来源未返回 JSON');
  }
  if (!response.body?.getReader) throw new Error('来源响应体不可读取');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('来源响应超过大小限制'); }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('来源 JSON 无法解析'); }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
// 每个出站请求（包括读取响应体）共用此闸门；等待任务受其自身期限约束。
function createRequestGate(limit = 2) {
  let active = 0; const queue = [];
  function drain() {
    while (active < limit && queue.length) {
      const job = queue.shift(); job.signal.removeEventListener('abort', job.abort);
      if (job.signal.aborted) { job.reject(job.signal.reason); continue; }
      active++; job.resolve(() => { active--; drain(); });
    }
  }
  return async (signal, run) => {
    signal.throwIfAborted();
    const release = await new Promise((resolve, reject) => {
      const job = { signal, resolve, reject, abort: () => { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); reject(signal.reason); } };
      queue.push(job); signal.addEventListener('abort', job.abort, { once: true }); drain();
    });
    try { signal.throwIfAborted(); return await run(); } finally { release(); }
  };
}
function createNewsProvider({ safeFetch, now = Date.now, budgetMs = 6000, globalSignal = new AbortController().signal } = {}) {
  const gate = createRequestGate();
  const request = (url, signal, options = {}) => gate(signal, async () => readJson(await safeFetch(url, { ...options, signal }), signal));
  let mapping = null, mappingAt = 0, mapFailureAt = -Infinity, mapPending = null;
  async function stockMap() {
    if (mapping && now() - mappingAt < DAY) return mapping;
    if (mapPending) return mapPending;
    if (now() - mapFailureAt < 30000) throw new Error('公司代码来源稍后重试');
    const signal = AbortSignal.any([globalSignal, AbortSignal.timeout(budgetMs)]);
    mapPending = (async () => {
      try {
        const data = await request('https://www.cninfo.com.cn/new/data/szse_stock.json', signal);
        if (!Array.isArray(data?.stockList) || !data.stockList.length) throw new Error('公司代码来源结构异常');
        const result = new Map(data.stockList.filter(s => /^\d{6}$/.test(s.code) && typeof s.orgId === 'string' && /^[\w-]+$/.test(s.orgId)).map(s => [s.code, s.orgId]));
        if (!result.size) throw new Error('公司代码来源结构异常');
        mapping = result; mappingAt = now(); return result;
      } catch (error) { mapFailureAt = now(); throw error; }
      finally { mapPending = null; }
    })();
    return mapPending;
  }
  function within(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  return async function fetchNews(market, symbol, signal) {
    if (market === 'US') {
      const data = await request(`https://query1.finance.yahoo.com/v1/finance/search?${new URLSearchParams({ q: symbol, newsCount: '10', quotesCount: '1' })}`, signal);
      return parseYahoo(data, symbol, now());
    }
    const orgId = (await within(stockMap(), signal)).get(symbol); signal.throwIfAborted();
    if (!orgId) throw new Error('未找到官方公司代码映射');
    const end = new Date(now() + 8 * 3600000).toISOString().slice(0, 10);
    const start = new Date(now() + 8 * 3600000 - 90 * DAY).toISOString().slice(0, 10);
    const data = await request('https://www.cninfo.com.cn/new/hisAnnouncement/query', signal, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.cninfo.com.cn/new/index', 'User-Agent': 'ScannerDesk/2.0' },
      body: new URLSearchParams({ pageNum: '1', pageSize: '10', column: '', tabName: 'fulltext', stock: `${symbol},${orgId}`, searchkey: '', category: '', seDate: `${start}~${end}`, sortName: 'time', sortType: 'desc', isHLtitle: 'false' }).toString()
    });
    return parseCninfo(data, symbol, now());
  };
}
module.exports = { createNewsProvider, parseYahoo, parseCninfo, readJson, safeLink, createRequestGate, classifyTime };
