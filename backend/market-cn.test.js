const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getChinaMarketInfo, transformChinaStock, fetchChinaSnapshot, fetchChinaQuotes } = require('./market-cn');

function quote(overrides = {}) {
  return { f12: '600000', f13: 1, f14: '浦发银行', f2: 10, f3: 5, f4: 0.5,
    f5: 1200, f10: 2.5, f15: 10.5, f16: 9.5, f17: 9.6, f18: 9,
    f20: 1e9, f21: 5e8, f124: 1790818800, ...overrides };
}

test('人民币行情保持小数价格，手转换成股，流通盘明确为估算', () => {
  const stock = transformChinaStock(quote());
  assert.equal(stock.price, '10.00');
  assert.equal(stock.currency, 'CNY');
  assert.equal(stock.volumeRaw, 120000);
  assert.equal(stock.volume, '12.00万');
  assert.equal(stock.floatRaw, 50000000);
  assert.equal(stock.floatSource, 'circulatingCap');
  assert.equal(stock.gap, '6.67');
  assert.equal(stock.chartSymbol, 'SSE:600000');
});

test('深市和北交所代码含前导零；北交所不伪造 TradingView 映射', () => {
  assert.equal(transformChinaStock(quote({ f12: '000001', f13: 0 })).chartSymbol, 'SZSE:000001');
  for (const code of ['430047', '830799', '920002']) {
    const stock = transformChinaStock(quote({ f12: code, f13: 0 }));
    assert.equal(stock.exchange, 'BSE');
    assert.equal(stock.chartSymbol, null);
    assert.match(stock.quoteUrl, new RegExp(`0\\.${code}$`));
  }
});

test('停牌或无价格股票被排除；缺失指标不冒充零或真实值', () => {
  assert.equal(transformChinaStock(quote({ f2: '-' })), null);
  assert.equal(transformChinaStock(quote({ f3: '-' })), null);
  const stock = transformChinaStock(quote({ f5: '-', f10: '-', f17: '-', f21: '-', f124: '-' }));
  assert.equal(stock.volumeRaw, null);
  assert.equal(stock.rvol, '—');
  assert.equal(stock.gap, '—');
  assert.equal(stock.float, '—');
  assert.equal(stock.quoteTime, null);
});

test('中国交易时段使用北京时间，处理午休及两次集合竞价边界', () => {
  const expected = { '09:14': 'closed', '09:15': 'auction', '09:24': 'auction', '09:25': 'preopen', '09:29': 'preopen',
    '09:30': 'regular', '11:29': 'regular', '11:30': 'lunch', '12:59': 'lunch',
    '13:00': 'regular', '14:56': 'regular', '14:57': 'closingAuction', '15:00': 'closed' };
  for (const [time, session] of Object.entries(expected)) {
    assert.equal(getChinaMarketInfo(new Date(`2026-09-30T${time}:00+08:00`)).session, session, time);
  }
  assert.equal(getChinaMarketInfo(new Date('2026-09-30T01:30:00Z')).session, 'regular');
});

test('国庆及周末休市；未知年度明确标注日历未登记', () => {
  for (const date of ['2026-10-01', '2026-10-07', '2026-10-10', '2026-02-23']) {
    assert.equal(getChinaMarketInfo(new Date(`${date}T10:00:00+08:00`)).session, 'closed');
  }
  assert.equal(getChinaMarketInfo(new Date('2026-10-08T10:00:00+08:00')).session, 'regular');
  assert.equal(getChinaMarketInfo(new Date('2027-01-04T10:00:00+08:00')).calendarKnown, false);
  assert.equal(getChinaMarketInfo(new Date('2027-01-04T10:00:00+08:00')).session, 'unknown');
});

