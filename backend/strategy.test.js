const test = require('node:test');
const assert = require('node:assert/strict');
const { createStrategyEngine, WINDOW_MS, marketDate } = require('./strategy');

const START = Date.parse('2026-09-29T14:00:00Z');
function samples(prices, { market = 'US', symbol = 'TEST', start = START, dayHigh = 10 } = {}) {
  return prices.map((price, index) => ({ market, symbol, name: symbol, price,
    high: dayHigh, low: 1, volumeRaw: 1000 + index * 100,
    quoteTime: new Date(start + index * 15000).toISOString() }));
}
function feedSeries(engine, quotes, market = 'US') {
  for (const quote of quotes) engine.feed([quote], market, Date.parse(quote.quoteTime));
  return Date.parse(quotes.at(-1).quoteTime);
}
const regular = (market, now) => ({ session: 'regular', date: marketDate(now, market), calendarKnown: true,
  lastTradingDate: marketDate(now, market), nextTradingDate: market === 'CN' ? '2026-09-30' : null });

test('all US radar states are reachable with cumulative day highs and lows', () => {
  for (const [expected, prices] of [
    ['rally', [9.7, 9.8, 9.9, 9.95, 10]],
    ['pullback', [9.7, 9.9, 10, 9.8, 9.7]],
    ['based', [9.7, 9.9, 10, 9.7, 9.7, 9.7]],
    ['trigger', [9.7, 9.9, 10, 9.7, 9.7, 9.71]]
  ]) {
    const engine = createStrategyEngine();
    const now = feedSeries(engine, samples(prices));
    const result = engine.analyze('TEST', 'US', now);
    assert.equal(result.state, expected);
    assert.equal(result.target, 10);
    assert.ok(result.pullbackLow > 1, 'cumulative day low must not become the pullback low');
  }
});

test('duplicate quotes do not manufacture history or volume', () => {
  const engine = createStrategyEngine();
  const quote = samples([9.7])[0];
  assert.equal(engine.feed([quote, quote], 'US', START), 1);
  assert.equal(engine.feed([quote], 'US', START + 15000), 0);
  assert.equal(engine.ticks.get('US:TEST').length, 1);
  assert.equal(engine.ticks.get('US:TEST')[0].volume, null);
  assert.equal(engine.feed([{ ...quote, quoteTime: null }], 'US', START), 0);
});

test('history uses elapsed time and never crosses trading dates', () => {
  const engine = createStrategyEngine();
  const now = feedSeries(engine, samples([10, 9.7, 9.7, 9.7, 9.71]));
  engine.prune(now + WINDOW_MS + 1);
  assert.equal(engine.ticks.has('US:TEST'), false);
  assert.equal(engine.analyze('TEST', 'US', now + WINDOW_MS + 1), null);
  const next = START + 24 * 60 * 60 * 1000;
  engine.feed(samples([9], { start: next, dayHigh: 9 }), 'US', next);
  assert.equal(engine.ticks.get('US:TEST').length, 1);
  assert.equal(engine.ticks.get('US:TEST')[0].volume, null, 'new day must not subtract old cumulative volume');
});

test('out-of-order or future source quotes cannot replace the latest price', () => {
  const engine = createStrategyEngine();
  const quote = samples([10])[0];
  engine.feed([quote], 'US', START);
  engine.feed([{ ...quote, price: 1, quoteTime: new Date(START - 1000).toISOString() }], 'US', START);
  engine.feed([{ ...quote, price: 1, quoteTime: new Date(START + 120000).toISOString() }], 'US', START);
  assert.equal(engine.latestQuotes.get('US:TEST').price, 10);
});

test('same-round independent quote wins a same-timestamp ranking duplicate', () => {
  const engine = createStrategyEngine();
  const quote = samples([10])[0];
  engine.feed([quote, { ...quote, price: 10.01 }], 'US', START);
  assert.equal(engine.latestQuotes.get('US:TEST').price, 10.01);
  assert.equal(engine.ticks.get('US:TEST').length, 1);
});

test('missing fresh holdings quotes become stale without advancing timestamps', () => {
  const engine = createStrategyEngine({ getMarketInfo: regular });
  const positions = new Map([['US:TEST', { market: 'US', symbol: 'TEST', entry: 10, shares: 100,
    stop: 9, target: 12, peak: 10, entryTime: START }]]);
  engine.feed(samples([10]), 'US', START);
  engine.updatePositions(positions, 'US', START);
  assert.equal(positions.get('US:TEST').status, 'holding');
  const original = positions.get('US:TEST').updatedAt;
  engine.updatePositions(positions, 'US', START + 4 * 60000);
  assert.equal(positions.get('US:TEST').status, 'stale');
  assert.equal(positions.get('US:TEST').updatedAt, original);
  assert.equal(positions.get('US:TEST').quoteTime, new Date(START).toISOString());
});

test('independent held-symbol quote updates stop monitoring even outside rankings', () => {
  const engine = createStrategyEngine({ getMarketInfo: regular });
  const positions = new Map([['US:HELD', { market: 'US', symbol: 'HELD', entry: 10, shares: 100,
    stop: 9.5, target: 12, peak: 10, entryTime: START }]]);
  engine.feed(samples([9.4], { symbol: 'HELD' }), 'US', START);
  engine.updatePositions(positions, 'US', START);
  assert.equal(positions.get('US:HELD').status, 'stop_triggered');
});

