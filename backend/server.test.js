const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createScannerServer } = require('./server');
const { mergeQuotesLatest } = require('./server');
test('部分榜单失败保留旧数据时，合并择最新源时间，独立旧报价不能覆盖新榜单报价', () => {
  const latest = { symbol: 'TEST', price: '9', quoteTime: '2026-09-24T14:00:15Z' };
  const previous = { symbol: 'TEST', price: '10', quoteTime: '2026-09-24T14:00:00Z' };
  assert.equal(mergeQuotesLatest([[latest], [previous]]).get('TEST').price, '9');
  assert.equal(mergeQuotesLatest([[latest], [{ ...latest, price: '8.99' }]]).get('TEST').price, '8.99');
});
test('部分榜单跨时段失败时，当前交易日期的盘后展示优先且旧日期盘后不会覆盖当日盘中', () => {
  const regular = { symbol: 'TEST', price: '10', quoteTime: '2026-09-24T19:59:00Z', quoteSession: 'regular' };
  const afterhours = { symbol: 'TEST', price: '11', sourceDate: '2026-09-24', quoteSession: 'afterhours' };
  const options = { market: 'US', session: 'afterhours', tradingDate: '2026-09-24' };
  assert.equal(mergeQuotesLatest([[regular], [afterhours]], options).get('TEST').price, '11');
  assert.equal(mergeQuotesLatest([[regular], [{ ...afterhours, sourceDate: '2026-09-23' }]], options).get('TEST').price, '10');
});

