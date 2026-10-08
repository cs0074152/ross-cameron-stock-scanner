// 东方财富公开行情适配器。所有请求由 server.js 注入的 safeFetch 发出。
const { CN_TIMEZONE, chinaDate, getChinaMarketInfo } = require('./market-calendar');
const CN_CATEGORIES = new Set(['gainers', 'losers', 'mostActive', 'hodMomentum', 'gapScanner']);
const RANKING_SIZE = 200;
const QUOTE_FIELDS = 'f2,f3,f4,f5,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f124';

function numeric(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatShares(value) {
  if (value == null) return '—';
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return String(Math.round(value));
}

function transformChinaStock(row) {
  const symbol = String(row.f12 || '');
  const price = numeric(row.f2);
  const changePercent = numeric(row.f3);
  if (!/^\d{6}$/.test(symbol) || price == null || price <= 0 || changePercent == null) return null;
  const exchange = Number(row.f13) === 1 ? 'SSE' : /^(4|8|92)/.test(symbol) ? 'BSE' : 'SZSE';
  const open = numeric(row.f17);
  const prevClose = numeric(row.f18);
  const volume = numeric(row.f5);
  // 东方财富 f5 单位为手，统一转换成股；f21 / 最新价估算流通股数。
  const volumeRaw = volume == null ? null : volume * 100;
  const floatCap = numeric(row.f21);
  const floatRaw = floatCap != null && floatCap > 0 ? floatCap / price : null;
  const gap = open > 0 && prevClose > 0 ? (open - prevClose) / prevClose * 100 : null;
  const rvol = numeric(row.f10);
  const quoteSeconds = numeric(row.f124);
  const quoteTime = quoteSeconds > 0 && Number.isFinite(new Date(quoteSeconds * 1000).getTime())
    ? new Date(quoteSeconds * 1000).toISOString() : null;
  const name = String(row.f14 || symbol);
  const board = exchange === 'BSE' ? 'BSE' : /^68/.test(symbol) ? 'STAR' : /^30/.test(symbol) ? 'CHINEXT' : 'MAIN';
  const boardLabel = { BSE: '北交所', STAR: '科创板', CHINEXT: '创业板', MAIN: '主板' }[board];
  const riskWarning = /^S?\*?ST/i.test(name);
  // N/C 名称前缀能提示新股，缺少上市日期时不能反向保证已过无涨跌幅限制期。
  const newListing = /^[NC]/.test(name) ? true : null;
  const ruleDate = quoteTime ? chinaDate(quoteTime) : chinaDate(new Date());
  const standardLimitPct = board === 'BSE' ? 30 : board === 'MAIN'
    ? riskWarning && ruleDate < '2026-07-06' ? 5 : 10 : 20;
  return {
    market: 'CN', currency: 'CNY', symbol, name, exchange, board, boardLabel, riskWarning,
    newListing, listingDate: null, limitPct: newListing ? null : standardLimitPct,
    standardLimitPct, limitIsEstimate: !newListing, limitRuleDate: ruleDate,
    chartSymbol: exchange === 'BSE' ? null : `${exchange}:${symbol}`,
    quoteUrl: `https://quote.eastmoney.com/unify/r/${Number(row.f13) === 1 ? 1 : 0}.${symbol}`,
    price: price.toFixed(2), change: numeric(row.f4)?.toFixed(2) ?? '—',
    changePercent: changePercent.toFixed(2), volumeRaw, volume: formatShares(volumeRaw),
    gap: gap?.toFixed(2) ?? '—', floatRaw, float: formatShares(floatRaw),
    floatSource: floatRaw == null ? 'unavailable' : 'circulatingCap',
    rvol: rvol?.toFixed(2) ?? '—', high: numeric(row.f15)?.toFixed(2) ?? '—',
    low: numeric(row.f16)?.toFixed(2) ?? '—', open: open?.toFixed(2) ?? '—',
    prevClose: prevClose?.toFixed(2) ?? '—', marketCap: numeric(row.f20), quoteTime
  };
}

async function fetchChinaRanking(safeFetch, field, descending = true, signal) {
  const url = new URL('https://push2.eastmoney.com/api/qt/clist/get');
  url.search = new URLSearchParams({
    pn: '1', pz: String(RANKING_SIZE), po: descending ? '1' : '0', np: '1', fltt: '2', invt: '2',
    // 东方财富行情中心 bj_a_board 当前使用 s:262144 限定北交所上市股票。
    // https://quote.eastmoney.com/center/static/build/index.js
    fid: field, fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:262144',
    fields: QUOTE_FIELDS
  });
  const response = await safeFetch(url.toString(), {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000), redirect: 'error'
  });
  if (!response.ok) throw new Error(`东方财富 HTTP ${response.status}`);
  const body = await response.json();
  const diff = body?.data?.diff;
  if (body.rc !== 0 || !diff || typeof diff !== 'object') throw new Error('东方财富行情格式异常');
  const stocks = (Array.isArray(diff) ? diff : Object.values(diff)).map(transformChinaStock).filter(Boolean);
  if (!stocks.length) throw new Error('东方财富未返回有效行情');
  return stocks.sort((a, b) => {
    const av = field === 'f5' ? a.volumeRaw : Number(a.changePercent);
    const bv = field === 'f5' ? b.volumeRaw : Number(b.changePercent);
    return descending ? bv - av : av - bv;
  });
}

