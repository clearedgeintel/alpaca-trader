# ClearEdge Trader UI Roadmap

## Goal

Transform ClearEdge Trader from a functional trading/admin dashboard into a polished, professional day-trading interface with the density, clarity, and confidence of modern broker apps such as Robinhood, Stash, Webull, and professional trading terminals.

The UI should prioritize fast decision-making, live market awareness, open risk visibility, and direct trade execution. It should minimize dead space, show stock logos next to symbols wherever available, and make the app feel like a complete trading workspace rather than a collection of separate pages.

## Design Principles

- Put the trader's current decision in the center: symbol, chart, position, order ticket, risk, and signal.
- Use dense but readable layouts on desktop; reserve card-heavy views for mobile only.
- Keep market data, P&L, and risk visually scannable with consistent color and number treatment.
- Add logos beside stock symbols wherever a logo is available, with clean fallbacks for missing assets and crypto.
- Collapse or dock secondary operational information instead of stacking everything vertically.
- Make controls feel purposeful: segmented controls for modes, toggles for overlays, compact icon buttons for actions, and tables for repeated financial data.
- Keep the product visually restrained, sharp, and trustworthy.

## Status

- **Phase 1**: ✅ Complete (commit `e5c2fdc`, 2026-05-09)
- **Phase 2**: ✅ Complete (2026-05-09) — see Phase 2 section below for what landed
- **Phase 3**: 🚧 Up next — Professional Trading Dashboard

## Phase 1: Foundation And Visual System ✅

**Status**: Complete. Shipped in `e5c2fdc` ("Polish trading UI foundation").

**What landed**:
- CSS tokens defined in `trader-ui/src/index.css` (`--bg-base`, `--bg-surface`, `--border`, `--accent-*`, `--text-*`).
- Utility patterns: `.app-panel`, `.app-panel-header`, `.app-section-title`, `.page-title`, `.data-table`, `.control-surface`.
- Tabular numerics on all `.font-mono` so columns of numbers align by digit.
- Tightened table density (`th: px-3 py-2`, `td: px-3 py-1.5`) and softer row dividers (`border-border/50`).
- Scrollbar restyled to match the dark theme.
- Tailwind config exports the same color tokens so JSX can use `bg-surface`, `text-accent-green`, etc.
- Cleaned encoding artifacts — `â€"`, `Â·`, `â€¦` no longer appear in `trader-ui/src/`.
- Sidebar + TopBar reworked with the new tokens; `Badge`, `PnlCell`, `StatCard`, `LoadingState` aligned to the system.

**Acceptance check (verified)**:
- ✅ Desktop screens dense without becoming cramped (table row heights ~34px on data tables).
- ✅ Tables, cards, and forms share `.app-panel` + `.data-table` + `.control-surface` patterns.
- ✅ Zero encoding artifacts in `trader-ui/src/` (grep confirms).
- ✅ The app reads as a trading product — sidebar branding, dense panels, consistent financial-value colors.

### Scope

- Refine the dark theme into a more broker-quality interface.
- Tighten spacing across the app to reduce dead space.
- Standardize panel, table, button, badge, and input styling.
- Fix visible text encoding artifacts such as `â€”`, `â€¦`, `Â·`, and related characters.
- Establish consistent typography for:
  - market prices,
  - P&L values,
  - table labels,
  - status badges,
  - timestamps,
  - secondary metadata.

### Deliverables

- Updated global CSS tokens and utility patterns.
- Dense panel and table styling.
- Consistent green/red/neutral treatment for financial values.
- Cleaner app shell with a more professional brand area.

### Acceptance Criteria

- Desktop screens feel materially denser without becoming cramped.
- Tables, cards, and forms share a consistent visual language.
- No visible encoding artifacts remain in common UI paths.
- The app reads as a trading product, not an admin console.

## Phase 2: Stock Logos Everywhere ✅

**Status**: Complete (2026-05-09).

**What landed**:
- New shared `SymbolIdentity` composition (`trader-ui/src/components/shared/SymbolIdentity.jsx`) — logo + symbol + optional company name in three variants (`row` / `header` / `compact`). Resolves OCC option symbols to the underlying logo automatically and stamps an "opt" pill.
- MarketView's `SymbolHeader` now shows a 36px logo next to the price.
- MarketView's `SymbolAutocomplete` dropdown rows show 22px logos.
- DashboardView's `DashSymbolSearch` dropdown shows 20px logos.
- SignalsTable rows render through `SymbolIdentity`.
- DecisionsView rows render through `SymbolIdentity` (compact variant).
- UniverseView's `SymbolGrid` chips and `CandidatesTable` rows show 18-20px logos.
- `StockLogo` already had a clean fallback (initials tile + deterministic gradient) and same-origin proxy to dodge ad blockers — reused as-is.

