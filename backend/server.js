// 本文件仅协调模块、API 与轮询；行情、策略、持仓存储均可独立测试。
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const path = require('path');
const { randomUUID } = require('crypto');
const { createSafeFetch } = require('./safe-fetch');
const { createNewsService } = require('./news-service');
const { getMarketInfo } = require('./market-calendar');
const { createUSProvider } = require('./market-us');
const { fetchChinaSnapshot, fetchChinaQuotes } = require('./market-cn');
const { deriveScanners } = require('./scanner-filters');
const { createStrategyEngine } = require('./strategy');
const { cnMetadata } = require('./strategy');
const { createPositionStore } = require('./positions');
http.setGlobalProxyFromEnv?.();
const MARKETS = new Set(['US', 'CN']);
const CATEGORIES = new Set(['gainers', 'losers', 'mostActive', 'premarket', 'afterhours',
  'fivePillars', 'strictFivePillars', 'docPick', 'docPickStrict', 'hodMomentum', 'gapScanner', 'cnWatch']);
const CN_CATEGORIES = new Set(['gainers', 'losers', 'mostActive', 'hodMomentum', 'gapScanner', 'cnWatch']);
const emptyCache = () => ({ gainers: [], losers: [], mostActive: [], premarket: [], afterhours: [],
  strategyPool: { limited: true, rows: [] }, quotes: {} });
const validSymbol = (s, market) => market === 'CN' ? /^\d{6}$/.test(s) : /^[A-Z0-9][A-Z0-9.^=-]{0,19}$/.test(s);
// 某榜失败会保留旧快照。合并时必须择最新报价，不能靠榜单排列顺序覆盖。
function mergeQuotesLatest(lists, { session, market = 'US', tradingDate } = {}) {
  const result = new Map();
  // 一次合并复用日期格式器和每条报价的结果，避免逐类别先播时反复创建Intl实例。
  const times = new Map(), priorities = new Map();
  const dateFormatter = session ? new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'CN' ? 'Asia/Shanghai' : 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }) : null;
  const time = q => {
    if (!times.has(q)) times.set(q, Date.parse(q?.quoteTime || q?.sourceDate || '') || 0);
    return times.get(q);
  };
  const priority = q => {
    if (!session) return 0;
    if (!priorities.has(q)) {
      const sourceTime = Date.parse(q.quoteTime);
      const date = q.quoteTime ? Number.isFinite(sourceTime) ? dateFormatter.format(new Date(sourceTime)) : null : q.sourceDate;
      priorities.set(q, q.quoteSession === session && date === tradingDate ? 1 : 0);
    }
    return priorities.get(q);
  };
  for (const q of lists.flat()) {
    if (!q?.symbol) continue;
    const previous = result.get(q.symbol);
    if (!previous || priority(q) > priority(previous) ||
      (priority(q) === priority(previous) && time(q) >= time(previous))) result.set(q.symbol, q);
  }
  return result;
}

