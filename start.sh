#!/bin/bash

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║     Ross Cameron Stock Scanner v2.0                       ║"
echo "║     Powered by Alpha Vantage + TradingView                ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# Check for .env file
if [ ! -f backend/.env ]; then
    echo "⚠️  No .env file found in backend/"
    echo "   Creating default .env with demo API key..."
    echo "ALPHA_VANTAGE_KEY=demo" > backend/.env
    echo "PORT=3001" >> backend/.env
    echo ""
fi

# Install dependencies if needed
if [ ! -d "backend/node_modules" ]; then
    echo "📦 Installing backend dependencies..."
    cd backend && npm install && cd ..
fi

if [ ! -d "frontend/node_modules" ]; then
    echo "📦 Installing frontend dependencies..."
    cd frontend && npm install && cd ..
fi

# Kill any existing processes
pkill -f "node server.js" 2>/dev/null
pkill -f "vite" 2>/dev/null
sleep 1

# Start backend
echo ""
echo "🚀 Starting backend server..."
cd backend && node server.js &
BACKEND_PID=$!

# Wait for backend to start
sleep 3

# Start frontend
echo "🎨 Starting frontend..."
cd ../frontend && npm run dev &
FRONTEND_PID=$!

sleep 2

echo ""
echo "✅ Application started!"
echo ""
echo "📊 Frontend:     http://localhost:5173"
echo "🔌 Backend API:  http://localhost:3001"
echo "📡 WebSocket:    ws://localhost:3001"
echo ""
echo "💡 TIP: Login to TradingView in your browser for real-time charts"
echo "💡 TIP: Get a free Alpha Vantage API key at alphavantage.co for better rate limits"
echo ""
echo "Press Ctrl+C to stop both servers"

# Wait for Ctrl+C
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo ''; echo 'Servers stopped.'; exit" INT
wait