**Already in place from earlier work** (left untouched):
- DashboardView ticker cards / open positions / recent trades.
- PositionsTable desktop + mobile.
- TradesTable desktop.
- OptionActivityCard.

**Acceptance check (verified)**:
- ✅ Every primary trading surface that shows a symbol now shows a logo when available.
- ✅ Missing logos degrade to the colored initials tile (no broken-image icons).
- ✅ Logo treatment is visually consistent — same rounded shape, same fallback, same size scale across tables/cards/headers.
- ✅ Crypto pairs (e.g. `BTC/USD`) skip the CDN lookup and go straight to the initials tile.

### Scope

The existing `StockLogo` component should become the standard symbol identity treatment across the application.

Add symbol logos to:

- dashboard ticker cards,
- dashboard open positions,
- recent trades,
- market symbol header,
- watchlist rows,
- symbol search/autocomplete results,
- positions table desktop rows,
- trades table desktop rows,
- signals table,
- universe scanner rows,
- AI decision rows,
- news symbol chips where useful.

### Deliverables

- Shared `SymbolIdentity` or equivalent composition if needed.
- Logo plus symbol plus optional company/name metadata pattern.
- Fallback initials tile for missing logos.
- Crypto-safe fallback behavior.

### Acceptance Criteria

- Any visible stock symbol in a primary trading surface has a logo when available.
- Missing logos degrade cleanly without broken image icons.
- Logo usage is visually consistent across tables, cards, and headers.

## Phase 3: Professional Trading Dashboard

### Scope

Redesign the home dashboard into a trading cockpit instead of a stacked report page.

Recommended desktop layout:

- Top account band:
  - portfolio value,
  - day P&L,
  - buying power,
  - open positions,
  - market status,
  - paper/live mode.
- Market strip:
  - SPY,
  - QQQ,
  - IWM,
  - DIA,
  - optional volatility or sector indicator.
- Main content:
  - compact chart or selected symbol preview,
  - active watchlist,
  - open positions,
  - quick trade ticket,
  - AI trade recommendations.
- Bottom/docked content:
  - recent fills,
  - alerts,
  - scanner/agent activity.

Move low-frequency panels such as LLM costs, cycle diagnostics, broad news, sector rotation, and sentiment into tabs, drawers, or collapsed utility panels.

### Deliverables

- New dense dashboard layout.
- Compact market ticker strip.
- Open positions and recent trades shown above lower-priority diagnostic content.
- Quick trade panel integrated into the main workspace.

### Acceptance Criteria

- A trader can see account state, market state, open risk, and trade actions without scrolling on desktop.
- Secondary operational panels no longer dominate the first screen.
- The dashboard feels like a live trading workspace.

## Phase 4: Market And Chart Trade Station

### Scope

Make `/market` the primary trade station.

Enhance the view with:

- symbol logo,
- symbol,
- company name when available,
- latest price,
- day change,
- bid/ask/spread,
- volume,
- day range,
- selected timeframe,
- chart overlay controls,
- position summary for the selected symbol,
- order ticket,
- symbol-specific news,
- AI thesis or signal summary.

Improve the chart area:

- maximize available space,
- reduce surrounding padding,
- keep controls close to the chart,
- preserve VWAP and volume profile controls,
- make timeframe controls compact and clear.

### Deliverables

- Redesigned symbol header.
- Dense chart layout.
- Right-side trading rail with order ticket, stats, position, and news.
- Better responsive behavior for mobile.

### Acceptance Criteria

- Chart, order ticket, and selected-symbol context are visible together on desktop.
- Symbol identity includes logo and high-value market stats.
- Order placement feels like part of the trade station, not a side widget.

## Phase 5: Positions And Trades Blotter

### Scope

Upgrade portfolio and trade history into professional trading tables.

Positions should include:

- logo,
- symbol,
- side,
- quantity,
- average entry,
- current price,
- market value,
- day P&L,
- total P&L,
- stop/target if available,
- risk status,
- close/action controls.

Trades should include:

- logo,
- symbol,
- side/status,
- quantity,
- entry,
- exit,
- realized P&L,
- percent return,
- strategy or agent,
- exit reason,
- timestamp,
- drawer for details.

### Deliverables

- Dense desktop positions table.
- Dense desktop trades blotter.
- Improved mobile cards.
- Sticky filter bars where appropriate.
- Better empty/loading/error states.

### Acceptance Criteria

- Positions and trades can be scanned quickly without excess vertical space.
- Logo treatment is present in both desktop and mobile views.
- Important financial values are aligned and formatted consistently.

