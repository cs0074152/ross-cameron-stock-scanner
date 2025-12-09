import { useState, useEffect, useRef, useCallback } from 'react';

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
function StockRow({ stock, index, onClick, isSelected, previousPrice }) {
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    if (previousPrice !== undefined && previousPrice !== stock.price) {
      const newFlash = parseFloat(stock.price) > parseFloat(previousPrice) ? 'up' : 'down';
      setFlash(newFlash);
      const timer = setTimeout(() => setFlash(null), 500);
      return () => clearTimeout(timer);
    }
  }, [stock.price, previousPrice]);

  const changeValue = parseFloat(stock.changePercent);
  const changeClass = changeValue >= 0 ? 'positive' : 'negative';
  const arrow = changeValue >= 0 ? '▲' : '▼';
  const rvolClass = parseFloat(stock.rvol) >= 2 ? 'hot' : parseFloat(stock.rvol) >= 1.5 ? 'warm' : '';

  return (
    <tr
      className={`stock-row ${flash ? `flash-${flash}` : ''} ${isSelected ? 'selected' : ''}`}
      onClick={() => onClick(stock.symbol)}
    >
      <td className="symbol">{stock.symbol}</td>
      <td className="price">${stock.price}</td>
      <td className={`change ${changeClass}`}>
        <span className="arrow">{arrow}</span>
        {changeValue >= 0 ? '+' : ''}{stock.changePercent}%
      </td>
      <td className="volume">{stock.volume}</td>
      <td className={`gap ${parseFloat(stock.gap) >= 0 ? 'positive' : 'negative'}`}>
        {parseFloat(stock.gap) >= 0 ? '+' : ''}{stock.gap}%
      </td>
      <td className="float">{stock.float}</td>
      <td className={`rvol ${rvolClass}`}>{stock.rvol}x</td>
    </tr>
  );
}

// Sortable Header Component
function SortableHeader({ label, field, sortField, sortDirection, onSort }) {
  const isActive = sortField === field;
  const arrow = isActive ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <th
      className={`sortable ${isActive ? 'active' : ''}`}
      onClick={() => onSort(field)}
    >
      {label}{arrow}
    </th>
  );
}