test('三类榜单去重筛选、榜单方向正确、跳空使用开盘价而非涨跌幅', async () => {
  const rows = [quote({ f15: 10.01 }), quote({ f12: '000001', f13: 0, f3: -4, f5: 6000, f17: 9 }),
    quote({ f12: '300001', f13: 0, f3: 8, f5: 3000, f17: '-', f15: 10.02 })];
  const requests = [];
  const snapshot = await fetchChinaSnapshot(async (url, options) => {
    requests.push(new URL(url));
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ rc: 0, data: { diff: Object.fromEntries(rows.map((r, i) => [i, r])) } }));
  });
  assert.equal(requests.length, 3);
  assert.deepEqual(snapshot.gainers.map(s => s.symbol), ['300001', '600000']);
  assert.deepEqual(snapshot.losers.map(s => s.symbol), ['000001']);
  assert.equal(snapshot.mostActive[0].symbol, '000001');
  assert.equal(snapshot.hodMomentum.length, 2);
  assert.deepEqual(snapshot.gapScanner.map(s => s.symbol), ['600000']);
  assert.ok(requests.every(url => url.hostname === 'push2.eastmoney.com'));
  assert.ok(requests.every(url => url.searchParams.get('pz') === '200'));
  assert.equal(snapshot.scope.kind, 'ranked-sample');
  assert.equal(snapshot.scope.sampleSize, 3);
  assert.ok(requests.every(url => url.searchParams.get('fs').includes('m:0+t:81+s:262144')));
});

test('board metadata marks new listings as uncertain and uses current ST rules', () => {
  assert.equal(transformChinaStock(quote({ f12: '688001' })).board, 'STAR');
  assert.equal(transformChinaStock(quote({ f12: '300001', f13: 0 })).standardLimitPct, 20);
  assert.equal(transformChinaStock(quote({ f12: '920002', f13: 0 })).standardLimitPct, 30);
  const st = transformChinaStock(quote({ f14: '*ST测试' }));
  assert.equal(st.riskWarning, true);
  assert.equal(st.standardLimitPct, 10); // 2026-07-06 新规已生效。
  assert.equal(st.newListing, null);
  assert.equal(st.limitIsEstimate, true);
  assert.equal(transformChinaStock(quote({ f14: 'N测试' })).limitPct, null);
  assert.equal(transformChinaStock(quote({ f14: 'C测试' })).newListing, true);
  assert.equal(transformChinaStock(quote({ f14: 'ST测试', f124: Date.parse('2026-06-01T10:00:00+08:00') / 1000 })).standardLimitPct, 5);
});

test('HOD excludes stocks far from the daily high, even with a large gain', async () => {
  const rows = [quote({ f3: 15, f15: 12 }), quote({ f12: '000001', f13: 0, f3: 6, f15: 10.01 })];
  const snapshot = await fetchChinaSnapshot(async () => new Response(JSON.stringify({ rc: 0, data: { diff: rows } })));
  assert.deepEqual(snapshot.hodMomentum.map(s => s.symbol), ['000001']);
});

test('round cancellation reaches ranking and held quote requests', async () => {
  const round = new AbortController();
  let signals = [];
  const stub = async (_, options) => {
    signals.push(options.signal);
    return new Response(JSON.stringify({ rc: 0, data: { diff: [quote()] } }));
  };
  await fetchChinaSnapshot(stub, round.signal);
  await fetchChinaQuotes(stub, ['600000'], round.signal);
  assert.equal(signals.length, 4);
  round.abort();
  assert.ok(signals.every(signal => signal.aborted));
});

test('held quotes query explicit symbols independently of rankings and reject bad symbols', async () => {
  const requests = [];
  const rows = [quote(), quote({ f12: '000001', f13: 0 }), quote({ f12: '920002', f13: 0 }), quote({ f12: '600111' })];
  const fetcher = async url => { requests.push(new URL(url)); return new Response(JSON.stringify({ rc: 0, data: { diff: rows } })); };
  const result = await fetchChinaQuotes(fetcher, ['600000', '000001', '920002', '600000']);
  assert.equal(requests[0].pathname, '/api/qt/ulist.np/get');
  assert.equal(requests[0].searchParams.get('np'), '1');
  assert.equal(requests[0].searchParams.get('pz'), '50');
  assert.equal(requests[0].searchParams.get('secids'), '1.600000,0.000001,0.920002');
  assert.deepEqual(result.map(s => s.symbol), ['600000', '000001', '920002']);
  assert.deepEqual(await fetchChinaQuotes(fetcher, []), []);
  await assert.rejects(fetchChinaQuotes(fetcher, ['../secret']), /Invalid/);
  await assert.rejects(fetchChinaQuotes(async () => new Response('', { status: 503 }), ['600000']), /HTTP 503/);
});

test('行情源错误或无有效数据必须上报失败，不能替换为成功的空快照', async () => {
  await assert.rejects(fetchChinaSnapshot(async () => new Response('', { status: 503 })), /HTTP 503/);
  await assert.rejects(fetchChinaSnapshot(async () => new Response(JSON.stringify({ rc: 0, data: { diff: [] } }))), /有效行情/);
});
