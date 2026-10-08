// JSON行情与A股启动不需要HTML解析器；首次解析盘前/盘后页面时再加载。
let cheerio;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const FLOAT_TTL = 6 * 60 * 60 * 1000;
const validSymbol = s => typeof s === 'string' && /^[A-Z0-9][A-Z0-9.^=-]{0,19}$/.test(s);
const value = (n, fallback = 0) => Number.isFinite(Number(n)) && n != null ? Number(n) : fallback;
const format = n => n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n);
function timestamp(seconds) { return value(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : null; }
function transformYahooStock(q, session = 'regular') {
  if (!validSymbol(q.symbol)) return null;
  const regular = value(q.regularMarketPrice);
  const extended = session === 'premarket' ? 'pre' : session === 'afterhours' ? 'post' : null;
  const useExtended = extended && value(q[`${extended}MarketPrice`]) > 0 &&
    value(q[`${extended}MarketTime`]) >= value(q.regularMarketTime);
  const price = useExtended ? Number(q[`${extended}MarketPrice`]) : regular;
  if (!(price > 0)) return null;
  const change = useExtended ? value(q[`${extended}MarketChange`]) : value(q.regularMarketChange);
  const pct = useExtended ? value(q[`${extended}MarketChangePercent`]) : value(q.regularMarketChangePercent);
  const prev = value(q.regularMarketPreviousClose, regular - value(q.regularMarketChange));
  const open = value(q.regularMarketOpen);
  const avg = value(q.averageDailyVolume3Month);
  const volume = useExtended ? null : value(q.regularMarketVolume);
  const shares = value(q.floatShares || q.sharesOutstanding);
  return { market: 'US', currency: 'USD', symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
    price: price.toFixed(2), change: change.toFixed(2), changePercent: pct.toFixed(2),
    volumeRaw: volume, volume: format(volume), gap: open > 0 && prev > 0 ? ((open - prev) / prev * 100).toFixed(2) : '—',
    floatRaw: shares || null, float: format(shares || null), floatSource: q.floatShares ? 'float' : 'outstanding',
    rvol: !useExtended && avg > 0 ? (volume / avg).toFixed(2) : '—', high: value(q.regularMarketDayHigh, regular).toFixed(2),
    low: value(q.regularMarketDayLow, regular).toFixed(2), open: open > 0 ? open.toFixed(2) : '—',
    prevClose: prev.toFixed(2), avgVolume: avg, marketCap: value(q.marketCap),
    quoteTime: timestamp(useExtended ? q[`${extended}MarketTime`] : q.regularMarketTime),
    quoteSession: useExtended ? session : 'regular', dataSource: '雅虎财经',
    delayedMinutes: value(q.exchangeDataDelayedBy), chartSymbol: q.symbol };
}
function parseAmount(text) {
  const cleaned = String(text || '').replace(/[$,%\s]/g, '');
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return n * (/B$/i.test(cleaned) ? 1e9 : /M$/i.test(cleaned) ? 1e6 : /K$/i.test(cleaned) ? 1e3 : 1);
}
function parseExtendedTable(html, session) {
  cheerio ||= require('cheerio');
  const $ = cheerio.load(html);
  const headers = $('thead th').map((i, e) => $(e).text().trim().toLowerCase()).get();
  const volumeIndex = headers.findIndex(h => h.includes('volume'));
  const capIndex = headers.findIndex(h => h.includes('market cap'));
  const dateText = $('main').text().match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/)?.[0];
  const sourceDate = dateText ? new Date(`${dateText} 12:00:00 GMT-0400`).toISOString().slice(0, 10) : null;
  const rows = [];
  $('tbody tr').each((i, row) => {
    const tds = $(row).find('td');
    const symbol = $(tds[1]).text().trim();
    const price = parseAmount($(tds[4]).text());
    const change = parseAmount($(tds[3]).text());
    if (!validSymbol(symbol) || !(price > 0) || change == null) return;
    const volume = volumeIndex >= 0 ? parseAmount($(tds[volumeIndex]).text()) : null;
    rows.push({ market: 'US', currency: 'USD', symbol, name: $(tds[2]).text().trim(),
      price: price.toFixed(2), change: '—', changePercent: change.toFixed(2),
      volumeRaw: volume, volume: format(volume), marketCap: capIndex >= 0 ? parseAmount($(tds[capIndex]).text()) : null,
      gap: '—', floatRaw: null, float: '—', floatSource: 'unavailable', rvol: '—',
      high: '—', low: '—', open: '—', prevClose: '—', quoteTime: null,
      sourceDate, quoteSession: session, dataSource: 'StockAnalysis', chartSymbol: symbol });
  });
  if (!rows.length) throw new Error('StockAnalysis 未返回可识别的行情表格');
  return rows.slice(0, 200);
}
function createUSProvider(safeFetch) {
  const floatCache = new Map();
  let crumb = null;
  let crumbPending = null;
  async function getCrumb(force = false, signal) {
    if (!force && crumb && Date.now() - crumb.ts < 3600000) return crumb;
    if (!force && crumbPending) return crumbPending;
    const pending = (async () => {
      const response = await safeFetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual', signal });
      const cookie = (response.headers.getSetCookie?.() || []).map(s => s.split(';')[0]).join('; ');
      const tokenResponse = await safeFetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie }, signal });
      if (!tokenResponse.ok) throw new Error(`Yahoo 凭证 HTTP ${tokenResponse.status}`);
      const token = (await tokenResponse.text()).trim();
      if (!token || token.length > 24 || /[<>\s]/.test(token)) throw new Error('Yahoo 凭证不可用');
      crumb = { token, cookie, ts: Date.now() };
      return crumb;
    })();
    crumbPending = pending;
    try { return await pending; } finally { if (crumbPending === pending) crumbPending = null; }
  }
  async function yahooJSON(path, signal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await getCrumb(attempt > 0, signal);
      const url = new URL(`https://query1.finance.yahoo.com${path}`);
      url.searchParams.set('crumb', auth.token);
      const response = await safeFetch(url.toString(), { headers: { 'User-Agent': UA, Cookie: auth.cookie }, signal });
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
      return response.json();
    }
    throw new Error('Yahoo 凭证重试失败');
  }
  async function fetchRanking(category, session, signal) {
    if (session === 'premarket' || session === 'afterhours') {
      // 盘后页没有可靠的成交活跃榜，不把收盘价或盘前榜伪装为盘后数据。
      if (session === 'afterhours' && category === 'mostActive') return [];
      const page = category === 'mostActive' ? 'most-active' : category;
      const response = await safeFetch(`https://stockanalysis.com/markets/${session}/${page}/`, { headers: { 'User-Agent': UA }, signal });
      if (!response.ok) throw new Error(`StockAnalysis HTTP ${response.status}`);
      return parseExtendedTable(await response.text(), session);
    }
    const scrIds = { gainers: 'day_gainers', losers: 'day_losers', mostActive: 'most_actives' };
    const response = await safeFetch(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrIds[category]}&count=200`, { headers: { 'User-Agent': UA }, signal });
    if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
    const json = await response.json();
    const quotes = json?.finance?.result?.[0]?.quotes;
    if (!Array.isArray(quotes) || !quotes.length) throw new Error('Yahoo 未返回有效榜单');
    const stocks = quotes.map(q => transformYahooStock(q)).filter(Boolean);
    if (!stocks.length) throw new Error('Yahoo 榜单行情无效');
    return stocks;
  }
  async function fetchQuotes(symbols, session, signal) {
    const wanted = [...new Set(symbols.filter(validSymbol))];
    if (!wanted.length) return [];
    const rows = [];
    for (let i = 0; i < wanted.length; i += 50) {
      const json = await yahooJSON(`/v7/finance/quote?symbols=${encodeURIComponent(wanted.slice(i, i + 50).join(','))}`, signal);
      if (!Array.isArray(json?.quoteResponse?.result)) throw new Error('Yahoo 独立报价格式异常');
      rows.push(...json.quoteResponse.result.map(q => transformYahooStock(q, session)).filter(Boolean));
    }
    return rows;
  }
  async function enrichFloats(stocks, signal) {
    const now = Date.now();
    for (const [key, cached] of floatCache) if (now - cached.ts > FLOAT_TTL) floatCache.delete(key);
    const symbols = [...new Set(stocks.map(s => s.symbol))].filter(s => !floatCache.has(s)).slice(0, 5);
    await Promise.all(symbols.map(async symbol => {
      try {
        const json = await yahooJSON(`/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics`, signal);
        const float = json?.quoteSummary?.result?.[0]?.defaultKeyStatistics?.floatShares?.raw;
        floatCache.set(symbol, { float: Number.isFinite(float) && float > 0 ? float : null, ts: Date.now() });
      } catch { floatCache.set(symbol, { float: null, ts: Date.now() - FLOAT_TTL + 60000 }); }
    }));
    for (const stock of stocks) {
      const float = floatCache.get(stock.symbol)?.float;
      if (float > 0) { stock.floatRaw = float; stock.float = format(float); stock.floatSource = 'float'; }
    }
  }
  return { fetchRanking, fetchQuotes, enrichFloats };
}
module.exports = { createUSProvider, transformYahooStock, parseExtendedTable };
