const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPositionStore } = require('./positions');
const { marketDate } = require('./strategy');

const TEST_ROOT = path.resolve(process.env.SCANNER_TEST_DIR || path.join(os.tmpdir(), 'ross-scanner-position-tests'));
fs.mkdirSync(TEST_ROOT, { recursive: true });
function fixture(t, getMarketInfo) {
  const directory = fs.mkdtempSync(path.join(TEST_ROOT, 'case-'));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(`${TEST_ROOT}${path.sep}`));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filePath = path.join(directory, 'positions.json');
  return { directory, filePath, store: createPositionStore({ filePath, getMarketInfo }) };
}
const regular = (market, now) => ({ session: 'regular', date: marketDate(now, market), calendarKnown: true,
  lastTradingDate: marketDate(now, market), nextTradingDate: null });
function quote(position, now, price = 11) {
  Object.assign(position, { price, peak: Math.max(position.peak, price), quoteTime: new Date(now).toISOString(), updatedAt: now });
}

test('durable positions preserve entry time, peak, and quote metadata across restart', t => {
  const { store, filePath } = fixture(t, regular);
  const first = store.upsert({ symbol: 'TEST', entry: 10, shares: 100, stop: 9, target: 12 }, 'US');
  const now = Date.now();
  const position = store.positions.get('US:TEST');
  quote(position, now, 10.5);
  position.peak = 11;
  store.save();
  const restarted = createPositionStore({ filePath, getMarketInfo: regular });
  const loaded = restarted.list('US')[0];
  assert.equal(loaded.entryTime, first.entryTime);
  assert.equal(loaded.peak, 11);
  assert.equal(loaded.price, 10.5);
  assert.equal(loaded.quoteTime, new Date(now).toISOString());
  assert.equal(restarted.hasState('US'), true);
});

test('close receipts survive restart and are idempotent without changing later positions', t => {
  const { store, filePath } = fixture(t, regular);
  const now = Date.now();
  store.upsert({ symbol: 'TEST', entry: 10, shares: 100 }, 'US');
  quote(store.positions.get('US:TEST'), now, 11);
  const receipt = store.close('TEST', 'US', { operationId: 'close-operation-1', now });
  assert.equal(receipt.pnl, 100);
  assert.equal(receipt.currency, 'USD');
  assert.equal(store.trades('US').length, 1);
  assert.equal(store.trades('CN').length, 0);
  assert.equal(store.positions.size, 0);
  const restarted = createPositionStore({ filePath, getMarketInfo: regular });
  restarted.upsert({ symbol: 'TEST', entry: 12, shares: 100 }, 'US');
  const repeated = restarted.close('TEST', 'US', { operationId: 'close-operation-1', now });
  assert.equal(repeated.pnl, 100);
  assert.equal(repeated.closedAt, receipt.closedAt);
  assert.equal(restarted.positions.size, 1, 'retry must not close the new holding');
  assert.equal(repeated.data.length, 1, 'retry must return current positions');
  assert.throws(() => restarted.close('OTHER', 'US', { operationId: 'close-operation-1', now }), { status: 409 });
});

test('missing or stale active quotes reject close without losing the holding', t => {
  const { store } = fixture(t, regular);
  const now = Date.now();
  store.upsert({ symbol: 'TEST', entry: 10, shares: 100 }, 'US');
  assert.throws(() => store.close('TEST', 'US', { operationId: 'close-operation-1', now }), { status: 409 });
  quote(store.positions.get('US:TEST'), now - 4 * 60000);
  assert.throws(() => store.close('TEST', 'US', { operationId: 'close-operation-2', now }), { status: 409 });
  assert.equal(store.positions.size, 1);
  assert.equal(store.receipts.size, 0);
});

test('closed-session close accepts only the calendar last-trading-date quote', t => {
  const now = Date.parse('2026-10-04T02:00:00Z');
  const { store } = fixture(t, (market, n) => ({ date: marketDate(n, market), session: 'closed', calendarKnown: true,
    lastTradingDate: '2026-10-02' }));
  store.upsert({ symbol: 'TEST', entry: 10, shares: 100 }, 'US');
  quote(store.positions.get('US:TEST'), Date.parse('2026-10-02T20:00:00Z'));
  assert.equal(store.close('TEST', 'US', { operationId: 'close-operation-1', now }).pnl, 100);
  store.upsert({ symbol: 'OTHER', entry: 10, shares: 100 }, 'US');
  quote(store.positions.get('US:OTHER'), Date.parse('2026-10-01T20:00:00Z'));
  assert.throws(() => store.close('OTHER', 'US', { operationId: 'close-operation-2', now }), { status: 409 });
});

test('empty legacy migration is durable and later old mirrors cannot resurrect positions', t => {
  const { store, filePath } = fixture(t, regular);
  assert.equal(store.hasState('US'), false);
  assert.deepEqual(store.restore([], 'US'), []);
  assert.equal(store.hasState('US'), true);
  const restarted = createPositionStore({ filePath, getMarketInfo: regular });
  assert.deepEqual(restarted.restore([{ symbol: 'TEST', entry: 10, shares: 100 }], 'US'), []);
  assert.equal(restarted.hasState('CN'), false);
});

test('closed markets stay initialized after restart and ignore pre-close mirrors', t => {
  const { store, filePath } = fixture(t, regular);
  const now = Date.now();
  store.upsert({ symbol: 'TEST', entry: 10, shares: 100 }, 'US');
  quote(store.positions.get('US:TEST'), now);
  store.close('TEST', 'US', { operationId: 'close-operation-1', now });
  const restarted = createPositionStore({ filePath, getMarketInfo: regular });
  assert.deepEqual(restarted.restore([{ symbol: 'TEST', entry: 10, shares: 100 }], 'US'), []);
});