async function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-integration-'));
  let clock = Date.parse('2026-09-24T14:00:00Z');
  const controls = { failRankings: false, missingQuotes: false, calls: [], session: [] };
  const row = symbol => ({ market: 'US', symbol, name: symbol, price: '9.00', high: '10.00', low: '8.90',
    changePercent: '12', gap: '5', rvol: '6', floatRaw: 1e6, volumeRaw: 100,
    quoteTime: new Date(clock).toISOString() });
  const usProvider = {
    fetchRanking: async (category, session) => {
      controls.session.push(session);
      if (controls.failRankings) throw new Error('HTTP 503');
      return [row('LISTED')];
    },
    fetchQuotes: async symbols => { controls.calls.push([...symbols]); return controls.missingQuotes ? [] : symbols.map(row); },
    enrichFloats: async () => {}
  };
  const scanner = createScannerServer({ poll: false, launchId: 'integration-launch-id', statePath: path.join(directory, 'positions.json'),
    now: () => clock, usProvider, cnSnapshot: async () => ({ gainers: [], losers: [], mostActive: [],
    scope: { label: 'A股榜单样本' } }), cnQuotes: async () => [], ...overrides });
  const address = await scanner.start(0);
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await scanner.stop();
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function request(route, method = 'GET', body) {
    const response = await fetch(`${url}${route}`, { method, headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  return { scanner, request, controls, directory, url,
    advance: milliseconds => { clock += milliseconds; } };
}
test('榜单源失败保留数据/成功时间；独立持仓报价仍更新且不会假装过期价新鲜', async t => {
  const f = await fixture(t);
  await f.scanner.refresh('US');
  const before = f.scanner.snapshot('US');
  await f.request('/api/positions', 'POST', { symbol: 'OFFLIST', entry: 10, shares: 10, stop: 9.5 });
  f.advance(15000);
  f.controls.failRankings = true;
  await f.scanner.refresh('US');
  const failed = f.scanner.snapshot('US');
  assert.equal(failed.data.gainers[0].symbol, 'LISTED');
  assert.equal(failed.lastUpdateTime, before.lastUpdateTime);
  assert.match(failed.dataError, /获取失败/);
  assert.ok(f.controls.calls.some(symbols => symbols.includes('OFFLIST')));
  assert.equal(failed.data.positions[0].price, 9);
  assert.equal(failed.data.positions[0].status, 'stop_triggered');
  const quoteTime = failed.data.positions[0].quoteTime;
  f.advance(4 * 60 * 1000);
  f.controls.missingQuotes = true;
  await f.scanner.refresh('US');
  const stale = f.scanner.snapshot('US').data.positions[0];
  assert.equal(stale.status, 'stale');
  assert.equal(stale.quoteTime, quoteTime);
});
test('持仓/峰值跨进程实例恢复，空权威状态不会迁移已平仓镜像，平仓幂等', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/positions')).body.migrationNeeded, true);
  await f.request('/api/positions', 'POST', { symbol: 'OFFLIST', entry: 10, shares: 10 });
  await f.scanner.refresh('US');
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, 'positions.json'), 'utf8'));
  assert.equal(saved.positions[0].quoteTime, f.scanner.snapshot('US').data.positions[0].quoteTime);
  const first = await f.request('/api/positions/OFFLIST?market=US&operationId=test-close-1', 'DELETE');
  assert.equal(first.status, 200);
  const second = await f.request('/api/positions/OFFLIST', 'DELETE', { operationId: 'test-close-1' });
  assert.equal(second.status, 200);
  assert.equal(second.body.pnl, first.body.pnl);
  assert.equal((await f.request('/api/trades')).body.data.length, 1);
  const resurrect = await f.request('/api/positions/sync', 'POST', { positions: [{ symbol: 'OFFLIST', entry: 10 }] });
  assert.equal(resurrect.body.data.length, 0);
  assert.equal(resurrect.body.migrationNeeded, false);
  const { createPositionStore } = require('./positions');
  const loaded = createPositionStore({ filePath: path.join(f.directory, 'positions.json') });
  assert.equal(loaded.list('US').length, 0);
  assert.equal(loaded.trades('US').length, 1);
});
test('两市场持仓/API/WS隔离，拒绝来源和非法市场', async t => {
  const f = await fixture(t);
  await f.request('/api/positions?market=CN', 'POST', { symbol: '600000', entry: 10, shares: 100 });
  assert.equal((await f.request('/api/positions?market=US')).body.data.length, 0);
  assert.equal((await f.request('/api/positions?market=CN')).body.data.length, 1);
  assert.equal((await f.request('/api/positions?market=BAD')).status, 400);
  assert.equal((await f.request('/api/scanner/docPick?market=CN')).status, 404);
  assert.equal((await f.request('/api/scanner/cnWatch?market=US')).status, 404);
  const foreign = await fetch(`${f.url}/api/positions`, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(foreign.status, 403);
  const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/?market=CN');
  const [raw] = await once(ws, 'message');
  const initial = JSON.parse(raw);
  assert.equal(initial.market, 'CN');
  assert.equal(initial.data.positions[0].symbol, '600000');
  ws.close();
  await once(ws, 'close');
});
test('超大WebSocket消息关闭异常连接，HTTP服务继续工作', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(f.url.replace('http:', 'ws:'));
  ws.on('error', () => {});
  await once(ws, 'open');
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.send(Buffer.alloc(1024 * 1024 + 1));
  await closed;
  assert.equal((await f.request('/api/health')).status, 200);
});
test('健康检查标识当前项目和启动实例，供桌面入口核对运行中的服务', async t => {
  const f = await fixture(t);
  const health = await f.request('/api/health');
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.service, 'ross-cameron-stock-scanner');
  assert.equal(health.body.launchId, 'integration-launch-id');
  assert.equal(health.body.instanceId, f.scanner.snapshot('US').instanceId);
});
test('盘后选择真实盘后源，未知日历不生成策略买点', async t => {
  const f = await fixture(t);
  f.advance(7 * 60 * 60 * 1000);
  await f.scanner.refresh('US');
  assert.ok(f.controls.session.every(session => session === 'afterhours'));
  assert.equal(f.scanner.snapshot('US').session, 'afterhours');
  assert.ok(f.scanner.snapshot('US').data.strategyPool.rows.every(row => row.watchOnly));
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function waitForSnapshot(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('等待行情快照超时')), 5000);
    const receive = raw => {
      const message = JSON.parse(raw);
      if (predicate(message)) finish(null, message);
    };
    function finish(error, message) {
      clearTimeout(timer);
      ws.off('message', receive);
      error ? reject(error) : resolve(message);
    }
    ws.on('message', receive);
  });
}

function watchFinalProcessing(scanner) {
  const counts = { feed: 0, positions: 0, save: 0 };
  for (const [object, method, name] of [
    [scanner.engine, 'feed', 'feed'], [scanner.engine, 'updatePositions', 'positions'], [scanner.store, 'save', 'save']
  ]) {
    const original = object[method];
    object[method] = (...args) => { counts[name]++; return original(...args); };
  }
  return counts;
}

function earlyRow(symbol, market = 'US', quoteTime = '2026-09-24T13:59:50.000Z') {
  return { market, currency: market === 'CN' ? 'CNY' : 'USD', symbol, name: symbol,
    price: '9.00', high: '10.00', low: '8.90', changePercent: '12', gap: '5',
    rvol: '6', floatRaw: 1e6, volumeRaw: 100, quoteTime, quoteSession: 'regular',
    dataSource: market === 'CN' ? '东方财富' : '雅虎财经' };
}

