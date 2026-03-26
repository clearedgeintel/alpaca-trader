# Alpaca Auto Trader — React Frontend Requirements
**Version:** 1.0  
**Connects to:** Express API at `http://localhost:3001/api`  
**Stack:** React 18 · Vite · TailwindCSS · Recharts · React Query

---

## 1. Project Overview

Build a real-time trading dashboard that displays the state of the Alpaca auto trader backend. The UI is read-only — no trade buttons, no forms. It's a monitoring console that polls the backend API and renders live data across four views.

**Aesthetic direction:** Dark, professional sportsbook/trading terminal aesthetic. Think Bloomberg Terminal meets a sharp sports analytics dashboard. Dark background (`#0a0b0d`), tight data-dense layouts, monospace numbers, green/red PnL coloring, subtle grid lines, and sharp accent colors (electric blue `#3b82f6`, signal green `#22c55e`, alert red `#ef4444`). Zero gradients on backgrounds. Data should feel alive — numbers that changed should flash briefly.

---

## 2. Directory Structure

```
trader-ui/
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   ├── api/
│   │   └── client.js          # All fetch calls to backend, one function per endpoint
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.jsx    # Left nav with route links + market status indicator
│   │   │   └── TopBar.jsx     # Portfolio value, buying power, last scan timestamp
│   │   ├── dashboard/
│   │   │   ├── StatCard.jsx   # Reusable metric tile (value, label, delta, trend)
│   │   │   ├── PortfolioChart.jsx  # Daily P&L line chart
│   │   │   └── ActivityFeed.jsx    # Recent signals + trade events, newest first
│   │   ├── positions/
│   │   │   ├── PositionsTable.jsx  # Live open positions with P&L
│   │   │   └── PositionRow.jsx     # Single row with flash animation on price change
│   │   ├── trades/
│   │   │   ├── TradesTable.jsx     # Paginated trade history
│   │   │   └── TradeDrawer.jsx     # Slide-in detail panel for a single trade
│   │   ├── signals/
│   │   │   └── SignalsTable.jsx    # Recent scanner signals with acted_on indicator
│   │   └── shared/
│   │       ├── Badge.jsx      # Status badges (OPEN, CLOSED, BUY, SELL)
│   │       ├── PnlCell.jsx    # Green/red colored PnL with % and dollar amount
│   │       ├── Sparkline.jsx  # Tiny inline bar chart for vol ratio
│   │       └── LoadingState.jsx
├── .env
├── vite.config.js
├── tailwind.config.js
└── package.json
```

---

## 3. Environment Variables

```
VITE_API_BASE_URL=http://localhost:3001/api
VITE_POLL_INTERVAL_MS=30000
```

---

## 4. API Client (src/api/client.js)

One exported async function per backend endpoint. All throw on non-2xx. Base URL from `import.meta.env.VITE_API_BASE_URL`.

```javascript
export const getStatus      = () => fetch(`${BASE}/status`).then(r => r.json())
export const getAccount     = () => fetch(`${BASE}/account`).then(r => r.json())
export const getPositions   = () => fetch(`${BASE}/positions`).then(r => r.json())
export const getTrades      = (params = {}) => fetch(`${BASE}/trades?${new URLSearchParams(params)}`).then(r => r.json())
export const getTrade       = (id) => fetch(`${BASE}/trades/${id}`).then(r => r.json())
export const getSignals     = (limit = 50) => fetch(`${BASE}/signals?limit=${limit}`).then(r => r.json())
export const getPerformance = () => fetch(`${BASE}/performance`).then(r => r.json())
```

---

## 5. Data Polling Strategy

Use **React Query** (`@tanstack/react-query`) for all data fetching.

| Query Key | Endpoint | Refetch Interval | Stale Time |
|-----------|----------|-----------------|------------|
| `['status']` | `/status` | 15s | 10s |
| `['account']` | `/account` | 30s | 20s |
| `['positions']` | `/positions` | 30s | 20s |
| `['trades', 'open']` | `/trades?status=open` | 30s | 20s |
| `['trades', 'all']` | `/trades` | 60s | 30s |
| `['signals']` | `/signals` | 60s | 30s |
| `['performance']` | `/performance` | 120s | 60s |

Show a small pulsing dot in the TopBar when any query is actively refetching.

---

## 6. Views / Routes

Use React Router v6. Four routes:

| Path | Component | Description |
|------|-----------|-------------|
| `/` | `DashboardView` | Summary cards + chart + activity feed |
| `/positions` | `PositionsView` | Live open positions table |
| `/trades` | `TradesView` | Full trade history with filters |
| `/signals` | `SignalsView` | Scanner signal log |

