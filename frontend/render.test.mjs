import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('both strategy pages render absent quotes, T+1 and risk metadata without runtime errors', async () => {
  // 静态组件测试不访问浏览器，也不读取用户的本机存储。
  const before = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const vite = await createServer({ root: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const module = await vite.ssrLoadModule('/src/StrategyCenter.jsx');
    const stocks = { gainers: [], losers: [], mostActive: [], docPick: [], docPickStrict: [],
      strategyPool: { limited: true, rows: [] }, positions: [{ symbol: '600000', entry: 10, price: null,
        shares: 100, peak: 10, pnlPct: 0, stop: 9.5, quoteTime: null, status: 'stale', sellable: false,
        signals: ['报价过期'], tradableOn: '2026-10-08' }] };
    const props = { stocks, selectedStock: null, trade: { date: '2026-10-02', entries: [], maxLoss: 200 },
      setTrade: () => {}, onMarkBuy: () => {}, onClosePosition: () => {}, onAdjustPosition: () => {},
      pending: () => false, historyDates: {}, scope: { description: '测试样本' }, calendarKnown: true };
    const cn = renderToStaticMarkup(React.createElement(module.CNStrategyCenter, props));
    assert.match(cn, /T\+1/);
    assert.match(cn, /报价时间未知/);
    assert.match(cn, /disabled=""/);
    assert.match(cn, /¥10\.00 \/ —/);
    const us = renderToStaticMarkup(React.createElement(module.StrategyCenter, { ...props,
      session: 'regular', etMeta: { minutes: 600, day: 4 }, selectedSymbol: null, onOpenPreset: () => {} }));
    assert.match(us, /持仓监控/);
    assert.match(us, /行情过期/);
    assert.doesNotMatch(us, /\$0\.00<\/td>/);
  } finally { await vite.close(); globalThis.localStorage = before; }
});
