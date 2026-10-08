// Snapshot strategy engine. Prices are samples, not OHLC candles.
const WINDOW_MS = 15 * 60 * 1000;
const QUOTE_MAX_AGE_MS = 3 * 60 * 1000;
const CONFIG = {
  US: { pullbackMinPct: 0.01, pullbackMinTicks: 2, baseRangePct: 0.008, baseTicks: 3, rrMin: 2, fadePctMin: 0.02 },
  // A-share signals are observations, with their own parameters and T+1 warnings.
  CN: { pullbackMinPct: 0.015, pullbackMinTicks: 2, baseRangePct: 0.006, baseTicks: 3, rrMin: 2, fadePctMin: 0.03 }
};
const ACTIVE_SESSIONS = new Set(['premarket', 'regular', 'afterhours', 'auction', 'preopen', 'closingAuction']);

function normalizeMarket(market = 'US') {
  if (market !== 'US' && market !== 'CN') throw new Error('Unknown market');
  return market;
}

function marketDate(timestamp, market = 'US') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'CN' ? 'Asia/Shanghai' : 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(timestamp));
}

function timestampOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Fallback clock is deliberately calendar-unknown; the server supplies its calendar.
function defaultMarketInfo(market, now) {
  const date = marketDate(now, market);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: market === 'CN' ? 'Asia/Shanghai' : 'America/New_York',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  let session = 'closed';
  if (day > 0 && day < 6) {
    if (market === 'US') {
      if (minute >= 240 && minute < 570) session = 'premarket';
      else if (minute >= 570 && minute < 960) session = 'regular';
      else if (minute >= 960 && minute < 1200) session = 'afterhours';
    } else {
      if (minute >= 555 && minute < 565) session = 'auction';
      else if (minute >= 565 && minute < 570) session = 'preopen';
      else if ((minute >= 570 && minute < 690) || (minute >= 780 && minute < 897)) session = 'regular';
      else if (minute >= 690 && minute < 780) session = 'lunch';
      else if (minute >= 897 && minute < 900) session = 'closingAuction';
    }
  }
  return { date, session, calendarKnown: false, lastTradingDate: date, nextTradingDate: null };
}

function cnMetadata(quote = {}) {
  const symbol = String(quote.symbol || '');
  const board = quote.board || (quote.exchange === 'BSE' || /^(4|8|92)/.test(symbol) ? '北交所'
    : /^68[89]/.test(symbol) ? '科创板' : /^30[01]/.test(symbol) ? '创业板' : '主板');
  const boardLabel = quote.boardLabel || ({ BSE: '北交所', STAR: '科创板', CHINEXT: '创业板', MAIN: '主板' }[board] || board);
  const riskWarning = quote.riskWarning || /^S?\*?ST/i.test(String(quote.name || ''));
  const riskFlags = Array.isArray(quote.riskFlags) ? [...quote.riskFlags] : [];
  if (riskWarning && !riskFlags.includes('风险警示股票')) riskFlags.push('风险警示股票');
  if (quote.newListing && !riskFlags.includes('新股涨跌幅限制待确认')) riskFlags.push('新股涨跌幅限制待确认');
  if (!quote.listingDate && quote.newListing == null && !riskFlags.includes('上市日期待核实')) riskFlags.push('上市日期待核实');
  const fallbackLimit = riskWarning || quote.newListing ? null : boardLabel === '北交所' ? 30 : /科创|创业/.test(boardLabel) ? 20 : 10;
  const limitPercent = quote.limitPercent !== undefined ? quote.limitPercent
    : quote.limitPct !== undefined ? quote.limitPct : fallbackLimit;
  return { board, boardLabel, riskWarning: !!riskWarning, riskFlags, riskTags: [...riskFlags],
    limitPercent, limitPct: limitPercent, newListing: quote.newListing ?? null,
    limitIsEstimate: quote.limitIsEstimate ?? true, listingDate: quote.listingDate || null };
}