---

## 7. Component Specifications

### 7.1 Layout — Sidebar

- Fixed left sidebar, width 220px
- App name `CLEAREDGE TRADER` at top in monospace, all caps, small text, electric blue
- Nav links: Dashboard, Positions, Trades, Signals — with active state highlight (left border accent)
- Bottom of sidebar: version number + `PAPER MODE` badge in amber

### 7.2 Layout — TopBar

Sticky top bar across all views. Show:
- **Portfolio Value** — large, white, monospace. Flash green if increased since last poll
- **Buying Power** — smaller, muted gray
- **Open Positions** — count badge
- **Market Status** — `MARKET OPEN` (green pulsing dot) or `MARKET CLOSED` (gray dot)
- **Last Scan** — relative time ("2 min ago"), tooltip with exact ISO timestamp
- **Live indicator** — pulsing dot that animates while any query refetches

### 7.3 Dashboard View

**Top row — 4 stat cards:**
| Card | Value | Delta |
|------|-------|-------|
| Today's P&L | Sum of closed trade PnL today | vs yesterday |
| Win Rate | Wins / total trades (%) | last 7 days |
| Open Positions | Count of status=open trades | — |
| Total Trades | All-time trade count | this week |

**Middle — PortfolioChart:**
- Line chart using Recharts `LineChart`
- X-axis: `trade_date` from `daily_performance`
- Y-axis: `portfolio_value`
- Two lines: `portfolio_value` (blue) and a zeroed baseline
- Tooltip shows date, portfolio value, daily PnL, win rate
- No legend clutter — use inline labels at end of lines
- Height: 220px
- Background: transparent, custom grid lines in `#1a1b1e`

**Bottom — ActivityFeed:**
- Combined feed of recent signals and recent trade opens/closes
- Newest first, max 20 items visible
- Each item: timestamp (relative) · symbol badge · event type · detail text
- Signal items: `SCAN` tag, symbol, signal direction (BUY/SELL), RSI + EMA values
- Trade open items: `OPEN` tag in green, symbol, qty, entry price
- Trade close items: `CLOSE` tag, symbol, PnL in green/red
- Auto-scrolls to top when new items arrive

### 7.4 Positions View

Full-width table. Columns:

| Column | Source | Notes |
|--------|--------|-------|
| Symbol | `trades.symbol` | Bold, uppercase |
| Side | `trades.side` | Badge: BUY=green |
| Qty | `trades.qty` | Right-aligned monospace |
| Entry | `trades.entry_price` | Monospace |
| Current | Alpaca position `current_price` | **Flash on change** |
| Stop | `trades.stop_loss` | Red tint |
| Target | `trades.take_profit` | Green tint |
| P&L $ | Calculated | Green if positive, red if negative |
| P&L % | Calculated | Same coloring |
| Duration | `now - created_at` | "2h 14m" |

**Flash behavior:** When `current_price` changes between polls, the entire row briefly flashes green (price up) or red (price down) using a CSS animation, then returns to normal. Duration: 800ms.

**Empty state:** If no open positions, show centered message: `"No open positions — scanner is watching the market"` with a subtle pulsing indicator if market is open.

### 7.5 Trades View

Paginated table, 25 rows per page.

**Filter bar (top):**
- Status toggle: `ALL · OPEN · CLOSED`
- Symbol text search input
- Date range picker (simple: Today / This Week / This Month / All Time)

**Columns:**

| Column | Notes |
|--------|-------|
| Date | `created_at` formatted `MMM D, h:mm a` |
| Symbol | Bold |
| Side | Badge |
| Qty | Monospace |
| Entry | Monospace |
| Exit | Monospace, `—` if still open |
| P&L $ | Green/red, `—` if open |
| P&L % | Green/red |
| Exit Reason | `Stop Loss` / `Take Profit` / `—` |
| Status | Badge: OPEN (blue) / CLOSED (gray) |

**Row click** → opens `TradeDrawer` slide-in panel from the right.

**TradeDrawer:** Shows full trade detail:
- All fields from the trades table
- Signal that triggered the trade (join via `signal_id`): reason text, RSI, EMA values
- Inline mini P&L bar showing entry → stop → current → target on a number line
- Close button (X) or click outside to dismiss

### 7.6 Signals View

Table of recent scanner signals. Default: last 50, with "Load More" button.

**Columns:**

