# Trader Academy

A practical guide to operating the ClearEdge Alpaca trading bot. Written for the operator and any future teammate who needs to run, tune, or extend the system.

---

## How to use this guide

Read in order if you're new. Skim by chapter once you've operated the bot for a week. Each top-level chapter (`##` heading) is self-contained — fine to split into its own wiki page once you stand up the Academy portal.

Three reading paths:

- **Just shipped this — what does it do?** → Chapters 1–4. Stop after the first cycle runs cleanly on paper.
- **Operating day-to-day** → Chapters 5–9 (the screens) + 14 (troubleshooting).
- **Taking it toward real money** → Chapter 4 plus the full Part 4 (Phases 1–8). Don't skip Phase 6.

Conventions used throughout:

- **Bold** = a UI element you'll click or read.
- `monospace` = a config key, flag, or shell command.
- "Operator" = you (or whoever is running the bot today).
- "Live capital" = real money. Until Phase 7, everything is paper.

---

# Part 1 — Foundations

## 1. What this bot does

The ClearEdge Alpaca bot is an automated trading system that scans US equities, ETFs, options, and crypto every five minutes during market hours, decides whether to enter or exit positions, and places orders through Alpaca's paper or live brokerage. It runs unattended.

What makes it different from a basic rule-based bot:

- **Multi-agent decision-making.** Nine specialized agents (rule-based + LLM-assisted) each produce a per-cycle report. An orchestrator synthesizes them into a final buy / sell / hold per symbol with a confidence score. Only decisions above the confidence floor are acted on.
- **Risk discipline built in.** Per-trade stop and target, portfolio heat cap, sector concentration cap, correlation guard, gap-risk handler at open, halt detection, broker-outage state machine, and a daily-drawdown cutoff that pauses the system.
- **Two strategy pools.** *Equity hybrid* (the default — EMA crossover + RSI + volume + ATR-scaled stops) and *Momentum Hunter* (a separate pool for parabolic runners with its own risk model and time-based exit). Options trading is a third pool gated behind its own toggle.
- **Path-to-live program.** A staged plan (Chapters 16–24) that takes the system from "paper trading with all agents on" to "live capital with measured edge."

What this bot deliberately does not do:

- High-frequency or sub-minute trading (5-minute bars are the finest grain).
- Discretionary intervention while a cycle is running (the operator tunes config, not individual decisions).
- Auto-tune of its own parameters (no reinforcement learning).
- Multi-broker execution (Alpaca only).

---

## 2. How a trading cycle works

The bot runs three recurring workflows scheduled by `setInterval` in `src/index.js`. All three are gated to market hours (9:35 AM – 3:50 PM ET, Mon–Fri) for equities; crypto trades 24/7.

```
                     ┌───────────────────────────────┐
                     │  Every 5 minutes (market open)│
                     └────────────────┬──────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
   ┌──────────┐                ┌─────────────┐               ┌───────────┐
   │ Scanner  │                │ Orchestrator│               │  Monitor  │
   │          │                │    cycle    │               │           │
   │ Pulls    │                │             │               │ Checks    │
   │ 5-min    │ ─signals──▶    │ 9 agents    │ ─decisions─▶  │ open      │
   │ bars,    │                │ produce     │               │ positions │
   │ writes   │                │ reports,    │               │ vs stop/  │
   │ signals  │                │ orchestrator│               │ target,   │
   └──────────┘                │ synthesizes │               │ closes    │
                               └─────────────┘               │ when hit  │
                                      │                      └───────────┘
                                      ▼
                               ┌────────────┐
                               │  Executor  │
                               │            │
                               │ Sizes the  │
                               │ position,  │
                               │ places the │
                               │ Alpaca     │
                               │ order      │
                               └────────────┘
```

**Scanner.** Pulls 5-minute bars from Alpaca for every watchlist symbol. Computes EMA9 / EMA21 / RSI14 / volume ratio. Persists any BUY or SELL signal to the `signals` table. The scanner is pure rules — no LLM cost.

**Orchestrator cycle.** Fires immediately after the scanner. Each of the nine agents (see Chapter 3) produces a report based on the same shared context. The orchestrator collects them, optionally runs an inter-agent debate when agents disagree, then synthesizes a final decision per symbol. Decisions ship to the executor.

**Executor.** Sizes each accepted decision (default 2% of portfolio risk, ATR-scaled stop, reward-ratio target), places the market or limit order via Alpaca, records the trade. Only one open position per symbol allowed.

**Monitor.** Independent loop on a 5-minute interval. Reads every open position from Alpaca, compares current price to the stored stop / target / trailing stop. Closes positions that hit stop or target, updates `daily_performance`. Also tracks max-adverse and max-favorable excursion per trade so the Trade Retro card can show stop-placement quality.

A few things that gate the cycle:

- **Market-hours check** (`isMarketOpen()` in `src/index.js`) — outside the window, the scanner and monitor skip. Crypto bypass this.
- **Broker-outage state machine** — three Alpaca API failures > 30 s apart trips the breaker; new entries pause until recovery + 60 s grace.
- **Cycle guard** — when consecutive cycles agree on nothing (all agents HOLD on the same hash of input), the orchestrator skips the expensive Sonnet call and reuses the prior decision.
- **LLM cost cap + circuit breaker** — daily $ cap (default $5), token cap (10 M), failure threshold (3 consecutive). Any of these tripping puts agents into rules-only fallback for the rest of the day.

---

## 3. The agents — who they are, what they do

Nine agents in total. Each has a nickname used throughout the UI. You don't need to know what's inside each one to operate the bot, but knowing what they look at and what they emit makes the Decisions log readable.

| Nickname | Role | What it sees | What it emits | LLM? |
|---|---|---|---|---|
| **Scout** | Market Screener | Alpaca most-active + top-gainers / losers lists | A ranked watchlist for the cycle | Optional rerank (LLM, default off) |
| **Atlas** | Market Regime | SPY / QQQ daily DMA + volatility proxy | `regime` ∈ {trending_bull, trending_bear, range_bound, high_vol, recovery} | No |
| **Vega** | Risk Manager | Portfolio heat, sector exposure, correlation, daily loss | Veto, size scale-down, or pass | Mostly rule-based, optional LLM polish |
| **Quant** | Technical Analyst | Multi-timeframe (5m / 15m / 1h / daily) EMA, RSI, MACD, BB, VWAP, S/R | Per-symbol verdict {BUY / SELL / HOLD, confidence, patterns, key levels} | Yes (batched, default on) |
| **Herald** | News Sentinel | Alpaca + Polygon + Reddit news for the symbol | Sentiment + critical-alert flag (earnings miss, downgrade, fraud, FDA reject, bankruptcy) | Optional LLM (default off — keyword detector is the veto path) |
| **Rupture** | Breakout Agent | Same MTF data as Quant, looking for resistance breaks on volume | BUY signal when a clean breakout fires | LLM (default off, Phase 0 cut) |
| **Bounce** | Mean-Reversion Agent | Same MTF data, looking for BB / RSI extremes pulling back | BUY signal at the reversion turn | LLM (default off, Phase 0 cut) |
| **Momentum Hunter** | Parabolic Runner Pool | Pre-screened high-gap, high-volume names | BUY decisions sized at 0.5% risk, 5% stop, 30-min time-exit | No (100% rule-based) |
| **Nexus** | Orchestrator | All agent reports + the inter-agent debate transcript | Final decision per symbol {action, confidence, reasoning} | Yes (Haiku for unanimous, Sonnet on dissent — gated by `ORCHESTRATOR_DEBATE_ENABLED`) |
| **Striker** | Execution Agent | Nexus's decisions + a snapshot of current portfolio + risk state | Order placed, or skip with reason | No |

Two things worth understanding about how the agents interact:

