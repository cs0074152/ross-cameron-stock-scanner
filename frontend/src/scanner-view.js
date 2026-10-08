import { filterStocks, isQuoteStale, MARKET_TIMEZONES } from './scanner-state.js';

const timeFormatters = new Map();

// Reuse the two timezone formatters rather than constructing one for every row/render.
export function formatQuoteTime(time, market) {
  const timeZone = MARKET_TIMEZONES[market] || MARKET_TIMEZONES.US;
  if (!timeFormatters.has(timeZone)) timeFormatters.set(timeZone, new Intl.DateTimeFormat('zh-CN', { timeZone, hour12: false, hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  return timeFormatters.get(timeZone).format(new Date(time));
}

export function selectScannerRows(stocks, filters, field, direction) {
  return filterStocks(stocks, filters).sort((a, b) => {
    if (field === 'symbol') return direction === 'asc' ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol);
    const value = stock => {
      switch (field) {
        case 'price': return parseFloat(stock.price);
        case 'volume': return stock.volumeRaw || 0;
        case 'gap': return parseFloat(stock.gap);
        case 'float': return Number.isFinite(stock.floatRaw) ? stock.floatRaw : null;
        case 'rvol': return parseFloat(stock.rvol);
        default: return parseFloat(stock.changePercent);
      }
    };
    const aVal = value(a), bVal = value(b);
    if (aVal == null || !Number.isFinite(aVal)) return bVal == null || !Number.isFinite(bVal) ? 0 : 1;
    if (bVal == null || !Number.isFinite(bVal)) return -1;
    return direction === 'asc' ? aVal - bVal : bVal - aVal;
  });
}

const ROW_FIELDS = ['symbol', 'name', 'price', 'changePercent', 'volume', 'gap', 'float', 'floatSource', 'rvol', 'quoteTime'];
export function sameStockRowProps(before, after) {
  if (before.onClick !== after.onClick || before.isSelected !== after.isSelected || before.market !== after.market || before.prices !== after.prices) return false;
  if (ROW_FIELDS.some(field => before.stock[field] !== after.stock[field])) return false;
  const oldTags = before.stock.riskTags || [], newTags = after.stock.riskTags || [];
  if (oldTags.length !== newTags.length || oldTags.some((tag, index) => tag !== newTags[index])) return false;
  // The clock can cross the stale boundary even when the server quote has not changed.
  return isQuoteStale(before.stock, before.now) === isQuoteStale(after.stock, after.now);
}

// Keep third-party widget work out of the first paint after a symbol/theme change.
export function scheduleAfterPaint(task, host = globalThis) {
  let frame = null, timer = null, cancelled = false;
  frame = host.requestAnimationFrame(() => {
    frame = null;
    timer = host.setTimeout(() => { timer = null; if (!cancelled) task(); }, 0);
  });
  return () => {
    cancelled = true;
    if (frame != null) host.cancelAnimationFrame(frame);
    if (timer != null) host.clearTimeout(timer);
  };
}
