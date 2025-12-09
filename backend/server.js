require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Cache for stock data
let stockCache = {
  gainers: [],
  losers: [],
  mostActive: [],
  premarket: [],
  afterhours: [],
  fivePillars: [],
  hodMomentum: [],
  gapScanner: []
};

let lastUpdateTime = null;

// Market session detection (Eastern Time)
function getMarketSession() {
  const now = new Date();
  const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hours = etTime.getHours();
  const minutes = etTime.getMinutes();
  const day = etTime.getDay();

  if (day === 0 || day === 6) return 'closed';

  const timeInMinutes = hours * 60 + minutes;

  if (timeInMinutes >= 240 && timeInMinutes < 570) return 'premarket';
  if (timeInMinutes >= 570 && timeInMinutes < 960) return 'regular';
  if (timeInMinutes >= 960 && timeInMinutes < 1200) return 'afterhours';

  return 'closed';
}

function getETTime() {
  const now = new Date();
  return now.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

// Parse volume/market cap string to number
function parseVolumeString(str) {
  if (!str) return 0;
  str = str.toString().replace(/,/g, '').trim();
  const num = parseFloat(str);
  if (str.endsWith('M')) return num * 1000000;
  if (str.endsWith('B')) return num * 1000000000;
  if (str.endsWith('K')) return num * 1000;
  return num || 0;
}

// Scrape pre-market gainers from stockanalysis.com using HTML table
async function scrapePremarketGainers() {
  try {
    const url = 'https://stockanalysis.com/markets/premarket/gainers/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    if (!response.ok) {
      console.error('Failed to fetch premarket gainers:', response.status);
      return [];
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const stocks = [];

    // Parse HTML table: td0=rank, td1=symbol, td2=name, td3=change%, td4=price, td5=volume, td6=marketCap
    $('tbody tr').each((index, row) => {
      const tds = $(row).find('td');
      if (tds.length >= 5) {
        const symbol = $(tds[1]).text().trim();
        const name = $(tds[2]).text().trim();
        const changePercentStr = $(tds[3]).text().trim().replace('%', '');
        const priceStr = $(tds[4]).text().trim().replace('$', '').replace(',', '');
        const volumeStr = tds.length > 5 ? $(tds[5]).text().trim() : '0';
        const marketCapStr = tds.length > 6 ? $(tds[6]).text().trim() : '0';

        const changePercent = parseFloat(changePercentStr) || 0;
        const price = parseFloat(priceStr) || 0;
        const volumeRaw = parseVolumeString(volumeStr);
        const marketCap = parseVolumeString(marketCapStr);

        if (symbol && symbol.match(/^[A-Z]+$/)) {
          stocks.push({
            symbol,
            name,
            price: price.toFixed(2),
            change: '0.00',
            changePercent: changePercent.toFixed(2),
            volume: formatVolume(volumeRaw),
            volumeRaw,
            gap: changePercent.toFixed(2),
            float: formatFloat(marketCap / 10), // Rough estimate
            floatRaw: marketCap / 10,
            rvol: '1.00',
            high: price.toFixed(2),
            low: price.toFixed(2),
            open: price.toFixed(2),
            prevClose: '0.00',
            avgVolume: 0,
            marketCap
          });
        }
      }
    });

    console.log(`Scraped ${stocks.length} premarket gainers`);
    if (stocks.length > 0) {
      console.log(`Top gainers: ${stocks.slice(0, 3).map(s => `${s.symbol}(${s.changePercent}%)`).join(', ')}`);
    }
    return stocks.slice(0, 50);
  } catch (error) {
    console.error('Error scraping premarket gainers:', error.message);
    return [];
  }
}

// Scrape pre-market losers from stockanalysis.com
async function scrapePremarketLosers() {
  try {
    const url = 'https://stockanalysis.com/markets/premarket/losers/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      }
    });

    if (!response.ok) return [];

    const html = await response.text();
    const $ = cheerio.load(html);
    const stocks = [];

    $('tbody tr').each((index, row) => {
      const tds = $(row).find('td');
      if (tds.length >= 5) {
        const symbol = $(tds[1]).text().trim();
        const name = $(tds[2]).text().trim();
        const changePercentStr = $(tds[3]).text().trim().replace('%', '');
        const priceStr = $(tds[4]).text().trim().replace('$', '').replace(',', '');
        const volumeStr = tds.length > 5 ? $(tds[5]).text().trim() : '0';
        const marketCapStr = tds.length > 6 ? $(tds[6]).text().trim() : '0';

        const changePercent = parseFloat(changePercentStr) || 0;
        const price = parseFloat(priceStr) || 0;
        const volumeRaw = parseVolumeString(volumeStr);
        const marketCap = parseVolumeString(marketCapStr);

        if (symbol && symbol.match(/^[A-Z]+$/)) {
          stocks.push({
            symbol,
            name,
            price: price.toFixed(2),
            change: '0.00',
            changePercent: changePercent.toFixed(2),
            volume: formatVolume(volumeRaw),
            volumeRaw,
            gap: changePercent.toFixed(2),
            float: formatFloat(marketCap / 10),
            floatRaw: marketCap / 10,
            rvol: '1.00',
            high: price.toFixed(2),
            low: price.toFixed(2),
            open: price.toFixed(2),
            prevClose: '0.00',
            avgVolume: 0,
            marketCap
          });
        }
      }
    });

    console.log(`Scraped ${stocks.length} premarket losers`);
    return stocks.slice(0, 50);
  } catch (error) {
    console.error('Error scraping premarket losers:', error.message);
    return [];
  }
}