function createScannerServer(options = {}) {
  const now = options.now || Date.now;
  const info = (market, at = now()) => getMarketInfo(market, new Date(at));
  const safeFetch = options.safeFetch || createSafeFetch();
  const newsService = options.newsService || createNewsService({ safeFetch, now });
  const us = options.usProvider || createUSProvider(safeFetch);
  const cnSnapshot = options.cnSnapshot || (signal => fetchChinaSnapshot(safeFetch, signal));
  const cnQuotes = options.cnQuotes || ((symbols, signal) => fetchChinaQuotes(safeFetch, symbols, signal));
  const engine = options.engine || createStrategyEngine({ getMarketInfo: info });
  const store = options.store || createPositionStore({
    filePath: options.statePath || process.env.STATE_FILE || path.join(__dirname, 'data', 'positions.json'),
    getMarketInfo: info
  });
  const instanceId = randomUUID();
  const revisions = { US: 0, CN: 0 };
  const state = Object.fromEntries([...MARKETS].map(m => [m, {
    cache: emptyCache(), lastUpdate: null, error: null, quoteError: null, refreshing: false,
    source: m === 'CN' ? '东方财富' : '雅虎财经', categories: {}, scope: null
  }]));
  const watched = { US: new Map(), CN: new Map() };
  const allowedOrigins = new Set((options.allowedOrigins || process.env.ALLOWED_ORIGIN ||
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173').split(',').map(s => s.trim()).filter(Boolean));
  const app = express();
  app.set('query parser', 'simple');
  app.use(cors({ origin: [...allowedOrigins] }));
  app.use(express.json({ limit: '256kb' }));
  // 本机网页仍需 Origin 约束；非浏览器本机请求允许无 Origin。
  app.use((req, res, next) => req.headers.origin && !allowedOrigins.has(req.headers.origin)
    ? res.status(403).json({ error: 'Origin not allowed' }) : next());
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
  const getMarket = req => {
    const market = req.query.market || req.body?.market || 'US';
    if (!MARKETS.has(market)) throw Object.assign(new Error('Unknown market'), { status: 400 });
    return market;
  };
  function snapshot(market, type = 'update') {
    const s = state[market];
    const meta = info(market);
    const all = [s.cache.gainers, s.cache.losers, s.cache.mostActive, Object.values(s.cache.quotes || {})].flat();
    const quoteTimes = all.map(q => q?.quoteTime).filter(Boolean).sort();
    const quoteTime = quoteTimes.at(-1) || null;
    const sourceDate = all.map(q => q?.sourceDate).filter(Boolean).sort().at(-1) || null;
    return { type, market, instanceId, positionsDurable: true, positionsRevision: revisions[market],
      data: { ...s.cache, positions: store.list(market) }, session: meta.session,
      lastUpdateTime: s.lastUpdate, quoteTime,
      dataDate: quoteTime ? new Date(quoteTime).toLocaleDateString('en-CA', { timeZone: meta.timeZone || (market === 'CN' ? 'Asia/Shanghai' : 'America/New_York') }) : sourceDate,
      tradingDate: meta.date, marketTime: meta.marketTime, marketMinutes: meta.minutes, marketDay: meta.day,
      timeZone: meta.timeZone, dataSource: s.source, dataError: [s.error, s.quoteError].filter(Boolean).join('；') || null,
      calendarKnown: meta.calendarKnown, categoryStatus: s.categories, scope: s.scope,
      ...(market === 'US' ? { etTime: meta.marketTime, etMinutes: meta.minutes, etDay: meta.day } : {}),
      timestamp: new Date(now()).toISOString() };
  }
  function send(client, message) {
    if (client.readyState !== WebSocket.OPEN) return;
    try { client.send(message, error => { if (error) client.terminate(); }); }
    catch { client.terminate(); }
  }
  function broadcast(market) {
    const message = JSON.stringify(snapshot(market));
    for (const client of wss.clients) if (client.market === market) send(client, message);
  }
  function pool(market, quotes, scanners, gainers, session) {
    const wanted = new Map();
    const candidates = market === 'CN' ? scanners.cnWatch || [] : [...(scanners.docPickStrict || []), ...(scanners.docPick || [])];
    for (const q of candidates) wanted.set(q.symbol, market === 'CN' || session !== 'regular');
    const limited = wanted.size === 0 || session !== 'regular';
    if (limited && market === 'US') for (const q of gainers.slice(0, 10)) wanted.set(q.symbol, true);
    const order = { trigger: 0, based: 1, pullback: 2, rally: 3, watch: 4, stale: 5 };
    const rows = [];
    for (const [symbol, watchOnly] of wanted) {
      const q = quotes.get(symbol);
      if (!q) continue;
      const analysis = session === 'regular' ? engine.analyze(symbol, market, now()) : null;
      rows.push({ ...q, ...(market === 'CN' ? cnMetadata(q) : {}), dayHigh: q.high, ...analysis, state: analysis?.state || 'watch',
        watchOnly, held: store.positions.has(`${market}:${symbol}`) });
    }
    rows.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || Number(b.changePercent) - Number(a.changePercent));
    return { limited, rows: rows.slice(0, 30), market, observationOnly: market === 'CN' };
  }

  // 展示榜单不必等待独立持仓报价或float补全。此阶段不运行策略、不修改权威持仓。
  function publishRankings(market, meta) {
    const s = state[market];
    const lists = [s.cache.gainers, s.cache.losers, s.cache.mostActive];
    const all = [...mergeQuotesLatest(lists, {
      market, session: meta.session, tradingDate: meta.lastTradingDate || meta.date
    }).values()];
    s.cache = { ...s.cache, ...deriveScanners(all, market) };
    if (market === 'US') {
      s.scope = { kind: 'ranked-sample', perRanking: 200, label: '榜单合并样本',
        description: meta.session === 'afterhours' ? '盘后涨跌榜合并样本；无可靠盘后成交活跃榜。页面报价缺少精确时间，买点仅观察。' :
          '三类榜单各最多 200 只；来源可能返回更少，筛选不代表全市场。' };
      if (meta.session === 'premarket') s.cache.premarket = s.cache.gainers;
      if (meta.session === 'afterhours') s.cache.afterhours = s.cache.gainers;
    }
    s.scope = { ...s.scope, sampleSize: all.length };
    const sources = [...new Set(lists.flat().map(q => q.dataSource).filter(Boolean))];
    if (sources.length) s.source = sources.join(' / ') + (sources.length > 1 ? '（含保留数据）' : '');
    broadcast(market);
  }

  async function refresh(market) {
    const s = state[market];
    if (s.refreshing) return;
    s.refreshing = true;
    const meta = info(market);
    const roundSignal = AbortSignal.timeout(12000);
    try {
      for (const [symbol, expiry] of watched[market]) if (expiry < now()) watched[market].delete(symbol);
      const tracked = [...new Set([...store.list(market).map(p => p.symbol), ...watched[market].keys()])];
      const quotePromise = market === 'CN' ? cnQuotes(tracked, roundSignal) : us.fetchQuotes(tracked, meta.session, roundSignal);
      // 报价任务独立于排行榜；榜单失败不阻断持仓监控。
      const categories = ['gainers', 'losers', 'mostActive'];
      let categoriesFinished = 0;
      const rankingSession = ['premarket', 'afterhours'].includes(meta.session) ? meta.session : 'regular';
      const rankingPromise = market === 'CN' ? cnSnapshot(roundSignal).then(snapshot => {
        // CN仍按完整三榜原子成功，避免改变任何一榜失败时保留完整旧快照的语义。
        s.cache = { ...s.cache, ...snapshot };
        s.scope = snapshot.scope;
        s.lastUpdate = new Date(now()).toISOString();
        for (const category of categories) s.categories[category] = { lastSuccess: s.lastUpdate, error: null };
        s.error = null;
        publishRankings(market, meta);
        return snapshot;
      }) : Promise.allSettled(categories.map(async category => {
        try {
          const rows = await us.fetchRanking(category, rankingSession, roundSignal);
          s.cache[category] = rows;
          s.categories[category] = { lastSuccess: new Date(now()).toISOString(), error: null, session: rankingSession };
          categoriesFinished++;
          s.error = categories.map(name => s.categories[name]?.error).filter(Boolean).join('；') || null;
          if (categoriesFinished === categories.length && !s.error) s.lastUpdate = new Date(now()).toISOString();
          publishRankings(market, meta);
          return rows;
        } catch (error) {
          categoriesFinished++;
          const message = `${category} 行情获取失败，保留上次成功数据`;
          s.categories[category] = { ...s.categories[category], error: message };
          s.error = categories.map(name => s.categories[name]?.error).filter(Boolean).join('；') || null;
          throw error;
        }
      }));
      const [rankings, quotes] = await Promise.allSettled([rankingPromise, quotePromise]);
      const errors = [];
      if (market === 'CN') {
        if (rankings.status === 'rejected') errors.push('A 股榜单暂时无法刷新，保留上次成功数据');
      } else if (rankings.status === 'fulfilled') {
        rankings.value.forEach((result, i) => {
          const category = categories[i];
          if (result.status === 'rejected') errors.push(s.categories[category].error);
        });
      } else errors.push('美股榜单暂时无法刷新，保留上次成功数据');
      s.error = errors.join('；') || null;
      const independent = quotes.status === 'fulfilled' ? quotes.value : [];
      const missing = tracked.filter(symbol => !independent.some(q => q.symbol === symbol && q.quoteTime));
      s.quoteError = missing.length ? `独立报价暂缺：${missing.slice(0, 5).join('、')}，持仓将显示报价状态` : null;
      const displayOptions = { market, session: meta.session, tradingDate: meta.lastTradingDate || meta.date };
      const rankingLists = [s.cache.gainers, s.cache.losers, s.cache.mostActive];
      const all = [...mergeQuotesLatest(rankingLists, displayOptions).values()];
      if (market === 'US' && meta.session === 'regular' && !s.error) {
        await us.enrichFloats(all, AbortSignal.any([roundSignal, AbortSignal.timeout(2500)]));
      }
      s.cache.quotes = Object.fromEntries(mergeQuotesLatest([Object.values(s.cache.quotes), independent]));
      for (const symbol of Object.keys(s.cache.quotes)) if (!tracked.includes(symbol)) delete s.cache.quotes[symbol];
      // 展示可采用日期明确的盘后页，策略仅消费独立的真实时间戳报价。
      engine.feed([...rankingLists.flat(), ...independent], market, now());
      engine.updatePositions(store.positions, market, now());
      engine.prune(now());
      store.save();
      revisions[market]++;
      const scanners = deriveScanners(all, market);
      const quoteMap = mergeQuotesLatest([all, independent], displayOptions);
      s.cache = { ...s.cache, ...scanners, strategyPool: pool(market, quoteMap, scanners, s.cache.gainers, meta.session) };
      if (meta.session === 'premarket') s.cache.premarket = s.cache.gainers;
      if (meta.session === 'afterhours') s.cache.afterhours = s.cache.gainers;
      s.scope = { ...s.scope, sampleSize: all.length };
      const sources = [...new Set(rankingLists.flat().map(q => q.dataSource).filter(Boolean))];
      if (sources.length) s.source = sources.join(' / ') + (sources.length > 1 ? '（含保留数据）' : '');
    } catch (error) {
      s.error = `行情更新暂时失败：${error.message}，保留上次成功数据`;
    } finally { s.refreshing = false; broadcast(market); }
  }
  wss.on('error', error => console.error('WebSocket 服务错误:', error.message));
  wss.on('connection', (ws, req) => {
    ws.on('error', () => ws.terminate());
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return ws.close(1008, 'Origin not allowed');
    const market = new URL(req.url, 'http://localhost').searchParams.get('market') || 'US';
    if (!MARKETS.has(market)) return ws.close(1008, 'Unknown market');
    ws.market = market;
    send(ws, JSON.stringify(snapshot(market, 'initial')));
  });
  const wrap = handler => (req, res, next) => { try { Promise.resolve(handler(req, res)).catch(next); } catch (error) { next(error); } };
  const positionResponse = market => ({ ok: true, market, instanceId, positionsDurable: true,
    migrationNeeded: !store.hasState(market), positionsRevision: revisions[market], data: store.list(market) });
  app.get('/api/health', wrap((req, res) => {
    const market = getMarket(req); const message = snapshot(market);
    res.json({ status: 'ok', service: 'ross-cameron-stock-scanner',
      launchId: options.launchId || process.env.SCANNER_LAUNCH_ID || null, instanceId,
      market, session: message.session, marketTime: message.marketTime,
      dataSource: message.dataSource, dataError: message.dataError, quoteTime: message.quoteTime,
      calendarKnown: message.calendarKnown, lastUpdate: message.lastUpdateTime,
      gainersCount: message.data.gainers.length, timestamp: message.timestamp });
  }));
  app.get('/api/scanner/:category', wrap((req, res) => {
    const market = getMarket(req);
    if (!(market === 'CN' ? CN_CATEGORIES : CATEGORIES).has(req.params.category) ||
      (market === 'US' && req.params.category === 'cnWatch')) return res.status(404).json({ error: 'Unknown category' });
    const message = snapshot(market);
    res.json({ ...message, data: message.data[req.params.category] || [] });
  }));
  app.post('/api/watch', wrap((req, res) => {
    const market = getMarket(req); const symbol = String(req.body.symbol || '').toUpperCase();
    if (!validSymbol(symbol, market)) return res.status(400).json({ error: '股票代码格式无效' });
    if (watched[market].size >= 100 && !watched[market].has(symbol)) return res.status(429).json({ error: '观察股票过多' });
    watched[market].set(symbol, now() + 30 * 60 * 1000);
    res.json({ ok: true });
  }));
  app.get('/api/news/:symbol', wrap(async (req, res) => {
    const market = getMarket(req), symbol = req.params.symbol.toUpperCase();
    if (!validSymbol(symbol, market)) return res.status(400).json({ error: '股票代码格式无效' });
    if (req.query.refresh !== undefined && !['0', '1'].includes(req.query.refresh)) return res.status(400).json({ error: 'refresh 必须为 0 或 1' });
    res.json(await newsService.get(market, symbol, { refresh: req.query.refresh === '1' }));
  }));
  app.get('/api/positions', wrap((req, res) => res.json(positionResponse(getMarket(req)))));
  app.get('/api/trades', wrap((req, res) => {
    const market = getMarket(req);
    res.json({ data: store.trades ? store.trades(market) : [] });
  }));
  app.post('/api/positions', wrap((req, res) => {
    const market = getMarket(req);
    store.upsert(req.body, market, { now: now() });
    revisions[market]++;
    res.json(positionResponse(market)); broadcast(market);
  }));
  app.post('/api/positions/sync', wrap((req, res) => {
    const market = getMarket(req);
    if (!Array.isArray(req.body.positions)) return res.status(400).json({ error: 'positions 必须为数组' });
    // 只迁移从未持久化的市场，空仓同样有权威状态，不能恢复已平仓旧镜像。
    if (!store.hasState(market)) { store.restore(req.body.positions, market, { now: now() }); revisions[market]++; }
    res.json(positionResponse(market)); broadcast(market);
  }));
  app.delete('/api/positions/:symbol', wrap((req, res) => {
    const market = getMarket(req);
    const result = store.close(req.params.symbol.toUpperCase(), market, {
      operationId: req.body?.operationId || req.headers['idempotency-key'] || req.query.operationId,
      now: now(), session: info(market).session
    });
    revisions[market]++;
    res.json({ ...positionResponse(market), ...result, data: store.list(market) }); broadcast(market);
  }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.status === 429 && error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    res.status(error.status || 500).json({ error: error.status ? error.message : '服务处理失败，请重试' });
    if (!error.status) console.error(error);
  });
  const intervals = [];
  function start(port = Number(process.env.PORT || 3001), host = process.env.HOST || '127.0.0.1') {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('服务仅允许绑定本机回环地址');
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        if (options.poll !== false) {
          for (const market of MARKETS) {
            refresh(market);
            intervals.push(setInterval(() => refresh(market), 15000));
          }
        }
        resolve(server.address());
      });
    });
  }
  async function stop() {
    newsService.close();
    intervals.forEach(clearInterval);
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
  return { app, server, wss, start, stop, refresh, snapshot, state, store, engine };
}
if (require.main === module) {
  const scanner = createScannerServer();
  scanner.start().then(address => console.log(`股票扫描器启动 http://${address.address}:${address.port}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createScannerServer, mergeQuotesLatest };