**The synthesis gate.** Nexus runs only when at least one agent emits a non-HOLD signal. If every agent says HOLD, the orchestrator short-circuits — no LLM cost, no decision. The Dashboard's "Why no trades?" card surfaces when this happens cycle after cycle.

**The debate phase.** When two or more agents disagree (one BUY, one SELL), each dissenter writes one challenge sentence; the majority writes one response. That transcript is included in Nexus's prompt. The cost is ~2 extra Haiku calls per disagreement; the value is that the synthesis prompt has the actual counterarguments instead of just the conclusion. Gated by `ORCHESTRATOR_DEBATE_ENABLED` — flip it off in Phase 4 block 4b.

---

# Part 2 — Operating the bot

## 4. Quick start — from boot to first paper trade in 10 minutes

Prerequisites:

- Alpaca paper account ([alpaca.markets](https://alpaca.markets) → free)
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com))
- PostgreSQL (Supabase free tier is fine)
- Node 18+

Steps:

1. **Configure `.env`** at repo root:
   ```bash
   ALPACA_KEY=<paper key>
   ALPACA_SECRET=<paper secret>
   ALPACA_BASE_URL=https://paper-api.alpaca.markets
   ANTHROPIC_API_KEY=<your key>
   DATABASE_URL=<your postgres URL>
   USE_AGENCY=true               # enables the multi-agent flow
   PORT=3001
   ```

2. **Install + boot.**
   ```bash
   npm install
   cd trader-ui && npm install && npm run build && cd ..
   npm start                     # API + scheduler on :3001 (UI served from /dist)
   # OR for development:
   npm run dev                   # backend with nodemon
   cd trader-ui && npm run dev   # UI hot-reload on :5173, proxies /api
   ```

3. **Open the Dashboard.** http://localhost:3001 (or :5173 if you ran the Vite dev server).

4. **Confirm health.** Top band reads `MARKET CLOSED` or `MARKET OPEN`; **PAPER** badge sits in the lower-left sidebar. The LLM-status banner should be absent (not throttled).

5. **Wait for the first cycle.** Within 5 minutes of market open you'll see entries appear in the Activity tab of the Diagnostics panel. If `0 decisions` keeps repeating, jump to Chapter 14 — "Why no trades?".

6. **First manual trade (optional).** In the **Quick Trade** card on the right, type `AAPL`, set Quantity = `1`, click BUY. Confirm. Watch the order appear under **Open Positions**.

That's it — the bot is operational. The rest of this guide walks through each surface in detail.

---

## 5. The Dashboard

The Dashboard is the operator's home screen. Cards are color-coded so the eye chunks them at a glance: blue = data / info, green = action, amber = analysis or history.

### Top band — six cells

| Cell | What it shows | When it matters |
|---|---|---|
| **Portfolio** | Total account value (equity + cash) | The number you grow |
| **Today** | $ and % change since prior close | Daily P&L pulse |
| **Buying Power** | Cash available for new positions (× 2 for margin accounts) | When sizing manually |
| **Open** | Count of open positions | Should match Alpaca account view |
| **Market** | Open / Closed + countdown to next open or close | Decides whether cycles run |
| **Mode** | PAPER (amber) or LIVE (red) | Sanity check before clicking buttons |

The thin top stripe on the band is dynamic: green when up, red when down, blue when flat.

### Market strip — SPY · QQQ · IWM · DIA

Four index tickers with a live websocket overlay (small green pulse dot when the websocket is delivering). Price flash-animates green or red on tick.

### Cockpit grid — left column

**Open Positions** (blue header). The list you act on most. See Chapter 7 for the full positions screen. Click any row to jump to that symbol's market view. The little "view all →" link sends you to the dedicated positions screen.

**Recent Trades** (amber header). Last 8 closed trades with P&L. Click "view all →" for the full trade history with filters.

### Cockpit grid — right column (sticky on desktop)

**Quick Trade** (green header). One-click BUY / SELL — see Chapter 6.

**Trade Retro** (amber header). The analysis surface. See Chapter 8.

**Option Activity** (blue header). Surfaces open option Greeks + today's flow. Hidden when options are off and there are no historical option trades.

### Diagnostics panel — tabbed at the bottom

Four tabs:

- **Why no trades?** (amber) — Cycle log + skip-reason histogram. Most important diagnostic surface.
- **LLM Cost** (blue) — Daily spend, cache hit rate, retries, per-agent breakdown.
- **Activity** (amber) — Live event feed (orders, fills, cancels, errors).
- **News · Sectors · Sentiment** (mixed) — Market context that the agents are also seeing.

Open the Diagnostics tab strip when something looks off — it's where root causes surface.

---

## 6. Quick Trade

The right-column card on the Dashboard. Built for one-off manual orders, not for tuning the bot.

**Equity flow:**

1. Type a symbol in the autocomplete (debounced search hits the Alpaca asset list).
2. Set Quantity (whole shares for equities, 6 decimals for crypto).
3. SOR checkbox is on by default — Smart Order Routing places a limit at the inside of the spread with a market-fallback if it doesn't fill in 30 s. Uncheck to send a plain market order.
4. **BUY** or **SELL** — confirmation dialog shows the order shape, click again to send.

**Advanced section** (click "Advanced" to expand):

- **Type** — Market or Limit. Limit needs a price.
- **Stop loss** + **Take profit** — together they create a bracket order (BUY only). Both required, or both empty. Equities only — paper options don't accept brackets.

**Option flow:**

Type an OCC symbol (e.g. `AAPL250620C00200000`) or paste from the options chain. The card flips to option mode automatically:

- The symbol line shows the plain-English label ("AAPL Jun 20 2025 $200 Call").
- DTE (days to expiry) chip: red ≤ 1 day, amber ≤ 7 days, gray otherwise.
- A risk panel shows: max loss = premium × contracts × 100, breakeven = strike + premium (calls) or strike − premium (puts), underlying price if known.
- Quantity is in contracts (always whole numbers).
- Brackets aren't accepted by paper Alpaca on options; the card hides those fields.

**Sanity warnings the bot won't let you bypass without a confirm:**

- Sub-$1 stocks (default `MIN_PRICE = 3.0` blocks new BUYs)
- Options within 7 days of expiry (when `THETA_DECAY_DAYS_THRESHOLD = 7`)
- Anything that would push portfolio heat over `MAX_DRAWDOWN_PCT`

When the bot rejects a Quick Trade, the error appears below the buttons. The most common rejection is "execution-min-confidence-failed" on a paper-mode chat order — see the floors in Chapter 11.

---

## 7. Reading the Positions screen

The full Positions screen lives at `/positions` (sidebar → Portfolio → Positions). Nine columns:

| Column | What it shows |
|---|---|
| **Symbol** | Logo, ticker, and (for options) a small `C200` / `P150` chip plus the plain-English label below |
| **Qty** | Side glyph (▲ green long, ▼ red short) + number of shares or contracts |
| **Entry → Now** | Average entry price → current price + a delta % chip (green if up, red if down) |
| **Market Value** | Position size at current price |
| **Day** | Today's $ change stacked over % — both color-coded |
| **Total P&L** | All-time unrealized $ over %, the biggest visual in the row |
| **Stop · Target** | Stop price (red) and target price (green), with a mini-bar beneath showing where current sits between them |
| **Risk** | Status pill — `SAFE` (green, >30% headroom to stop), `WATCH` (amber, 10–30%), `AT RISK` (red, <10%), `STOPPED` (red, current below stop) |
| (close) | One-click close-position button |

**How to read the mini-bar:**

```
$420  [●─────────────────]  $478
 stop                       target
```

The red end is the stop, the green end is the target, the white dot is the current price's position between them. If the dot is hugging the left, the trade is bleeding toward the stop. If it's past the right end, you're sitting above target — review whether the target should be moved up.