// Scrape most active from stockanalysis.com
async function scrapePremarketActive() {
  try {
    const url = 'https://stockanalysis.com/markets/premarket/most-active/';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      }
    });

    if (!response.ok) return [];

    const html = await response.text();
    const $ = cheerio.load(html);
    const stocks = [];

    $('tbody tr').each((index, row) => {
      const tds = $(row).find('td');
      if (tds.length >= 5) {
        const symbol = $(tds[1]).text().trim();
        const name = $(tds[2]).text().trim();
        const changePercentStr = $(tds[3]).text().trim().replace('%', '');
        const priceStr = $(tds[4]).text().trim().replace('$', '').replace(',', '');
        const volumeStr = tds.length > 5 ? $(tds[5]).text().trim() : '0';
        const marketCapStr = tds.length > 6 ? $(tds[6]).text().trim() : '0';

        const changePercent = parseFloat(changePercentStr) || 0;
        const price = parseFloat(priceStr) || 0;
        const volumeRaw = parseVolumeString(volumeStr);
        const marketCap = parseVolumeString(marketCapStr);

        if (symbol && symbol.match(/^[A-Z]+$/)) {
          stocks.push({
            symbol,
            name,
            price: price.toFixed(2),
            change: '0.00',
            changePercent: changePercent.toFixed(2),
            volume: formatVolume(volumeRaw),
            volumeRaw,
            gap: changePercent.toFixed(2),
            float: formatFloat(marketCap / 10),
            floatRaw: marketCap / 10,
            rvol: '1.00',
            high: price.toFixed(2),
            low: price.toFixed(2),
            open: price.toFixed(2),
            prevClose: '0.00',
            avgVolume: 0,
            marketCap
          });
        }
      }
    });

    console.log(`Scraped ${stocks.length} premarket active`);
    return stocks.slice(0, 50);
  } catch (error) {
    console.error('Error scraping premarket active:', error.message);
    return [];
  }
}

// Fetch Yahoo screener for regular market hours
async function fetchYahooScreener(scrId, count = 50) {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=${count}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) return [];

    const data = await response.json();
    const quotes = data?.finance?.result?.[0]?.quotes || [];
    return quotes.map(transformYahooStock);
  } catch (error) {
    console.error(`Error fetching ${scrId}:`, error.message);
    return [];
  }
}