## Phase 6: Watchlists And Symbol Discovery

### Scope

Create a professional watchlist experience to support day trading.

Recommended watchlist groups:

- Favorites,
- Momentum,
- AI Picks,
- Open Positions,
- Recently Traded,
- Crypto,
- Options candidates.

Watchlist rows should include:

- logo,
- symbol,
- price,
- day change,
- volume or relative volume,
- signal/rating,
- quick open chart action,
- quick trade action.

### Deliverables

- Watchlist panel or page with grouped lists.
- Compact row design.
- Symbol search integration.
- Ability to navigate quickly to `/market?symbol=...`.

### Acceptance Criteria

- Traders can move from symbol discovery to chart/trade flow in one click.
- Watchlists use logos and dense financial row formatting.
- The layout supports repeated daily use.

## Phase 7: AI Signals And Risk UX

### Scope

Make AI and risk features feel like trading assistance, not backend logs.

Improve:

- AI recommendations,
- agent status,
- decision reasoning,
- confidence,
- risk warnings,
- skipped trade explanations,
- execution readiness.

Recommended presentation:

- signal cards or rows with symbol logo,
- BUY/SELL/HOLD badge,
- confidence,
- risk score,
- expected setup,
- invalidation level,
- recommended sizing,
- link to chart/order ticket.

### Deliverables

- Professional signal rows.
- Clear AI decision hierarchy.
- Better separation between trader-facing insight and operational diagnostics.

### Acceptance Criteria

- AI guidance is actionable and visually connected to symbols and trade actions.
- Operational details are still accessible but no longer crowd the main workspace.
- Risk warnings are visible before order submission.

## Phase 8: Order Ticket Upgrade

### Scope

Upgrade manual ordering into a full professional order ticket.

Support:

- buy/sell segmented control,
- market,
- limit,
- stop,
- stop-limit,
- quantity,
- dollar amount,
- estimated cost,
- buying power impact,
- smart order router toggle,
- stop loss,
- take profit,
- review/confirm state,
- paper/live mode visibility.

For options:

- contract quantity,
- premium,
- multiplier,
- estimated notional,
- expiration,
- strike,
- call/put display,
- Greeks where available.

### Deliverables

- Shared order ticket component if possible.
- Consistent order ticket usage on dashboard and market pages.
- Safer confirmation and error states.

### Acceptance Criteria

- Order controls feel complete enough for a serious day trader.
- Estimated impact is visible before submit.
- Paper/live context is always obvious.

## Phase 9: Responsive And Accessibility Polish

### Scope

Ensure the professional experience works across desktop and mobile.

Focus areas:

- desktop density,
- tablet layout,
- mobile card ergonomics,
- touch targets,
- readable financial values,
- no overlapping text,
- no clipped buttons,
- keyboard navigation,
- focus states,
- color contrast.

### Deliverables

- Desktop and mobile layout QA.
- Screenshot review at common breakpoints.
- Fixes for overflow and text wrapping.

### Acceptance Criteria

- No major screen has overlapping or clipped UI.
- Financial values remain readable on mobile.
- Main trading flows remain usable without desktop-only assumptions.

## Suggested Implementation Order

1. Foundation and visual cleanup.
2. Stock logo standardization.
3. Dashboard trading cockpit.
4. Market/chart trade station.
5. Positions and trades blotter.
6. Watchlists and symbol discovery.
7. AI signals and risk UX.
8. Order ticket upgrade.
9. Responsive polish and screenshot QA.

## Key Files To Review During Implementation

- `trader-ui/src/App.jsx`
- `trader-ui/src/index.css`
- `trader-ui/src/components/layout/Sidebar.jsx`
- `trader-ui/src/components/layout/TopBar.jsx`
- `trader-ui/src/components/shared/StockLogo.jsx`
- `trader-ui/src/views/DashboardView.jsx`
- `trader-ui/src/views/MarketView.jsx`
- `trader-ui/src/views/PositionsView.jsx`
- `trader-ui/src/views/TradesView.jsx`
- `trader-ui/src/views/SignalsView.jsx`
- `trader-ui/src/views/UniverseView.jsx`
- `trader-ui/src/components/positions/PositionsTable.jsx`
- `trader-ui/src/components/trades/TradesTable.jsx`

## Definition Of Done

The UI redesign is complete when a trader can open the app and immediately understand:

- account value,
- day performance,
- buying power,
- market status,
- open positions,
- active risk,
- best current opportunities,
- selected-symbol chart context,
- how to place or manage an order.

The final product should feel dense, confident, polished, and practical for repeated day-trading use.
