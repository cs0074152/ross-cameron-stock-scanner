# Ross Cameron Stock Scanner

<div align="center">

![Stock Scanner](https://img.shields.io/badge/Stock-Scanner-00d26a?style=for-the-badge&logo=tradingview&logoColor=white)
![React](https://img.shields.io/badge/React-18.2-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![WebSocket](https://img.shields.io/badge/WebSocket-Real--time-ff4757?style=for-the-badge&logo=socket.io&logoColor=white)

**A professional-grade stock scanner inspired by Ross Cameron's Warrior Trading methodology**

*Real-time pre-market and regular session stock scanning with TradingView integration*

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Screenshots](#screenshots) • [Tech Stack](#tech-stack)

</div>

---

## Overview

This stock scanner is designed for day traders who follow Ross Cameron's (Warrior Trading) approach to finding momentum stocks. It automatically scans for the best trading opportunities during pre-market and regular trading sessions, applying professional filters to surface high-probability setups.

## Features

### Scanner Categories
- **Top Gainers** - Stocks with the highest percentage gains
- **Top Losers** - Stocks with the largest percentage drops
- **Most Active** - Highest volume stocks in the session
- **Pre-Market Movers** - Real-time pre-market data (4 AM - 9:30 AM ET)
- **After Hours** - Post-market trading activity

### Professional Filters

| Filter | Description |
|--------|-------------|
| **5 Pillars** | Ross Cameron's criteria: Price $1-$20, Change >10%, Low float, High relative volume |
| **HOD Momentum** | Stocks making new highs of day with strong momentum |
| **Gap Scanner** | Stocks gapping up/down >4% from previous close |

### Real-Time Features
- **Live WebSocket Updates** - Data refreshes every 15 seconds
- **TradingView Charts** - Click any stock to view professional charts
- **Session Detection** - Automatically switches data sources based on market hours
- **Visual Alerts** - Flash animations for price movements
- **Sortable Columns** - Sort by any metric with ascending/descending arrows

## Screenshots

```
┌─────────────────────────────────────────────────────────────┐
│  Ross Cameron Stock Scanner              ET: 09:15:32 AM    │
├─────────────────────────────────────────────────────────────┤
│  [Top Gainers] [Losers] [Active] [Pre-Market] [5 Pillars]   │
├──────────────────────────────┬──────────────────────────────┤
│  Symbol  │ Change  │ Price  │          TradingView         │
│  ───────────────────────────│                              │
│  ATMC    │ +405.0% │ $72.54 │      [Interactive Chart]     │
│  XCUR    │ +70.73% │ $9.10  │                              │
│  NCPL    │ +42.66% │ $0.94  │                              │
│  VOR     │ +26.91% │ $20.70 │                              │
│  TVGN    │ +34.43% │ $42.59 │                              │
└──────────────────────────────┴──────────────────────────────┘
```

## Tech Stack

### Frontend
- **React 18** - Modern UI with hooks
- **Vite** - Lightning-fast build tool
- **TradingView Widget** - Professional charting
- **WebSocket Client** - Real-time data streaming
- **CSS Variables** - Dark theme with custom properties

### Backend
- **Node.js** - Server runtime
- **Express** - REST API framework
- **WebSocket (ws)** - Real-time bi-directional communication
- **Cheerio** - HTML parsing for web scraping

### Data Sources
- **stockanalysis.com** - Pre-market data (scraped)
- **Yahoo Finance API** - Regular session data
- **TradingView** - Chart widgets

## Installation

### Prerequisites
- Node.js 18+
- npm or yarn

### Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/ross-cameron-stock-scanner.git
cd ross-cameron-stock-scanner

# Run the start script (installs dependencies automatically)
chmod +x start.sh
./start.sh
```

### Manual Installation

```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install

# Start backend (from backend directory)
node server.js

# Start frontend (from frontend directory)
npm run dev
```

## Usage

1. **Open the scanner**: Navigate to `http://localhost:5173`
2. **Select a category**: Choose from Top Gainers, Losers, Pre-Market, etc.
3. **Apply filters**: Use 5 Pillars, HOD, or Gap filters
4. **Click a stock**: View the TradingView chart on the right panel
5. **Sort columns**: Click column headers to sort data

### Market Hours (Eastern Time)
| Session | Hours | Data Source |
|---------|-------|-------------|
| Pre-Market | 4:00 AM - 9:30 AM | stockanalysis.com |
| Regular | 9:30 AM - 4:00 PM | Yahoo Finance |
| After Hours | 4:00 PM - 8:00 PM | stockanalysis.com |

## Project Structure

```
ross-cameron-stock-scanner/
├── backend/
│   ├── server.js          # Main server with WebSocket & scraping
│   ├── package.json
│   └── .env               # Environment variables
├── frontend/
│   ├── src/
│   │   ├── App.jsx        # Main React component
│   │   ├── App.css        # Styling (dark theme)
│   │   └── main.jsx       # Entry point
│   ├── index.html
│   └── package.json
├── start.sh               # Quick start script
└── README.md
```

## Configuration

Create a `.env` file in the backend directory:

```env
PORT=3001
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server health check |
| `GET /api/scanner/:category` | Get stocks by category |
| `WS /` | WebSocket connection for real-time updates |

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## Disclaimer

This software is for educational purposes only. It is not financial advice. Trading stocks involves risk, and you should never trade with money you cannot afford to lose. Always do your own research before making any investment decisions.

## Acknowledgments

- **Ross Cameron** - [Warrior Trading](https://www.warriortrading.com/) for the trading methodology
- **TradingView** - For the excellent charting widgets
- **stockanalysis.com** - For pre-market data

## License

MIT License - feel free to use this project for personal or commercial purposes.

---

<div align="center">

**Built for traders, by traders**

*Happy Trading!*

</div>