// Scanner Component
function Scanner({ stocks, selectedSymbol, onSelectSymbol, title, scannerPreset, onPresetChange, category, onCategoryChange, session, dataDate }) {
  const [previousPrices, setPreviousPrices] = useState({});
  const [sortField, setSortField] = useState('changePercent');
  const [sortDirection, setSortDirection] = useState('desc');

  useEffect(() => {
    const newPrices = {};
    stocks.forEach(s => {
      newPrices[s.symbol] = s.price;
    });
    setPreviousPrices(prev => {
      const merged = { ...prev };
      Object.keys(newPrices).forEach(symbol => {
        if (prev[symbol] !== newPrices[symbol]) {
          merged[symbol] = prev[symbol];
        }
      });
      return merged;
    });
  }, [stocks]);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const sortedStocks = [...stocks].sort((a, b) => {
    let aVal, bVal;

    switch (sortField) {
      case 'symbol':
        aVal = a.symbol;
        bVal = b.symbol;
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      case 'price':
        aVal = parseFloat(a.price);
        bVal = parseFloat(b.price);
        break;
      case 'changePercent':
        aVal = parseFloat(a.changePercent);
        bVal = parseFloat(b.changePercent);
        break;
      case 'volume':
        aVal = a.volumeRaw || 0;
        bVal = b.volumeRaw || 0;
        break;
      case 'gap':
        aVal = Math.abs(parseFloat(a.gap));
        bVal = Math.abs(parseFloat(b.gap));
        break;
      case 'float':
        aVal = a.floatRaw || 0;
        bVal = b.floatRaw || 0;
        break;
      case 'rvol':
        aVal = parseFloat(a.rvol);
        bVal = parseFloat(b.rvol);
        break;
      default:
        aVal = parseFloat(a.changePercent);
        bVal = parseFloat(b.changePercent);
    }

    return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
  });

  const categories = [
    { id: 'gainers', label: 'Top Gainers', icon: '📈' },
    { id: 'losers', label: 'Top Losers', icon: '📉' },
    { id: 'mostActive', label: 'Most Active', icon: '🔥' },
    { id: 'premarket', label: 'Pre-Market', icon: '🌅' },
    { id: 'afterhours', label: 'After Hours', icon: '🌙' }
  ];

  const scannerPresets = [
    { id: 'all', label: 'All Stocks' },
    { id: 'fivePillars', label: '5 Pillars' },
    { id: 'hodMomentum', label: 'HOD Momentum' },
    { id: 'gapScanner', label: 'Gap Scanner' }
  ];

  return (
    <div className="scanner">
      <div className="scanner-header">
        <h2>{title}</h2>
        <div className="session-badge">
          {session === 'regular' && '🟢 Market Open'}
          {session === 'premarket' && '🟡 Pre-Market'}
          {session === 'afterhours' && '🟠 After Hours'}
          {session === 'closed' && '🔴 Market Closed'}
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
            <label>Scanner:</label>
            <select value={scannerPreset} onChange={(e) => onPresetChange(e.target.value)}>
              {scannerPresets.map(preset => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
          </div>
          <div className="stock-count">
            {sortedStocks.length} stocks
          </div>
        </div>
      </div>

      <div className="scanner-table-container">
        <table className="scanner-table">
          <thead>
            <tr>
              <SortableHeader label="Symbol" field="symbol" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="Price" field="price" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="Change" field="changePercent" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="Volume" field="volume" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="Gap" field="gap" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="Float" field="float" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
              <SortableHeader label="RVol" field="rvol" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {sortedStocks.length === 0 ? (
              <tr>
                <td colSpan="7" className="no-data">
                  {session === 'closed'
                    ? 'Market is closed. Showing last available data.'
                    : 'Loading stocks...'}
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
                  previousPrice={previousPrices[stock.symbol]}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// TradingView Chart Component
function TradingViewChart({ symbol, isFullscreen, onToggleFullscreen }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!symbol || !containerRef.current) return;

    containerRef.current.innerHTML = '';

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: symbol,
      interval: "5",
      timezone: "America/New_York",
      theme: "dark",
      style: "1",
      locale: "en",
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

    containerRef.current.appendChild(widgetContainer);
    widgetContainer.appendChild(script);

    return () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  }, [symbol]);

  return (
    <div className={`chart-container ${isFullscreen ? 'fullscreen' : ''}`}>
      <div className="chart-header">
        <h3>{symbol || 'Select a stock'}</h3>
        <div className="chart-actions">
          <span className="realtime-badge">
            Real-Time Chart
          </span>
          <button className="fullscreen-btn" onClick={onToggleFullscreen}>
            {isFullscreen ? '⛶ Exit' : '⛶ Fullscreen'}
          </button>
        </div>
      </div>
      <div className="chart-wrapper" ref={containerRef}>
        {!symbol && (
          <div className="chart-placeholder">
            <p>Click on a stock to view chart</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Main App Component
function App() {
  const [stocks, setStocks] = useState({
    gainers: [],
    losers: [],
    mostActive: [],
    premarket: [],
    afterhours: [],
    fivePillars: [],
    hodMomentum: [],
    gapScanner: []
  });
  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const [category, setCategory] = useState('gainers');
  const [scannerPreset, setScannerPreset] = useState('all');
  const [session, setSession] = useState('closed');
  const [dataDate, setDataDate] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [etTime, setEtTime] = useState(null);
  const wsRef = useRef(null);
  const previousStocksRef = useRef({});
  const reconnectTimeoutRef = useRef(null);

  // WebSocket connection with proper reconnection
  useEffect(() => {
    let isUnmounting = false;

    const connect = () => {
      if (isUnmounting) return;

      try {
        const ws = new WebSocket('ws://localhost:3001');

        ws.onopen = () => {
          console.log('Connected to scanner backend');
          setConnected(true);
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);

            if (message.type === 'initial' || message.type === 'update') {
              // Check for new high-momentum stocks
              if (soundEnabled && previousStocksRef.current.gainers) {
                const prevGainers = previousStocksRef.current.gainers;
                const newGainers = message.data.gainers || [];

                newGainers.forEach(stock => {
                  const prev = prevGainers.find(s => s.symbol === stock.symbol);
                  if (!prev && parseFloat(stock.changePercent) >= 10) {
                    playAlert('momentum');
                  } else if (prev && parseFloat(stock.changePercent) >= 10 && parseFloat(prev.changePercent) < 10) {
                    playAlert('breakout');
                  }
                });
              }

              previousStocksRef.current = message.data;
              setStocks(message.data);
              setSession(message.session);
              setDataDate(message.dataDate || null);
              setLastUpdate(new Date(message.timestamp));
              setEtTime(message.etTime || null);
            }
          } catch (error) {
            console.error('Error parsing message:', error);
          }
        };

        ws.onclose = () => {
          console.log('Disconnected from backend');
          setConnected(false);
          if (!isUnmounting) {
            reconnectTimeoutRef.current = setTimeout(connect, 3000);
          }
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
        };

        wsRef.current = ws;
      } catch (error) {
        console.error('Failed to connect:', error);
        if (!isUnmounting) {
          reconnectTimeoutRef.current = setTimeout(connect, 3000);
        }
      }
    };

    connect();

    return () => {
      isUnmounting = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [soundEnabled]);

  // Get current display stocks based on category and scanner preset
  const getDisplayStocks = useCallback(() => {
    if (scannerPreset === 'fivePillars') {
      return stocks.fivePillars || [];
    } else if (scannerPreset === 'hodMomentum') {
      return stocks.hodMomentum || [];
    } else if (scannerPreset === 'gapScanner') {
      return stocks.gapScanner || [];
    }
    return stocks[category] || [];
  }, [stocks, category, scannerPreset]);

  const displayStocks = getDisplayStocks();

  return (
    <div className={`app ${isFullscreen ? 'chart-fullscreen-mode' : ''}`}>
      <header className="app-header">
        <div className="header-left">
          <h1>Ross Cameron Stock Scanner</h1>
          <span className="powered-by">Yahoo Finance Real-Time</span>
        </div>
        <div className="header-right">
          <button
            className={`sound-toggle ${soundEnabled ? 'enabled' : 'disabled'}`}
            onClick={() => setSoundEnabled(!soundEnabled)}
            title={soundEnabled ? 'Sound alerts ON' : 'Sound alerts OFF'}
          >
            {soundEnabled ? '🔊' : '🔇'}
          </button>
          <div className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? '● Connected' : '○ Reconnecting...'}
          </div>
          {etTime && (
            <div className="et-time">
              ET: {etTime}
            </div>
          )}
          {lastUpdate && (
            <div className="last-update">
              Updated: {lastUpdate.toLocaleTimeString()}
            </div>
          )}
        </div>
      </header>

      <main className="app-main">
        <div className="left-panel">
          <Scanner
            stocks={displayStocks}
            selectedSymbol={selectedSymbol}
            onSelectSymbol={setSelectedSymbol}
            title="Stock Scanner"
            scannerPreset={scannerPreset}
            onPresetChange={setScannerPreset}
            category={category}
            onCategoryChange={setCategory}
            session={session}
            dataDate={dataDate}
          />
        </div>

        <div className="right-panel">
          <TradingViewChart
            symbol={selectedSymbol}
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => setIsFullscreen(!isFullscreen)}
          />
        </div>
      </main>

      <footer className="app-footer">
        <div className="footer-info">
          <span>Ross Cameron 5 Pillars: Float &lt;10M | Gap 4%+ | RVol 2x+ | Price $1-$20 | Catalyst</span>
        </div>
        <div className="footer-disclaimer">
          Data by Yahoo Finance | Charts by TradingView
        </div>
      </footer>
    </div>
  );
}

export default App;
