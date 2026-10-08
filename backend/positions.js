// Local, durable simulated positions and idempotent close receipts.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { marketDate, timestampOf, defaultMarketInfo, QUOTE_MAX_AGE_MS, ACTIVE_SESSIONS, cnMetadata } = require('./strategy');

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function checkedMarket(market) {
  if (market !== 'US' && market !== 'CN') throw httpError(400, 'Unknown market');
  return market;
}

function checkedSymbol(symbol, market) {
  const value = String(symbol || '').trim().toUpperCase();
  if (!(market === 'CN' ? /^\d{6}$/ : /^[A-Z][A-Z0-9.-]{0,14}$/).test(value)) {
    throw httpError(400, '无效股票代码');
  }
  return value;
}

function positiveNumber(value, field, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw httpError(400, `${field} 必须是有效正数`);
  return n;
}

function createPositionStore({ filePath, getMarketInfo = defaultMarketInfo } = {}) {
  if (!filePath) throw new Error('Position persistence filePath is required');
  const positions = new Map();
  const receipts = new Map();
  const initializedMarkets = new Set();
  const keyOf = (symbol, market) => `${checkedMarket(market)}:${checkedSymbol(symbol, market)}`;
  const infoAt = (market, now) => getMarketInfo(market, now) || defaultMarketInfo(market, now);

  function list(market = 'US') {
    checkedMarket(market);
    return Array.from(positions.values()).filter(p => p.market === market).map(p => ({ ...p, signals: [...(p.signals || [])] }));
  }

  function save() {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    const content = JSON.stringify({ version: 1, initializedMarkets: [...initializedMarkets],
      positions: [...positions.values()], receipts: [...receipts.values()] }, null, 2);
    let descriptor;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch { /* a failed creation has no temporary file */ }
      throw httpError(503, `持仓保存失败：${error.message}`);
    }
  }

  function transaction(action) {
    const previousPositions = new Map(positions);
    const previousReceipts = new Map(receipts);
    const previousMarkets = new Set(initializedMarkets);
    try {
      const result = action();
      save();
      return result;
    } catch (error) {
      positions.clear();
      for (const [key, value] of previousPositions) positions.set(key, value);
      receipts.clear();
      for (const [key, value] of previousReceipts) receipts.set(key, value);
      initializedMarkets.clear();
      for (const value of previousMarkets) initializedMarkets.add(value);
      throw error;
    }
  }

  function normalize(payload, market, existing, now, restoring = false) {
    if (!payload || typeof payload !== 'object') throw httpError(400, '持仓参数无效');
    if (payload.market != null && payload.market !== market) throw httpError(400, '持仓市场不匹配');
    const symbol = checkedSymbol(payload.symbol, market);
    const entry = positiveNumber(payload.entry ?? existing?.entry, 'entry');
    const shares = payload.shares === undefined ? (existing?.shares ?? 0) : Number(payload.shares);
    if (!Number.isSafeInteger(shares) || shares < 0) throw httpError(400, 'shares 必须是非负整数');
    const stop = payload.stop === undefined && existing ? existing.stop : positiveNumber(payload.stop, 'stop', true);
    const target = payload.target === undefined && existing ? existing.target : positiveNumber(payload.target, 'target', true);
    const suppliedEntryTime = timestampOf(payload.entryTime);
    const entryTime = existing?.entryTime ?? (restoring && suppliedEntryTime != null && suppliedEntryTime <= now ? suppliedEntryTime : now);
    const tradeDate = marketDate(entryTime, market);
    const today = marketDate(now, market);
    const addedShares = existing && (shares > existing.shares || entry !== existing.entry);
    const lastBuyDate = market === 'CN'
      ? (addedShares ? today : existing?.lastBuyDate || (restoring && /^\d{4}-\d{2}-\d{2}$/.test(payload.lastBuyDate || '') && payload.lastBuyDate >= tradeDate ? payload.lastBuyDate : tradeDate))
      : tradeDate;
    const quoteTime = existing?.quoteTime ?? (restoring && timestampOf(payload.quoteTime) != null && timestampOf(payload.quoteTime) <= now ? new Date(timestampOf(payload.quoteTime)).toISOString() : null);
    const sourcePrice = existing?.price ?? (restoring && Number.isFinite(Number(payload.price)) && Number(payload.price) > 0 ? Number(payload.price) : null);
    const savedPeak = existing?.peak ?? (restoring && Number.isFinite(Number(payload.peak)) && Number(payload.peak) > 0 ? Number(payload.peak) : entry);
    const peak = Math.max(savedPeak, entry, sourcePrice || entry);
    const info = infoAt(market, now);
    const settlementDate = ACTIVE_SESSIONS.has(info.session) ? today : (info.lastTradingDate || today);
    const cannotSell = market === 'CN' && lastBuyDate >= settlementDate;
    return {
      ...(existing || {}), market, currency: market === 'CN' ? 'CNY' : 'USD', symbol,
      name: payload.name || existing?.name || symbol, entry, shares, stop, target, entryTime, tradeDate, lastBuyDate,
      peak, price: sourcePrice, quoteTime, updatedAt: timestampOf(quoteTime),
      pnlPct: sourcePrice == null ? 0 : (sourcePrice - entry) / entry * 100,
      status: existing?.status || 'stale', signals: [...(existing?.signals || [])],
      cannotSell, sellable: !cannotSell,
      tradableOn: cannotSell && info.calendarKnown ? (info.nextTradingDate || null) : null,
      ...(market === 'CN' ? cnMetadata({ ...existing, ...payload, symbol }) : {})
    };
  }

  function upsert(payload, market = 'US', { now = Date.now() } = {}) {
    checkedMarket(market);
    const key = keyOf(payload?.symbol, market);
    const position = normalize(payload, market, positions.get(key), now);
    return transaction(() => {
      positions.set(key, position);
      initializedMarkets.add(market);
      return { ...position };
    });
  }

  function hasState(market = 'US') {
    return initializedMarkets.has(checkedMarket(market));
  }

  function trades(market = 'US') {
    checkedMarket(market);
    return Array.from(receipts.values()).filter(receipt => receipt.market === market)
      .sort((a, b) => a.closedAt - b.closedAt).map(receipt => ({ ...receipt }));
  }

  function restore(legacy, market = 'US', { now = Date.now() } = {}) {
    checkedMarket(market);
    if (!Array.isArray(legacy)) throw httpError(400, 'positions 必须是数组');
    // A persisted empty market is authoritative: old localStorage must never resurrect a close.
    if (hasState(market)) return list(market);
    const normalized = legacy.map(raw => normalize(raw, market, null, now, true));
    return transaction(() => {
      for (const position of normalized) positions.set(keyOf(position.symbol, market), position);
      initializedMarkets.add(market);
      return list(market);
    });
  }

  function close(symbol, market = 'US', { operationId, now = Date.now(), session } = {}) {
    checkedMarket(market);
    const key = keyOf(symbol, market);
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(operationId)) {
      throw httpError(400, '平仓需要有效的 operationId');
    }
    const prior = receipts.get(operationId);
    if (prior) {
      if (prior.market !== market || prior.symbol !== checkedSymbol(symbol, market)) throw httpError(409, 'operationId 已用于另一项操作');
      return { ...prior, data: list(market) };
    }
    const position = positions.get(key);
    if (!position) throw httpError(404, 'position not found');
    const info = infoAt(market, now);
    if (market === 'CN' && !info.calendarKnown) throw httpError(409, '交易日历未知，暂不能确认 A 股 T+1 可卖日期');
    const date = info.date || marketDate(now, market);
    const buyDate = position.lastBuyDate || position.tradeDate || marketDate(position.entryTime, market);
    const time = timestampOf(position.quoteTime);
    const active = ACTIVE_SESSIONS.has(session || info.session);
    const quoteDate = time == null ? null : marketDate(time, market);
    const settlementDate = active ? date : (info.lastTradingDate || quoteDate || date);
    if (market === 'CN' && (buyDate >= settlementDate || (quoteDate != null && quoteDate <= buyDate))) {
      throw httpError(409, 'A 股 T+1：新增持仓尚未到下一交易日，暂不可卖出');
    }
    const requiredDate = active ? date : (info.lastTradingDate || date);
    if (!Number.isFinite(position.price) || position.price <= 0 || time == null || time > now + 60000 ||
        quoteDate !== requiredDate || (active && now - time > QUOTE_MAX_AGE_MS)) {
      throw httpError(409, '行情缺失或已过期，无法按有效行情计算模拟平仓盈亏');
    }
    const receipt = {
      ok: true, operationId, symbol: position.symbol, market, currency: position.currency,
      tradeDate: date, closedAt: now, quoteTime: position.quoteTime,
      entry: position.entry, exit: position.price, shares: position.shares,
      pnl: position.shares > 0 ? Math.round((position.price - position.entry) * position.shares * 100) / 100 : null
    };
    return transaction(() => {
      positions.delete(key);
      receipts.set(operationId, receipt);
      initializedMarkets.add(market);
      return { ...receipt, data: list(market) };
    });
  }

  // A corrupt state file must fail visibly rather than silently overwrite durable holdings.
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.positions) || !Array.isArray(data.receipts) || !Array.isArray(data.initializedMarkets)) {
      throw new Error('持仓存储格式异常，请保留文件后检查');
    }
    for (const market of data.initializedMarkets) initializedMarkets.add(checkedMarket(market));
    for (const raw of data.positions) {
      const market = checkedMarket(raw.market);
      const position = normalize(raw, market, null, Date.now(), true);
      positions.set(keyOf(position.symbol, market), position);
      initializedMarkets.add(market);
    }
    for (const receipt of data.receipts) {
      if (!receipt || typeof receipt.operationId !== 'string' || !receipt.ok) throw new Error('平仓回执格式异常');
      checkedMarket(receipt.market);
      checkedSymbol(receipt.symbol, receipt.market);
      receipts.set(receipt.operationId, receipt);
    }
  }

  return { positions, receipts, list, upsert, restore, close, save, hasState, trades };
}

module.exports = { createPositionStore, httpError };
