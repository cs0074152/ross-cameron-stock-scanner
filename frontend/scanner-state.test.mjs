import test from 'node:test';
import assert from 'node:assert/strict';
import { marketDate, quoteMillis, isQuoteStale, chartMetadata, previousPriceMap, latestStockQuotes, updatePriceHistory, filterStocks, positionMirror, positionVersion, createOperationGate, emptyLedger, normalizeLedger, currentTrade, changeTrade, appendReceipt } from './src/scanner-state.js';

test('market dates retain a US session across China midnight and observe DST', () => {
  assert.equal(marketDate('US', '2026-10-01T16:30:00Z'), '2026-10-01');
  assert.equal(marketDate('CN', '2026-10-01T16:30:00Z'), '2026-10-02');
  assert.equal(marketDate('US', '2026-01-01T04:30:00Z'), '2025-12-31');
});
test('day rollover preserves history and resets the new session only', () => {
  const ledger = changeTrade(emptyLedger(), '2026-10-01', t => ({ ...t, entries: [100, -60], marketWeak: true }));
  assert.deepEqual(currentTrade(ledger, '2026-10-01').entries, [100, -60]);
  assert.deepEqual(currentTrade(ledger, '2026-10-02').entries, []);
  assert.equal(currentTrade(ledger, '2026-10-02').marketWeak, false);
});
test('server close receipt is idempotent across reload and history replay', () => {
  const receipt = { operationId: 'closed-once', pnl: 100.129, tradeDate: '2026-10-01' };
  const once = appendReceipt(emptyLedger(), receipt, 'US');
  const restored = normalizeLedger(JSON.parse(JSON.stringify(once)));
  assert.equal(appendReceipt(restored, receipt, 'US'), restored);
  assert.deepEqual(currentTrade(restored, '2026-10-01').entries, [100.13]);
  const cleared = changeTrade(restored, '2026-10-01', t => ({ ...t, entries: [] }));
  assert.equal(appendReceipt(cleared, receipt, 'US'), cleared);
});
test('legacy logs preserve earlier days and IDs survive manual edits', () => {
  const ledger = normalizeLedger({ date: '2026-09-30', entries: [20, -10], maxLoss: 300 });
  assert.equal(ledger.maxLoss, 300);
  const added = changeTrade(ledger, '2026-09-30', t => ({ ...t, entries: [...t.entries, 30] }));
  assert.equal(added.sessions['2026-09-30'].entries[0].id, 'legacy-2026-09-30-0');
});
test('previous quotes are populated and distinguish upward/downward moves', () => {
  const prices = previousPriceMap([{ symbol: 'TEST', price: '10.00' }]);
  assert.equal(prices.TEST, '10.00');
  assert.equal(Number('11.00') > Number(prices.TEST), true);
  assert.equal(Number('9.50') > Number(prices.TEST), false);
});
test('history deduplicates same-source quotes, caps length and expires missing symbols', () => {
  const now = Date.now();
  const first = updatePriceHistory({}, [{ symbol: 'TEST', price: 10, quoteTime: now }], now);
  const repeated = updatePriceHistory(first, [{ symbol: 'TEST', price: 10, quoteTime: now }], now + 1000);
  assert.deepEqual(repeated.TEST.prices, [10]);
  const next = updatePriceHistory(repeated, [{ symbol: 'TEST', price: 11, quoteTime: now + 1000 }], now + 1000);
  assert.deepEqual(next.TEST.prices, [10, 11]);
  assert.deepEqual(updatePriceHistory(next, [], now + 16 * 60000), {});
  assert.deepEqual(updatePriceHistory({}, [{ symbol: 'NO-TIME', price: 10 }], now), {});
});
test('A share chart metadata survives list departure and BSE has no unsupported mapping', () => {
  assert.equal(chartMetadata({ symbol: '600519' }).chartSymbol, 'SSE:600519');
  assert.equal(chartMetadata({ symbol: '300750' }).chartSymbol, 'SZSE:300750');
  assert.equal(chartMetadata({ symbol: '920001' }).chartSymbol, null);
});
test('custom numeric filters reject absent values without hiding unfiltered data', () => {
  const stocks = [{ price: 8, changePercent: 4, rvol: 2, floatRaw: 2000000 }, { price: 18, changePercent: 8, rvol: null, floatRaw: 9000000 }];
  assert.equal(filterStocks(stocks, {}).length, 2);
  assert.equal(filterStocks(stocks, { priceMax: 10, changeMin: 3, rvolMin: 1.5, floatMax: 5 }).length, 1);
});
test('source time and persistence preserve stop-monitor evidence', () => {
  assert.equal(quoteMillis(1700000000), 1700000000000);
  assert.equal(isQuoteStale({ quoteTime: null }), true);
  assert.equal(isQuoteStale({ quoteTime: 1700000000000 }, 1700000000001), false);
  const mirror = positionMirror([{ symbol: 'TEST', peak: 20, price: 19, quoteTime: 1700000000000, shares: 100 }]);
  assert.equal(mirror[0].peak, 20);
  assert.equal(mirror[0].quoteTime, 1700000000000);
});
test('reconnect starts a new epoch while old snapshots and late acknowledgements cannot overwrite it', () => {
  const previous = positionVersion(null, { instanceId: 'old', positionsRevision: 10 }, true);
  const restarted = positionVersion(previous, { instanceId: 'new', positionsRevision: 0 }, true);
  assert.equal(positionVersion(restarted, { instanceId: 'old', positionsRevision: 11 }), null);
  const updated = positionVersion(restarted, { instanceId: 'new', positionsRevision: 5 });
  assert.equal(positionVersion(updated, { instanceId: 'new', positionsRevision: 4 }), null);
});
test('duplicate close locks synchronously and a market switch cannot release another market operation', async () => {
  const gate = createOperationGate();
  const us = gate.acquire('US', 'TEST');
  assert.equal(gate.acquire('US', 'TEST'), null);
  const cn = gate.acquire('CN', 'TEST');
  gate.release(us);
  assert.equal(gate.has('CN', 'TEST'), true);
  gate.release(cn);
  assert.notEqual(gate.acquire('US', 'TEST'), null);
});
test('lost close response is recovered exactly once from durable receipt replay in the originating market', () => {
  const receipt = { operationId: 'lost-response', pnl: -40, closedAt: '2026-10-01T16:30:00Z', market: 'US' };
  const us = appendReceipt(emptyLedger(), receipt, 'US');
  const cn = emptyLedger();
  assert.deepEqual(currentTrade(us, '2026-10-01').entries, [-40]);
  assert.deepEqual(currentTrade(cn, '2026-10-02').entries, []);
  assert.equal(appendReceipt(us, receipt, 'US'), us);
  assert.equal(appendReceipt(cn, receipt, 'CN'), cn);
});
test('an old independent quote cannot hide a new ranked quote and the holding mirror preserves last buy date', () => {
  const [quote] = latestStockQuotes([{ symbol: 'TEST', price: 10, quoteTime: 1700000000000 }, { symbol: 'TEST', price: 9, quoteTime: 1700000010000 }]);
  assert.equal(quote.price, 9);
  const [mirror] = positionMirror([{ symbol: '600000', market: 'CN', lastBuyDate: '2026-09-30', peak: 11 }]);
  assert.equal(mirror.lastBuyDate, '2026-09-30');
});
