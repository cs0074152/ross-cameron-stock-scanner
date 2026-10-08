import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './App.css'

// StrictMode is intentionally omitted: its dev double-mount makes the
// TradingView embed script create two widget instances per selection.
ReactDOM.createRoot(document.getElementById('root')).render(<App />)