test('CN T+1 rejects same-date closes and stop adjustments preserve the buy date', t => {
  const { store } = fixture(t, regular);
  const now = Date.now();
  const original = store.upsert({ symbol: '600001', entry: 10, shares: 100, stop: 9 }, 'CN');
  quote(store.positions.get('CN:600001'), now);
  assert.throws(() => store.close('600001', 'CN', { operationId: 'close-operation-1', now }), { status: 409 });
  const adjusted = store.upsert({ symbol: '600001', entry: 10, stop: 9.5 }, 'CN');
  assert.equal(adjusted.lastBuyDate, original.lastBuyDate);
  assert.equal(adjusted.entryTime, original.entryTime);
  assert.equal(adjusted.sellable, false);
  const tomorrow = now + 86400000;
  quote(store.positions.get('CN:600001'), tomorrow);
  assert.equal(store.close('600001', 'CN', { operationId: 'close-operation-2', now: tomorrow }).currency, 'CNY');
});

test('CN additions conservatively relock a prior-day holding', t => {
  const { store } = fixture(t, regular);
  const now = Date.now();
  store.restore([{ symbol: '600001', entry: 10, shares: 100, entryTime: now - 86400000,
    quoteTime: new Date(now).toISOString(), price: 11, peak: 11 }], 'CN');
  assert.equal(store.list('CN')[0].sellable, true);
  const increased = store.upsert({ symbol: '600001', shares: 200 }, 'CN');
  assert.equal(increased.sellable, false);
  assert.equal(increased.lastBuyDate, marketDate(now, 'CN'));
  assert.throws(() => store.close('600001', 'CN', { operationId: 'close-operation-1', now }), { status: 409 });
});

test('CN full closes stay blocked across a holiday until the next trading session quote', t => {
  const { store } = fixture(t, () => ({ date: '2026-10-02', session: 'closed', calendarKnown: true,
    lastTradingDate: '2026-09-30', nextTradingDate: '2026-10-08' }));
  const entry = Date.parse('2026-09-30T02:00:00Z');
  store.restore([{ symbol: '600001', entry: 10, shares: 100, entryTime: entry,
    quoteTime: new Date(entry + 5 * 60000).toISOString(), price: 11, peak: 11 }], 'CN', { now: entry + 10 * 60000 });
  assert.equal(store.list('CN')[0].sellable, false);
  assert.equal(store.list('CN')[0].tradableOn, '2026-10-08');
  assert.throws(() => store.close('600001', 'CN', { operationId: 'holiday-close-1',
    now: Date.parse('2026-10-02T02:00:00Z') }), { status: 409 });
});

test('US and CN position, migration, receipt, and currency state are separate', t => {
  const { store } = fixture(t, regular);
  store.upsert({ symbol: 'TEST', entry: 10 }, 'US');
  store.upsert({ symbol: '600001', entry: 20 }, 'CN');
  assert.equal(store.list('US').length, 1);
  assert.equal(store.list('CN').length, 1);
  assert.equal(store.list('US')[0].currency, 'USD');
  assert.equal(store.list('CN')[0].currency, 'CNY');
  assert.throws(() => store.upsert({ symbol: '600002', market: 'US', entry: 20 }, 'CN'), { status: 400 });
});

test('invalid position inputs and close IDs are rejected precisely', t => {
  const { store } = fixture(t, regular);
  for (const payload of [
    { symbol: 'TEST', entry: '10junk' }, { symbol: '../TEST', entry: 10 },
    { symbol: 'TEST', entry: 10, shares: Infinity }, { symbol: 'TEST', entry: 10, shares: 1.5 },
    { symbol: 'TEST', entry: 10, stop: -1 }, { symbol: 'TEST', entry: 10, target: 'bad' }
  ]) assert.throws(() => store.upsert(payload, 'US'), { status: 400 });
  store.upsert({ symbol: 'TEST', entry: 10 }, 'US');
  assert.throws(() => store.close('TEST', 'US'), { status: 400 });
});
test('unknown CN calendar cannot release a simulated close even with a source quote', t => {
  const now = Date.parse('2027-02-02T02:00:00Z');
  const { store } = fixture(t, () => ({ date: '2027-02-02', session: 'unknown', calendarKnown: false }));
  store.restore([{ symbol: '600001', entry: 10, shares: 100, entryTime: now - 86400000,
    quoteTime: new Date(now).toISOString(), price: 11 }], 'CN', { now });
  assert.throws(() => store.close('600001', 'CN', { operationId: 'unknown-calendar-close', now }),
    { status: 409, message: '交易日历未知，暂不能确认 A 股 T+1 可卖日期' });
});

test('failed atomic persistence rolls back mutations and preserves original state', t => {
  const { directory } = fixture(t, regular);
  const blockedParent = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blockedParent, 'existing');
  const store = createPositionStore({ filePath: path.join(blockedParent, 'positions.json') });
  assert.throws(() => store.upsert({ symbol: 'TEST', entry: 10 }, 'US'), { status: 503 });
  assert.equal(store.positions.size, 0);
  assert.equal(store.hasState('US'), false);
  assert.equal(fs.readFileSync(blockedParent, 'utf8'), 'existing');
});

test('corrupt persistence fails visibly without overwriting the file', t => {
  const { filePath } = fixture(t, regular);
  fs.writeFileSync(filePath, '{broken');
  assert.throws(() => createPositionStore({ filePath }));
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
});
