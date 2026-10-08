import { quoteMillis } from './scanner-state.js';
import { formatQuoteTime } from './scanner-view.js';

export default function QuoteTime({ value, market, now = Date.now() }) {
  const time = quoteMillis(value);
  if (time == null) return <span>报价时间未知</span>;
  return <span>{formatQuoteTime(time, market)}{now - time > 180000 ? ' · 旧报价' : ''}</span>;
}
