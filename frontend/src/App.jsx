import { useState, useEffect, useRef, useMemo, useCallback, memo, lazy, Suspense } from 'react';
import QuoteTime from './QuoteTime.jsx';
import { selectScannerRows, sameStockRowProps, scheduleAfterPaint } from './scanner-view.js';

const StrategyView = lazy(() => import('./StrategyCenter.jsx'));
const EMPTY_LIST = [];
import { marketDate, quoteMillis, isQuoteStale, chartMetadata, latestStockQuotes, updatePriceHistory, positionMirror, positionVersion, createOperationGate, normalizeLedger, currentTrade, changeTrade, appendReceipt, requestJson } from './scanner-state.js';

const API_BASE = (globalThis.__SCANNER_CONFIG__?.apiBase || import.meta.env.VITE_API_BASE || 'http://localhost:3001').replace(/\/$/, '');
const WS_BASE = globalThis.__SCANNER_CONFIG__?.wsBase || import.meta.env.VITE_WS_BASE || API_BASE.replace(/^http/, 'ws');
const emptyStocks = () => ({
  gainers: [], losers: [], mostActive: [], premarket: [], afterhours: [],
  fivePillars: [], strictFivePillars: [], docPick: [], docPickStrict: [],
  hodMomentum: [], gapScanner: [], strategyPool: { limited: false, rows: [] }, positions: []
});

// Sound alert for momentum stocks
const playAlert = (type = 'momentum') => {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    if (type === 'momentum') {
      oscillator.frequency.value = 880;
      oscillator.type = 'sine';
    } else if (type === 'breakout') {
      oscillator.frequency.value = 1200;
      oscillator.type = 'square';
    } else {
      oscillator.frequency.value = 660;
      oscillator.type = 'triangle';
    }

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  } catch (e) {
    console.log('Audio not available');
  }
};

// Stock Row Component with animation and arrows
const StockRow = memo(function StockRow({ stock, onClick, isSelected, prices, market, now }) {
  const [flash, setFlash] = useState(null);
  const previousPriceRef = useRef(stock.price);

  useEffect(() => {
    const previousPrice = previousPriceRef.current;
    previousPriceRef.current = stock.price;
    if (previousPrice !== undefined && previousPrice !== stock.price) {
      const newFlash = parseFloat(stock.price) > parseFloat(previousPrice) ? 'up' : 'down';
      setFlash(newFlash);
      const timer = setTimeout(() => setFlash(null), 500);
      return () => clearTimeout(timer);
    }
  }, [stock.price]);

  const changeValue = parseFloat(stock.changePercent);
  const changeClass = changeValue >= 0 ? 'positive' : 'negative';
  const arrow = changeValue >= 0 ? '▲' : '▼';
  const rvolClass = parseFloat(stock.rvol) >= 2 ? 'hot' : parseFloat(stock.rvol) >= 1.5 ? 'warm' : '';

  return (
    <tr
      className={`stock-row ${flash ? `flash-${flash}` : ''} ${isSelected ? 'selected' : ''}`}
      onClick={() => onClick(stock.symbol)}
      tabIndex={0}
      aria-label={`查看 ${stock.symbol} ${stock.name || ''} 的图表`}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(stock.symbol); } }}
    >
      <td className="symbol" title={stock.name}>
        {stock.symbol}
        {market === 'CN' && <span className="stock-name">{stock.name}</span>}
        {market === 'CN' && (stock.riskTags || []).length > 0 && <span className="risk-label">{stock.riskTags.join(' / ')}</span>}
      </td>
      <td className="price">{market === 'CN' ? '¥' : '$'}{stock.price}</td>
      <td className={`change ${changeClass}`}>
        <span className="arrow">{arrow}</span>
        {changeValue >= 0 ? '+' : ''}{stock.changePercent}%
        <div className="change-bar">
          <span style={{ width: `${Math.min(Math.abs(changeValue) / 20, 1) * 100}%` }} />
        </div>
      </td>
      <td className="volume">{stock.volume}</td>
      <td className={`gap ${parseFloat(stock.gap) >= 0 ? 'positive' : 'negative'}`}>
        {Number.isFinite(parseFloat(stock.gap)) ? `${parseFloat(stock.gap) >= 0 ? '+' : ''}${stock.gap}%` : '—'}
      </td>
      <td
        className="float"
        title={stock.floatSource === 'circulatingCap'
          ? '流通股数：由流通市值 ÷ 最新价估算'
          : stock.floatSource === 'unavailable' ? '暂无流通股数数据'
          : stock.floatSource === 'float'
          ? '流通盘（真实值）'
          : '总股本（流通盘数据未取到，用总股本近似；数值偏大，筛选偏保守）'}
      >
        {stock.float}
      </td>
      <td className={`rvol ${rvolClass}`}>{Number.isFinite(parseFloat(stock.rvol)) ? `${stock.rvol}x` : '—'}</td>
      <td className="trend"><Sparkline prices={prices} /></td>
      <td className={`quote-time ${isQuoteStale(stock, now) ? 'stale' : ''}`} title="行情源最后报价时间；不等于本机抓取时间"><QuoteTime value={stock.quoteTime} market={market} now={now} /></td>
    </tr>
  );
}, sameStockRowProps);

