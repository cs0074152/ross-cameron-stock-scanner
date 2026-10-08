export const MARKET_TIMEZONES = { US: 'America/New_York', CN: 'Asia/Shanghai' };
export const HISTORY_TTL = 15 * 60 * 1000;

export function marketDate(market, at = new Date()) {
  const date = new Date(at);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_TIMEZONES[market] || MARKET_TIMEZONES.US, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function quoteMillis(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function isQuoteStale(stock, now = Date.now(), maxAge = 180000) {
  const time = quoteMillis(stock?.quoteTime);
  return time == null || now - time > maxAge;
}

export function chartMetadata(stock) {
  if (!stock) return null;
  const symbol = String(stock.symbol || '');
  const exchange = /^[69]/.test(symbol) && !/^92/.test(symbol) ? 'SSE' : /^[03]/.test(symbol) ? 'SZSE' : null;
  return { ...stock, chartSymbol: stock.chartSymbol ?? (exchange && /^\d{6}$/.test(symbol) ? `${exchange}:${symbol}` : null) };
}

export function previousPriceMap(stocks) {
  return Object.fromEntries(stocks.map(s => [s.symbol, s.price]));
}

export function latestStockQuotes(stocks) {
  const latest = new Map();
  for (const stock of stocks) {
    if (!stock?.symbol) continue;
    const previous = latest.get(stock.symbol);
    if (!previous || (quoteMillis(stock.quoteTime) || 0) > (quoteMillis(previous.quoteTime) || 0)) latest.set(stock.symbol, stock);
  }
  return [...latest.values()];
}

export function updatePriceHistory(history, stocks, now = Date.now(), ttl = HISTORY_TTL) {
  let next = history;
  for (const [symbol, value] of Object.entries(history)) {
    if (now - value.lastSeen < ttl) continue;
    if (next === history) next = { ...history };
    delete next[symbol];
  }
  const seen = new Set();
  for (const stock of stocks) {
    if (seen.has(stock.symbol)) continue;
    seen.add(stock.symbol);
    const price = Number(stock.price);
    const time = quoteMillis(stock.quoteTime);
    if (!Number.isFinite(price) || price <= 0 || time == null || now - time >= ttl) continue;
    const previous = next[stock.symbol];
    if (previous && time <= previous.quoteTime) continue;
    if (next === history) next = { ...history };
    next[stock.symbol] = { prices: [...(previous?.prices || []).slice(-29), price], quoteTime: time, lastSeen: now };
  }
  return next;
}

export function filterStocks(stocks, filters = {}) {
  const constraints = [['priceMin', 'price', 'min'], ['priceMax', 'price', 'max'], ['changeMin', 'changePercent', 'min'], ['rvolMin', 'rvol', 'min'], ['floatMax', 'floatRaw', 'max']];
  return stocks.filter(stock => constraints.every(([field, property, mode]) => {
    if (filters[field] == null || filters[field] === '') return true;
    const limit = Number(filters[field]) * (field === 'floatMax' ? 1000000 : 1);
    const value = stock[property] == null || stock[property] === '' || stock[property] === '—' ? NaN : Number(stock[property]);
    return Number.isFinite(limit) && Number.isFinite(value) && (mode === 'min' ? value >= limit : value <= limit);
  }));
}

export function positionMirror(positions = []) {
  return positions.map(p => ({ symbol: p.symbol, market: p.market, currency: p.currency, entry: p.entry,
    shares: p.shares, stop: p.stop, target: p.target, entryTime: p.entryTime, tradeDate: p.tradeDate,
    lastBuyDate: p.lastBuyDate, peak: p.peak, price: p.price, quoteTime: p.quoteTime,
    tradableOn: p.tradableOn, board: p.board, boardLabel: p.boardLabel, riskWarning: p.riskWarning,
    newListing: p.newListing, limitPct: p.limitPct, limitPercent: p.limitPercent }));
}

export function positionVersion(previous, payload, reset = false) {
  if (!reset && previous && payload.instanceId && previous.instanceId !== payload.instanceId) return null;
  if (!reset && previous && Number.isFinite(payload.positionsRevision) && payload.positionsRevision < previous.revision) return null;
  return { instanceId: payload.instanceId || previous?.instanceId, revision: payload.positionsRevision ?? previous?.revision ?? 0 };
}

export function createOperationGate() {
  const keys = new Set();
  return {
    acquire(market, symbol) { const key = `${market}:${symbol}`; if (keys.has(key)) return null; keys.add(key); return key; },
    release(key) { keys.delete(key); },
    has(market, symbol) { return keys.has(`${market}:${symbol}`); }
  };
}

export function emptyLedger() { return { maxLoss: 200, sessions: {}, seenReceipts: [] }; }

export function normalizeLedger(raw) {
  const ledger = emptyLedger();
  if (!raw || typeof raw !== 'object') return ledger;
  if (Number.isFinite(Number(raw.maxLoss))) ledger.maxLoss = Number(raw.maxLoss);
  ledger.seenReceipts = Array.isArray(raw.seenReceipts) ? raw.seenReceipts.filter(id => typeof id === 'string') : [];
  const sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : raw.date ? { [raw.date]: raw } : {};
  for (const [date, session] of Object.entries(sessions)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    ledger.sessions[date] = { entries: (Array.isArray(session?.entries) ? session.entries : []).map((entry, index) => typeof entry === 'number' ? { id: `legacy-${date}-${index}`, value: entry } : entry).filter(entry => entry && Number.isFinite(entry.value) && typeof entry.id === 'string'), marketWeak: !!session?.marketWeak };
  }
  for (const session of Object.values(ledger.sessions)) for (const entry of session.entries) if (!entry.id.startsWith('legacy-') && !entry.id.startsWith('manual-') && !ledger.seenReceipts.includes(entry.id)) ledger.seenReceipts.push(entry.id);
  return ledger;
}

export function currentTrade(ledger, date) {
  const session = ledger.sessions[date] || { entries: [], marketWeak: false };
  return { date, maxLoss: ledger.maxLoss, marketWeak: session.marketWeak, entries: session.entries.map(e => e.value) };
}

export function changeTrade(ledger, date, update) {
  const before = currentTrade(ledger, date);
  const after = typeof update === 'function' ? update(before) : update;
  const old = ledger.sessions[date]?.entries || [];
  // Match unchanged entries by occurrence, retaining server receipt identities after edits.
  const remaining = [...old];
  const entries = after.entries.filter(Number.isFinite).map((value, index) => {
    const found = remaining.findIndex(entry => entry.value === value);
    return found >= 0 ? remaining.splice(found, 1)[0] : { id: `manual-${date}-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`, value };
  });
  return { ...ledger, maxLoss: after.maxLoss, sessions: { ...ledger.sessions, [date]: { entries, marketWeak: !!after.marketWeak } } };
}

export function appendReceipt(ledger, receipt, market) {
  if (!receipt || typeof receipt.operationId !== 'string' || !Number.isFinite(receipt.pnl)) return ledger;
  if (receipt.market && receipt.market !== market) return ledger;
  if (ledger.seenReceipts?.includes(receipt.operationId)) return ledger;
  if (Object.values(ledger.sessions).some(session => session.entries.some(e => e.id === receipt.operationId))) return ledger;
  const date = receipt.tradeDate || marketDate(market, receipt.closedAt || new Date());
  const session = ledger.sessions[date] || { entries: [], marketWeak: false };
  return { ...ledger, seenReceipts: [...(ledger.seenReceipts || []), receipt.operationId], sessions: { ...ledger.sessions, [date]: { ...session, entries: [...session.entries, { id: receipt.operationId, value: Math.round(receipt.pnl * 100) / 100, at: receipt.closedAt }] } } };
}

export async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(12000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
