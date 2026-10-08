const test = require('node:test');
const assert = require('node:assert/strict');
const { createUSProvider, transformYahooStock, parseExtendedTable } = require('./market-us');
test('冷启动和JSON行情不加载HTML解析器，首次盘后HTML解析才加载', () => {
  const { execFileSync } = require('node:child_process');
  const source = `
    const assert = require('node:assert/strict');
    const modulePath = ${JSON.stringify(require.resolve('./market-us'))};
    const { transformYahooStock, parseExtendedTable } = require(modulePath);
    const parserLoaded = () => Object.keys(require.cache).some(p => /[\\\\/]cheerio[\\\\/]/.test(p));
    assert.equal(parserLoaded(), false);
    transformYahooStock({symbol:'TEST', regularMarketPrice:10});
    assert.equal(parserLoaded(), false);
    parseExtendedTable('<main>Oct 1, 2026<table><tbody><tr><td>1</td><td>TEST</td><td>公司</td><td>6%</td><td>10.60</td></tr></tbody></table></main>', 'afterhours');
    assert.equal(parserLoaded(), true);
  `;
  execFileSync(process.execPath, ['-e', source], { timeout: 10000 });
});
test('Yahoo 保留真实报价时间和有效零跳空，盘后采用 post 字段', () => {
  const input = { symbol: 'TEST', regularMarketPrice: 10.6, regularMarketOpen: 10,
    regularMarketPreviousClose: 10, regularMarketTime: 1790861400,
    postMarketPrice: 11, postMarketTime: 1790865000, postMarketChangePercent: 3.77 };
  const regular = transformYahooStock(input);
  assert.equal(regular.gap, '0.00');
  assert.equal(regular.quoteTime, new Date(input.regularMarketTime * 1000).toISOString());
  const after = transformYahooStock(input, 'afterhours');
  assert.equal(after.price, '11.00');
  assert.equal(after.quoteSession, 'afterhours');
  assert.equal(after.quoteTime, new Date(input.postMarketTime * 1000).toISOString());
  assert.equal(after.volumeRaw, null);
  assert.equal(after.rvol, '—');
});
test('无报价时间不能以请求时间冒充；旧盘后价格不能覆盖新的 regular', () => {
  assert.equal(transformYahooStock({ symbol: 'TEST', regularMarketPrice: 10 }).quoteTime, null);
  const stock = transformYahooStock({ symbol: 'TEST', regularMarketPrice: 10, regularMarketTime: 100,
    postMarketPrice: 9, postMarketTime: 50 }, 'afterhours');
  assert.equal(stock.price, '10.00');
  assert.equal(stock.quoteSession, 'regular');
});
test('真实盘后表 Close 列不能当成交量，未知量比与流通盘不编造', () => {
  const html = '<main>Oct 1, 2026<table><thead><tr><th>No.</th><th>Symbol</th><th>Company</th><th>% Change</th><th>Afterhr. Price</th><th>Afterhr. Close</th><th>Market Cap</th></tr></thead><tbody><tr><td>1</td><td>TEST</td><td>公司</td><td>6%</td><td>10.60</td><td>10.00</td><td>20M</td></tr></tbody></table></main>';
  const [stock] = parseExtendedTable(html, 'afterhours');
  assert.equal(stock.volumeRaw, null);
  assert.equal(stock.quoteTime, null);
  assert.equal(stock.sourceDate, '2026-10-01');
  assert.equal(stock.floatRaw, null);
  assert.equal(stock.rvol, '—');
});
test('源失败和空格式会抛错而非空成功；盘后请求使用盘后路径', async () => {
  const urls = [];
  const provider = createUSProvider(async url => { urls.push(url); return new Response('', { status: 503 }); });
  await assert.rejects(provider.fetchRanking('gainers', 'afterhours'), /503/);
  assert.match(urls[0], /markets\/afterhours\/gainers/);
  await assert.rejects(provider.fetchRanking('gainers', 'regular'), /503/);
  const invalid = createUSProvider(async () => Response.json({ finance: { result: [{ quotes: [] }] } }));
  await assert.rejects(invalid.fetchRanking('gainers', 'regular'), /有效榜单/);
});
test('独立持仓查询与榜单无关，返回榜外股票报价', async () => {
  const seen = [];
  const provider = createUSProvider(async url => {
    seen.push(url);
    if (url === 'https://fc.yahoo.com') return new Response('', { headers: { 'set-cookie': 'test=1' } });
    if (url.includes('getcrumb')) return new Response('testcrumb');
    return Response.json({ quoteResponse: { result: [{ symbol: 'OFFLIST', regularMarketPrice: 9, regularMarketTime: 1790861400 }] } });
  });
  const stocks = await provider.fetchQuotes(['OFFLIST'], 'regular');
  assert.equal(stocks[0].symbol, 'OFFLIST');
  assert.ok(stocks[0].quoteTime);
  assert.ok(seen.some(url => url.includes('symbols=OFFLIST')));
});
