import { useEffect, useRef, useState } from 'react';
import { createNewsSession, newsTimeLabel, safeNewsUrl } from './news-state.js';

const emptyState = () => ({ data: null, error: null, loading: false, retrySeconds: 0 });
function checkedTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚无记录';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
export default function NewsPanel({ apiBase, market, symbol }) {
  const [state, setState] = useState(emptyState);
  const [expanded, setExpanded] = useState(false);
  const session = useRef(null);
  const identity = `${market}:${symbol}`;
  useEffect(() => {
    setState(emptyState()); setExpanded(false);
    const current = createNewsSession({ apiBase, market, symbol, visible: document.visibilityState !== 'hidden', onState: next => setState({ ...next, identity }) });
    session.current = current;
    const onVisibility = () => current.setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => { current.dispose(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [apiBase, market, symbol, identity]);
  // Effects run after render; never display a previous selection during that gap.
  return <NewsPanelContent market={market} symbol={symbol} state={state.identity === identity ? state : emptyState()} expanded={expanded} onExpanded={() => setExpanded(value => !value)} onRefresh={() => session.current?.refresh()} />;
}

export function NewsPanelContent({ market, symbol, state, expanded = false, onExpanded = () => {}, onRefresh = () => {} }) {
  const { data, error, loading, retrySeconds } = state;
  const items = (data?.items || []).slice(0, 10);
  return <section className="news-panel" aria-label="新闻来源核查">
    <div className="news-heading"><div><h3>新闻来源核查 <span>{symbol} · {market === 'CN' ? 'A股' : '美股'}</span></h3><p>跟随榜单选股；图表内换股不会同步到此处</p></div><button className="btn news-refresh" disabled={loading || retrySeconds > 0} onClick={onRefresh}>{loading ? '核查中…' : retrySeconds > 0 ? `${retrySeconds}秒后可重查` : '重新核查'}</button></div>
    <p className="news-description">自动检查来源记录、股票关联和发布时间；具体内容请查看原文</p>
    <div className="news-content" aria-live="polite">
      {loading && <p className="news-message" role="status">正在核查{market === 'CN' ? '巨潮公司公告' : 'Yahoo 收录的相关报道'}…</p>}
      {error && <p className="news-error" role="alert">{error}{data ? ' 以下为上次结果，未完成本次核查。' : ''}</p>}
      {data && <>
        {data.stale && <p className="news-warning">旧缓存：本次未取得最新来源记录。上次成功：{checkedTime(data.lastSuccessAt)}（北京时间）</p>}
        {data.refreshing && <p className="news-message">来源更新中，暂显示已有结果；稍后自动检查更新。</p>}
        {(data.partial || data.status === 'unavailable') && <p className="news-error">来源核查未完整成功，不能据此判断没有新闻或公告。</p>}
        {data.sources.map(source => <div className="news-source" key={source.id}><strong>{source.id === 'cninfo' ? '巨潮公司公告' : 'Yahoo 新闻索引'}</strong><span>{source.status === 'ok' ? '来源记录已获取' : '来源获取失败'}</span></div>)}
        {data.status === 'none' && !data.partial && <p className="news-message">{error || data.stale || data.refreshing ? (market === 'CN' ? '上次成功结果：最近90天当时未找到匹配公告' : '上次成功结果：当时未找到标的匹配报道（Yahoo检索样本）') : (market === 'CN' ? '最近90天本次未找到匹配公告' : '本次未找到标的匹配报道（Yahoo检索样本）')}</p>}
        {items.length > 0 && <><p className="news-count">近7天匹配记录 {data.recentCount ?? 0} 条 · 最多展示10条</p><ul className="news-items">{(expanded ? items : items.slice(0, 4)).map(item => { const href = safeNewsUrl(item.url); return <li key={item.id}><div className="news-evidence">{item.evidenceType === 'announcement' ? '公司公告可追溯' : 'Yahoo 收录的相关报道'}{(item.stale || data.stale) && <span> · 旧缓存</span>}</div>{href ? <a href={href} target="_blank" rel="noreferrer noopener">{item.title}</a> : <span className="news-title">{item.title}</span>}<div className="news-item-meta">{item.publisher || item.source || '来源未注明'} · {item.timePrecision === 'day' ? (item.publishedDate || '日期未知') : item.timePrecision === 'second' ? checkedTime(item.publishedAt) + '（北京时间）' : '发布时间未知'} · {newsTimeLabel(item)}</div></li>; })}</ul>{items.length > 4 && <button className="news-expand" onClick={onExpanded}>{expanded ? '收起' : `展开其余 ${items.length - 4} 条`}</button>}</>}
                <details className="news-details"><summary>查询详情</summary><p>最后尝试：{checkedTime(data.checkedAt)} · 上次成功：{checkedTime(data.lastSuccessAt)}（北京时间）</p><p>以上是来源查询时间；条目日期是原文发布时间。</p>{data.sources.filter(source => source.checkedAt !== data.checkedAt || source.lastSuccessAt !== data.lastSuccessAt).map(source => <p key={source.id}>{source.id === 'cninfo' ? '巨潮公司公告' : 'Yahoo 新闻索引'}：最后尝试 {checkedTime(source.checkedAt)} · 上次成功 {checkedTime(source.lastSuccessAt)}（北京时间）</p>)}</details>
      </>}
      {!data && !loading && !error && <p className="news-message">准备核查来源记录…</p>}
    </div>
  </section>;
}
