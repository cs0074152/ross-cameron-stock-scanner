function number(value) {
  if (value === null || value === undefined || value === '' || value === '—') return NaN;
  return Number(value);
}

// 宽松观察池只有两个数值条件；独立新闻服务核查来源，不判断内容或催化作用。
function apply5PillarsFilter(stocks) {
  return stocks.filter(s => number(s.price) >= 1 && number(s.price) <= 20 && Math.abs(number(s.changePercent)) >= 10)
    .sort((a, b) => Math.abs(number(b.changePercent)) - Math.abs(number(a.changePercent)));
}
function applyHODFilter(stocks) {
  return stocks.filter(s => number(s.changePercent) >= 5 && number(s.high) > 0 && number(s.price) >= number(s.high) * 0.998)
    .sort((a, b) => number(b.changePercent) - number(a.changePercent));
}
function applyGapFilter(stocks) {
  return stocks.filter(s => Number.isFinite(number(s.gap)) && Math.abs(number(s.gap)) >= 4)
    .sort((a, b) => Math.abs(number(b.gap)) - Math.abs(number(a.gap)));
}
function applyStrict5PillarsFilter(stocks) {
  return stocks.filter(s => number(s.price) >= 1 && number(s.price) <= 20 &&
    number(s.floatRaw) > 0 && number(s.floatRaw) < 10000000 && number(s.gap) >= 4 &&
    number(s.rvol) >= 2 && Math.abs(number(s.changePercent)) >= 10)
    .sort((a, b) => Math.abs(number(b.changePercent)) - Math.abs(number(a.changePercent)));
}
function applyDocPickFilter(stocks, strict = false) {
  return stocks.filter(s => number(s.price) >= (strict ? 5 : 2) && number(s.price) <= (strict ? 10 : 20) &&
    number(s.changePercent) > (strict ? 30 : 10) && number(s.rvol) >= 5 &&
    number(s.floatRaw) > 0 && number(s.floatRaw) < (strict ? 10000000 : 20000000))
    .sort((a, b) => number(b.changePercent) - number(a.changePercent));
}
function applyChinaWatchFilter(stocks) {
  return stocks.filter(s => number(s.price) >= 5 && number(s.price) <= 100 &&
    number(s.changePercent) >= 3 && number(s.rvol) >= 1.5 && !s.riskWarning && !s.newListing &&
    (!Number.isFinite(number(s.limitPct)) || number(s.changePercent) < number(s.limitPct) - 0.2));
}
function deriveScanners(stocks, market) {
  if (market === 'CN') return { hodMomentum: applyHODFilter(stocks), gapScanner: applyGapFilter(stocks), cnWatch: applyChinaWatchFilter(stocks) };
  return { fivePillars: apply5PillarsFilter(stocks), strictFivePillars: applyStrict5PillarsFilter(stocks),
    docPick: applyDocPickFilter(stocks), docPickStrict: applyDocPickFilter(stocks, true),
    hodMomentum: applyHODFilter(stocks), gapScanner: applyGapFilter(stocks) };
}
module.exports = { apply5PillarsFilter, applyHODFilter, applyGapFilter, applyStrict5PillarsFilter,
  applyDocPickFilter, applyChinaWatchFilter, deriveScanners };