test('美股成功类别先通过REST/WS展示，不等待慢榜单/持仓报价/float且不提前处理持仓', async t => {
  const rankingGate = deferred(), quoteGate = deferred(), floatGate = deferred(), floatStarted = deferred();
  const f = await fixture(t, { usProvider: {
    fetchRanking: async category => {
      if (category !== 'gainers') await rankingGate.promise;
      return category === 'gainers' ? [earlyRow('LISTED')] : [];
    },
    fetchQuotes: async symbols => { await quoteGate.promise; return symbols.map(symbol => earlyRow(symbol)); },
    enrichFloats: async stocks => {
      floatStarted.resolve();
      await floatGate.promise;
      for (const stock of stocks) { stock.floatRaw = 700000; stock.floatSource = 'float'; }
    }
  } });
  await f.request('/api/positions', 'POST', { symbol: 'OFFLIST', entry: 10, shares: 10, stop: 9.5 });
  const before = f.scanner.snapshot('US');
  const counts = watchFinalProcessing(f.scanner);
  const ws = new WebSocket(f.url.replace('http:', 'ws:'));
  await once(ws, 'message');
  let running;
  try {
    const firstRows = waitForSnapshot(ws, message => message.data.gainers.length > 0);
    running = f.scanner.refresh('US');
    const early = await firstRows;
    assert.equal(early.data.gainers[0].symbol, 'LISTED');
    assert.equal(early.data.docPick[0].symbol, 'LISTED');
    assert.equal(early.data.gainers[0].quoteTime, '2026-09-24T13:59:50.000Z');
    assert.equal(early.categoryStatus.gainers.lastSuccess, '2026-09-24T14:00:00.000Z');
    assert.equal(early.lastUpdateTime, null, '整体成功时间不能在其他榜单尚未完成时推进');
    assert.equal(early.positionsRevision, before.positionsRevision);
    assert.deepEqual(early.data.positions, before.data.positions);
    assert.deepEqual(counts, { feed: 0, positions: 0, save: 0 });
    assert.equal(f.scanner.engine.ticks.size, 0);
    const api = await f.request('/api/scanner/gainers');
    assert.equal(api.body.data[0].symbol, 'LISTED');
    assert.equal((await f.request('/api/positions')).body.positionsRevision, before.positionsRevision);
    rankingGate.resolve();
    quoteGate.resolve();
    await floatStarted.promise;
    assert.deepEqual(counts, { feed: 0, positions: 0, save: 0 }, '补全前也不能提前喂策略或持仓');
    floatGate.resolve();
    await running;
    const final = f.scanner.snapshot('US');
    assert.deepEqual(counts, { feed: 1, positions: 1, save: 1 });
    assert.equal(final.positionsRevision, before.positionsRevision + 1);
    assert.equal(final.data.positions[0].status, 'stop_triggered');
    assert.equal(final.data.positions[0].quoteTime, '2026-09-24T13:59:50.000Z');
    assert.equal(final.data.docPick[0].floatSource, 'float');
    assert.equal(final.data.strategyPool.rows[0].symbol, 'LISTED');
  } finally {
    rankingGate.resolve(); quoteGate.resolve(); floatGate.resolve();
    if (running) await running;
    ws.close(); await once(ws, 'close');
  }
});

test('A股完整榜单先展示，慢独立报价结束后才更新权威持仓和观察策略', async t => {
  const quoteGate = deferred();
  const sourceTime = '2026-09-24T01:59:50.000Z';
  const f = await fixture(t, { now: () => Date.parse('2026-09-24T02:00:00Z'),
    cnSnapshot: async () => ({ gainers: [earlyRow('600000', 'CN', sourceTime)], losers: [], mostActive: [],
      scope: { kind: 'ranked-sample', perRanking: 200 } }),
    cnQuotes: async symbols => { await quoteGate.promise; return symbols.map(symbol => earlyRow(symbol, 'CN', sourceTime)); }
  });
  await f.request('/api/positions?market=CN', 'POST', { symbol: '600001', entry: 10, shares: 100, stop: 9.5 });
  const before = f.scanner.snapshot('CN');
  const counts = watchFinalProcessing(f.scanner);
  const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/?market=CN');
  await once(ws, 'message');
  let running;
  try {
    const firstRows = waitForSnapshot(ws, message => message.data.gainers.length > 0);
    running = f.scanner.refresh('CN');
    const early = await firstRows;
    assert.equal(early.data.gainers[0].symbol, '600000');
    assert.equal(early.data.cnWatch[0].symbol, '600000');
    assert.equal(early.positionsRevision, before.positionsRevision);
    assert.deepEqual(early.data.positions, before.data.positions);
    assert.deepEqual(counts, { feed: 0, positions: 0, save: 0 });
    assert.equal(early.categoryStatus.gainers.lastSuccess, '2026-09-24T02:00:00.000Z');
    assert.equal((await f.request('/api/scanner/gainers?market=CN')).body.data[0].quoteTime, sourceTime);
    quoteGate.resolve(); await running;
    const final = f.scanner.snapshot('CN');
    assert.deepEqual(counts, { feed: 1, positions: 1, save: 1 });
    assert.equal(final.positionsRevision, before.positionsRevision + 1);
    assert.equal(final.data.positions[0].status, 'stop_triggered');
    assert.equal(final.data.positions[0].cannotSell, true);
    assert.equal(final.data.positions[0].quoteTime, sourceTime);
    assert.ok(final.data.strategyPool.rows.every(row => row.watchOnly));
  } finally {
    quoteGate.resolve(); if (running) await running;
    ws.close(); await once(ws, 'close');
  }
});