function transformYahooStock(quote) {
  const price = quote.regularMarketPrice || 0;
  const change = quote.regularMarketChange || 0;
  const changePercent = quote.regularMarketChangePercent || 0;
  const volume = quote.regularMarketVolume || 0;
  const prevClose = quote.regularMarketPreviousClose || price - change;
  const dayHigh = quote.regularMarketDayHigh || price;
  const dayLow = quote.regularMarketDayLow || price;
  const open = quote.regularMarketOpen || prevClose;
  const avgVolume = quote.averageDailyVolume3Month || volume;
  const sharesFloat = quote.floatShares || quote.sharesOutstanding || 0;
  const gap = prevClose > 0 ? ((open - prevClose) / prevClose * 100) : 0;
  const rvol = avgVolume > 0 ? (volume / avgVolume) : 1;

  return {
    symbol: quote.symbol,
    name: quote.shortName || quote.longName || quote.symbol,
    price: price.toFixed(2),
    change: change.toFixed(2),
    changePercent: changePercent.toFixed(2),
    volume: formatVolume(volume),
    volumeRaw: volume,
    gap: gap.toFixed(2),
    float: formatFloat(sharesFloat),
    floatRaw: sharesFloat,
    rvol: rvol.toFixed(2),
    high: dayHigh.toFixed(2),
    low: dayLow.toFixed(2),
    open: open.toFixed(2),
    prevClose: prevClose.toFixed(2),
    avgVolume: avgVolume,
    marketCap: quote.marketCap || 0
  };
}

function formatVolume(vol) {
  if (vol >= 1000000000) return (vol / 1000000000).toFixed(1) + 'B';
  if (vol >= 1000000) return (vol / 1000000).toFixed(1) + 'M';
  if (vol >= 1000) return (vol / 1000).toFixed(0) + 'K';
  return vol.toString();
}

function formatFloat(floatShares) {
  if (!floatShares || floatShares === 0) return 'N/A';
  if (floatShares >= 1000000000) return (floatShares / 1000000000).toFixed(1) + 'B';
  if (floatShares >= 1000000) return (floatShares / 1000000).toFixed(1) + 'M';
  if (floatShares >= 1000) return (floatShares / 1000).toFixed(0) + 'K';
  return floatShares.toString();
}

// Scanner Filters
function apply5PillarsFilter(stocks) {
  return stocks.filter(s => {
    const price = parseFloat(s.price);
    const change = Math.abs(parseFloat(s.changePercent));
    const priceOk = price >= 1 && price <= 20;
    const changeOk = change >= 10;
    return priceOk && changeOk;
  }).sort((a, b) => Math.abs(parseFloat(b.changePercent)) - Math.abs(parseFloat(a.changePercent)));
}

function applyHODFilter(stocks) {
  return stocks.filter(s => {
    const change = parseFloat(s.changePercent);
    return change >= 5;
  }).sort((a, b) => parseFloat(b.changePercent) - parseFloat(a.changePercent));
}

function applyGapFilter(stocks) {
  return stocks.filter(s => {
    const gap = Math.abs(parseFloat(s.gap) || parseFloat(s.changePercent));
    return gap >= 4;
  }).sort((a, b) => Math.abs(parseFloat(b.gap) || parseFloat(b.changePercent)) - Math.abs(parseFloat(a.gap) || parseFloat(a.changePercent)));
}

