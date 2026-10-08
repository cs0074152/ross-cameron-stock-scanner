const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getMarketInfo } = require('./market-calendar');

test('US holidays and early close follow the exchange calendar, not government weekdays', () => {
  assert.equal(getMarketInfo('US', '2026-04-03T10:00:00-04:00').session, 'closed');
  assert.equal(getMarketInfo('US', '2026-07-03T10:00:00-04:00').session, 'closed');
  assert.equal(getMarketInfo('US', '2026-07-02T15:00:00-04:00').session, 'regular');
  assert.equal(getMarketInfo('US', '2026-11-27T12:59:00-05:00').session, 'regular');
  assert.equal(getMarketInfo('US', '2026-11-27T13:00:00-05:00').session, 'afterhours');
  assert.equal(getMarketInfo('US', '2026-11-27T17:00:00-05:00').session, 'closed');
  assert.equal(getMarketInfo('US', '2026-12-24T13:00:00-05:00').earlyClose, true);
  assert.equal(getMarketInfo('US', '2027-11-26T13:00:00-05:00').session, 'afterhours');
});

test('ET clock respects daylight savings and unknown calendars are never tradable', () => {
  assert.equal(getMarketInfo('US', '2026-03-09T13:30:00Z').minutes, 570);
  assert.equal(getMarketInfo('US', '2026-11-02T14:30:00Z').minutes, 570);
  for (const market of ['US', 'CN']) {
    const unknown = getMarketInfo(market, '2029-01-02T10:00:00+08:00');
    assert.equal(unknown.session, 'unknown');
    assert.equal(unknown.calendarKnown, false);
    assert.equal(unknown.lastTradingDate, null);
    assert.equal(unknown.nextTradingDate, null);
  }
});

test('trading dates handle holidays, preopen, weekends and calendar year boundaries', () => {
  assert.equal(getMarketInfo('CN', '2026-10-02T10:00:00+08:00').lastTradingDate, '2026-09-30');
  assert.equal(getMarketInfo('CN', '2026-09-30T10:00:00+08:00').nextTradingDate, '2026-10-08');
  assert.equal(getMarketInfo('CN', '2026-10-08T09:14:00+08:00').lastTradingDate, '2026-09-30');
  assert.equal(getMarketInfo('CN', '2026-10-08T09:15:00+08:00').lastTradingDate, '2026-10-08');
  assert.equal(getMarketInfo('CN', '2026-10-10T10:00:00+08:00').lastTradingDate, '2026-10-09');
  assert.equal(getMarketInfo('US', '2026-12-31T10:00:00-05:00').nextTradingDate, '2027-01-04');
  assert.equal(getMarketInfo('CN', '2026-12-31T10:00:00+08:00').nextTradingDate, null);
});