**Sorting:**

Click any column header. Numeric columns open big-first, alphabetic columns open A-Z. Click again to reverse. The active column shows `▼` or `▲` in blue.

Default sort is **Risk** descending. That surfaces `STOPPED` rows first, then `AT RISK`, then `WATCH`, then `SAFE`. Within a risk bucket, the biggest dollar losers come first — so the position needing attention is always at the top. Your sort choice persists to `localStorage`; refresh keeps it.

**Footer total row.** Shows position count, aggregate market value, aggregate day P&L, aggregate total unrealized P&L. Useful when the list is long and you want one summary number.

---

## 8. Reading the Trade Retro card

The Trade Retro card on the Dashboard is where you'd answer "what's been working, what's been losing, and where do I tighten up?" It reads from `/api/analytics/attribution` — slices closed trades by multiple dimensions and runs a small rule set to surface findings.

**Window selector.** Top right of the card — `7d / 30d / 90d`. The bot uses 30 days by default; switch to 90 when the recent sample is too small.

**Findings list.** Each finding is one of three severities:

- 🟢 **Green** — validation. "Friday wins 62% over 14 trades, net +$340 — your best weekday."
- 🟡 **Amber** — watch. "Mondays avg −$80/trade vs Fridays +$45/trade — consider a Monday gate."
- 🔴 **Red** — losing. "Exit reason 'trailing_stop' wins 28% over 18 trades, net −$420 — trailing is firing too early in this regime."

Findings rank red → amber → green; within a tier by P&L impact. The card hides any finding based on fewer than 8 trades to avoid coin-flip noise. Click "show numbers" on a row to see n / wins / losses / $.

**Per-strategy MAE / MFE table** (bottom of the card):

| Pool | n | MAE | MFE | Capture % |
|---|---|---|---|---|
| equity | 24 | -3.1% | +5.4% | 62% |
| momentum | 18 | -4.8% | +12.1% | 31% |

- **MAE** (max adverse excursion) — biggest drawdown observed inside the trade. Compare to your stop %: if MAE averages 8% but your stop fires at 3%, the stop is too tight — most trades hit it before they had a chance.
- **MFE** (max favorable excursion) — biggest unrealized gain observed inside the trade. If MFE is +12% but the trade closed at +4%, you exited at the reversal trough.
- **Capture %** — realized P&L ÷ MFE. Green ≥ 70% (letting winners run), amber 40–69%, red < 40% (giving back most of the move).

**The slices the card uses:**

