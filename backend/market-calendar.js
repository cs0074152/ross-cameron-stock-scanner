const calendars = require('./market-calendars.json');
const CN_TIMEZONE = 'Asia/Shanghai';
const US_TIMEZONE = 'America/New_York';

function localParts(now, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(p => [p.type, p.value]));
}

function chinaDate(now) {
  const p = localParts(new Date(now), CN_TIMEZONE);
  return `${p.year}-${p.month}-${p.day}`;
}

function dayInfo(market, date) {
  const config = calendars[market]?.[date.slice(0, 4)];
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const md = date.slice(5);
  const holiday = config?.holidays?.includes(md) || config?.holidayRanges?.some(([a, b]) => md >= a && md <= b);
  return { config, day, trading: !!config && day !== 0 && day !== 6 && !holiday };
}

function adjacentTradingDate(market, date, direction) {
  const cursor = new Date(`${date}T12:00:00Z`);
  for (let i = 0; i < 370; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + direction);
    const candidate = cursor.toISOString().slice(0, 10);
    const info = dayInfo(market, candidate);
    if (!info.config) return null; // 未登记年度不能跨越推算。
    if (info.trading) return candidate;
  }
  return null;
}

function getMarketInfo(market = 'US', now = new Date()) {
  if (!['US', 'CN'].includes(market)) throw new Error('Unknown market');
  now = new Date(now);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid market time');
  const timeZone = market === 'CN' ? CN_TIMEZONE : US_TIMEZONE;
  const p = localParts(now, timeZone);
  const date = `${p.year}-${p.month}-${p.day}`;
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const { config, day, trading } = dayInfo(market, date);
  const calendarKnown = !!config;
  const regularCloseMinutes = market === 'CN' ? 900 : (config?.earlyCloses?.[date.slice(5)] ?? 960);
  // NYSE 指定提前收盘日，相关股票市场晚盘于 17:00 结束。
  const afterhoursCloseMinutes = market === 'CN' ? 900 : regularCloseMinutes < 960 ? 1020 : 1200;
  let session = calendarKnown ? 'closed' : 'unknown';
  if (trading) {
    if (market === 'US') {
      if (minutes >= 240 && minutes < 570) session = 'premarket';
      else if (minutes >= 570 && minutes < regularCloseMinutes) session = 'regular';
      else if (minutes >= regularCloseMinutes && minutes < afterhoursCloseMinutes) session = 'afterhours';
    } else {
      if (minutes >= 555 && minutes < 565) session = 'auction';
      else if (minutes >= 565 && minutes < 570) session = 'preopen';
      else if ((minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 897)) session = 'regular';
      else if (minutes >= 690 && minutes < 780) session = 'lunch';
      else if (minutes >= 897 && minutes < 900) session = 'closingAuction';
    }
  }
  const started = trading && minutes >= (market === 'CN' ? 555 : 240);
  return {
    session, date, minutes, day, calendarKnown, timeZone,
    isTradingDay: trading, earlyClose: market === 'US' && regularCloseMinutes < 960,
    regularCloseMinutes, afterhoursCloseMinutes,
    lastTradingDate: calendarKnown ? started ? date : adjacentTradingDate(market, date, -1) : null,
    nextTradingDate: calendarKnown ? adjacentTradingDate(market, date, 1) : null,
    marketTime: now.toLocaleTimeString(market === 'CN' ? 'zh-CN' : 'en-US', { timeZone, hour12: market !== 'CN' })
  };
}

const getChinaMarketInfo = (now = new Date()) => getMarketInfo('CN', now);
module.exports = { CN_TIMEZONE, US_TIMEZONE, chinaDate, getMarketInfo, getChinaMarketInfo };
