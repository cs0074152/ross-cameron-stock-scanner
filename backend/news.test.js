const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYahoo, parseCninfo, readJson, createNewsProvider, safeLink } = require('./news-provider');
const { createNewsService } = require('./news-service');
const DAY = 86400000, NOW = Date.parse('2026-10-08T04:00:00Z');
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const row = (extra = {}) => ({ uuid: 'one', title: '<b>Company</b> update', link: 'https://finance.yahoo.com/news/company-1.html', publisher: '<i>Press</i>', relatedTickers: ['AAPL'], providerPublishTime: NOW / 1000, ...extra });
const items = parseYahoo({ news: [row()] }, 'AAPL', NOW);
test('Yahoo 严格股票关联、文本剥标签、URL安全、标题和URL去重、时间分类', () => {
  const result = parseYahoo({ news: [row(), row({ uuid: 'two' }), row({ relatedTickers: ['MSFT'] }), row({ link: 'https://finance.yahoo.com:444/news/unsafe', title: 'unsafe' }),
    row({ uuid: 'future', title: 'Future', link: 'https://finance.yahoo.com/news/future', providerPublishTime: NOW / 1000 + 1 }),
    row({ uuid: 'unknown', title: 'Unknown', link: 'https://finance.yahoo.com/news/unknown', providerPublishTime: null })] }, 'AAPL', NOW);
  assert.equal(result.length, 3); assert.equal(result[0].title, 'Company update'); assert.equal(result[0].publisher, 'Press');
  assert.equal(result[0].timeStatus, 'recent'); assert.equal(result[1].timeStatus, 'future'); assert.equal(result[2].timeStatus, 'unknown');
  assert.throws(() => parseYahoo({}, 'AAPL', NOW), /结构/);
  assert.deepEqual(parseYahoo({ news: [] }, 'AAPL', NOW), []);
});
test('巨潮公告精确代码和固定PDF路径、北京日精度、未来日期不算近期', () => {
  const announcement = { secCode: '000001', announcementId: 'a', announcementTitle: '<em>公告</em>', adjunctUrl: 'finalpage/2026-10-08/abc.PDF', announcementTime: Date.parse('2026-10-07T16:00:00Z') };
  const result = parseCninfo({ announcements: [announcement, { ...announcement, secCode: '000002' }, { ...announcement, adjunctUrl: 'https://evil.com/a.PDF' }] }, '000001', NOW);
  assert.equal(result.length, 1); assert.equal(result[0].publishedDate, '2026-10-08'); assert.equal(result[0].timePrecision, 'day'); assert.equal(result[0].title, '公告');
  const future = parseCninfo({ announcements: [{ ...announcement, announcementTime: NOW + DAY }] }, '000001', NOW);
  assert.equal(future[0].timeStatus, 'future');
  const exact = parseCninfo({ announcements: [{ ...announcement, announcementTime: NOW + 1000 }] }, '000001', NOW)[0];
  assert.equal(exact.timePrecision, 'second'); assert.equal(exact.publishedAt, new Date(NOW + 1000).toISOString()); assert.equal(exact.timeStatus, 'future');
  const past = parseCninfo({ announcements: [{ ...announcement, announcementTime: NOW - 1000 }] }, '000001', NOW)[0];
  assert.equal(past.timePrecision, 'second'); assert.equal(past.timeStatus, 'recent');
  const evening = parseCninfo({ announcements: [{ ...announcement, announcementTime: Date.parse('2026-10-07T17:00:00Z') }] }, '000001', NOW)[0];
  assert.equal(evening.publishedDate, '2026-10-08'); assert.equal(evening.publishedAt, '2026-10-07T17:00:00.000Z');
});
test('Yahoo真实文章路径可追溯，拒绝quote/root/login和伪装域名', () => {
  const paths = ['/markets/stocks/articles/apple-aapl-catalyst-could-drive-135808239.html', '/technology/articles/apple-story.html', '/technology/ai/articles/company-story.html', '/technology/article/story.html', '/m/c861c57f-11ed-33ef-ad7c-615f55181128/dow-jones-futures-fall-as-oil.html', '/news/company-story.html'];
  for (const path of paths) assert.equal(safeLink(`https://finance.yahoo.com${path}`), `https://finance.yahoo.com${path}`);
  const parsed = parseYahoo({ news: paths.map((path, index) => row({ uuid: `${index}`, title: `Story ${index}`, link: `https://finance.yahoo.com${path}` })) }, 'AAPL', NOW);
  assert.equal(parsed.length, paths.length);
  for (const url of ['https://finance.yahoo.com/', 'https://finance.yahoo.com/quote/AAPL', 'https://finance.yahoo.com/login', 'https://finance.yahoo.com.attacker.invalid/news/story.html', 'http://finance.yahoo.com/news/story.html', 'https://user@finance.yahoo.com/news/story.html', 'https://finance.yahoo.com:444/news/story.html', 'https://finance.yahoo.com/m/fake/story.html']) assert.equal(safeLink(url), null);
});
test('巨潮实际零公告响应null+totalAnnouncement0为空，其他null和错误类型为来源异常', () => {
  const empty = { classifiedAnnouncements: null, totalSecurities: 0, totalAnnouncement: 0, totalRecordNum: 0, announcements: null, categoryList: null, hasMore: false, totalpages: 0 };
  assert.deepEqual(parseCninfo(empty, '600519', NOW), []);
  for (const response of [{}, { announcements: null }, { announcements: null, totalAnnouncement: 1 }, { announcements: null, totalAnnouncement: '0' }, { announcements: {}, totalAnnouncement: 0 }, { totalAnnouncement: 0 }]) assert.throws(() => parseCninfo(response, '600519', NOW), /结构/);
});
test('读取JSON累计大小限制会取消流；错误content-type/JSON不能当空结果', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } });
  await assert.rejects(readJson(response, new AbortController().signal, 10), /大小/); assert.equal(cancelled, true);
  await assert.rejects(readJson(new Response('<html/>'), new AbortController().signal), /JSON/);
  await assert.rejects(readJson(new Response('oops', { headers: { 'Content-Type': 'application/json' } }), new AbortController().signal), /解析/);
});
test('缓存5分钟、同键去重、失败保留旧数据且最后成功时间不延长、30秒退避、24小时丢旧数据', async () => {
  let clock = NOW, calls = 0, fail = false, resolve;
  const service = createNewsService({ now: () => clock, fetchNews: async () => { calls++; if (resolve === null) await new Promise(r => { resolve = r; }); if (fail) throw Error('source'); return items; } });
  resolve = null;
  const a = service.get('US', 'AAPL'), b = service.get('US', 'AAPL');
  assert.equal(calls, 1); resolve(); const first = await a; assert.deepEqual(await b, first);
  await service.get('US', 'AAPL', { refresh: true }); assert.equal(calls, 1);
  clock += 300001; fail = true;
  const stale = await service.get('US', 'AAPL'); assert.equal(stale.refreshing, true); assert.equal(stale.stale, true);
  await new Promise(setImmediate);
  const failed = await service.get('US', 'AAPL'); assert.equal(failed.partial, true); assert.equal(failed.status, 'found'); assert.equal(failed.lastSuccessAt, first.lastSuccessAt); assert.equal(calls, 2);
  clock = NOW + DAY + 1;
  const expired = await service.get('US', 'AAPL'); assert.equal(expired.items.length, 0); assert.equal(expired.status, 'unavailable'); assert.equal(expired.lastSuccessAt, first.lastSuccessAt);
  await service.get('US', 'AAPL'); assert.equal(calls, 3); service.close();
});
test('成功空结果为none，来源失败为unavailable且强制刷新仍受失败退避限制', async () => {
  let calls = 0;
  const empty = createNewsService({ fetchNews: async () => [] }); assert.equal((await empty.get('US', 'AAPL')).status, 'none'); empty.close();
  const failed = createNewsService({ fetchNews: async () => { calls++; throw Error(); } });
  assert.equal((await failed.get('US', 'AAPL')).status, 'unavailable'); await failed.get('US', 'AAPL', { refresh: true }); assert.equal(calls, 1); failed.close();
});
test('缓存按当前时间重算七天边界和未来时刻，保留lastSuccessAt', async () => {
  let clock = NOW, fail = false;
  const old = parseYahoo({ news: [row({ providerPublishTime: (NOW - 7 * DAY + 1000) / 1000 }), row({ uuid: 'future', title: 'Future', link: 'https://finance.yahoo.com/news/future', providerPublishTime: (NOW + 1000) / 1000 })] }, 'AAPL', NOW);
  const service = createNewsService({ now: () => clock, fetchNews: async () => { if (fail) throw Error(); return old; } });
  const first = await service.get('US', 'AAPL'); assert.equal(first.recentCount, 1); assert.equal(first.items[1].timeStatus, 'future');
  clock += 2000;
  const cached = await service.get('US', 'AAPL'); assert.equal(cached.items[0].timeStatus, 'older'); assert.equal(cached.items[1].timeStatus, 'recent'); assert.equal(cached.recentCount, 1); assert.equal(cached.lastSuccessAt, first.lastSuccessAt);
  clock += 300000; fail = true;
  await service.get('US', 'AAPL'); await new Promise(setImmediate);
  const stale = await service.get('US', 'AAPL'); assert.equal(stale.stale, true); assert.equal(stale.items[0].timeStatus, 'older'); assert.equal(stale.lastSuccessAt, first.lastSuccessAt); service.close();
});
test('最多两个任务、四个等待任务；队列超时移除且不补发，停止取消所有等待者', async () => {
  const called = [];
  const service = createNewsService({ budgetMs: 40, fetchNews: async (market, symbol, signal) => {
    called.push(symbol); await new Promise((resolve, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 15), { once: true })); return [];
  } });
  const pending = ['A','B','C','D','E','F'].map(symbol => service.get('US', symbol));
  await assert.rejects(service.get('US', 'G'), error => error.status === 429 && error.retryAfter === 6);
  const results = await Promise.all(pending); assert.ok(results.every(r => r.status === 'unavailable')); assert.deepEqual(called, ['A','B']);
  const late = service.get('US', 'H'); service.close(); assert.equal((await late).status, 'unavailable'); await assert.rejects(service.get('US', 'I'), /停止/);
});
test('请求体读取也受期限约束，暂停的流会被取消', async () => {
  let cancelled = false;
  const service = createNewsService({ budgetMs: 30, safeFetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal((await service.get('US', 'AAPL')).status, 'unavailable'); assert.equal(cancelled, true); service.close();
});
test('共享CN映射单独查询取消不能取消他人；映射和响应体全局出站不超过2', async () => {
  let count = 0, max = 0, maps = 0;
  const provider = createNewsProvider({ now: () => NOW, safeFetch: async (url, options) => {
    count++; max = Math.max(max, count);
    await new Promise(r => setTimeout(r, 15)); count--;
    if (url.includes('szse_stock')) { maps++; return json({ stockList: [{ code: '000001', orgId: 'gssz1' }, { code: '000002', orgId: 'gssz2' }] }); }
    assert.equal(options.method, 'POST'); assert.match(options.body, /stock=00000[12]%2Cgssz[12]/); return json({ announcements: [] });
  } });
  const cancelled = new AbortController(), other = new AbortController();
  const first = provider('CN', '000001', cancelled.signal); const second = provider('CN', '000002', other.signal); cancelled.abort();
  await assert.rejects(first); assert.deepEqual(await second, []); assert.equal(maps, 1); assert.ok(max <= 2);
  await provider('CN', '000001', other.signal); assert.equal(maps, 1);
});
test('CN映射失败退避30秒，成功共享24小时后重新获取', async () => {
  let clock = NOW, maps = 0, fail = true;
  const provider = createNewsProvider({ now: () => clock, safeFetch: async url => {
    if (url.includes('szse_stock')) { maps++; if (fail) throw Error('unavailable'); return json({ stockList: [{ code: '000001', orgId: 'gssz1' }] }); }
    return json({ announcements: [] });
  } });
  const signal = new AbortController().signal;
  await assert.rejects(provider('CN', '000001', signal)); fail = false;
  await assert.rejects(provider('CN', '000001', signal)); assert.equal(maps, 1);
  clock += 30001; await provider('CN', '000001', signal); await provider('CN', '000001', signal); assert.equal(maps, 2);
  clock += DAY; await provider('CN', '000001', signal); assert.equal(maps, 3);
});
test('缓存超过100股票淘汰最久未访问键，失败轮询不循环打来源', async () => {
  let calls = 0;
  const service = createNewsService({ fetchNews: async () => { calls++; return []; } });
  await service.get('US', 'FIRST'); await service.get('US', 'SECOND');
  for (let i = 0; i < 98; i++) await service.get('US', `S${i}`);
  await service.get('US', 'FIRST'); await service.get('US', 'NEW'); await service.get('US', 'FIRST'); assert.equal(calls, 101);
  await service.get('US', 'SECOND'); assert.equal(calls, 102); service.close();
});