| Slice | What to read it for |
|---|---|
| `byExitReason` | Are trailing stops firing too early? Is `orchestrator_sell` overruling the bracket? |
| `byDayOfWeek` | Do certain days lose consistently? |
| `byHoldDuration` | Intraday vs swing — which holds your edge? |
| `byRegime` | Which regime kills you (Atlas's regime label at entry) |
| `byTimeOfDay` | Open-volatility vs midday drift vs close — where's the edge concentrated? |
| `bySymbol` | Repeat offenders — drop them from the watchlist |
| `byStrategy` | Equity hybrid vs momentum — which pool is paying? |

The findings + the MAE/MFE table together are your honest per-bucket attribution. They become the primary measurement surface during Phase 3 (rules-only baseline) and Phase 4 (ablation).

---

## 9. The Diagnostics panel

Four tabs at the bottom of the Dashboard.

### Why no trades?

Headline diagnosis updates every 20 seconds. Possible states:

- "*N* orders placed in last *M* cycles" (green) — system is trading.
- "*N* decisions made but all skipped at execution" (amber) — Nexus produced decisions, Striker filtered them. Expand the card and read the skip-reason histogram.
- "*N* decisions dropped — confidence < 70%" (red) — agents are returning low conviction. Either market is genuinely flat or `ORCHESTRATOR_MIN_CONFIDENCE` is set higher than the agents can hit.
- "Synthesis short-circuited — agents are all HOLD" (red) — no agent is signaling. Look at the last-cycle agent signals row to see which agents returned BUY / SELL / HOLD.
- "*N* cycles ran but produced zero decisions" (red) — catch-all when none of the above matches. Read the recent event log.

The expanded view shows:
- Cycle / decision / executed counts.
- Skip-reason histogram (which gate is firing most: `confidence_below_floor`, `position_already_open`, `risk_veto`, `regime_block`, `news_critical_alert`, etc.).
- Last 30 cycle events (chronological).

### LLM Cost

Six metrics at a glance:

- **Cost** — $ spent today vs daily cap. Color: green < 50%, amber 50–80%, red > 80%.
- **Calls** — total LLM call count today (+ token total).
- **Cache** — prompt cache hit rate. Healthy ≥ 60%. Red `OFF` means the system preamble fell below the model's cache threshold (~2K tokens) — a quiet regression that 10× the bill.
- **Retries** — `success/failure` count of malformed-JSON retries. Failures > 5 = a prompt is breaking.
- **Skipped** — count of cycles the cycle guard skipped (context unchanged → cheap reuse).
- **Up** — uptime since boot.

Expand to see per-agent cost: which agent is eating the budget, with retry counts and the last error message per agent (so a quiet regression in one agent's prompt surfaces immediately).

### Activity

Live event feed via websocket. Shows orders placed, fills, partial fills, cancels, rejections, and errors as they happen. Useful while a cycle is running and you want to see what's actually hitting the wire.

### News · Sectors · Sentiment

- **Market News** (left) — Alpaca News feed, 12 articles, headlines + thumbnails + symbol chips. What Herald is also reading.
- **Sector Rotation** (right) — Leaders / laggards over the lookback window (5d default). Helps explain why a sector-correlated batch of positions is moving in lockstep.
- **Sentiment Shifts** (bottom) — Symbols whose news-sentiment delta exceeded a threshold in the lookback window. Inflection alerts — sometimes a leading indicator before price moves.

---

# Part 3 — Configuration

## 10. Settings — what each section does

The Settings screen (sidebar → Settings) is divided into sections. Each section corresponds to a runtime-config domain that can be hot-reloaded (no restart needed). Every numeric or boolean override gets a small **CUSTOM** badge in the UI; click **Reset** to clear the override and fall back to the code default.

| Section | Owns | When to touch |
|---|---|---|
| Watchlist | Symbols the scanner watches | Change in/out as your universe evolves |
| Signal Tuning | Confidence floors, scan interval | When too few or too many trades fire |
| Risk Parameters | Stop %, target %, max position, risk per trade, drawdown cap | When stop/target sizing is wrong for current vol |
| Strategy | Equity hybrid vs other modes per symbol | Per-symbol strategy overrides |
| Agent Toggles (v2 Phase 0) | Rupture / Bounce / Scout LLM / Herald LLM ON/OFF | Cost cuts — see Chapter 11 |
| Phase 3 — Rules-Only Baseline | The two Phase 3 gates (Quant LLM + Orchestrator LLM) | Start the Phase 3 measurement window |
| Phase 4 — Ablation Cockpit | Block start/end + per-block EV/trade | Run the Phase 4 ablation sequence |
| Momentum Hunter | Gap %, min volume, stop %, time-exit min, target % | Tune the parabolic-runner pool |
| Cost Controls | Daily $ cap, daily token cap, circuit breaker threshold | Throttle LLM spend |
| Options Trading | OPTIONS_ENABLED + delta exposure cap + DTE block | Toggle options + set caps |
| Alerts | Slack / Telegram destinations + digest schedule | Where alerts go |
| Datasources | Polygon enrichment status + toggle | Enable Polygon for sector + sentiment |
| Cycle Guard | The orchestrator-skip optimizer | When you suspect skipping is masking trades |
| Strategy Import / Export | Backup + restore the strategy config blob | Migration / disaster recovery |

The pattern across every section: read the current effective value, edit in place, click Save → the value writes to `runtime_config` and is picked up by the next cycle (30 s refresh). A **CUSTOM** badge means the value is an override; a **Reset** button restores the code default.

---

## 11. Risk parameters in detail

These are the levers that decide how much capital each trade risks, and when the system stops trading altogether.

| Key | Default | What it controls |
|---|---|---|
| `RISK_PCT` | 0.02 | % of portfolio risked per trade. With $100K and 2%, max loss per trade is $2K. |
| `STOP_PCT` | 0.035 | Default stop distance (3.5%). ATR scaling can override per-symbol. |
| `TARGET_PCT` | 0.10 | Default target distance (10%). Implies ~3:1 reward:risk. |
| `MAX_POS_PCT` | 0.10 | Max % of portfolio in any single position. Caps notional regardless of risk. |
| `ATR_STOP_MULT` | 2.0 | Stop = entry − (daily ATR × this). Replaces flat `STOP_PCT` when ATR data is available. |
| `ATR_STOP_MIN_PCT` | 0.02 | Floor on ATR stop — never tighter than 2%. |
| `ATR_STOP_MAX_PCT` | 0.08 | Cap on ATR stop — never wider than 8%. |
| `REWARD_RATIO` | 2.0 | Target distance = stop distance × this. |
| `TRAILING_ATR_MULT` | 2.5 | Trailing stop = price − (daily ATR × this). |
| `TRAILING_MIN_PCT` | 0.02 | Floor on trailing distance — never less than 2% below the running high. |
| `PARTIAL_EXIT_PCT` | 0.5 | Fraction sold when partial exit triggers. |
| `PARTIAL_EXIT_TRIGGER` | 0.5 | Triggers partial exit when this % of target is hit. |
| `MAX_DRAWDOWN_PCT` | 0.10 | Daily drawdown cutoff — system pauses for the day when hit. |
| `CORRELATION_THRESHOLD` | 0.85 | Vega vetoes a new BUY when 60-day correlation with existing holdings exceeds this. |

And the confidence floors, which sit above the agents:

| Key | Default | What it does |
|---|---|---|
| `ORCHESTRATOR_MIN_CONFIDENCE` | 0.70 | Decisions below this don't ship. Reverted from a 0.55 experiment that halved the win rate. **Don't drop below 0.65 without fresh data.** |
| `EXECUTION_MIN_CONFIDENCE` | 0.60 | Independent floor at Striker. Catches manual / chat / fallback decisions that bypass the orchestrator floor. |

**Tuning intuition.** The right way to find the right floor is *not* "drop it until you see trades." It's "look at the Trade Retro per-confidence-bucket P&L, find the floor where EV/trade goes positive, and put the floor just above that." If the bot isn't trading, the answer is usually "agents are returning low conviction because the market is flat" — not "lower the floor."

---

## 12. Strategy pools — Equity Hybrid vs Momentum Hunter

The bot runs two parallel strategy pools. Each has its own risk model.

### Equity Hybrid (the default)

- **Signal source:** Quant (multi-timeframe EMA crossover + RSI + volume confirmation + ATR-scaled stop) + the rest of the agency.
- **Stop:** ATR-scaled, floor 2%, cap 8%. Recalculates if ATR data is missing.
- **Target:** Stop distance × `REWARD_RATIO` (default 2:1).
- **Risk per trade:** `RISK_PCT` (default 2%) of portfolio.
- **Trailing stop:** Daily ATR × 2.5, minimum 2% below the running high.
- **Partial exit:** When 50% of the target distance is hit, sells 50% of the position.

### Momentum Hunter (separate pool, default OFF)

For stocks already up 30%+ on huge volume — the parabolic / runner names. Different risk model:

- **Entry filter:** `MOMENTUM_GAP_PCT` (default 17.5%) min |% change|, `MOMENTUM_MIN_VOLUME` (default 400K) min shares today, `MIN_PRICE` (default $3) floor.
- **Risk per trade:** `MOMENTUM_RISK_PCT` = 0.5% of portfolio (a quarter of equity hybrid).
- **Stop:** Flat 5% — wide. The real risk control is the time-exit.
- **Target:** 50%.
- **Time exit:** Sells after `MOMENTUM_TIME_EXIT_MIN` (30 min) if not up at least `MOMENTUM_MIN_GAIN_AT_EXIT` (20%).
- **Trailing:** Activates once up 10%, trails 6% below the running high.
- **Max concurrent positions:** `MOMENTUM_MAX_OPEN` (default 3).

The pool is OFF by default. Flip `MOMENTUM_HUNTER_ENABLED=true` in Settings → Momentum Hunter to turn it on. Has its own loss profile — high loss rate, occasionally huge winners — and is not for everyone.

---

## 13. LLM cost controls

The bot makes between $0.50 and $8/day in LLM calls in steady state. The controls:

| Key | Default | What it does |
|---|---|---|
| `LLM_DAILY_COST_CAP_USD` | 5.0 | Soft cap. Agents fall back to rules-only when hit. Resets at midnight UTC. |
| `LLM_DAILY_TOKEN_CAP` | 10,000,000 | Safety net. Cost cap is the real bound; this catches runaway loops. |
| `LLM_CIRCUIT_BREAKER_FAILURES` | 3 | Consecutive auth/model/network failures that trip the breaker. Banner appears with "Reset Breaker" button. |

**Where the money goes.** Quant is usually the biggest spender (one batched call per cycle covering 5–25 symbols at ~150 tokens each). Nexus is second (Haiku for unanimous-agent cycles, Sonnet on dissent). Herald is third when news-LLM is on. The LLM Cost card's expanded view shows the per-agent breakdown.

**Cost cuts shipped (v2 Phase 0):**

| Cut | Saves | When you'd reverse it |
|---|---|---|
| `BREAKOUT_AGENT_ENABLED=false` (Rupture off) | ~$1-2/day | When Trade Retro shows Quant is missing clean breakout patterns |
| `MEAN_REVERSION_AGENT_ENABLED=false` (Bounce off) | ~$1-2/day | When you start trading oversold reversion plays and need explicit grading |
| `SCREENER_LLM_RERANK_ENABLED=false` (Scout LLM off) | ~$1-2/day | When the screener consistently misses good entries that Quant catches |
| `NEWS_PER_CYCLE_LLM_ENABLED=false` (Herald LLM off) | ~$0.60/day | When you want LLM-graded sentiment beyond the keyword detector |

The four cuts together save $3-6.50/day. The keyword detector (`src/agents/news-keyword-alerts.js`) still vetoes trades on catastrophic news (earnings miss, downgrade, fraud, FDA reject, bankruptcy) even with Herald LLM off — the safety side of news doesn't depend on the spend.

---

## 14. Options trading (Phase 1 MVP)

Single-leg long calls and puts only. Multi-leg, short options, and option spreads are not in scope.

**Enabling.** Settings → Options Trading → flip `OPTIONS_ENABLED=true`. Defaults ship OFF so a fresh install doesn't accidentally trade options.

**The three guardrails:**

| Key | Default | What it does |
|---|---|---|
| `MAX_OPTION_RISK_PCT` | 0.01 | 1% of portfolio in premium per contract. Caps single-contract loss to 1%. |
| `MAX_DELTA_EXPOSURE_PCT` | 0.05 | 5% of portfolio in delta-adjusted notional across all options. Caps directional exposure. |
| `THETA_DECAY_DAYS_THRESHOLD` | 7 | Blocks new opens with ≤ 7 days to expiry. Theta decay accelerates past this. |

**Stop / target on options:** Premium-curve, not price-curve. Stop fires at 50% premium loss; target at 100% premium gain. Set in code; brackets aren't supported by paper Alpaca on options so the monitor enforces them in dollar terms.

**Reading an option position.** The Positions screen shows the OCC symbol + a plain-English label ("AAPL Jun 20 2025 $200 Call"). Stop / Target cells show "—" because options use the premium-curve gates, not price-curve. The Option Activity card aggregates: total Δ-notional, today's opens / closes, realized P&L on closed contracts.

---

# Part 4 — The v2 Path-to-Live Program

## 15. Why the program exists

The bot was originally built and shipped with all agents on by default. The brutal-review premise: until you've measured what each component contributes to EV / trade, you don't actually know whether you have edge — you have hopeful architecture.

The program turns "is this making money?" from a yes/no into a measurable, decomposable answer. Eight phases, sequential. Each one has explicit no-go criteria that stop the progression if they're not met. The discipline matters more than the code.

The order reflects severity:

1. **Safety before performance.** A bypassed stop on a halted stock kills a real account; backtest fidelity is annoying. Safety controls ship first.
2. **Measurement before ablation.** Without honest attribution, every "the LLM added 12% EV" claim is unfalsifiable.
3. **Strip then add, not selective-cut.** Builds confidence that the rule-based foundation actually exists before you start crediting LLM contributions.
4. **Calendar is calendar.** 200 trades is 200 trades. No code shipping during the 200-trade gate.
5. **Live transition gets paranoia.** Real money.
6. **Delete pass last.** Only after you know what was worth keeping.

The temptation when something feels stuck is to ship more code. The right move is to read the no-go criteria for the current phase and answer them honestly first.

---

## 16. Phase 1 — Safety prereqs

**Goal:** Make the bot safe enough that live-trading it isn't reckless. None of these are optional.

**Shipped:**

- **Halt detection.** Subscribes to Alpaca's halt status feed. Pauses any position in a halted symbol; refuses entry into a halted name. Status codes from the IEX feed (B/C/D/E/H/J/K/M/P = halt, Q/R/T/O = resume) drive an in-memory state machine in `src/halt-tracker.js`.
- **Gap-risk handling.** Before market open, the bot checks premarket % change for every open position. If gap > 1.5 × the configured stop distance, it logs `GAP-RISK` and exits at open instead of waiting for the 5-min monitor to catch a stop that already blew through. `GAP_EXIT_THRESHOLD_MULT` controls the multiplier.
- **Broker-outage state machine.** Detects Alpaca API down via three consecutive 5xx/network failures spaced > 30 s apart. Stops entering new positions; logs + alerts on open positions but does not panic-close. Resumes after API recovery + 60 s grace.
- **Risk-rule audit.** Integration tests against contrived fixtures confirm portfolio heat cap, sector concentration cap, correlation guard, and max-position-% all actually fire — not just exist as code.

**No-go criteria:** If any safety prereq can't be cleanly tested, do not advance. Phase 1 is the line under "responsibly trade real capital."

**Operator action:** Verify these surfaces are alive after deploy:
- `/api/halt-status` returns the halt-tracker's current state
- `/api/broker-health` returns the outage breaker's state
- Gap-risk runs at first cycle after 9:30 ET — appears in the cycle log as `GAP_CHECK_RAN`

---

## 17. Phase 2 — Measurement prereqs

**Goal:** Have honest attribution before measuring anything else.

**Shipped:**

- **MAE / MFE attribution.** Schema migration `015_mae_mfe_columns.sql` adds `mae_pct` + `mfe_pct` to trades. The monitor populates them every cycle. The Trade Retro card's per-strategy table reads them as the stop-placement health signal.
- **Trade attribution dimensions.** The `/api/analytics/attribution` endpoint slices closed trades by regime, time-of-day, day-of-week, hold-duration, exit-reason, strategy pool, sector, and symbol. The Trade Retro card surfaces actionable findings from each slice with sample-size discipline (n ≥ 8 floor).
- **Runtime-config drift reconciliation.** Migration 016 deleted 8 DB overrides that had been silently masking config.js defaults since April. Code defaults realigned to production reality. Future "default change" PRs will now actually take effect.

**The backtest fidelity audit — what we learned:** The original Phase 2 included a backtest-fidelity gate ("predicts live within 15% over 200 trades"). Four iterations of fixes (modeling momentum_time_exit, switching to 5-min intraday bars, bounding the sim window, filtering modelable exits, changing the stop check from bar.l to bar.c) produced *worse* median error, not better — 78.7% → 88.6%. Root cause is structural: a bar-OHLC simulator cannot replicate per-cycle polling on intraday strategies, where stop/target ordering inside a bar is fundamentally ambiguous.

**Resolution:** The bar-based backtest is retired as a path-to-live gate. The replacement is **live-paper agreement** measured at Phase 7's 25-trade and 50-trade milestones. MAE/MFE + the retro card's per-bucket realized-edge picture are the sizing inputs in the meantime.

**Operator action:** Phase 2 is done. Use the Trade Retro card daily. When something looks wrong, the per-bucket numbers are where root causes show up.

---

## 18. Phase 3 — Rules-only baseline

**Goal:** Establish what the bot earns with no LLM call sites on the trading path. If the rules-only baseline isn't profitable, the LLMs were masking the absence of a rule-based foundation — and there's no point in adding them back.

**Shipped (code):** Two new flags in Settings → Phase 3 — Rules-Only Baseline:

- `TECHNICAL_LLM_ENABLED` — when OFF, Quant skips its batched Haiku call. Every symbol's signal comes from `indicators.detectSignal` directly (rule-based EMA + RSI + volume).
- `ORCHESTRATOR_LLM_ENABLED` — when OFF, Nexus skips its Haiku/Sonnet synthesis. Decisions come from `_fallbackDecisions` — MTF-aligned BUYs at 0.8× confidence and 0.8× size.

Both default ON (a fresh install doesn't accidentally enter baseline mode).

**Operator action:**

1. Open Settings → Phase 3 — Rules-Only Baseline.
2. Click **Start baseline — flip both OFF**. The header now reads **BASELINE ACTIVE** in amber.
3. Open the Phase 4 Cockpit (next chapter) and start a block labeled "baseline" — this stamps the timestamp so closed trades during this window will attribute to the baseline window.
4. Leave the system alone for 7–10 days. Resist tuning.
5. End condition: ≥ 20 closed trades.

**No-go criteria:**

- 7–10 day EV/trade < 0 with > 20 closed trades → **strategy lacks base edge**. Stop. Re-evaluate the setups themselves. Don't proceed to Phase 4 thinking the LLMs will fix it.
- < 5 closed trades in 10 days → rules are too restrictive. Loosen rule thresholds before Phase 4, or accept that the strategy never trades.

**Reading the baseline.** The Trade Retro card filtered to the 7-10 day window is your honest measurement. EV/trade > 0 with reasonable variance, no single symbol dominating, and MAE per pool not blowing through the stop = the foundation is sound.

---

## 19. Phase 4 — Ablation cockpit

**Goal:** Find out which LLM agents pay for themselves. Add agents back one block at a time; compare each block's EV/trade against the prior block.

**Shipped (code):** Migration `017_phase4_ablation_blocks.sql` adds the `phase4_blocks` table (label, started_at, ended_at, flag_snapshot, notes). API endpoints `GET/POST /api/phase4-blocks{,/start,/end}` manage block windows. The Settings → Phase 4 — Ablation Cockpit tile gives one-click block-start with flag-snapshot capture.

**The block sequence:**

| Block | Add back | Measure vs |
|---|---|---|
| baseline | (nothing — Phase 3 rules-only) | EV/trade reference |
| 4a | Technical-Analysis LLM (Quant grading) | baseline |
| 4b | Orchestrator Haiku (no debate, no Sonnet) | 4a |
| 4c | Debate + Sonnet on dissent | 4b |
| 4d | News-LLM (Herald) — only if 4c was positive | 4c |
| 4e | Breakout + Mean-Reversion (Rupture + Bounce) | 4d |

**Operating the cockpit.** Open Settings → Phase 4 — Ablation Cockpit:

- The **Active** badge shows the currently running block, time elapsed, n closed trades, EV/trade, win %, total P&L.
- Each block template (one row per block) has a **Start** button. Clicking it:
  1. Auto-closes the current active block (if any).
  2. Sets the flags for that block's template.
  3. Creates a new `phase4_blocks` row stamped with the resulting flag snapshot + the timestamp.
- **End block** closes the active window without starting a new one (use when pausing between blocks).
- The closed-block history (last 10) shows each block's n_closed, avg_pnl, and **Δ vs prior** — your decision signal.

**Decision rule:** Keep an addition only if Δ EV/trade ≥ that addition's LLM cost per trade × 2 (margin for small-sample noise). Below that, the addition is paying for itself but with no headroom — cut it.

**No-go criteria:**

- 4a regresses by > 10% — Quant's LLM is actively harmful. Cut it.
- Any block adds > $1/day cost with EV/trade unchanged — that agent is noise.
- < 8 closed trades in a block — sample too small. Extend the window before judging.

**Pacing.** Each block runs 3–4 days. The full sweep takes 15–21 days. Calendar gates over code — advance only when the sample is large enough to compare honestly.

---

## 20. Phase 5 — Two-setup focus

**Goal:** After Phase 4 you know which combinations of (rule + LLM) pay. Now narrow down to the two best.

**Operator action:**

1. From Phase 4's block history, identify the (setup × regime) combinations with the highest **EV × frequency** product. Frequency matters — a setup with EV/trade = +$50 that fires once a month is worth less than EV = +$15 that fires daily.
2. Pick the top two.
3. Drop everything else into "watch but don't trade" mode — signals still get logged so you can audit them, but Striker filters them out before execution.

**No code work in this phase.** It's a config decision plus a 7–10 day observation window with the narrowed setups.

**No-go criteria:**

- No setup combo has positive EV × frequency after Phase 4 → the system doesn't have edge. **Stop.** The path-to-live ends here. Re-evaluate the entire strategy thesis before reopening any phase.

---

## 21. Phase 6 — 200-trade discipline

**Goal:** Accumulate enough sample size that the live-edge claim is statistical, not anecdotal.

**No code work.** Run the Phase 5 system on paper for as long as it takes to clear:

- 200+ closed trades per regime label (Atlas's regime labels: `trending_bull`, `trending_bear`, `range_bound`, at minimum).
- Sharpe ratio (annualized, net of fees) > 1.0.
- Max drawdown < 15%.
- Per-setup MAE shows the stops are above the 90th-percentile loss point — otherwise stops are getting picked off by noise.

**Calendar:** Realistically 4–8 weeks. Maybe longer in slow regimes.

**The hard part.** This is the most-tempting phase to over-engineer. Resist. Every code change during the 200-trade gate compromises the data. Take notes for Phase 8 — log every "I wish this had X" thought into a backlog file, don't merge them.

**No-go criteria:**

- Sharpe < 1.0 after 200+ trades → the edge isn't durable. Do not advance to Phase 7. Investigate why.
- Max drawdown > 15% → risk model is wrong. Tighten `MAX_DRAWDOWN_PCT` or the per-trade `RISK_PCT` and re-run.
- MAE per setup ≥ stop distance → stops are firing on noise. Either widen the stop, or the setup itself doesn't have edge at the timeframe you're trading.

---

## 22. Phase 7 — Paper-to-live transition

**Goal:** Get from "200 paper trades cleared" to "100 live trades cleared at full size" without blowing up.

This is the most dangerous phase. It gets the most discipline.

**The ramp:**

1. Start with **5–10% of intended live capital.** If you intend $50K, start with $5K.
2. Track real-money slippage vs paper slippage per trade.
3. After the **first 25 live trades:** compare live P&L vs paper P&L for the same orchestrator decisions. **Acceptable divergence: ≤ 25%.** This is the **new fidelity gate** — moved here from Phase 2's retired backtest criterion.
4. After the **first 50 live trades:** re-measure live-vs-paper, ratchet to **≤ 15% median error.** Failures here mean SOR / slippage diverges from paper in ways no backtest could have caught — pause before ramping capital.
5. Cap any single trade at **1% of live capital** regardless of strategy size, until 100 trades are in.
6. Ramp capital in 25% increments only after each milestone clears.

**No-go criteria:**

- Live slippage > 2 × paper slippage → recalibrate before ramping.
- First live week ends with > 8% drawdown → pause, post-mortem, do NOT ramp capital.
- ANY broker-side error not handled cleanly → stop, fix, re-test before continuing.

**Operator surface.** During Phase 7, the bot needs two new things you'll wire up:

1. A live-paper divergence card (compare same-decision P&L between paper and live books).
2. A staged-capital ramp UI (the `LIVE_RAMP_TIER` runtime flag exists; the UI surfaces the current tier + advance/rollback buttons).

Both are in the Phase 7 implementation scope and not shipped at this writing.

---

## 23. Phase 8 — Delete pass + code consolidation

**Goal:** After Phase 7's first 100 live trades complete cleanly, you know what was worth keeping. Now strip the rest.

**Targets:**

- Delete agents that didn't survive Phase 4 (remove the code, not just the flag — Phase 0 marked code for "stays in repo 14 days, deletion in Phase 8").
- Settings UI: collapse into a single sticky left-nav (the long-promised cleanup).
- Wiki views: delete, replace with inline `?` tooltips next to controls.
- CryptoView / AgentChatView / TimelineView: delete if unused (Phase 6 will surface what's actually opened).
- Orchestrator prompt: strip dead-agent role descriptions.
- Goal: `trader-ui/src/views/` shrinks by 30%+ of LOC.

**Why last.** Phase 8 is destructive. Deleting before Phase 7 cleared would have removed work you might've wanted to revive. Now you know.

---

# Part 5 — Troubleshooting

## 24. Why no trades? — the diagnostic playbook

The Diagnostics → Why no trades? card is the single most useful surface when the bot is alive but not trading. The headline diagnosis maps to a fix:

### "Synthesis short-circuited — agents are all HOLD"

Every agent in the last cycle returned HOLD. Nexus skips synthesis to save the LLM cost. Look at:

- Atlas's regime — if `high_vol`, several agents auto-throttle.
- Quant's per-symbol verdicts — open the Agents page and read Quant's last report.
- The watchlist — if the watchlist is 8 mega-caps and they all consolidated today, there's no signal to act on.

### "N decisions dropped — confidence < 70%"

Agents are producing decisions, but Nexus's confidence floor is filtering them out. Two real causes:

- **Genuinely flat market** — agents have no conviction. Accept it.
- **Floor set too high for current data** — open Trade Retro, look at win rate by confidence bucket. If you'd be winning above 60% confidence and the floor is at 70%, drop to 0.65 (don't go below).

### "N decisions made but all skipped at execution"

Striker is filtering. Expand the card and read the skip-reason histogram. Common ones:

| Reason | Meaning | Fix |
|---|---|---|
| `position_already_open` | Bot wanted to BUY a symbol you already own | Expected — the bot doesn't pyramid by default |
| `risk_veto` | Vega's heat / sector / correlation cap blocked | Review portfolio composition |
| `regime_block` | Atlas vetoed long entries in a bear regime | Expected behavior |
| `news_critical_alert` | Herald's keyword detector flagged catastrophic news | Expected — read the news for that symbol |
| `min_price_floor` | Symbol was below `MIN_PRICE` ($3 default) | Either raise the floor or accept penny names |
| `execution_min_confidence_failed` | Below `EXECUTION_MIN_CONFIDENCE` (0.60) | Same fix as the orchestrator floor |
| `cycle_guard_skipped` | Cycle guard reused the prior decision (no action needed) | Expected unless it keeps repeating |

### "N cycles ran but produced zero decisions"

Catch-all. Read the cycle event log (last 30 events at the bottom of the card). Look for:

- `cycle_skipped` — what reason? (market_closed / outage_pause / drawdown_cutoff)
- Missing `orchestrator_synthesis` events — the orchestrator never ran. Likely an LLM issue; check the LLM Cost banner.

---

## 25. LLM circuit breaker tripped

The red banner at the top of the Dashboard with "Circuit Breaker Open" means three consecutive auth/model/network failures fired. The banner includes:

- The last error (auth issue → fix your API key; model not found → check the model name in `src/agents/llm.js`; rate limit → wait).
- Consecutive failure count.
- A **Reset Breaker** button.

**Order of operations:**

1. **Read the last error.** Don't reset blindly — the breaker exists because retrying without fixing the cause burns budget.
2. **Fix the underlying issue** (API key in `.env`, model name in code, network connectivity).
3. **Click Reset Breaker.** Confirm.
4. **Wait for the next cycle** — the breaker should stay closed.

If the breaker re-trips immediately, the fix didn't take. Don't keep clicking Reset.

---

## 26. Broker outage handling

When Alpaca's API has three consecutive 5xx or network failures spaced > 30 s apart, the broker-health state machine moves from HEALTHY → OUTAGE. The Dashboard shows it as a small amber dot in the Market cell of the top band; the Activity feed logs `broker_outage_detected`.

**What the bot does during outage:**

- Stops entering new positions immediately.
- Open positions are *not* panic-closed — they sit where they are.
- Cycles still run for diagnostic purposes, but decisions don't ship.

**What you should do:**

- Check Alpaca's status page (`status.alpaca.markets`).
- Wait. The state machine auto-recovers when 3 consecutive successful calls arrive + 60 s grace.
- During the grace window the status shows RECOVERING (amber).
- After grace, back to HEALTHY (green).

If Alpaca is healthy but the bot thinks it's not, the network between your deploy and Alpaca is the suspect — check your hosting provider's outbound network status.

---

# Part 6 — Reference

## 27. Glossary

| Term | Meaning |
|---|---|
| **5-min bar** | OHLCV bar covering 5 minutes of trading. The base timeframe for signals. |
| **ATR** | Average True Range. A volatility measure used to scale stops per-symbol. |
| **Agency mode** | The multi-agent flow (USE_AGENCY=true). Off = the legacy scanner/executor only. |
| **Ablation block** | A measurement window in Phase 4 with a specific flag combination, used to attribute EV/trade to LLM contributions. |
| **Bracket order** | A market or limit entry plus an attached stop and target. Equities only on Alpaca paper. |
| **Cycle** | One scan + orchestrator + execute pass. Default 5-minute cadence. |
| **Cycle guard** | Optimizer that skips Nexus when agent inputs are identical to the prior cycle. Saves ~$0.8 per skipped cycle. |
| **DTE** | Days To Expiry. Used to gate option entries (default block ≤ 7 DTE). |
| **EMA** | Exponential Moving Average. The bot uses EMA9 + EMA21 crossovers. |
| **EV/trade** | Expected Value per trade. Avg P&L over n closed trades. The main metric for Phases 3-4. |
| **MAE / MFE** | Max Adverse / Max Favorable Excursion. The biggest drawdown / unrealized gain observed inside a trade. |
| **OCC symbol** | Standard option symbol format: `AAPL250620C00200000` = AAPL 2025-06-20 $200 call. |
| **Orchestrator** | Nexus. Synthesizes agent reports into final BUY/SELL/HOLD decisions. |
| **Regime** | Atlas's classification of market state: trending_bull, trending_bear, range_bound, high_vol, recovery. |
| **Runtime config** | The `runtime_config` table — hot-reloadable overrides for any `ALLOWED_KEYS` entry. Picked up within 30 s. |
| **SOR** | Smart Order Routing. Places a limit at the spread; falls back to market if unfilled within `SOR_TIMEOUT_MS`. |
| **Strategy pool** | A separate code path with its own risk model. Currently: Equity Hybrid + Momentum Hunter + Options. |
| **Trailing stop** | A stop that ratchets up with the running high. Activates after a configurable profit threshold. |

---

## 28. Runtime config keys — quick reference

Every key here is hot-reloadable (no restart). Set via Settings UI or `PUT /api/runtime-config/:key`. The full list lives in `src/runtime-config.ts` → `ALLOWED_KEYS`.

### Signal + execution

| Key | Default | Range |
|---|---|---|
| `SCAN_INTERVAL_MS` | 300000 | 60000–900000 |
| `ORCHESTRATOR_MIN_CONFIDENCE` | 0.70 | 0.50–0.95 (don't drop below 0.65) |
| `EXECUTION_MIN_CONFIDENCE` | 0.60 | 0.50–0.90 |
| `VOLUME_SPIKE_RATIO` | 1.2 | 1.0–3.0 |
| `MIN_PRICE` | 3.0 | 0.50–25.00 |

### Risk

| Key | Default | Range |
|---|---|---|
| `RISK_PCT` | 0.02 | 0.005–0.05 |
| `STOP_PCT` | 0.035 | 0.01–0.10 |
| `TARGET_PCT` | 0.10 | 0.02–0.30 |
| `MAX_POS_PCT` | 0.10 | 0.02–0.30 |
| `TRAILING_ATR_MULT` | 2.5 | 1.0–5.0 |
| `MAX_DRAWDOWN_PCT` | 0.10 | 0.03–0.20 |
| `CORRELATION_THRESHOLD` | 0.85 | 0.50–0.95 |

### Agent gates (Phase 0 + Phase 3 + Phase 4)

| Key | Default | Notes |
|---|---|---|
| `BREAKOUT_AGENT_ENABLED` | false | Rupture cut. Flip on if Trade Retro shows missed breakouts. |
| `MEAN_REVERSION_AGENT_ENABLED` | false | Bounce cut. Flip on for oversold reversion plays. |
| `SCREENER_LLM_RERANK_ENABLED` | false | Scout LLM cut. Rule-based composite score handles 95% of cases. |
| `NEWS_PER_CYCLE_LLM_ENABLED` | false | Herald LLM cut. Keyword detector still vetoes catastrophic news. |
| `TECHNICAL_LLM_ENABLED` | true | Quant grading. Flip off for Phase 3 baseline. |
| `ORCHESTRATOR_LLM_ENABLED` | true | Nexus synthesis. Flip off for Phase 3 baseline. |
| `ORCHESTRATOR_DEBATE_ENABLED` | true | Debate + Sonnet on dissent. Flip off for Phase 4 block 4b. |

### Momentum Hunter

| Key | Default | Notes |
|---|---|---|
| `MOMENTUM_HUNTER_ENABLED` | false | Master toggle. |
| `MOMENTUM_GAP_PCT` | 0.175 | Min |% change| from prior close. |
| `MOMENTUM_MIN_VOLUME` | 400000 | Min shares today. |
| `MOMENTUM_RISK_PCT` | 0.005 | 0.5% portfolio per trade. |
| `MOMENTUM_STOP_PCT` | 0.05 | 5% flat stop. Time-exit is the real control. |
| `MOMENTUM_TIME_EXIT_MIN` | 30 | Minutes before time-exit check. |
| `MOMENTUM_MIN_GAIN_AT_EXIT` | 0.20 | Sell if not up this much at time-exit. |
| `MOMENTUM_MAX_OPEN` | 3 | Max concurrent positions. |
| `MOMENTUM_TRAIL_ACTIVATE_PCT` | 0.10 | Start trailing once up this much. |
| `MOMENTUM_TRAIL_PCT` | 0.06 | Trail this % below the running high. |

### Options

| Key | Default | Notes |
|---|---|---|
| `OPTIONS_ENABLED` | false | Master toggle for the options pool. |
| `MAX_OPTION_RISK_PCT` | 0.01 | 1% portfolio in premium per contract. |
| `MAX_DELTA_EXPOSURE_PCT` | 0.05 | 5% portfolio in delta-adjusted notional. |
| `THETA_DECAY_DAYS_THRESHOLD` | 7 | Block opens with ≤ this many days to expiry. |

### LLM cost

| Key | Default | Notes |
|---|---|---|
| `LLM_DAILY_COST_CAP_USD` | 5.0 | Soft cap; agents fall back when hit. |
| `LLM_DAILY_TOKEN_CAP` | 10000000 | Safety-net. |
| `LLM_CIRCUIT_BREAKER_FAILURES` | 3 | Consecutive failure threshold. |

### Infra

| Key | Default | Notes |
|---|---|---|
| `CORS_ENABLED` | false | Flip on with `CORS_ORIGINS` to allow cross-origin. |
| `IP_ALLOWLIST_ENABLED` | false | Flip on with `IP_ALLOWLIST` to restrict by source IP. |
| `CYCLE_GUARD_ENABLED` | true | Cycle skip-when-input-unchanged optimizer. |
| `CYCLE_GUARD_MAX_SKIPS` | 4 | Max consecutive cycles skipped before forcing a synthesis. |

---

## 29. API endpoints — quick reference

All endpoints under `/api/*`. Auth by `x-api-key` header when `API_KEY` is set in `.env`. The full surface lives in `src/server.js`.

### Read

| Endpoint | Returns |
|---|---|
| `GET /api/status` | Service health, market open state, uptime, cycle guard, LLM usage |
| `GET /api/account` | Alpaca account snapshot |
| `GET /api/positions` | All open positions |
| `GET /api/trades?limit=...&status=...` | Filtered trade list |
| `GET /api/trades/:id` | Single trade detail |
| `GET /api/signals?limit=...` | Recent scanner signals |
| `GET /api/performance` | Daily performance rollup |
| `GET /api/agents` | Per-agent health + last report |
| `GET /api/agents/:name/report` | Latest report from a specific agent |
| `GET /api/agents/:name/reports?limit=...` | Recent reports |
| `GET /api/decisions?limit=...` | Recent orchestrator decisions |
| `GET /api/decisions/:id` | Single decision detail |
| `GET /api/analytics/attribution?days=N` | Multi-dimensional trade attribution (the Trade Retro source) |
| `GET /api/analytics/by-strategy?days=N` | Per-pool performance |
| `GET /api/sectors/rotation?days=N` | Sector leaders/laggards |
| `GET /api/cycle-log?limit=N&events=M` | Cycle event log + skip-reason summary |
| `GET /api/phase4-blocks` | List Phase 4 ablation blocks + per-block EV/trade |
| `GET /api/runtime-config` | All current overrides + effective config |
| `GET /api/config` | Effective configuration (full) |

### Write

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/trades/manual` | `{symbol, qty, side, orderType?, limitPrice?, stopLoss?, takeProfit?, useSor?}` | Place manual order (the Quick Trade backend) |
| `POST /api/chat` | `{message, sessionId?}` | Chat-driven order via Claude tool-use |
| `PUT /api/runtime-config/:key` | `{value}` | Set a runtime override |
| `DELETE /api/runtime-config/:key` | — | Clear an override (revert to code default) |
| `POST /api/phase4-blocks/start` | `{label, setFlags?, notes?}` | Start a Phase 4 ablation block |
| `POST /api/phase4-blocks/end` | — | End the active block |
| `PUT /api/strategies/:symbol` | `{mode}` | Set strategy for a symbol |
| `PUT /api/strategies` | `{mode}` | Set default strategy |
| `POST /api/alerts/test` | `{channel}` | Test alert delivery |

### Operational

| Endpoint | Notes |
|---|---|
| `GET /metrics` | Prometheus scrape endpoint (no auth) |
| `GET /healthz` | Cheap liveness check |
| `POST /api/llm/reset-breaker` | Reset the LLM circuit breaker |

---

## 30. Where the code lives — a one-page map

```
alpaca-trader/
├── src/
│   ├── index.js                  ← Entry point. Schedules scanner, monitor, agency cycles.
│   ├── config.js                 ← Frozen default config object.
│   ├── runtime-config.ts         ← Hot-reload overrides + ALLOWED_KEYS.
│   ├── db.js                     ← pg Pool. initSchema() runs db/schema.sql.
│   ├── alpaca.js                 ← Alpaca REST + websocket wrapper.
│   ├── server.js                 ← Express API (all /api/* endpoints).
│   ├── scanner.js                ← Legacy rule-based scanner.
│   ├── executor.js               ← Order sizing + placement.
│   ├── monitor.js                ← Open-position tracker (stop/target/trailing).
│   ├── indicators.js             ← Pure indicator functions (EMA, RSI, ATR, etc.).
│   ├── halt-tracker.js           ← Phase 1 halt-detection state machine.
│   ├── gap-risk.js               ← Phase 1 premarket gap exit handler.
│   ├── broker-health.js          ← Phase 1 outage state machine.
│   ├── cycle-log.js              ← Diagnostic event recorder.
│   └── agents/
│       ├── orchestrator.js       ← Nexus. Synthesis + debate + fallback.
│       ├── technical-agent.js    ← Quant.
│       ├── market-screener.js    ← Scout.
│       ├── risk-agent.js         ← Vega.
│       ├── market-regime.js      ← Atlas.
│       ├── news-sentinel.js      ← Herald.
│       ├── breakout-agent.js     ← Rupture.
│       ├── mean-reversion-agent.js ← Bounce.
│       ├── momentum-agent.js     ← Momentum Hunter (no LLM).
│       ├── execution-agent.js    ← Striker.
│       ├── debate.js             ← Inter-agent debate runner.
│       ├── schemas.js            ← JSON schemas every agent's output is validated against.
│       └── llm.js                ← askJson() — the only LLM call site. Caching, retries, cost tracking.
├── db/
│   ├── schema.sql                ← Tables: signals, trades, daily_performance, agent_reports, etc.
│   └── migrations/               ← Versioned migrations. 017 is the most recent.
├── trader-ui/
│   └── src/
│       ├── views/                ← Top-level pages (Dashboard, Positions, Settings, etc.)
│       ├── components/           ← Cards + tables + shared widgets
│       ├── api/client.js         ← Single source of truth for API call signatures
│       └── lib/                  ← Persona map, option symbol parsing, format helpers
├── scripts/                      ← One-off ops scripts (audits, fidelity checks, reconciliation)
├── tests/                        ← Jest suites — 44 suites, 478 tests as of 2026-05-29
├── v2_roadmap.md                 ← Authoritative path-to-live program doc
├── TRADER_ACADEMY.md             ← This document
└── CLAUDE.md                     ← Repo instructions for Claude Code
```

---

## Closing notes

This Academy is a living document. Two heuristics for keeping it useful:

1. **When the bot's behavior changes, update the relevant chapter same-PR.** Drift between docs and code is the original sin.
2. **When you discover something the docs should have told you, add it.** The chapters here are the things current-you wished past-you had known. Keep that compounding.

When you stand up the wiki portal, each `##` chapter splits cleanly into its own page. The cross-references (e.g. "see Chapter 14") become wiki links. The table of contents at the top becomes the portal landing page.

The hard part of trading isn't the code. It's the discipline to follow the no-go criteria when the temptation is to ship more features. The Academy is here to make the discipline easier — by writing down what was learned, so the next decision isn't an opinion.
