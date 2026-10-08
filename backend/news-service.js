const { createNewsProvider, classifyTime } = require('./news-provider');
const DAY = 86400000;
function createNewsService({ safeFetch, now = Date.now, budgetMs = 6000, fetchNews } = {}) {
  const stop = new AbortController();
  const provider = fetchNews || createNewsProvider({ safeFetch, now, budgetMs, globalSignal: stop.signal });
  const cache = new Map(), inflight = new Map(), queue = [];
  let active = 0, closed = false;
  const iso = () => new Date(now()).toISOString();
  const touch = (key, value) => { cache.delete(key); cache.set(key, value); while (cache.size > 100) cache.delete(cache.keys().next().value); };
  function view(market, symbol, entry, refreshing = false) {
    const retained = entry?.lastSuccessMs != null && now() - entry.lastSuccessMs <= DAY;
    const stale = retained && (entry.error != null || now() - entry.lastSuccessMs >= 300000);
    const items = retained ? entry.items.map(item => ({ ...item, stale, timeStatus: classifyTime(item, now()) })) : [];
    const source = market === 'CN' ? { id: 'cninfo', label: '巨潮资讯公司公告' } : { id: 'yahoo', label: 'Yahoo 财经收录' };
    return { market, symbol, status: items.length ? 'found' : entry?.error == null && retained ? 'none' : 'unavailable',
      partial: items.length > 0 && entry?.error != null, stale: !!stale, refreshing,
      checkedAt: entry?.checkedAt || null, lastSuccessAt: entry?.lastSuccessAt || null, rangeDays: 90,
      recentCount: items.filter(item => item.timeStatus === 'recent').length,
      sources: [{ ...source, status: entry?.error == null && retained ? 'ok' : 'error', checkedAt: entry?.checkedAt || null,
        lastSuccessAt: entry?.lastSuccessAt || null, error: entry?.error || (retained ? null : '新闻来源暂不可用') }], items };
  }
  function drain() {
    while (!closed && active < 2 && queue.length) {
      const job = queue.shift();
      if (job.signal.aborted) continue;
      if (performance.now() >= job.deadline) { job.expire(); continue; }
      active++; job.start();
    }
  }
  function launch(key, market, symbol, previous) {
    if (closed) throw Object.assign(new Error('新闻服务已停止'), { status: 503 });
    if (active >= 2 && queue.length >= 4) throw Object.assign(new Error('新闻查询繁忙，请稍后重试'), { status: 429, retryAfter: 6 });
    const control = new AbortController();
    const signal = AbortSignal.any([stop.signal, control.signal]);
    const timer = setTimeout(() => control.abort(new Error('新闻来源查询超时')), budgetMs);
    const checkedAt = iso(), attemptMs = now();
    let began = false, finish, settled = false;
    const promise = new Promise(resolve => { finish = resolve; });
    const job = { signal, deadline: performance.now() + budgetMs, expire: () => control.abort(new Error('新闻来源查询超时')), start: async () => {
      began = true;
      try {
        const items = await provider(market, symbol, signal);
        if (!signal.aborted) complete(null, items);
      } catch (error) { complete(error); }
      finally { active--; drain(); }
    } };
    function complete(error, items) {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
      // 失败保留最后成功时间，超过24小时的旧条目永久丢弃。
      const keep = previous?.lastSuccessMs != null && now() - previous.lastSuccessMs <= DAY;
      const entry = error ? { ...previous, items: keep ? previous.items : [], checkedAt, attemptMs,
        error: signal.aborted ? closed ? '新闻服务已停止' : '新闻来源查询超时' : '新闻来源暂不可用，请稍后重试' } :
        { items, checkedAt, attemptMs, lastSuccessAt: iso(), lastSuccessMs: now(), error: null };
      if (!closed) touch(key, entry);
      inflight.delete(key); finish(view(market, symbol, entry));
      if (!began) drain();
    }
    const abort = () => complete(signal.reason || new Error('已取消'));
    signal.addEventListener('abort', abort, { once: true });
    inflight.set(key, promise);
    queue.push(job); drain();
    return promise;
  }
  async function get(market, symbol, { refresh = false } = {}) {
    if (closed) throw Object.assign(new Error('新闻服务已停止'), { status: 503 });
    const key = `${market}:${symbol}`, entry = cache.get(key);
    if (entry) touch(key, entry);
    const pending = inflight.get(key);
    const retained = entry?.lastSuccessMs != null && now() - entry.lastSuccessMs <= DAY;
    if (pending) return retained ? view(market, symbol, entry, true) : pending;
    const elapsed = entry ? now() - entry.attemptMs : Infinity;
    if (entry?.error && elapsed < 30000 || refresh && elapsed < 15000 || !refresh && retained && now() - entry.lastSuccessMs < 300000 && !entry.error) return view(market, symbol, entry);
    const task = launch(key, market, symbol, entry);
    return retained ? view(market, symbol, entry, true) : task;
  }
  function close() { closed = true; stop.abort(new Error('新闻服务已停止')); queue.length = 0; }
  return { get, close };
}
module.exports = { createNewsService };