test('逐类别先播仍保留失败类别的缓存/成功时间，其他成功类别得到真实新时间', async t => {
  let fail = false;
  const quoteGate = deferred();
  const f = await fixture(t, { usProvider: {
    fetchRanking: async category => {
      if (fail && category === 'gainers') throw new Error('HTTP 503');
      return category === (fail ? 'losers' : 'gainers') ? [earlyRow(fail ? 'SECOND' : 'LISTED')] : [];
    },
    fetchQuotes: async () => { if (fail) await quoteGate.promise; return []; },
    enrichFloats: async () => {}
  } });
  await f.scanner.refresh('US');
  const before = f.scanner.snapshot('US');
  f.advance(15000); fail = true;
  const counts = watchFinalProcessing(f.scanner);
  const ws = new WebSocket(f.url.replace('http:', 'ws:'));
  await once(ws, 'message');
  let running;
  try {
    const nextRows = waitForSnapshot(ws, message => message.data.losers[0]?.symbol === 'SECOND');
    running = f.scanner.refresh('US');
    const early = await nextRows;
    assert.deepEqual(early.data.gainers, before.data.gainers);
    assert.equal(early.categoryStatus.gainers.lastSuccess, before.categoryStatus.gainers.lastSuccess);
    assert.equal(early.categoryStatus.losers.lastSuccess, '2026-09-24T14:00:15.000Z');
    assert.equal(early.lastUpdateTime, before.lastUpdateTime);
    assert.match(early.dataError, /gainers.*获取失败/);
    assert.deepEqual(counts, { feed: 0, positions: 0, save: 0 });
    quoteGate.resolve(); await running;
    const final = f.scanner.snapshot('US');
    assert.deepEqual(final.data.gainers, before.data.gainers);
    assert.equal(final.lastUpdateTime, before.lastUpdateTime);
    assert.equal(final.categoryStatus.gainers.lastSuccess, before.categoryStatus.gainers.lastSuccess);
    assert.match(final.dataError, /gainers.*获取失败/);
  } finally {
    quoteGate.resolve(); if (running) await running;
    ws.close(); await once(ws, 'close');
  }
});

test('A股批榜失败仍保留完整旧快照，不能把部分失败当作提前发布成功', async t => {
  let fail = false;
  const quoteGate = deferred();
  const f = await fixture(t, {
    cnSnapshot: async () => {
      if (fail) throw new Error('one ranking failed');
      return { gainers: [earlyRow('600000', 'CN')], losers: [], mostActive: [] };
    },
    cnQuotes: async () => { if (fail) await quoteGate.promise; return []; }
  });
  await f.scanner.refresh('CN');
  const before = f.scanner.snapshot('CN');
  fail = true; f.advance(15000);
  const running = f.scanner.refresh('CN');
  try {
    const pending = await f.request('/api/scanner/gainers?market=CN');
    assert.deepEqual(pending.body.data, before.data.gainers);
    assert.equal(pending.body.lastUpdateTime, before.lastUpdateTime);
    assert.equal(pending.body.positionsRevision, before.positionsRevision);
    quoteGate.resolve(); await running;
    const final = f.scanner.snapshot('CN');
    assert.deepEqual(final.data.gainers, before.data.gainers);
    assert.equal(final.lastUpdateTime, before.lastUpdateTime);
    assert.deepEqual(final.categoryStatus, before.categoryStatus);
    assert.match(final.dataError, /A 股榜单暂时无法刷新/);
  } finally { quoteGate.resolve(); await running; }
});
