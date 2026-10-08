import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQuoteTime, selectScannerRows, sameStockRowProps, scheduleAfterPaint } from './src/scanner-view.js';
import { updatePriceHistory } from './src/scanner-state.js';

test('cached quote formatters preserve displayed times for both markets and DST', () => {
  for (const market of ['US', 'CN']) for (const iso of ['2026-01-01T05:30:00Z', '2026-07-01T05:30:00Z']) {
    const at = Date.parse(iso);
    const expected = new Date(at).toLocaleTimeString('zh-CN', { timeZone: market === 'CN' ? 'Asia/Shanghai' : 'America/New_York', hour12: false });
    assert.equal(formatQuoteTime(at, market), expected);
    assert.equal(formatQuoteTime(at, market), expected);
  }
});

test('scanner selection preserves signed sorting, missing values, custom filters and source order', () => {
  const stocks = [
    { symbol: 'B', price: '10', changePercent: '8', gap: '-6', floatRaw: null, rvol: '—', volumeRaw: 200 },
    { symbol: 'A', price: '5', changePercent: '-4', gap: '3', floatRaw: 3000000, rvol: 2, volumeRaw: 100 },
    { symbol: 'C', price: '7', changePercent: '2', gap: '—', floatRaw: 1000000, rvol: 3, volumeRaw: 300 }
  ];
  const symbols = rows => rows.map(row => row.symbol);
  assert.deepEqual(symbols(selectScannerRows(stocks, {}, 'gap', 'asc')), ['B', 'A', 'C']);
  assert.deepEqual(symbols(selectScannerRows(stocks, {}, 'float', 'asc')), ['C', 'A', 'B']);
  assert.deepEqual(symbols(selectScannerRows(stocks, {}, 'symbol', 'asc')), ['A', 'B', 'C']);
  assert.deepEqual(symbols(selectScannerRows(stocks, { rvolMin: 2, priceMax: 7 }, 'volume', 'desc')), ['C', 'A']);
  assert.deepEqual(symbols(stocks), ['B', 'A', 'C']);
});

test('row render reuse ignores hidden fields while retaining every displayed change and stale transitions', () => {
  const time = Date.now(), click = () => {};
  const stock = { symbol: 'TEST', name: 'Example', price: '10', changePercent: '2', volume: '2M', gap: '1', float: '3M', floatSource: 'float', rvol: '2', quoteTime: time, riskTags: ['观察'] };
  const before = { stock, onClick: click, isSelected: false, prices: [9, 10], market: 'US', now: time };
  assert.equal(sameStockRowProps(before, { ...before, stock: { ...stock, riskTags: ['观察'], marketCap: 9000000 }, now: time + 30000 }), true);
  for (const field of ['symbol', 'name', 'price', 'changePercent', 'volume', 'gap', 'float', 'floatSource', 'rvol', 'quoteTime']) {
    assert.equal(sameStockRowProps(before, { ...before, stock: { ...stock, [field]: 'changed' } }), false, field);
  }
  assert.equal(sameStockRowProps(before, { ...before, now: time + 180001 }), false);
  assert.equal(sameStockRowProps(before, { ...before, isSelected: true }), false);
  assert.equal(sameStockRowProps(before, { ...before, prices: [9, 11] }), false);
  assert.equal(sameStockRowProps(before, { ...before, market: 'CN' }), false);
  assert.equal(sameStockRowProps(before, { ...before, onClick: () => {} }), false);
  assert.equal(sameStockRowProps(before, { ...before, stock: { ...stock, riskTags: ['ST'] } }), false);
});

test('unchanged price history retains identity while new quotes and TTL eviction return independent snapshots', () => {
  const now = Date.now();
  const history = updatePriceHistory({}, [{ symbol: 'TEST', price: 10, quoteTime: now }], now);
  assert.equal(updatePriceHistory(history, [], now + 30000), history);
  assert.equal(updatePriceHistory(history, [{ symbol: 'TEST', price: 10, quoteTime: now }], now + 1000), history);
  const next = updatePriceHistory(history, [{ symbol: 'TEST', price: 11, quoteTime: now + 1000 }], now + 1000);
  assert.notEqual(next, history);
  assert.deepEqual(history.TEST.prices, [10]);
  assert.deepEqual(next.TEST.prices, [10, 11]);
  assert.deepEqual(updatePriceHistory(history, [], now + 16 * 60000), {});
  assert.equal(history.TEST.prices.length, 1);
});

test('deferred widget setup is cancellable before and after the paint frame', () => {
  let frame, timer, mounts = 0;
  const host = {
    requestAnimationFrame: fn => { frame = fn; return 1; }, cancelAnimationFrame: () => { frame = null; },
    setTimeout: fn => { timer = fn; return 2; }, clearTimeout: () => { timer = null; }
  };
  let cancel = scheduleAfterPaint(() => mounts++, host);
  assert.equal(mounts, 0);
  cancel();
  assert.equal(frame, null);
  cancel = scheduleAfterPaint(() => mounts++, host);
  frame();
  assert.equal(mounts, 0);
  cancel();
  assert.equal(timer, null);
  scheduleAfterPaint(() => mounts++, host);
  frame(); timer();
  assert.equal(mounts, 1);
});