| Column | Notes |
|--------|-------|
| Time | Relative + absolute on hover |
| Symbol | Bold |
| Signal | `BUY` (green badge) / `SELL` (red badge) |
| Close | Entry price |
| EMA9 | Monospace |
| EMA21 | Monospace |
| RSI | Color-coded: <30 red, 30-45 orange, 45-70 green, >70 orange |
| Vol Ratio | `1.4x` format, green if ≥ 1.2 |
| Acted | Checkmark if `acted_on = true`, dash if not |
| Reason | Truncated text, full on hover tooltip |

---

## 8. Shared Components

### 8.1 Badge
```
Props: variant ('buy' | 'sell' | 'open' | 'closed' | 'paper' | 'scan')
Styling: tight padding, monospace text, uppercase, colored border-left 2px + subtle bg tint
```

### 8.2 PnlCell
```
Props: dollar (number), pct (number)
Renders: "+$142.50  +1.84%" in green, or "-$85.20  -0.92%" in red
Zero: neutral gray
Monospace font throughout
```

### 8.3 StatCard
```
Props: label, value, delta, deltaLabel, trend ('up'|'down'|'neutral')
Dark card with 1px border in #1e2025
Value: large monospace
Delta: small colored text below value
Optional: sparkline or icon
```

### 8.4 LoadingState
```
Skeleton loader using pulsing gray blocks that match the shape of the target content
Never use a spinner — use skeleton screens only
```

---

## 9. Styling Rules

### Colors (CSS variables in index.css)
```css
:root {
  --bg-base:      #0a0b0d;
  --bg-surface:   #111318;
  --bg-elevated:  #1a1d24;
  --border:       #1e2228;
  --text-primary: #e8eaf0;
  --text-muted:   #6b7280;
  --text-dim:     #374151;
  --accent-blue:  #3b82f6;
  --accent-green: #22c55e;
  --accent-red:   #ef4444;
  --accent-amber: #f59e0b;
  --font-mono:    'JetBrains Mono', 'Fira Code', monospace;
  --font-ui:      'DM Sans', sans-serif;
}
```

### Typography
- All numeric values: `var(--font-mono)`, tabular numbers (`font-variant-numeric: tabular-nums`)
- UI labels, nav: `var(--font-ui)`
- Load both from Google Fonts in `index.html`

### Spacing
- Base unit: 4px (Tailwind default)
- Tables: compact row height (`py-2`), dense data
- Cards: `p-4` or `p-5`

### Borders
- All cards and table containers: `1px solid var(--border)`
- No box shadows — use borders only
- Table rows: bottom border only, `1px solid var(--border)`

### Animations
- Price flash: `@keyframes flash-green` / `flash-red` — fade from tinted bg to transparent over 800ms
- Pulsing live dot: `@keyframes pulse` — subtle opacity oscillation
- Page transitions: none (instant is fine for a trading terminal)
- Skeleton loading: `@keyframes shimmer` — standard left-to-right sweep

---

## 10. Error & Edge States

| State | Behavior |
|-------|---------|
| Backend offline | TopBar shows `API OFFLINE` in red, all data panels show "Unable to connect to trader backend" with retry button |
| Market closed | TopBar shows `MARKET CLOSED`, positions view shows last known data with `STALE` tag |
| Empty data | Every table and chart has a proper empty state (not blank) |
| Stale data | If last successful fetch > 2 min ago, show stale warning banner |
| Query error | Inline error message inside the failing panel — never crash the whole page |

---

## 11. package.json Dependencies

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.18.0",
    "@tanstack/react-query": "^5.0.0",
    "recharts": "^2.9.0",
    "date-fns": "^2.30.0",
    "clsx": "^2.0.0"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.1.0",
    "tailwindcss": "^3.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0"
  }
}
```

---

## 12. vite.config.js

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
```

> The proxy means you can use `/api` directly in dev without CORS issues.  
> Update `VITE_API_BASE_URL` to `/api` when using the proxy.

---

## 13. README Additions

Add to the backend README or create `trader-ui/README.md`:

1. `npm install` inside `trader-ui/`
2. Copy `.env.example` → `.env`
3. `npm run dev` → opens at `http://localhost:5173`
4. Backend must be running at port 3001 first
5. How to build for production: `npm run build` → `dist/` folder

---

## 14. Out of Scope (v1)

- Trade execution buttons (buy/sell from UI)
- Authentication / login screen
- Watchlist editor in UI
- Strategy config editor in UI
- Mobile responsive layout (desktop-first only)
- WebSocket real-time push (polling is sufficient for v1)
- Dark/light mode toggle