function createStrategyEngine({ getMarketInfo = defaultMarketInfo } = {}) {
  const ticks = new Map();
  const latestQuotes = new Map();
  const keyOf = (symbol, market) => `${normalizeMarket(market)}:${String(symbol).toUpperCase()}`;

  function prune(now = Date.now()) {
    for (const [key, arr] of ticks) {
      const market = key.slice(0, 2);
      const date = marketDate(now, market);
      const current = arr.filter(t => t.t >= now - WINDOW_MS && t.tradeDate === date);
      if (current.length) ticks.set(key, current);
      else ticks.delete(key);
    }
    // Latest quotes are useful for closed-session positions; keep only a bounded recent history.
    for (const [key, quote] of latestQuotes) {
      if (now - quote.t > 30 * 24 * 60 * 60 * 1000) latestQuotes.delete(key);
    }
  }

  function feed(stocks, market = 'US', now = Date.now()) {
    normalizeMarket(market);
    prune(now);
    const best = new Map();
    for (const quote of (stocks || []).flat()) {
      if (!quote || !quote.symbol) continue;
      const price = Number(quote.price);
      const t = timestampOf(quote.quoteTime);
      if (!Number.isFinite(price) || price <= 0 || t == null || t > now + 60000) continue;
      const key = keyOf(quote.symbol, market);
      // The caller appends independent held-symbol quotes after rankings.
      if (!best.has(key) || t >= best.get(key).t) best.set(key, { quote, price, t });
    }
    let accepted = 0;
    for (const [key, { quote, price, t }] of best) {
      const previous = latestQuotes.get(key);
      if (previous && t <= previous.t) continue;
      const tradeDate = marketDate(t, market);
      const cumVol = Number.isFinite(Number(quote.volumeRaw)) && quote.volumeRaw != null ? Number(quote.volumeRaw) : null;
      const quoteSession = quote.quoteSession || 'regular';
      const sameDate = previous && previous.tradeDate === tradeDate && previous.quoteSession === quoteSession;
      const volume = sameDate && cumVol != null && previous.cumVol != null && cumVol >= previous.cumVol
        ? cumVol - previous.cumVol : null;
      const dayHigh = Number(quote.dayHigh ?? quote.high);
      const sample = {
        t, quoteTime: new Date(t).toISOString(), tradeDate, quoteSession, price, high: price, low: price,
        volume, cumVol, dayHigh: Number.isFinite(dayHigh) && dayHigh > 0 ? Math.max(dayHigh, price) : price,
        name: quote.name || quote.symbol, market, currency: market === 'CN' ? 'CNY' : 'USD',
        ...(market === 'CN' ? cnMetadata(quote) : {})
      };
      latestQuotes.set(key, sample);
      accepted++;
      if (t < now - WINDOW_MS || tradeDate !== marketDate(now, market)) continue;
      let arr = ticks.get(key) || [];
      arr = arr.filter(tick => tick.tradeDate === tradeDate && tick.t >= now - WINDOW_MS);
      arr.push(sample);
      ticks.set(key, arr);
    }
    return accepted;
  }

  function analyze(symbol, market = 'US', now = Date.now()) {
    normalizeMarket(market);
    prune(now);
    const arr = ticks.get(keyOf(symbol, market));
    if (!arr || arr.length < 5) return null;
    const last = arr.at(-1);
    if (now - last.t > QUOTE_MAX_AGE_MS) return null;
    if (market === 'CN' && last.riskWarning) return null;
    const cfg = CONFIG[market];
    const window = arr.slice(-20);
    let recentHigh = 0, recentHighIdx = -1;
    // Keep the first occurrence of an equal sample high; dayHigh is not a candle high.
    window.forEach((tick, i) => { if (tick.price > recentHigh) { recentHigh = tick.price; recentHighIdx = i; } });
    const ticksSinceHigh = window.length - 1 - recentHighIdx;
    const pullback = window.slice(recentHighIdx + 1);
    const pullbackLow = Math.min(...pullback.map(t => t.price), last.price);
    const pullbackPct = recentHigh > 0 ? (recentHigh - pullbackLow) / recentHigh : 0;
    const pullingBack = ticksSinceHigh >= cfg.pullbackMinTicks && pullbackPct >= cfg.pullbackMinPct;
    const base = arr.slice(-cfg.baseTicks);
    const based = pullingBack && (Math.max(...base.map(t => t.price)) - Math.min(...base.map(t => t.price))) / last.price <= cfg.baseRangePct;
    const crossAbovePrev = last.price > arr.at(-2).price;
    const target = Math.max(recentHigh, ...window.map(t => t.dayHigh));
    const riskPer = last.price - pullbackLow;
    const rr = riskPer > 0 ? (target - last.price) / riskPer : null;
    let state = pullingBack ? (based ? 'based' : 'pullback') : 'rally';
    if (state === 'based' && crossAbovePrev && rr != null && rr >= cfg.rrMin) state = 'trigger';
    return {
      state, recentHigh, pullbackLow, pullbackPct, rr, target,
      market, currency: last.currency, quoteTime: last.quoteTime, tradeDate: last.tradeDate,
      watchOnly: market === 'CN', observationOnly: market === 'CN',
      ...(market === 'CN' ? { ...cnMetadata(last), warning: 'A 股信号仅为观察提示；请结合涨跌停、停牌、流动性及 T+1 限制判断。' } : {})
    };
  }

  function updatePositions(positions, market = 'US', now = Date.now()) {
    normalizeMarket(market);
    prune(now);
    const info = getMarketInfo(market, now) || defaultMarketInfo(market, now);
    const date = info.date || marketDate(now, market);
    for (const pos of positions.values()) {
      if ((pos.market || 'US') !== market) continue;
      const quote = latestQuotes.get(keyOf(pos.symbol, market));
      const active = ACTIVE_SESSIONS.has(info.session);
      const quoteDate = quote ? quote.tradeDate : null;
      const validDate = active ? quoteDate === date : quoteDate === (info.lastTradingDate || date);
      const fresh = quote && validDate && (!active || now - quote.t <= QUOTE_MAX_AGE_MS);
      const savedTime = timestampOf(pos.quoteTime);
      pos.market = market;
      pos.currency = market === 'CN' ? 'CNY' : 'USD';
      if (market === 'CN') {
        const buyDate = pos.lastBuyDate || pos.tradeDate || marketDate(pos.entryTime || now, market);
        const settlementDate = active ? date : (info.lastTradingDate || quoteDate || date);
        pos.cannotSell = buyDate >= settlementDate;
        pos.sellable = !pos.cannotSell;
        pos.tradableOn = pos.cannotSell && info.calendarKnown ? (info.nextTradingDate || null) : null;
        Object.assign(pos, cnMetadata(quote || pos));
      } else {
        pos.cannotSell = false;
        pos.sellable = true;
        pos.tradableOn = null;
      }
      if (!fresh || (savedTime != null && quote.t < savedTime)) {
        pos.status = 'stale';
        pos.signals = ['行情缺失或已过期，无法继续判断止损和止盈。', ...(pos.cannotSell ? ['A 股 T+1：当日买入的股份尚不可卖出。'] : [])];
        continue;
      }
      // Never advance a position's timestamp using the polling clock.
      pos.price = quote.price;
      pos.quoteTime = quote.quoteTime;
      pos.quoteSession = quote.quoteSession;
      pos.updatedAt = quote.t;
      pos.peak = Math.max(Number(pos.peak) || pos.entry, pos.entry, quote.price);
      pos.pnlPct = ((quote.price - pos.entry) / pos.entry) * 100;
      const currency = market === 'CN' ? '¥' : '$';
      const signals = [];
      let status = 'holding';
      if (Number.isFinite(pos.stop) && quote.price <= pos.stop) {
        status = 'stop_triggered';
        signals.push(`触及止损位 ${currency}${pos.stop.toFixed(2)}（回调低点）`);
      } else {
        if (Number.isFinite(pos.target) && quote.price >= pos.target) {
          status = 'target_hit';
          signals.push(`到达止盈目标 ${currency}${pos.target.toFixed(2)}（当日高点附近）`);
        }
        const gain = (pos.peak - pos.entry) / pos.entry;
        const fade = (pos.peak - quote.price) / pos.peak;
        if (gain >= 0.02 && fade >= Math.max(CONFIG[market].fadePctMin, gain * 0.4)) {
          signals.push(`从持仓最高点回落 ${(fade * 100).toFixed(1)}% —— 离场信号④`);
          if (status === 'holding') status = 'warning';
        }
        const arr = (ticks.get(keyOf(pos.symbol, market)) || []).filter(t => t.t >= (pos.entryTime || 0));
        if (arr.length >= 9) {
          const w = arr.slice(-6);
          if (w.every(t => t.volume != null && t.quoteSession === w[0].quoteSession)) {
            const vRecent = w.slice(-3).reduce((a, t) => a + t.volume, 0);
            const vPrior = w.slice(0, 3).reduce((a, t) => a + t.volume, 0);
            const drift = (w[5].price - w[0].price) / w[0].price;
            if (drift >= 0.003 && vPrior > 0 && vRecent < vPrior * 0.5) {
              signals.push('价格仍在上升但量能推动明显减弱 —— 离场信号⑤');
              if (status === 'holding') status = 'warning';
            }
            if (Math.abs(drift) <= 0.002 && vRecent > 0 && pos.peak >= pos.entry * 1.01) {
              signals.push('持续有成交但价格滞涨 —— 疑似隐藏卖家，离场信号②');
              if (status === 'holding') status = 'warning';
            }
          }
        }
      }
      if (pos.cannotSell) signals.push('A 股 T+1：当日买入的股份尚不可卖出，止损／止盈仅作提醒。');
      pos.status = status;
      pos.signals = signals;
    }
    return Array.from(positions.values()).filter(p => (p.market || 'US') === market);
  }

  return { feed, analyze, updatePositions, prune, ticks, latestQuotes };
}

module.exports = { createStrategyEngine, CONFIG, WINDOW_MS, QUOTE_MAX_AGE_MS, ACTIVE_SESSIONS,
  marketDate, timestampOf, defaultMarketInfo, cnMetadata };