// Main refresh function
async function refreshData() {
  const session = getMarketSession();
  const etTime = getETTime();
  console.log(`[${new Date().toISOString()}] Refreshing... Session: ${session} (ET: ${etTime})`);

  try {
    let gainers, losers, mostActive;

    if (session === 'premarket') {
      // During premarket, scrape stockanalysis.com for real premarket data
      console.log('Fetching PREMARKET data from stockanalysis.com...');
      [gainers, losers, mostActive] = await Promise.all([
        scrapePremarketGainers(),
        scrapePremarketLosers(),
        scrapePremarketActive()
      ]);
    } else if (session === 'regular') {
      // During regular hours, use Yahoo Finance
      console.log('Fetching REGULAR session data from Yahoo Finance...');
      const [gainersData, losersData, activeData] = await Promise.all([
        fetchYahooScreener('day_gainers', 50),
        fetchYahooScreener('day_losers', 50),
        fetchYahooScreener('most_actives', 50)
      ]);
      gainers = gainersData;
      losers = losersData;
      mostActive = activeData;
    } else {
      // After hours or closed - try premarket data
      console.log('Fetching AFTERHOURS/CLOSED data...');
      [gainers, losers, mostActive] = await Promise.all([
        scrapePremarketGainers(),
        scrapePremarketLosers(),
        scrapePremarketActive()
      ]);
    }

    // Format data for display
    const formattedGainers = gainers.map(s => ({
      ...s,
      price: typeof s.price === 'number' ? s.price.toFixed(2) : s.price,
      changePercent: typeof s.changePercent === 'number' ? s.changePercent.toFixed(2) : s.changePercent
    }));

    const formattedLosers = losers.map(s => ({
      ...s,
      price: typeof s.price === 'number' ? s.price.toFixed(2) : s.price,
      changePercent: typeof s.changePercent === 'number' ? s.changePercent.toFixed(2) : s.changePercent
    }));

    // Apply scanner filters
    const fivePillars = apply5PillarsFilter(formattedGainers);
    const hodMomentum = applyHODFilter(formattedGainers);
    const gapScanner = applyGapFilter(formattedGainers);

    // Update cache
    stockCache = {
      gainers: formattedGainers,
      losers: formattedLosers,
      mostActive: mostActive,
      premarket: session === 'premarket' ? formattedGainers : stockCache.premarket,
      afterhours: session === 'afterhours' ? formattedGainers : stockCache.afterhours,
      fivePillars,
      hodMomentum,
      gapScanner
    };

    lastUpdateTime = new Date().toISOString();

    console.log(`Updated: ${formattedGainers.length} gainers, ${formattedLosers.length} losers, ${mostActive.length} active`);
    console.log(`Filters: ${fivePillars.length} 5-pillars, ${hodMomentum.length} HOD, ${gapScanner.length} gap`);
    if (formattedGainers.length > 0) {
      console.log(`Top 3: ${formattedGainers.slice(0, 3).map(s => `${s.symbol}(${s.changePercent}%)`).join(', ')}`);
    }

    broadcastUpdate();
  } catch (error) {
    console.error('Error refreshing data:', error.message);
  }
}

function broadcastUpdate() {
  const session = getMarketSession();
  const message = JSON.stringify({
    type: 'update',
    data: stockCache,
    session: session,
    lastUpdateTime,
    etTime: getETTime(),
    timestamp: new Date().toISOString()
  });

  let clientCount = 0;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      clientCount++;
    }
  });

  if (clientCount > 0) {
    console.log(`Broadcast to ${clientCount} clients`);
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  const session = getMarketSession();

  ws.send(JSON.stringify({
    type: 'initial',
    data: stockCache,
    session: session,
    lastUpdateTime,
    etTime: getETTime(),
    timestamp: new Date().toISOString()
  }));

  ws.on('close', () => console.log('Client disconnected'));
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    session: getMarketSession(),
    etTime: getETTime(),
    lastUpdate: lastUpdateTime,
    gainersCount: stockCache.gainers.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/scanner/:category', (req, res) => {
  const { category } = req.params;
  res.json({
    data: stockCache[category] || [],
    session: getMarketSession(),
    etTime: getETTime(),
    timestamp: new Date().toISOString()
  });
});

server.listen(PORT, () => {
  const session = getMarketSession();
  const etTime = getETTime();
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║     Ross Cameron Stock Scanner - Backend                  ║
║     Pre-Market: stockanalysis.com | Regular: Yahoo        ║
╠═══════════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                            ║
║  WebSocket: ws://localhost:${PORT}                           ║
║  Session: ${session.padEnd(12)} ET Time: ${etTime}        ║
╚═══════════════════════════════════════════════════════════╝
  `);

  refreshData();
  setInterval(refreshData, 15000); // Refresh every 15 seconds
});