// Sortable Header Component
const SortableHeader = memo(function SortableHeader({ label, field, sortField, sortDirection, onSort }) {
  const isActive = sortField === field;
  const arrow = isActive ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <th
      className={`sortable ${isActive ? 'active' : ''}`}
      onClick={() => onSort(field)}
      tabIndex={0}
      aria-sort={isActive ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSort(field); } }}
    >
      {label}{arrow}
    </th>
  );
});

// Inline SVG sparkline built from the client-side rolling price history
const Sparkline = memo(function Sparkline({ prices }) {
  if (!prices || prices.length < 2) {
    return <span className="sparkline-empty">—</span>;
  }
  const w = 80, h = 22, pad = 2;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const step = (w - pad * 2) / (prices.length - 1);
  const points = prices
    .map((p, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((p - min) / range) * (h - pad * 2)).toFixed(1)}`)
    .join(' ');
  const up = prices[prices.length - 1] >= prices[0];
  return (
    <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline
        points={points}
        fill="none"
        stroke={up ? 'var(--accent-green)' : 'var(--accent-red)'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
});

// Market overview stat cards
const MarketStats = memo(function MarketStats({ gainers, losers, market }) {
  const topGainer = gainers.length
    ? gainers.reduce((a, b) => (parseFloat(b.changePercent) > parseFloat(a.changePercent) ? b : a))
    : null;
  const topLoser = losers.length
    ? losers.reduce((a, b) => (parseFloat(b.changePercent) < parseFloat(a.changePercent) ? b : a))
    : null;
  const total = gainers.length + losers.length;
  const gainShare = total ? (gainers.length / total) * 100 : 50;
  const avgGainerChange = gainers.length
    ? gainers.reduce((s, x) => s + (parseFloat(x.changePercent) || 0), 0) / gainers.length
    : 0;

  return (
    <div className="stats-row">
      <div className="stat-card">
        <div className="stat-label">领涨股</div>
        {topGainer ? (
          <div className="stat-value">
            <span className="stat-symbol">{topGainer.symbol}</span>
            <span className="stat-price">{market === 'CN' ? '¥' : '$'}{topGainer.price}</span>
            <span className="stat-pct positive">+{topGainer.changePercent}%</span>
          </div>
        ) : <div className="stat-value stat-empty">—</div>}
      </div>
      <div className="stat-card">
        <div className="stat-label">领跌股</div>
        {topLoser ? (
          <div className="stat-value">
            <span className="stat-symbol">{topLoser.symbol}</span>
            <span className="stat-price">{market === 'CN' ? '¥' : '$'}{topLoser.price}</span>
            <span className="stat-pct negative">{topLoser.changePercent}%</span>
          </div>
        ) : <div className="stat-value stat-empty">—</div>}
      </div>
      <div className="stat-card">
        <div className="stat-label">榜单样本（非全市场广度）</div>
        <div className="breadth-bar">
          <span className="breadth-gain" style={{ width: `${gainShare}%` }} />
          <span className="breadth-lose" style={{ width: `${100 - gainShare}%` }} />
        </div>
        <div className="breadth-labels">
          <span className="breadth-up">▲ {gainers.length} 上涨</span>
          <span className="breadth-down">▼ {losers.length} 下跌</span>
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-label">平均涨幅</div>
        <div className={`stat-single ${avgGainerChange >= 0 ? 'positive' : 'negative'}`}>
          {avgGainerChange >= 0 ? '+' : ''}{avgGainerChange.toFixed(2)}%
        </div>
      </div>
    </div>
  );
});

// Scanner Component
const Scanner = memo(function Scanner({ stocks, selectedSymbol, onSelectSymbol, title, scannerPreset, onPresetChange, category, onCategoryChange, session, dataDate, history, market, dataError, lastUpdate, scope, now }) {
  const [filters, setFilters] = useState({ priceMin: '', priceMax: '', changeMin: '', rvolMin: '', floatMax: '' });
  const [sortField, setSortField] = useState('changePercent');
  const [sortDirection, setSortDirection] = useState('desc');

  useEffect(() => {
    setSortField(scannerPreset === 'all' && category === 'mostActive' ? 'volume' : 'changePercent');
    setSortDirection(scannerPreset === 'all' && category === 'losers' ? 'asc' : 'desc');
  }, [category, scannerPreset]);

  const handleSort = useCallback((field) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  }, [sortField]);

  const sortedStocks = useMemo(() => selectScannerRows(stocks, filters, sortField, sortDirection), [stocks, filters, sortField, sortDirection]);

  const categories = [
    { id: 'gainers', label: '涨幅榜', icon: '📈' },
    { id: 'losers', label: '跌幅榜', icon: '📉' },
    { id: 'mostActive', label: '最活跃', icon: '🔥' },
    { id: 'premarket', label: '盘前', icon: '🌅' },
    { id: 'afterhours', label: '盘后', icon: '🌙' }
  ].filter(cat => market !== 'CN' || !['premarket', 'afterhours'].includes(cat.id));

  const scannerPresets = [
    { id: 'all', label: '全部股票' },
    { id: 'docPick', label: '三步法选股' },
    { id: 'docPickStrict', label: '三步法·严格' },
    { id: 'fivePillars', label: '价格 / 涨幅初筛' },
    { id: 'strictFivePillars', label: '五项量化条件（新闻需核实）' },
    { id: 'hodMomentum', label: '接近日高动量' },
    { id: 'gapScanner', label: '跳空扫描' }
  ].filter(preset => market !== 'CN' || ['all', 'hodMomentum', 'gapScanner'].includes(preset.id))
    ;

  return (
    <div className="scanner">
      <div className="scanner-header">
        <h2>{title}</h2>
        <div className="session-badge">
          {session === 'regular' && '🟢 开盘中'}
          {session === 'premarket' && '🟡 盘前'}
          {session === 'afterhours' && '🟠 盘后'}
          {session === 'auction' && '🟡 开盘集合竞价'}
          {session === 'preopen' && '🟡 等待开盘'}
          {session === 'closingAuction' && '🟡 收盘集合竞价'}
          {session === 'lunch' && '🟡 午间休市'}
          {session === 'closed' && (market === 'CN' ? '🔴 休市／已收盘' : '🔴 已收盘')}
          {dataDate && <span className="data-date"> ({dataDate})</span>}
        </div>
      </div>

      <div className="scanner-controls">
        <div className="category-tabs">
          {categories.map(cat => (
            <button
              key={cat.id}
              className={`category-tab ${category === cat.id ? 'active' : ''}`}
              onClick={() => onCategoryChange(cat.id)}
            >
              <span className="tab-icon">{cat.icon}</span>
              <span className="tab-label">{cat.label}</span>
            </button>
          ))}
        </div>

        <div className="scanner-filters">
          <div className="filter-group">
            <label>扫描器:</label>
            <select value={scannerPreset} onChange={(e) => onPresetChange(e.target.value)}>
              {scannerPresets.map(preset => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
          </div>
          <div className="stock-count">
            {sortedStocks.length} 只股票{scannerPreset === 'strictFivePillars' ? ' · 5 条全满足' : ''}
          </div>
        </div>
      </div>

      <div className="scope-note">
        <span>{scope?.description || '基于行情源榜单样本，未覆盖全市场；筛选结果不代表全部符合条件的股票。'}</span>
        <span>{presetDescription(scannerPreset, market)}</span>
      </div>
      <details className="custom-filter-panel">
        <summary>自定义数值条件（叠加当前榜单与扫描器）</summary>
        <div className="custom-filter-fields">
          {[['priceMin', '最低价格'], ['priceMax', '最高价格'], ['changeMin', '最低涨跌幅 %'], ['rvolMin', '最低量比'], ['floatMax', '最大流通盘 / 百万股']].map(([field, label]) => (
            <label key={field}>{label}<input type="number" step="any" value={filters[field]} onChange={event => setFilters(prev => ({ ...prev, [field]: event.target.value }))} /></label>
          ))}
          <button className="btn secondary" onClick={() => setFilters({ priceMin: '', priceMax: '', changeMin: '', rvolMin: '', floatMax: '' })}>重置条件</button>
        </div>
      </details>
      <div className="scanner-table-container">
        <table className="scanner-table">
          <thead>
            <tr>
              <SortableHeader label="代码" field="symbol" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label={market === 'CN' ? '价格（元）' : '价格'} field="price" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="涨跌幅" field="changePercent" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label={market === 'CN' ? '成交量（股）' : '成交量'} field="volume" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="跳空" field="gap" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="流通盘" field="float" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="量比" field="rvol" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <th className="trend-header">走势</th>
              <th>源报价时间</th>
            </tr>
          </thead>
          <tbody>
            {sortedStocks.length === 0 ? (
              <tr>
                <td colSpan="9" className="no-data">
                  {dataError || (!lastUpdate ? '正在加载股票...' : scannerPreset === 'strictFivePillars'
                    ? '当前没有股票同时满足五大支柱的全部 5 个条件（价格 $1-$20、流通盘 <1000万、跳空 ≥4%、量比 ≥2、涨幅 ≥10%）。'
                    : scannerPreset !== 'all'
                      ? '暂无符合当前筛选条件的股票。'
                      : '暂无可用股票数据。')}
                </td>
              </tr>
            ) : (
              sortedStocks.map((stock, index) => (
                <StockRow
                  key={stock.symbol}
                  stock={stock}
                  index={index}
                  onClick={onSelectSymbol}
                  isSelected={selectedSymbol === stock.symbol}
                  prices={history?.[stock.symbol]?.prices}
                  market={market}
                  now={now}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
});

// TradingView Chart Component
const TradingViewChart = memo(function TradingViewChart({ symbol, stock, market, isFullscreen, onToggleFullscreen, theme }) {
  const containerRef = useRef(null);
  const [chartError, setChartError] = useState(null);
  const [chartAttempt, setChartAttempt] = useState(0);

  useEffect(() => {
    if (!symbol || (market === 'CN' && !stock?.chartSymbol) || !containerRef.current) return;
    const container = containerRef.current;
    container.replaceChildren();
    setChartError(null);

    let script = null;
    const cancelMount = scheduleAfterPaint(() => {
      script = document.createElement('script');
      script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
      script.type = 'text/javascript';
      script.async = true;
      script.onerror = () => setChartError('图表服务暂时无法加载，请检查网络或重新加载。');
      script.innerHTML = JSON.stringify({
        autosize: true,
        symbol: market === 'CN' ? stock.chartSymbol : symbol,
        interval: "5",
        timezone: market === 'CN' ? 'Asia/Shanghai' : 'America/New_York',
        theme: theme === 'light' ? 'light' : 'dark',
        style: "1",
        locale: "zh_CN",
        enable_publishing: false,
        allow_symbol_change: true,
        save_image: false,
        calendar: false,
        hide_volume: false,
        support_host: "https://www.tradingview.com",
        withdateranges: true,
        details: true,
        hotlist: true,
        studies: [
          "Volume@tv-basicstudies",
          "VWAP@tv-basicstudies"
        ]
      });

      const widgetContainer = document.createElement('div');
      widgetContainer.className = 'tradingview-widget-container__widget';
      widgetContainer.style.height = '100%';
      widgetContainer.style.width = '100%';

      container.appendChild(widgetContainer);
      widgetContainer.appendChild(script);
    });

    return () => {
      cancelMount();
      if (script) script.onerror = null;
      container.replaceChildren();
    };
  }, [symbol, stock?.chartSymbol, market, theme, chartAttempt]);

  return (
    <div className={`chart-container ${isFullscreen ? 'fullscreen' : ''}`}>
      <div className="chart-header">
          <h3>{symbol ? `${symbol}${market === 'CN' && stock ? ` · ${stock.name}` : ''}` : '选择一只股票'}</h3>
        <div className="chart-actions">
          <span className="realtime-badge">
            TradingView 图表
          </span>
          <button className="fullscreen-btn" onClick={onToggleFullscreen}>
            {isFullscreen ? '⛶ 退出全屏' : '⛶ 全屏'}
          </button>
        </div>
      </div>
      <div className="chart-wrapper">
        <div className="chart-widget" ref={containerRef} />
        {chartError && <div className="chart-placeholder"><p>{chartError}</p><button className="btn" onClick={() => setChartAttempt(value => value + 1)}>重试图表</button>{stock?.quoteUrl && <a href={stock.quoteUrl} target="_blank" rel="noreferrer">在行情源查看</a>}</div>}
        {!symbol && (
          <div className="chart-placeholder">
            <p>点击列表中的股票查看图表</p>
          </div>
        )}
        {symbol && market === 'CN' && !stock?.chartSymbol && (
          <div className="chart-placeholder">
            <p>该股票暂不支持 TradingView 图表</p>
            {stock?.quoteUrl && <a href={stock.quoteUrl} target="_blank" rel="noreferrer">在东方财富查看行情</a>}
          </div>
        )}
      </div>
    </div>
  );
});

function presetDescription(preset, market) {
  const rules = {
    all: '当前类别榜单，不是全市场股票；自定义条件只在该样本内生效。',
    docPick: '涨幅 >10%、量比 ≥5、价格 $2–$20、流通盘 <2000 万股；新闻需人工确认。',
    docPickStrict: '涨幅 >30%、量比 ≥5、价格 $5–$10、流通盘 <1000 万股；新闻需人工确认。',
    fivePillars: '仅价格 $1–$20、涨跌幅绝对值 ≥10%；未验证流通盘、跳空、量比或新闻。',
    strictFivePillars: '价格 $1–$20、流通盘 <1000 万、跳空 ≥4%、量比 ≥2、涨跌幅绝对值 ≥10%；新闻并未自动核实。',
    hodMomentum: '涨幅 ≥5%、距当日最高价 ≤0.2%；不是逐笔突破信号。',
    gapScanner: '真实开盘价相对昨收跳空的绝对值 ≥4%；开盘价未知时不以涨幅替代。'
  };
  return `${market === 'CN' ? 'A 股' : '美股'} · ${rules[preset] || rules.all}`;
}

function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function loadLedgers() {
  return { US: normalizeLedger(readStored('scanner-trade-log-US', readStored('scanner-trade-log', null))), CN: normalizeLedger(readStored('scanner-trade-log-CN', null)) };
}
function savedPositions(market) {
  const saved = readStored(`scanner-positions-${market}`, market === 'US' ? readStored('scanner-positions', []) : []);
  return Array.isArray(saved) ? saved : [];
}
function allQuotes(data) {
  return latestStockQuotes([...Object.values(data.quotes || {}), ...['gainers', 'losers', 'mostActive', 'premarket', 'afterhours', 'hodMomentum', 'gapScanner'].flatMap(key => data[key] || [])]);
}

// The server is authoritative; browser mirrors are only used for one-time migration.
function App() {
  const [market, setMarket] = useState(() => localStorage.getItem('scanner-market') === 'CN' ? 'CN' : 'US');
  const activeMarketRef = useRef(market);
  const [stocks, setStocks] = useState(emptyStocks);
  const stocksRef = useRef(stocks);
  stocksRef.current = stocks;
  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const [selectedMeta, setSelectedMeta] = useState(null);
  const [category, setCategory] = useState('gainers');
  const [scannerPreset, setScannerPreset] = useState('all');
  const [session, setSession] = useState('closed');
  const [dataDate, setDataDate] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [positionsReadyMarket, setPositionsReadyMarket] = useState(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const [theme, setTheme] = useState(() => localStorage.getItem('scanner-theme') || 'dark');
  const [view, setView] = useState('scanner');
  const [marketMeta, setMarketMeta] = useState({ minutes: null, day: null });
  const [lastUpdate, setLastUpdate] = useState(null);
  const [sourceQuoteTime, setSourceQuoteTime] = useState(null);
  const [marketTime, setMarketTime] = useState(null);
  const [dataSource, setDataSource] = useState(null);
  const [dataError, setDataError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [calendarKnown, setCalendarKnown] = useState(true);
  const [scope, setScope] = useState(null);
  const [priceHistory, setPriceHistory] = useState({});
  const [clockTick, setClockTick] = useState(Date.now());
  const [ledgers, setLedgers] = useState(loadLedgers);
  const [pendingKeys, setPendingKeys] = useState({});
  const pendingRef = useRef(createOperationGate());
  const versionsRef = useRef({});
  const previousStocksRef = useRef({});
  const posAlertsRef = useRef({});
  const closeOperationsRef = useRef(readStored('scanner-close-operations', {}));

  useEffect(() => {
    const timer = setInterval(() => { setClockTick(Date.now()); setPriceHistory(history => updatePriceHistory(history, [], Date.now())); }, 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    try { for (const value of ['US', 'CN']) localStorage.setItem(`scanner-trade-log-${value}`, JSON.stringify(ledgers[value])); }
    catch { setActionError('浏览器无法保存盈亏记录，请检查可用存储空间。服务器平仓收据仍可恢复。'); }
  }, [ledgers]);
  const date = marketDate(market, clockTick);
  const trade = currentTrade(ledgers[market], date);
  const setTrade = update => { setClockTick(Date.now()); setLedgers(previous => ({ ...previous, [market]: changeTrade(previous[market], marketDate(market), update) })); };
  const importReceipts = (origin, receipts) => {
    setClockTick(Date.now());
    setLedgers(previous => ({ ...previous, [origin]: (receipts || []).reduce((ledger, receipt) => appendReceipt(ledger, receipt, origin), previous[origin]) }));
    const received = new Set((receipts || []).map(receipt => receipt.operationId));
    for (const [key, value] of Object.entries(closeOperationsRef.current)) if (received.has(value.operationId)) delete closeOperationsRef.current[key];
    try { localStorage.setItem('scanner-close-operations', JSON.stringify(closeOperationsRef.current)); } catch { /* IDs remain available in this tab. */ }
  };
  const saveMirror = (origin, positions) => {
    try { localStorage.setItem(`scanner-positions-${origin}`, JSON.stringify(positionMirror(positions))); }
    catch { setActionError('浏览器持仓镜像无法保存；持仓已由服务器持久保存。'); }
  };
  const acceptsPositions = (origin, payload, reset = false) => {
    const next = positionVersion(versionsRef.current[origin], payload, reset);
    if (!next) return false;
    versionsRef.current[origin] = next;
    return true;
  };
  const applyPositions = (origin, payload, reset = false) => {
    if (!Array.isArray(payload.data) || !acceptsPositions(origin, payload, reset)) return;
    saveMirror(origin, payload.data);
    if (activeMarketRef.current === origin) setStocks(previous => ({ ...previous, positions: payload.data }));
  };
  useEffect(() => { if (positionsReadyMarket === market) saveMirror(market, stocks.positions || []); }, [stocks.positions, positionsReadyMarket, market]);
  useEffect(() => {
    if (!soundEnabled) return;
    const next = {};
    for (const position of stocks.positions || []) {
      const key = `${market}:${position.symbol}:${position.entryTime}`;
      const status = position.status;
      if ((status === 'stop_triggered' || status === 'target_hit') && !isQuoteStale(position) && posAlertsRef.current[key] !== status) playAlert(status === 'stop_triggered' ? 'breakout' : 'momentum');
      next[key] = status;
    }
    posAlertsRef.current = next;
  }, [stocks.positions, soundEnabled, market]);

  const pending = symbol => positionsReadyMarket !== market || !!pendingKeys[`${market}:${symbol}`];
  const performPosition = async (symbol, operation) => {
    const origin = market;
    if (positionsReadyMarket !== origin) return;
    const key = pendingRef.current.acquire(origin, symbol);
    if (!key) return;
    setPendingKeys(previous => ({ ...previous, [key]: true }));
    setActionError(null);
    try { await operation(origin, key); }
    catch (error) { setActionError(`${origin === 'CN' ? 'A 股' : '美股'} ${symbol}：${error.message}；操作尚未确认，请恢复连接后重试。`); }
    finally { pendingRef.current.release(key); setPendingKeys(previous => { const next = { ...previous }; delete next[key]; return next; }); }
  };
  const markPosition = payload => performPosition(payload.symbol, async origin => {
    const entry = Number(payload.entry), shares = Number(payload.shares);
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isInteger(shares) || shares <= 0) throw new Error('入场价需大于零，股数需为正整数');
    if (origin === 'CN' && shares % 100 !== 0) throw new Error('A 股登记股数需为 100 股整数倍');
    const result = await requestJson(`${API_BASE}/api/positions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, market: origin }) });
    applyPositions(origin, result);
  });
  const adjustPosition = (symbol, fields) => performPosition(symbol, async origin => {
    const position = (stocksRef.current.positions || []).find(value => value.symbol === symbol);
    if (!position) throw new Error('持仓已改变，请等待同步');
    if (fields.stop != null && (!Number.isFinite(fields.stop) || fields.stop <= 0 || (position.stop != null && fields.stop < position.stop))) throw new Error('止损必须大于零，持有期间不能向下移动止损');
    if (fields.shares != null && (!Number.isInteger(fields.shares) || fields.shares <= 0 || (origin === 'CN' && fields.shares % 100 !== 0))) throw new Error('请输入有效股数');
    const result = await requestJson(`${API_BASE}/api/positions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...position, ...fields, market: origin }) });
    applyPositions(origin, result);
  });
  const closePosition = symbol => performPosition(symbol, async (origin, key) => {
    const position = (stocksRef.current.positions || []).find(value => value.symbol === symbol);
    if (!position) throw new Error('持仓不存在，请等待同步');
    if (origin === 'CN' && position.sellable === false) throw new Error('T+1 限制：当日买入暂不可卖');
    const existing = closeOperationsRef.current[key];
    const operationId = existing?.entryTime === position.entryTime ? existing.operationId : crypto.randomUUID();
    closeOperationsRef.current[key] = { operationId, entryTime: position.entryTime };
    try { localStorage.setItem('scanner-close-operations', JSON.stringify(closeOperationsRef.current)); } catch { /* Retry in this tab uses the same ID. */ }
    const result = await requestJson(`${API_BASE}/api/positions/${encodeURIComponent(symbol)}?market=${origin}&operationId=${encodeURIComponent(operationId)}`, { method: 'DELETE' });
    applyPositions(origin, result);
    importReceipts(origin, [result]);
  });

  const selectSymbol = useCallback(symbol => {
    setSelectedSymbol(symbol);
    const stock = allQuotes(stocksRef.current).find(value => value.symbol === symbol);
    setSelectedMeta(chartMetadata(stock || { symbol }));
  }, []);
  const toggleFullscreen = useCallback(() => setIsFullscreen(previous => !previous), []);
  useEffect(() => {
    if (!selectedSymbol) return;
    let cancelled = false;
    const watch = () => requestJson(`${API_BASE}/api/watch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ market, symbol: selectedSymbol }) }).catch(error => { if (!cancelled) setActionError(`独立行情订阅失败：${error.message}。图表仍保留，稍后自动重试。`); });
    watch();
    const timer = setInterval(watch, 5 * 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selectedSymbol, market, connected]);

  const switchMarket = next => {
    if (next === market) return;
    activeMarketRef.current = next;
    setMarket(next);
    localStorage.setItem('scanner-market', next);
    setStocks(emptyStocks()); setPositionsReadyMarket(null); setSelectedSymbol(null); setSelectedMeta(null);
    setCategory('gainers'); setScannerPreset('all'); setView('scanner'); setIsFullscreen(false); setSession('closed');
    setPriceHistory({}); previousStocksRef.current = {}; setLastUpdate(null); setSourceQuoteTime(null); setMarketTime(null);
    setMarketMeta({ minutes: null, day: null }); setDataDate(null); setDataError(null); setActionError(null); setDataSource(null); setScope(null); setCalendarKnown(true); setConnected(false);
  };
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); localStorage.setItem('scanner-theme', next); };

  useEffect(() => {
    let disposed = false, socket = null, reconnectTimer = null, reconcileTimer = null, ready = false, latest = null;
    const relevant = () => !disposed && activeMarketRef.current === market;
    const applySnapshot = (message, restored = null) => {
      if (!relevant()) return;
      const data = message.data || emptyStocks();
      const positionPayload = restored || { ...message, data: data.positions || [] };
      const accept = acceptsPositions(market, positionPayload);
      const quotes = allQuotes(data);
      const previousGainers = new Map();
      for (const previous of previousStocksRef.current.gainers || []) if (!previousGainers.has(previous.symbol)) previousGainers.set(previous.symbol, previous);
      if (soundEnabledRef.current && previousStocksRef.current.gainers && message.type !== 'initial') for (const stock of data.gainers || []) {
        const previous = previousGainers.get(stock.symbol);
        if (!isQuoteStale(stock) && Number(stock.changePercent) >= 10 && (!previous || Number(previous.changePercent) < 10)) playAlert(previous ? 'breakout' : 'momentum');
      }
      previousStocksRef.current = data;
      setClockTick(Date.now());
      setStocks(previous => ({ ...data, positions: accept ? positionPayload.data : previous.positions }));
      setSelectedMeta(previous => previous ? chartMetadata(quotes.find(value => value.symbol === previous.symbol) || previous) : previous);
      setSession(message.session || 'closed'); setDataDate(message.dataDate || null);
      setLastUpdate(message.fetchTime || message.lastUpdateTime ? new Date(message.fetchTime || message.lastUpdateTime) : null);
      setSourceQuoteTime(message.quoteTime || quotes.reduce((latestTime, stock) => Math.max(latestTime, quoteMillis(stock.quoteTime) || 0), 0) || null);
      setMarketTime(message.marketTime || message.etTime || null); setDataSource(message.dataSource || null); setDataError(message.dataError || null); setScope(message.scope || null);
      setCalendarKnown(message.calendarKnown !== false); setMarketMeta({ minutes: message.marketMinutes ?? message.etMinutes ?? null, day: message.marketDay ?? message.etDay ?? null });
      setPriceHistory(previous => updatePriceHistory(previous, quotes, Date.now()));
    };
    const connect = () => {
      if (!relevant()) return;
      ready = false; latest = null; setPositionsReadyMarket(null);
      const current = new WebSocket(`${WS_BASE}/?market=${market}`);
      socket = current;
      const reconcile = async () => {
        if (!relevant() || current !== socket || current.readyState !== WebSocket.OPEN) return;
        try {
          let result = await requestJson(`${API_BASE}/api/positions?market=${market}`);
          if (result.positionsDurable !== true) throw new Error('服务器未确认持仓持久化，暂停镜像覆盖');
          if (result.migrationNeeded) result = await requestJson(`${API_BASE}/api/positions/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ market, positions: savedPositions(market) }) });
          if (!relevant() || current !== socket || current.readyState !== WebSocket.OPEN) return;
          applyPositions(market, result, true);
          ready = true; setPositionsReadyMarket(market); setConnected(true); setActionError(null);
          if (latest) applySnapshot(latest, latest.instanceId === result.instanceId && latest.positionsRevision > result.positionsRevision ? null : result);
          try { const receipts = await requestJson(`${API_BASE}/api/trades?market=${market}`); if (relevant() && current === socket) importReceipts(market, receipts.data); }
          catch (error) { if (relevant()) setActionError(`持仓已同步，但历史平仓收据尚未恢复：${error.message}`); }
        } catch (error) {
          if (!relevant() || current !== socket) return;
          setActionError(`持仓对账失败：${error.message}。保留浏览器镜像，正在重试。`);
          reconcileTimer = setTimeout(reconcile, 3000);
        }
      };
      current.onopen = reconcile;
      current.onmessage = event => {
        if (!relevant() || current !== socket) return;
        try { const message = JSON.parse(event.data); if ((message.market || 'US') !== market || !['initial', 'update'].includes(message.type)) return; latest = message; if (ready) applySnapshot(message); }
        catch (error) { setDataError(`行情消息无法解析：${error.message}`); }
      };
      current.onclose = () => { if (!relevant() || current !== socket) return; ready = false; clearTimeout(reconcileTimer); setPositionsReadyMarket(null); setConnected(false); reconnectTimer = setTimeout(connect, 3000); };
      current.onerror = () => { if (relevant()) setConnected(false); };
    };
    connect();
    return () => { disposed = true; clearTimeout(reconnectTimer); clearTimeout(reconcileTimer); socket?.close(); };
  }, [market]);

  const displayStocks = scannerPreset === 'all' ? stocks[category] || EMPTY_LIST : stocks[scannerPreset] || EMPTY_LIST;
  const quoteIndex = useMemo(() => new Map(allQuotes(stocks).map(stock => [stock.symbol, stock])), [stocks.quotes, stocks.gainers, stocks.losers, stocks.mostActive, stocks.premarket, stocks.afterhours, stocks.hodMomentum, stocks.gapScanner]);
  const selectedStock = useMemo(() => selectedSymbol ? chartMetadata(quoteIndex.get(selectedSymbol) || selectedMeta) : null, [quoteIndex, selectedSymbol, selectedMeta]);
  const showStale = ['regular', 'auction', 'closingAuction'].includes(session) && isQuoteStale({ quoteTime: sourceQuoteTime }, clockTick);
  return <div className={`app ${market === 'CN' ? 'market-cn' : ''} ${isFullscreen ? 'chart-fullscreen-mode' : ''}`}>
    <header className="app-header"><div className="header-left"><h1>罗斯·卡梅伦股票扫描器</h1><span className="powered-by">{market === 'CN' ? '沪深京 A 股' : '美股'} · {dataSource || '行情加载中'}</span></div>
      <div className="market-tabs" role="group" aria-label="股票市场"><button className={`view-tab ${market === 'US' ? 'active' : ''}`} aria-pressed={market === 'US'} onClick={() => switchMarket('US')}>美股</button><button className={`view-tab ${market === 'CN' ? 'active' : ''}`} aria-pressed={market === 'CN'} onClick={() => switchMarket('CN')}>A 股</button></div>
      <div className="view-tabs"><button className={`view-tab ${view === 'scanner' ? 'active' : ''}`} onClick={() => setView('scanner')}>📊 扫描器</button><button className={`view-tab ${view === 'strategy' ? 'active' : ''}`} onClick={() => setView('strategy')}>{market === 'CN' ? '📋 A 股观察 / 持仓' : '📋 策略中心'}</button></div>
      <div className="header-right"><button className="theme-toggle" onClick={toggleTheme} title="切换明暗主题">{theme === 'dark' ? '☀️' : '🌙'}</button><button className={`sound-toggle ${soundEnabled ? 'enabled' : 'disabled'}`} onClick={() => setSoundEnabled(!soundEnabled)} title={`声音提醒：${soundEnabled ? '开' : '关'}`}>{soundEnabled ? '🔊' : '🔇'}</button><div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>{connected ? '● 已连接 / 持仓已同步' : '○ 连接与持仓对账中…'}</div>{marketTime && <div className="et-time">{market === 'CN' ? '北京' : '美东'} {marketTime}</div>}{lastUpdate && <div className="last-update">抓取 {lastUpdate.toLocaleTimeString()}</div>}{sourceQuoteTime && <div className={`quote-time ${showStale ? 'stale' : ''}`}>源报价 <QuoteTime value={sourceQuoteTime} market={market} now={clockTick} /></div>}</div>
    </header>
    {market === 'CN' && <div className="market-note">A 股竞价行情 · 北京 09:30–11:30 / 13:00–15:00 · 休市显示最近可用行情 · T+1，观察信号需结合实际交易规则{!calendarKnown && <span> · 当前年度节假日日历未配置，自动交易日期判断暂停</span>}</div>}
    {showStale && <div className="data-error" role="status">行情源报价超过 3 分钟或时间未知；抓取成功不代表价格已更新，监控暂停使用过期行情。</div>}
    {dataError && <div className="data-error" role="status">{dataError}</div>}{actionError && <div className="action-error" role="alert">{actionError}<button className="btn secondary" onClick={() => setActionError(null)}>关闭提示</button></div>}
    <MarketStats gainers={stocks.gainers || EMPTY_LIST} losers={stocks.losers || EMPTY_LIST} market={market} />
    {view === 'scanner' ? <main className="app-main"><div className="left-panel"><Scanner key={market} stocks={displayStocks} selectedSymbol={selectedSymbol} onSelectSymbol={selectSymbol} title={market === 'CN' ? 'A 股扫描器' : '美股扫描器'} scannerPreset={scannerPreset} onPresetChange={setScannerPreset} category={category} onCategoryChange={setCategory} session={session} dataDate={dataDate} history={priceHistory} market={market} dataError={dataError} lastUpdate={lastUpdate} scope={scope} now={clockTick} /></div><div className="right-panel"><TradingViewChart key={market} symbol={selectedSymbol} stock={selectedStock} market={market} isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} theme={theme} /></div></main> : <main className="app-main"><Suspense fallback={<div className="empty-hint" role="status">正在加载策略与持仓页面…</div>}><StrategyView key={market} market={market} stocks={stocks} selectedStock={selectedStock} trade={trade} setTrade={setTrade} onMarkBuy={markPosition} onClosePosition={closePosition} onAdjustPosition={adjustPosition} pending={pending} historyDates={ledgers[market].sessions} scope={scope} calendarKnown={calendarKnown} session={session} etMeta={marketMeta} selectedSymbol={selectedSymbol} onOpenPreset={id => { setScannerPreset(id); setView('scanner'); }} /></Suspense></main>}
    <footer className="app-footer"><div className="footer-info"><span>{market === 'CN' ? '成交量：股 | 流通股数：流通市值估算 | 量比：行情源口径 | 仅榜单样本' : '美股榜单样本 | 条件与数据来源见扫描器说明 | 新闻催化需人工确认'}</span></div><div className="footer-disclaimer">数据：{dataSource || '加载中'} | 图表：TradingView（行情时效独立）</div></footer>
  </div>;
}

export default App;
export { Scanner };