test('preserved peak continues to produce fade warnings after restoring a holding', () => {
  const engine = createStrategyEngine({ getMarketInfo: regular });
  const positions = new Map([['US:TEST', { market: 'US', symbol: 'TEST', entry: 10, shares: 100,
    stop: 9, target: 12, peak: 11, entryTime: START - 60000 }]]);
  engine.feed(samples([10.5], { dayHigh: 11 }), 'US', START);
  engine.updatePositions(positions, 'US', START);
  assert.equal(positions.get('US:TEST').peak, 11);
  assert.equal(positions.get('US:TEST').status, 'warning');
  assert.match(positions.get('US:TEST').signals[0], /4.5%/);
});

test('CN radar remains an observation and carries board/risk metadata', () => {
  const engine = createStrategyEngine();
  const quotes = samples([9.7, 9.9, 10, 9.7, 9.7, 9.71], { market: 'CN', symbol: '300001' });
  const now = feedSeries(engine, quotes, 'CN');
  const analysis = engine.analyze('300001', 'CN', now);
  assert.equal(analysis.state, 'trigger');
  assert.equal(analysis.watchOnly, true);
  assert.equal(analysis.observationOnly, true);
  assert.equal(analysis.board, '创业板');
  assert.equal(analysis.currency, 'CNY');
});

test('T+1 warns on stop signals and unlocks only after the buy date', () => {
  const engine = createStrategyEngine({ getMarketInfo: regular });
  const cnTime = Date.parse('2026-09-29T02:00:00Z');
  const positions = new Map([['CN:600001', { market: 'CN', symbol: '600001', entry: 10, shares: 100,
    stop: 9.5, target: 12, peak: 10, entryTime: cnTime, tradeDate: '2026-09-29' }]]);
  engine.feed(samples([9.4], { start: cnTime, symbol: '600001' }), 'CN', cnTime);
  engine.updatePositions(positions, 'CN', cnTime);
  const position = positions.get('CN:600001');
  assert.equal(position.cannotSell, true);
  assert.equal(position.sellable, false);
  assert.equal(position.tradableOn, '2026-09-30');
  assert.equal(position.status, 'stop_triggered');
  assert.ok(position.signals.some(signal => signal.includes('T+1')));
  engine.updatePositions(positions, 'CN', cnTime + 86400000);
  assert.equal(position.sellable, true);
});

test('unknown calendar does not predict a CN tradable date', () => {
  const now = Date.parse('2027-09-29T02:00:00Z');
  const engine = createStrategyEngine({ getMarketInfo: (market, n) => ({ ...regular(market, n), calendarKnown: false }) });
  const positions = new Map([['CN:600001', { market: 'CN', symbol: '600001', entry: 10, peak: 10,
    entryTime: now, tradeDate: '2027-09-29' }]]);
  engine.updatePositions(positions, 'CN', now);
  assert.equal(positions.get('CN:600001').tradableOn, null);
});

test('CN holdings stay T+1 locked throughout the holiday before the next trading session', () => {
  const now = Date.parse('2026-10-02T02:00:00Z');
  const engine = createStrategyEngine({ getMarketInfo: () => ({ date: '2026-10-02', session: 'closed',
    calendarKnown: true, lastTradingDate: '2026-09-30', nextTradingDate: '2026-10-08' }) });
  const positions = new Map([['CN:600001', { market: 'CN', symbol: '600001', entry: 10, peak: 10,
    entryTime: Date.parse('2026-09-30T02:00:00Z'), tradeDate: '2026-09-30' }]]);
  engine.updatePositions(positions, 'CN', now);
  assert.equal(positions.get('CN:600001').sellable, false);
  assert.equal(positions.get('CN:600001').tradableOn, '2026-10-08');
});

test('CN explicit price-limit metadata is preserved and risk stocks get no radar trigger', () => {
  const engine = createStrategyEngine();
  const quotes = samples([9.7, 9.9, 10, 9.7, 9.7, 9.71], { market: 'CN', symbol: '600001' })
    .map(q => ({ ...q, name: '*ST测试', board: 'MAIN', boardLabel: '主板', riskWarning: true, limitPct: 10 }));
  const now = feedSeries(engine, quotes, 'CN');
  assert.equal(engine.analyze('600001', 'CN', now), null);
  assert.equal(engine.latestQuotes.get('CN:600001').limitPercent, 10);
});

test('US and CN ticks and position monitoring remain isolated', () => {
  const engine = createStrategyEngine({ getMarketInfo: regular });
  engine.feed(samples([10]), 'US', START);
  const positions = new Map([['CN:600001', { market: 'CN', symbol: '600001', entry: 20, peak: 20 }]]);
  engine.updatePositions(positions, 'US', START);
  assert.equal(positions.get('CN:600001').price, undefined);
  assert.equal(engine.analyze('TEST', 'CN', START), null);
});

test('a six-snapshot window crossing sessions cannot manufacture a weak-volume warning', () => {
  const engine = createStrategyEngine({ getMarketInfo: regular });
  const quotes = samples([10, 10.01, 10.02, 10.03, 10.04, 10.05, 10.06, 10.07, 10.08])
    .map((q, i) => ({ ...q, quoteSession: i < 6 ? 'regular' : 'afterhours',
      volumeRaw: i < 6 ? 1000 + i * 100 : 1501 + i - 6 }));
  const now = feedSeries(engine, quotes);
  const arr = engine.ticks.get('US:TEST');
  assert.equal(arr[6].volume, null, 'session first cumulative volume must never subtract the prior session');
  // Even if a source supplies an explicit transition interval, never compare different sessions.
  arr[6].volume = 1;
  const positions = new Map([['US:TEST', { market: 'US', symbol: 'TEST', entry: 10, shares: 100,
    peak: 10, entryTime: START - 60000 }]]);
  engine.updatePositions(positions, 'US', now);
  assert.equal(positions.get('US:TEST').status, 'holding');
  assert.deepEqual(positions.get('US:TEST').signals, []);
  assert.equal(positions.get('US:TEST').quoteSession, 'afterhours');
});
