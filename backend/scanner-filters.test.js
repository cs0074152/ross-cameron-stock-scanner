const test = require('node:test');
const assert = require('node:assert/strict');
const { applyGapFilter, applyHODFilter, applyChinaWatchFilter, applyDocPickFilter } = require('./scanner-filters');
test('零跳空不退回盘中涨幅，缺失跳空不通过', () => {
  const rows = [{ symbol: 'ZERO', gap: '0.00', changePercent: '6' }, { symbol: 'NONE', gap: '—', changePercent: '30' }, { symbol: 'GAP', gap: '-5' }];
  assert.deepEqual(applyGapFilter(rows).map(s => s.symbol), ['GAP']);
});
test('日高动量要求靠近日高，不能只凭涨幅', () => {
  const stocks = [{ symbol: 'FAR', price: 10, high: 12, changePercent: 20 }, { symbol: 'HIGH', price: 10, high: 10.01, changePercent: 6 }];
  assert.deepEqual(applyHODFilter(stocks).map(s => s.symbol), ['HIGH']);
});
test('A股池独立规则，排除ST、新股、接近涨停', () => {
  const base = { price: 20, changePercent: 4, rvol: 2, limitPct: 10 };
  const stocks = [{ ...base, symbol: 'VALID' }, { ...base, symbol: 'ST', riskWarning: true },
    { ...base, symbol: 'NEW', newListing: true }, { ...base, symbol: 'LIMIT', changePercent: 9.9 }];
  assert.deepEqual(applyChinaWatchFilter(stocks).map(s => s.symbol), ['VALID']);
});
test('美股文档阈值保持严格大于涨幅条件', () => {
  const base = { price: 5, rvol: 5, floatRaw: 1e6 };
  assert.equal(applyDocPickFilter([{ ...base, changePercent: 10 }]).length, 0);
  assert.equal(applyDocPickFilter([{ ...base, changePercent: 11 }]).length, 1);
  assert.equal(applyDocPickFilter([{ ...base, changePercent: 30 }], true).length, 0);
});
