# Alpaca Auto Trader

Automated paper trading bot using a momentum strategy (EMA crossover + RSI + volume confirmation) with the Alpaca API and Supabase PostgreSQL.

## Prerequisites

- **Node.js 18+** (uses native `fetch`)
- **Alpaca paper trading account** — sign up at [alpaca.markets](https://alpaca.markets)
- **Supabase project** — create at [supabase.com](https://supabase.com) (free tier works)

## Setup

1. Clone the repo and install dependencies:
   ```bash
   cd alpaca-trader
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

   Required variables:
   - `ALPACA_API_KEY` / `ALPACA_API_SECRET` — from your Alpaca paper trading dashboard
   - `ALPACA_BASE_URL` — `https://paper-api.alpaca.markets` for paper trading
   - `ALPACA_DATA_URL` — `https://data.alpaca.markets`
   - `DATABASE_URL` — Supabase direct connection string (Settings → Database → Connection string → URI)

3. Start the app:
   ```bash
   npm start
   ```

   For development with auto-reload:
   ```bash
   npm run dev
   ```

## Verifying It Works

1. **Logs** — on startup you should see:
   ```
   ✅ Database ready
   API server running on port 3001
   🚀 Alpaca Auto Trader running
   ```

2. **API health check**:
   ```bash
   curl http://localhost:3001/api/status
   ```

3. **Supabase** — check the `signals` table after the first scan during market hours

4. **Alpaca dashboard** — paper orders will appear at [app.alpaca.markets/paper/dashboard](https://app.alpaca.markets/paper/dashboard/overview) after a BUY signal fires

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/status` | App health, market open flag, last scan time |
| GET | `/api/account` | Live Alpaca account data |
| GET | `/api/positions` | Live open positions from Alpaca |
| GET | `/api/trades` | All trades from DB (supports `?status=open`) |
| GET | `/api/trades/:id` | Single trade detail |
| GET | `/api/signals` | Recent signals (supports `?limit=N`, default 50) |
| GET | `/api/performance` | Daily performance rows |

## Switching to Live Trading

> **Warning:** Live trading uses real money. Thoroughly test with paper trading first.

1. Get live API keys from Alpaca
2. Update `.env`:
   ```
   ALPACA_API_KEY=live_key
   ALPACA_API_SECRET=live_secret
   ALPACA_BASE_URL=https://api.alpaca.markets
   ```
3. Restart the app