async function fetchChinaSnapshot(safeFetch, signal) {
  const [gainers, losers, mostActive] = await Promise.all([
    fetchChinaRanking(safeFetch, 'f3', true, signal), fetchChinaRanking(safeFetch, 'f3', false, signal),
    fetchChinaRanking(safeFetch, 'f5', true, signal)
  ]);
  const all = [...new Map([...gainers, ...losers, ...mostActive].map(s => [s.symbol, s])).values()];
  return {
    scope: { kind: 'ranked-sample', perRanking: RANKING_SIZE, sampleSize: all.length,
      description: `涨幅、跌幅及成交量各前 ${RANKING_SIZE} 只的去重样本，非全市场扫描` },
    gainers: gainers.filter(s => Number(s.changePercent) > 0),
    losers: losers.filter(s => Number(s.changePercent) < 0), mostActive,
    // 通用数值筛选，不能套用美股的美元价格或小流通盘条件。
    hodMomentum: all.filter(s => Number(s.changePercent) >= 5 &&
      Number(s.high) > 0 && Number(s.price) >= Number(s.high) * 0.998)
      .sort((a, b) => Number(b.changePercent) - Number(a.changePercent)),
    gapScanner: all.filter(s => Math.abs(Number(s.gap)) >= 4)
      .sort((a, b) => Math.abs(Number(b.gap)) - Math.abs(Number(a.gap)))
  };
}

// 独立查询持仓/选中股票，避免它跌出排行榜后行情被冻结。
// 与 clist 相同的 fltt=2 及字段集合；批量接口缺失的代码不回填旧值。
async function fetchChinaQuotes(safeFetch, symbols, signal) {
  if (!Array.isArray(symbols)) throw new Error('Invalid A-share symbol list');
  const codes = [...new Set(symbols.map(String))];
  if (codes.length > 500 || codes.some(code => !/^\d{6}$/.test(code))) throw new Error('Invalid A-share symbols');
  const quotes = [];
  for (let start = 0; start < codes.length; start += 50) {
    const batch = codes.slice(start, start + 50);
    const url = new URL('https://push2.eastmoney.com/api/qt/ulist.np/get');
    url.search = new URLSearchParams({
      secids: batch.map(code => `${/^6/.test(code) ? 1 : 0}.${code}`).join(','),
      fields: QUOTE_FIELDS, fltt: '2', invt: '2', np: '1', pz: '50'
    });
    const response = await safeFetch(url.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000), redirect: 'error'
    });
    if (!response.ok) throw new Error(`东方财富持仓行情 HTTP ${response.status}`);
    const body = await response.json();
    const diff = body?.data?.diff;
    if (body?.rc !== 0 || !diff || typeof diff !== 'object') throw new Error('东方财富持仓行情格式异常');
    const wanted = new Set(batch);
    for (const row of Array.isArray(diff) ? diff : Object.values(diff)) {
      const stock = transformChinaStock(row);
      if (stock && wanted.has(stock.symbol)) quotes.push(stock);
    }
  }
  return [...new Map(quotes.map(stock => [stock.symbol, stock])).values()];
}

module.exports = { CN_CATEGORIES, CN_TIMEZONE, chinaDate, getChinaMarketInfo, transformChinaStock, fetchChinaSnapshot, fetchChinaQuotes };
