import { useState, useRef, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import StatCard from '../components/shared/StatCard'
import StockLogo from '../components/shared/StockLogo'
import ClosePositionButton from '../components/positions/ClosePositionButton'
import OptionActivityCard from '../components/dashboard/OptionActivityCard'
import ActivityFeed from '../components/dashboard/ActivityFeed'
import { LoadingCards } from '../components/shared/LoadingState'
import { usePerformance, useAllTrades, useOpenTrades, usePositions, useMarketTickers, useMarketNews, useAgents, useAccount } from '../hooks/useQueries'
import { useQuery } from '@tanstack/react-query'
import { getStatus, getSectorRotation, getSentimentShifts, getSentimentTrend, searchSymbols, getMarketSnapshot, placeManualOrder, getCycleLog, getOptionSnapshot } from '../api/client'
import { livePrices, onOrderUpdate } from '../hooks/useSocket'
import { isToday, isThisWeek, parseISO, formatDistanceToNow } from 'date-fns'

export default function DashboardView() {
  const { data: performance, isLoading: perfLoading } = usePerformance()
  const { data: allTrades, isLoading: tradesLoading } = useAllTrades()
  const { data: openTrades } = useOpenTrades()

  const isLoading = perfLoading || tradesLoading
  const stats = computeStats(performance, allTrades, openTrades)

  return (
    <div className="space-y-3">
      <OrderToasts />

      {/* LLM Status Banner */}
      <LlmStatusBanner />

      {/* Market Ticker Bar */}
      <MarketTickers />

      {/* Portfolio Hero — front and center */}
      <PortfolioHero />

      {isLoading ? (
        <LoadingCards count={3} />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <StatCard
            label="Win Rate"
            value={`${stats.winRate.toFixed(1)}%`}
            delta={stats.weekWinRate != null ? `${stats.weekWinRate.toFixed(1)}% last 7d` : null}
            trend={stats.winRate >= 50 ? 'up' : 'down'}
          />
          <StatCard
            label="Open Positions"
            value={String(stats.openCount)}
          />
          <StatCard
            label="Total Trades"
            value={String(stats.totalTrades)}
            delta={`${stats.weekTrades} this week`}
            trend="neutral"
          />
        </div>
      )}

      {/* Quick Trade, then Open positions stacked below */}
      <QuickTradePanel />
      <OpenPositionsCard />

      {/* Recent trades (full width) */}
      <RecentTradesCard />

      {/* Option Activity — open exposure + today's flow + delta heatmap.
          Hides itself when options trading is off and there's no history. */}
      <OptionActivityCard />

      {/* Why no trades? — recent cycle outcomes + skip reasons */}
      <CycleDiagnosticsCard />

      {/* Activity */}
      <ActivityFeed />

      {/* LLM Cost & Efficiency — moved to bottom */}
      <LlmCostCard />

      {/* Secondary: news + sector + sentiment (pushed to bottom, collapsible) */}
      <SecondaryPanels />
    </div>
  )
}

// Large portfolio value hero with today's delta + all-time P&L vs starting cash.
// Alpaca paper accounts start with $100k; the initial value is runtime-configurable.
const STARTING_CASH = 100000 // override via VITE_STARTING_CASH or backend runtime-config if your paper account was reset

function PortfolioHero() {
  const { data: account } = useAccount()
  const portfolioValue = Number(account?.portfolio_value ?? account?.equity ?? 0)
  const lastEquity = Number(account?.last_equity ?? 0)
  const todayChange = lastEquity > 0 ? portfolioValue - lastEquity : 0
  const todayChangePct = lastEquity > 0 ? (todayChange / lastEquity) * 100 : 0
  const allTimePnl = portfolioValue > 0 ? portfolioValue - STARTING_CASH : 0
  const allTimePct = portfolioValue > 0 ? (allTimePnl / STARTING_CASH) * 100 : 0

  const todayTrend = todayChange > 0 ? 'up' : todayChange < 0 ? 'down' : 'neutral'
  const allTimeTrend = allTimePnl > 0 ? 'up' : allTimePnl < 0 ? 'down' : 'neutral'

  return (
    <div className="bg-surface border border-border rounded-lg shadow-md shadow-black/30 relative overflow-hidden">
      <div className={clsx(
        'absolute inset-x-0 top-0 h-1',
        todayTrend === 'up' && 'bg-gradient-to-r from-accent-green via-accent-green/60 to-accent-green/0',
        todayTrend === 'down' && 'bg-gradient-to-r from-accent-red via-accent-red/60 to-accent-red/0',
        todayTrend === 'neutral' && 'bg-gradient-to-r from-accent-blue/60 to-accent-blue/0',
      )} />
      <div className="p-4 md:p-5 flex flex-col md:flex-row md:items-end gap-4 md:gap-8">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] md:text-xs text-text-muted uppercase tracking-widest mb-1">Portfolio Value</p>
          <p className="font-mono text-3xl md:text-4xl lg:text-5xl font-bold text-text-primary leading-none tracking-tight">
            ${portfolioValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>

        <div className="flex gap-4 md:gap-6">
          <HeroDelta
            label="Today"
            dollar={todayChange}
            pct={todayChangePct}
            trend={todayTrend}
          />
          <HeroDelta
            label="All-time"
            dollar={allTimePnl}
            pct={allTimePct}
            trend={allTimeTrend}
            sub={`from $${STARTING_CASH.toLocaleString()}`}
          />
        </div>
      </div>
    </div>
  )
}

function HeroDelta({ label, dollar, pct, trend, sub }) {
  const sign = dollar >= 0 ? '+' : '−'
  const abs = Math.abs(dollar)
  const color = trend === 'up' ? 'text-accent-green' : trend === 'down' ? 'text-accent-red' : 'text-text-muted'
  return (
    <div>
      <p className="text-[10px] text-text-muted uppercase tracking-widest mb-1">{label}</p>
      <p className={clsx('font-mono text-lg md:text-2xl font-bold leading-tight', color)}>
        {sign}${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
      <p className={clsx('font-mono text-xs md:text-sm', color)}>
        {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
      </p>
      {sub && <p className="font-mono text-[10px] text-text-dim mt-0.5">{sub}</p>}
    </div>
  )
}

// "Why no trades?" — surfaces recent agency cycle outcomes + skip reason
// histogram so you don't need to tail Railway logs to see what's happening.
function CycleDiagnosticsCard() {
  const [expanded, setExpanded] = useState(false)
  const { data } = useQuery({
    queryKey: ['cycle-log'],
    queryFn: () => getCycleLog(50, 20),
    refetchInterval: 20_000,
  })

  const events = data?.events || []
  const summary = data?.summary || { cycles: 0, decisions: 0, executed: 0, skipReasons: {} }
  const skipPairs = Object.entries(summary.skipReasons).sort((a, b) => b[1] - a[1])
  const totalSkipped = skipPairs.reduce((sum, [, n]) => sum + n, 0)

  // Inspect orchestrator events to give a more specific reason when 0 decisions
  const recentSyntheses = events.filter((e) => e.type === 'orchestrator_synthesis').slice(0, 5)
  const recentShortCircuits = events.filter((e) => e.type === 'orchestrator_short_circuit').slice(0, 5)
  const lastSignals = events.find((e) => e.type === 'orchestrator_signals')
  const droppedByConfidence = recentSyntheses.reduce((s, e) => s + (e.droppedByConfidence || 0), 0)
  const totalRawDecisions = recentSyntheses.reduce((s, e) => s + (e.rawDecisions || 0), 0)

  // Headline diagnosis
  let headline = 'Loading…'
  let headlineColor = 'text-text-muted'
  let subline = null
  if (data) {
    if (summary.cycles === 0) {
      headline = 'No agency cycles recorded yet'
      headlineColor = 'text-accent-amber'
    } else if (summary.executed > 0) {
      headline = `${summary.executed} order${summary.executed === 1 ? '' : 's'} placed in last ${summary.cycles} cycles`
      headlineColor = 'text-accent-green'
    } else if (summary.decisions > 0) {
      headline = `${summary.decisions} decision${summary.decisions === 1 ? '' : 's'} made but all skipped at execution`
      headlineColor = 'text-accent-amber'
    } else if (totalRawDecisions > 0 && droppedByConfidence > 0 && totalRawDecisions === droppedByConfidence) {
      const minConf = recentSyntheses[0]?.minConfidence ?? 0.7
      headline = `${droppedByConfidence} decisions dropped — confidence < ${(minConf * 100).toFixed(0)}%`
      headlineColor = 'text-accent-red'
      subline = `Settings → Signal Tuning → drop Min Orchestrator Confidence`
    } else if (recentShortCircuits.length >= summary.cycles && summary.cycles > 0) {
      headline = `Synthesis short-circuited — agents are all HOLD`
      headlineColor = 'text-accent-red'
      subline = lastSignals
        ? `Last cycle: ${lastSignals.buyCount} BUY / ${lastSignals.sellCount} SELL / ${lastSignals.holdCount} HOLD across agents`
        : null
    } else {
      headline = `${summary.cycles} cycles ran but produced zero decisions`
      headlineColor = 'text-accent-red'
    }
  }

  return (
    <div className="bg-surface border border-border rounded-lg shadow-sm shadow-black/20">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-elevated/30 transition-colors"
      >
        <div className="text-left">
          <h3 className="text-sm font-bold text-text-primary tracking-tight">Why no trades?</h3>
          <p className={clsx('text-[11px] font-mono mt-0.5', headlineColor)}>{headline}</p>
          {subline && <p className="text-[10px] text-text-dim font-mono mt-0.5">{subline}</p>}
        </div>
        <svg className={clsx('w-3 h-3 text-text-dim transition-transform flex-shrink-0', expanded && 'rotate-90')} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-border p-3 space-y-3">
          {/* Summary metrics */}
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Cycles" value={summary.cycles} />
            <Metric label="Decisions" value={summary.decisions} />
            <Metric
              label="Executed"
              value={summary.executed}
              color={summary.executed > 0 ? 'text-accent-green' : summary.decisions > 0 ? 'text-accent-amber' : 'text-text-primary'}
            />
          </div>

          {/* Skip reason histogram */}
          {skipPairs.length > 0 && (
            <div>
              <p className="text-[10px] text-text-dim font-mono uppercase tracking-wide mb-1.5">Why decisions got skipped</p>
              <div className="space-y-1">
                {skipPairs.map(([reason, count]) => {
                  const pct = totalSkipped > 0 ? (count / totalSkipped) * 100 : 0
                  return (
                    <div key={reason} className="flex items-center gap-2 text-[11px] font-mono">
                      <span className="flex-1 truncate text-text-primary" title={reason}>{reason}</span>
                      <span className="text-text-dim w-10 text-right">{count}×</span>
                      <div className="w-20 h-1.5 bg-elevated rounded-full overflow-hidden">
                        <div className="h-full bg-accent-red/60" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Recent events log */}
          <div>
            <p className="text-[10px] text-text-dim font-mono uppercase tracking-wide mb-1.5">Recent activity</p>
            {events.length === 0 ? (
              <p className="text-xs text-text-dim">No cycles logged yet — wait for the next 5-min tick.</p>
            ) : (
              <div className="max-h-[280px] overflow-y-auto space-y-0.5">
                {events.slice(0, 30).map((e, i) => (
                  <CycleEventRow key={i} event={e} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function CycleEventRow({ event }) {
  const ts = formatDistanceToNow(parseISO(event.ts), { addSuffix: true })
  let icon, label, color
  switch (event.type) {
    case 'cycle_started':
      icon = '▶'
      color = 'text-text-muted'
      label = `Cycle ${event.cycleNumber} started — ${event.reason} (${event.watchlistSize} symbols)`
      break
    case 'cycle_skipped':
      icon = '⏭'
      color = 'text-text-dim'
      label = `Cycle ${event.cycleNumber} skipped — ${event.reason}`
      break
    case 'cycle_completed':
      icon = '✓'
      color = event.decisionCount > 0 ? 'text-accent-blue' : 'text-text-muted'
      label = `Cycle ${event.cycleNumber} done — ${event.decisionCount} decisions (${event.durationMs}ms)`
      break
    case 'orchestrator_signals': {
      const tBuy = event.taBuySymbols?.length || 0
      const tSell = event.taSellSymbols?.length || 0
      icon = '⊙'
      color = tBuy + tSell > 0 ? 'text-accent-blue' : 'text-text-dim'
      const taPart = tBuy + tSell > 0 ? `, TA per-symbol: ${tBuy} BUY ${tSell} SELL` : ''
      label = `Cycle ${event.cycleNumber} agent signals — ${event.buyCount} BUY / ${event.sellCount} SELL / ${event.holdCount} HOLD${taPart}`
      break
    }
    case 'orchestrator_short_circuit':
      icon = '∅'
      color = 'text-accent-amber'
      label = `Cycle ${event.cycleNumber} synthesis skipped — ${event.reason}`
      break
    case 'orchestrator_synthesis': {
      icon = '⚖'
      color = event.finalDecisions > 0 ? 'text-accent-blue' : 'text-accent-red'
      const dropped = event.droppedByConfidence > 0 ? ` (${event.droppedByConfidence} dropped <${(event.minConfidence * 100).toFixed(0)}%)` : ''
      label = `Cycle ${event.cycleNumber} synthesis — ${event.rawDecisions} raw → ${event.finalDecisions} after filter${dropped}`
      break
    }
    case 'order_placed':
      icon = '✓'
      color = 'text-accent-green'
      label = `${event.action} ${event.symbol} executed (conf ${(event.confidence * 100).toFixed(0)}%)`
      break
    case 'order_skipped':
      icon = '✗'
      color = 'text-accent-red'
      label = `${event.action} ${event.symbol} skipped — ${event.reason}`
      break
    default:
      icon = '·'
      color = 'text-text-dim'
      label = event.type
  }
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono px-1 py-0.5 hover:bg-elevated/30 rounded">
      <span className={clsx('w-3 text-center', color)}>{icon}</span>
      <span className={clsx('flex-1 truncate', color)} title={label}>{label}</span>
      <span className="text-text-dim text-[10px] flex-shrink-0">{ts}</span>
    </div>
  )
}

function SecondaryPanels() {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="bg-surface border border-border rounded-lg">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-elevated/30 transition-colors"
      >
        <span className="text-sm font-bold text-text-primary tracking-tight">News · Sectors · Sentiment</span>
        <svg className={clsx('w-3 h-3 text-text-dim transition-transform', expanded && 'rotate-90')} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-border p-3 space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
            <div className="lg:col-span-3"><NewsFeed /></div>
            <div className="lg:col-span-2"><SectorRotationCard /></div>
          </div>
          <SentimentShiftsCard />
        </div>
      )}
    </div>
  )
}

// Compact quick-trade panel for the dashboard. Symbol autocomplete +
// shares qty + buy/sell buttons. Shows live price snapshot inline.
// Detect OCC option symbol shape inline so the Quick Trade panel can
// switch its UI/labels without an extra round trip.
const QUICK_OCC_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/

// Parse OCC for inline display in dashboard rows. Returns null on
// non-options. Strike is decoded from the 1/1000ths integer encoding.
const DASH_OCC_RE = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/
function parseDashOcc(s) {
  const m = DASH_OCC_RE.exec(String(s || ''))
  if (!m) return null
  return {
    underlying: m[1],
    type: m[5] === 'C' ? 'call' : 'put',
    strike: parseInt(m[6], 10) / 1000,
    expiration: `20${m[2]}-${m[3]}-${m[4]}`,
  }
}

function QuickTradePanel() {
  const [symbol, setSymbol] = useState('')
  const [qty, setQty] = useState('1')
  const [useSor, setUseSor] = useState(true)
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)

  // Advanced options (hidden by default)
  const [advanced, setAdvanced] = useState(false)
  const [orderType, setOrderType] = useState('market') // 'market' | 'limit'
  const [limitPrice, setLimitPrice] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const [takeProfit, setTakeProfit] = useState('')

  const isOption = QUICK_OCC_RE.test(symbol)

  // Equity snapshot (skipped for options)
  const { data: snap } = useQuery({
    queryKey: ['dash-snap', symbol],
    queryFn: () => getMarketSnapshot(symbol),
    enabled: !!symbol && !isOption,
    staleTime: 15_000,
    refetchInterval: 20_000,
  })
  const snapshot = snap?.snapshot
  const equityPrice = snapshot?.latestTrade?.p || snapshot?.minuteBar?.c || 0

  // Option snapshot (skipped for equities). Server normalizes shape.
  const { data: optSnap, isError: optSnapErr } = useQuery({
    queryKey: ['dash-opt-snap', symbol],
    queryFn: () => getOptionSnapshot(symbol),
    enabled: !!symbol && isOption,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  })
  const optionPremium = optSnap
    ? optSnap.last && optSnap.last > 0
      ? optSnap.last
      : optSnap.bid != null && optSnap.ask != null
        ? +(((optSnap.bid + optSnap.ask) / 2).toFixed(3))
        : null
    : null
  const optionMult = optSnap?.contractMultiplier || 100

  // Estimated cost — premium × multiplier × contracts for options;
  // shares × price for equities.
  const price = isOption ? optionPremium || 0 : equityPrice
  const estCost = isOption
    ? +qty > 0 && price > 0 ? (+qty * price * optionMult).toFixed(2) : null
    : +qty > 0 && price > 0 ? (+qty * price).toFixed(2) : null

  // DTE coloring for the option header line
  const dte = optSnap?.expiration
    ? Math.floor((Date.parse(optSnap.expiration + 'T16:00:00-04:00') - Date.now()) / (24 * 60 * 60 * 1000))
    : null

  async function handleOrder(side) {
    if (!symbol) { setErr('Pick a symbol first'); return }
    const n = Number(qty)
    if (!Number.isFinite(n) || n <= 0) { setErr('Quantity must be > 0'); return }
    if (isOption && Math.floor(n) !== n) {
      setErr('Options use whole-number contracts'); return
    }
    if (isOption && !optSnap) {
      setErr(optSnapErr ? 'No snapshot for this contract' : 'Loading option snapshot…'); return
    }

    // Build payload. Server detects OCC and routes to placeOptionOrder
    // — we just send the right fields. Bracket params are silently
    // ignored on options (paper Alpaca doesn't accept them on options).
    const payload = { symbol, qty: n, side, useSor }
    const lp = Number(limitPrice)
    const sl = Number(stopLoss)
    const tp = Number(takeProfit)
    if (advanced) {
      if (orderType === 'limit') {
        if (!Number.isFinite(lp) || lp <= 0) { setErr('Limit price required for limit orders'); return }
        payload.orderType = 'limit'
        payload.limitPrice = lp
      }
      if (!isOption && side === 'buy' && Number.isFinite(sl) && sl > 0) payload.stopLoss = sl
      if (!isOption && side === 'buy' && Number.isFinite(tp) && tp > 0) payload.takeProfit = tp
      if (!isOption && payload.stopLoss && !payload.takeProfit) { setErr('Bracket orders need both stop + target'); return }
      if (!isOption && !payload.stopLoss && payload.takeProfit) { setErr('Bracket orders need both stop + target'); return }
    }

    // Confirmation message
    const noun = isOption ? `contract${n === 1 ? '' : 's'}` : ''
    const parts = [`${side.toUpperCase()} ${n}${noun ? ' ' + noun : ''} ${symbol}`]
    if (payload.orderType === 'limit') parts.push(`@ limit $${lp}`)
    else if (estCost) parts.push(`(~$${estCost})`)
    if (payload.stopLoss && payload.takeProfit) parts.push(`bracket stop $${sl}/target $${tp}`)
    if (!confirm(`${parts.join(' ')}?`)) return

    setBusy(side); setErr(null); setResult(null)
    try {
      const data = await placeManualOrder(payload)
      setResult({ side, symbol, qty: n, route: data?.orderRoute })
    } catch (e) {
      setErr(e.message || 'Order failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="bg-surface border border-border rounded-lg shadow-sm shadow-black/20 flex flex-col">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <h3 className="text-sm font-bold text-text-primary tracking-tight">Quick Trade</h3>
        <Link to="/market" className="text-[11px] text-text-dim hover:text-accent-blue font-mono">full panel →</Link>
      </div>
      <div className="p-3 flex flex-col gap-2 flex-1">

      <div className="flex gap-2 mb-2">
        <DashSymbolSearch value={symbol} onSelect={setSymbol} />
        <input
          type="number"
          step={isOption ? '1' : '0.0001'}
          min="0"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="w-16 bg-elevated border border-border rounded px-2 py-1 text-xs font-mono text-text-primary outline-none focus:border-accent-blue/50"
          placeholder={isOption ? 'Contracts' : 'Qty'}
          title={isOption ? 'Number of contracts (× 100 shares each)' : 'Quantity'}
        />
      </div>

      {/* Symbol summary line — different shape for options */}
      {symbol && !isOption && (
        <div className="flex items-center justify-between text-[10px] font-mono text-text-dim mb-2">
          <span>{symbol} @ <span className="text-text-primary">${price ? price.toFixed(2) : '—'}</span></span>
          {estCost && <span>≈ ${estCost}</span>}
        </div>
      )}
      {symbol && isOption && (
        <OptionQuickContext optSnap={optSnap} optSnapErr={optSnapErr} premium={optionPremium} dte={dte} estCost={estCost} qty={qty} mult={optionMult} />
      )}

      {/* Advanced toggle */}
      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        className="text-[11px] text-text-muted hover:text-accent-blue font-mono flex items-center gap-1 self-start font-semibold uppercase tracking-wide"
      >
        <svg className={clsx('w-3 h-3 transition-transform', advanced && 'rotate-90')} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Advanced
      </button>

      {advanced && (
        <div className="border border-border rounded p-2.5 space-y-2.5 bg-elevated/50">
          {/* Order type toggle */}
          <div className="flex items-center gap-2 text-[11px] font-mono">
            <span className="text-text-muted uppercase tracking-wide font-semibold">Type</span>
            {['market', 'limit'].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setOrderType(t)}
                className={clsx(
                  'px-2 py-0.5 rounded uppercase font-semibold border',
                  orderType === t
                    ? 'bg-accent-blue/20 text-accent-blue border-accent-blue/40'
                    : 'text-text-muted hover:text-text-primary border-border bg-surface',
                )}
              >
                {t}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-1 text-text-muted cursor-pointer hover:text-text-primary">
              <input
                type="checkbox"
                checked={useSor}
                onChange={(e) => setUseSor(e.target.checked)}
                className="accent-accent-blue"
              />
              SOR
            </label>
          </div>

          {orderType === 'limit' && (
            <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wide font-semibold">
              Limit price
              <input
                type="number"
                step="0.01"
                min="0"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                placeholder={price ? price.toFixed(2) : '0.00'}
                className="mt-1 w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono text-text-primary normal-case font-normal tracking-normal outline-none focus:border-accent-blue/70 placeholder-text-dim"
              />
            </label>
          )}

          {!isOption && (
          <>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wide font-semibold">
              Stop loss
              <input
                type="number"
                step="0.01"
                min="0"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
                placeholder={price ? (price * 0.97).toFixed(2) : '—'}
                className="mt-1 w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono text-text-primary normal-case font-normal tracking-normal outline-none focus:border-accent-red/70 placeholder-text-dim"
              />
            </label>
            <label className="block text-[11px] font-mono text-text-muted uppercase tracking-wide font-semibold">
              Take profit
              <input
                type="number"
                step="0.01"
                min="0"
                value={takeProfit}
                onChange={(e) => setTakeProfit(e.target.value)}
                placeholder={price ? (price * 1.06).toFixed(2) : '—'}
                className="mt-1 w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono text-text-primary normal-case font-normal tracking-normal outline-none focus:border-accent-green/70 placeholder-text-dim"
              />
            </label>
          </div>
          <p className="text-[10px] text-text-muted leading-tight">
            Stop + target together = bracket order (BUY only). Leave blank for plain entry.
          </p>
          </>
          )}
          {isOption && (
            <p className="text-[10px] text-text-muted leading-tight">
              Options use premium-curve stop/target (50% / 100% by default). Set caps in Settings → Options Trading. Brackets aren't supported.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 mt-auto">
        <button
          onClick={() => handleOrder('buy')}
          disabled={busy !== null || !symbol}
          className="px-3 py-2 bg-accent-green/20 text-accent-green border border-accent-green/40 rounded text-sm font-mono font-bold hover:bg-accent-green/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy === 'buy' ? '…' : 'BUY'}
        </button>
        <button
          onClick={() => handleOrder('sell')}
          disabled={busy !== null || !symbol}
          className="px-3 py-2 bg-accent-red/20 text-accent-red border border-accent-red/40 rounded text-sm font-mono font-bold hover:bg-accent-red/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy === 'sell' ? '…' : 'SELL'}
        </button>
      </div>

      {!symbol && (
        <p className="text-[10px] text-text-muted font-mono text-center italic">
          Pick a symbol to enable trading
        </p>
      )}

      {err && <p className="mt-1 text-[10px] text-accent-red font-mono truncate" title={err}>{err}</p>}
      {result && (
        <p className="mt-1 text-[10px] text-accent-green font-mono">
          {result.side.toUpperCase()} {result.qty} {result.symbol} sent{result.route ? ` (${result.route})` : ''}
        </p>
      )}
      </div>
    </div>
  )
}

/**
 * Option-aware context line shown above the BUY/SELL buttons in Quick
 * Trade. Two rows of tiny mono text:
 *   row 1 — UNDERLYING CALL/PUT $strike · exp · DTE  ← red≤1d, amber≤7d
 *   row 2 — premium @ bid/ask · Δ Greek · IV · est cost
 * No estimate is shown until snapshot loads. Errors get a one-line note.
 */
function OptionQuickContext({ optSnap, optSnapErr, premium, dte, estCost, qty, mult }) {
  if (optSnapErr) {
    return <p className="text-[10px] text-accent-red font-mono">No snapshot for this contract</p>
  }
  if (!optSnap) {
    return <p className="text-[10px] text-text-dim font-mono">Loading option data…</p>
  }
  const isCall = optSnap.type === 'call'
  const dteColor = dte == null ? 'text-text-muted' : dte <= 1 ? 'text-accent-red' : dte <= 7 ? 'text-accent-amber' : 'text-text-primary'

  return (
    <div className="text-[10px] font-mono space-y-0.5 mb-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-bold text-text-primary">{optSnap.underlying}</span>
        <span className={clsx(
          'text-[9px] font-bold uppercase px-1.5 py-0.5 rounded',
          isCall ? 'bg-accent-green/20 text-accent-green' : 'bg-accent-red/20 text-accent-red',
        )}>
          {optSnap.type}
        </span>
        {optSnap.strike != null && (
          <span className="text-text-primary">${Number(optSnap.strike).toFixed(2)}</span>
        )}
        {optSnap.expiration && (
          <span className="text-text-dim">· {optSnap.expiration.slice(5)}</span>
        )}
        {dte != null && (
          <span className={clsx('font-semibold', dteColor)}>{dte}d</span>
        )}
        <span className="ml-auto text-text-dim">×{mult}</span>
      </div>
      <div className="flex items-center gap-2 text-text-dim">
        <span>
          prem <span className="text-text-primary">${premium != null ? premium.toFixed(3) : '—'}</span>
        </span>
        {optSnap.bid != null && optSnap.ask != null && (
          <span>· {optSnap.bid.toFixed(2)}/{optSnap.ask.toFixed(2)}</span>
        )}
        {optSnap.delta != null && (
          <span>· Δ <span className="text-text-primary">{Number(optSnap.delta).toFixed(2)}</span></span>
        )}
        {optSnap.impliedVolatility != null && (
          <span>· IV <span className="text-text-primary">{Number(optSnap.impliedVolatility).toFixed(2)}</span></span>
        )}
        {estCost && (
          <span className="ml-auto">≈ ${estCost} ({qty}×prem×{mult})</span>
        )}
      </div>
    </div>
  )
}

function DashSymbolSearch({ value, onSelect }) {
  const [q, setQ] = useState(value || '')
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const dq = useDebounced(q.trim(), 150)

  const { data: results = [] } = useQuery({
    queryKey: ['dash-search', dq],
    queryFn: () => searchSymbols(dq),
    enabled: dq.length >= 1,
    staleTime: 60_000,
  })

  useEffect(() => {
    function click(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', click)
    return () => document.removeEventListener('mousedown', click)
  }, [])

  useEffect(() => { if (value && value !== q) setQ(value) }, [value])

  function pick(sym) { onSelect(sym); setQ(sym); setOpen(false) }

  return (
    <div ref={ref} className="relative flex-1">
      <input
        type="text"
        value={q}
        onChange={(e) => { setQ(e.target.value.toUpperCase()); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter') { pick(results[0]?.symbol || q.trim().toUpperCase()) } }}
        placeholder="Symbol..."
        className="w-full bg-elevated border border-border rounded px-2 py-1 text-xs font-mono text-text-primary outline-none focus:border-accent-blue/50"
      />
      {open && dq.length >= 1 && results.length > 0 && (
        <div className="absolute z-40 mt-1 left-0 right-0 bg-surface border border-border rounded shadow-lg max-h-48 overflow-auto">
          {results.slice(0, 8).map((r) => (
            <button
              key={r.symbol}
              onMouseDown={(e) => { e.preventDefault(); pick(r.symbol) }}
              className="w-full text-left px-2 py-1 text-xs flex gap-2 hover:bg-elevated"
            >
              <span className="font-mono font-semibold text-text-primary w-14">{r.symbol}</span>
              <span className="text-text-muted truncate flex-1">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function useDebounced(value, delayMs) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return v
}

// Compact open-positions card — content-height (no dead space), logos, bigger header
function OpenPositionsCard() {
  const { data: positions, isLoading } = usePositions()
  const list = positions || []

  return (
    <div className="bg-surface border border-border rounded-lg shadow-sm shadow-black/20">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <h3 className="text-sm font-bold text-text-primary tracking-tight">
          Open Positions
          {list.length > 0 && <span className="ml-1.5 text-text-dim font-mono text-xs font-normal">({list.length})</span>}
        </h3>
        <Link to="/positions" className="text-[11px] text-text-dim hover:text-accent-blue font-mono">view all →</Link>
      </div>
      {isLoading ? (
        <div className="p-3 text-xs text-text-dim">Loading…</div>
      ) : list.length === 0 ? (
        <div className="p-6 text-xs text-text-dim text-center">No open positions</div>
      ) : (
        <div className={clsx('divide-y divide-border', list.length > 8 && 'max-h-[260px] overflow-y-auto')}>
          {list.slice(0, 20).map((p) => {
            const pnl = Number(p.unrealized_pl)
            const pnlPct = Number(p.unrealized_plpc) * 100
            const opt = parseDashOcc(p.symbol)
            const displaySymbol = opt ? opt.underlying : p.symbol
            const linkTarget = opt ? opt.underlying : p.symbol
            return (
              <Link
                key={p.symbol}
                to={`/market?symbol=${encodeURIComponent(linkTarget)}`}
                className="flex items-center gap-2 px-3 py-2 hover:bg-elevated/40 transition-colors text-xs font-mono"
              >
                <StockLogo symbol={displaySymbol} size={22} />
                <span className="font-semibold text-text-primary w-14 truncate">{displaySymbol}</span>
                {opt && (
                  <span className={clsx(
                    'text-[9px] font-bold uppercase px-1 py-0.5 rounded flex-shrink-0',
                    opt.type === 'call' ? 'bg-accent-green/20 text-accent-green' : 'bg-accent-red/20 text-accent-red',
                  )}>
                    {opt.type[0]}{opt.strike.toFixed(0)}
                  </span>
                )}
                <span className="text-text-dim w-12 text-right">{Number(p.qty).toFixed(p.symbol.includes('/') ? 4 : 0)}</span>
                <span className="text-text-dim w-16 text-right">${Number(p.current_price).toFixed(opt ? 3 : 2)}</span>
                <span className={clsx('w-20 text-right', pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-text-muted')}>
                  {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                </span>
                <span className={clsx('flex-1 text-right', pnlPct > 0 ? 'text-accent-green' : pnlPct < 0 ? 'text-accent-red' : 'text-text-muted')}>
                  {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                </span>
                <ClosePositionButton position={p} size="xs" />
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Compact recent-trades card — last 8 closed trades
function RecentTradesCard() {
  const { data: trades } = useAllTrades()
  const closed = useMemo(() => {
    return (trades || [])
      .filter((t) => t.status === 'closed')
      .slice(0, 8)
  }, [trades])

  return (
    <div className="bg-surface border border-border rounded-lg shadow-sm shadow-black/20">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <h3 className="text-sm font-bold text-text-primary tracking-tight">
          Recent Trades
          {closed.length > 0 && <span className="ml-1.5 text-text-dim font-mono text-xs font-normal">({closed.length})</span>}
        </h3>
        <Link to="/trades" className="text-[11px] text-text-dim hover:text-accent-blue font-mono">view all →</Link>
      </div>
      {closed.length === 0 ? (
        <div className="p-6 text-xs text-text-dim text-center">No closed trades yet</div>
      ) : (
        <div className={clsx('divide-y divide-border', closed.length > 8 && 'max-h-[260px] overflow-y-auto')}>
          {closed.map((t) => {
            const pnl = Number(t.pnl)
            return (
              <Link
                key={t.id}
                to={`/trades`}
                className="flex items-center gap-2 px-3 py-2 hover:bg-elevated/40 transition-colors text-xs font-mono"
              >
                <StockLogo symbol={t.symbol} size={22} />
                <span className="font-semibold text-text-primary w-14 truncate">{t.symbol}</span>
                <span className={clsx('w-10 text-[10px] font-bold', t.side === 'buy' ? 'text-accent-green' : 'text-accent-red')}>
                  {t.side?.toUpperCase()}
                </span>
                <span className="text-text-dim w-12 text-right">{Number(t.qty).toFixed(t.symbol?.includes('/') ? 4 : 0)}</span>
                <span className={clsx('w-20 text-right', pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-text-muted')}>
                  {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                </span>
                <span className="flex-1 text-right text-text-dim text-[10px]">
                  {t.closed_at ? formatDistanceToNow(parseISO(t.closed_at), { addSuffix: true }) : ''}
                </span>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SentimentShiftsCard() {
  const [hours, setHours] = useState(24)
  const [threshold, setThreshold] = useState(0.4)
  const { data, isLoading } = useQuery({
    queryKey: ['sentiment-shifts', hours, threshold],
    queryFn: () => getSentimentShifts(hours, threshold),
    staleTime: 60_000,
    refetchInterval: 5 * 60 * 1000,
  })
  const shifts = data?.shifts || []

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-text-primary tracking-tight">
          Sentiment Shifts — inflection alerts ({hours}h)
        </h3>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-text-dim font-mono">Window:</span>
            {[6, 24, 72].map(h => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={clsx(
                  'px-2 py-0.5 text-[10px] font-mono rounded',
                  hours === h ? 'bg-accent-blue text-white' : 'bg-elevated text-text-muted hover:text-text-primary',
                )}
              >{h}h</button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-text-dim font-mono">Δ ≥</span>
            {[0.3, 0.5, 0.8].map(t => (
              <button
                key={t}
                onClick={() => setThreshold(t)}
                className={clsx(
                  'px-2 py-0.5 text-[10px] font-mono rounded',
                  threshold === t ? 'bg-accent-blue text-white' : 'bg-elevated text-text-muted hover:text-text-primary',
                )}
              >{t.toFixed(1)}</button>
            ))}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-1">
          {[1,2,3].map(i => <div key={i} className="h-6 bg-elevated rounded animate-pulse" />)}
        </div>
      ) : shifts.length === 0 ? (
        <p className="text-xs text-text-dim">
          No sentiment shifts above Δ{threshold.toFixed(1)} in the last {hours}h.
          Needs at least 2 news-agent cycles per symbol with active news flow; check Polygon enrichment status if this is persistently empty.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {shifts.slice(0, 10).map(s => <ShiftRow key={s.symbol} shift={s} />)}
        </div>
      )}
    </div>
  )
}

function ShiftRow({ shift }) {
  const { data } = useQuery({
    queryKey: ['sentiment-trend', shift.symbol, 3],
    queryFn: () => getSentimentTrend(shift.symbol, 3),
    staleTime: 60_000,
  })
  const points = data?.points || []
  const isBullish = shift.direction === 'bullish'
  const colorClass = isBullish ? 'text-accent-green' : 'text-accent-red'

  return (
    <div className="bg-elevated rounded p-2 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-sm text-text-primary">{shift.symbol}</span>
          <span className={clsx('text-[10px] font-mono font-semibold', colorClass)}>
            {isBullish ? '▲' : '▼'} Δ{shift.delta > 0 ? '+' : ''}{shift.delta.toFixed(2)}
          </span>
          <span className="text-[10px] text-text-dim font-mono ml-auto">n={shift.sampleSize}</span>
        </div>
        <div className="text-[10px] font-mono text-text-dim mt-0.5">
          {shift.first.toFixed(2)} → {shift.last.toFixed(2)}
        </div>
      </div>
      <Sparkline points={points} colorClass={colorClass} />
    </div>
  )
}

function Sparkline({ points, colorClass }) {
  if (!points?.length || points.length < 2) return <div className="w-20 h-8" />
  const values = points.map(p => Number(p.sentiment))
  const min = Math.min(-1, ...values)
  const max = Math.max(1, ...values)
  const range = max - min || 1
  const w = 80
  const h = 32
  const step = w / (values.length - 1)
  const path = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={w} height={h} className="flex-shrink-0">
      <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="currentColor" className="text-border" strokeDasharray="2 2" strokeWidth="0.5" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" className={colorClass} />
    </svg>
  )
}

function SectorRotationCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['sector-rotation', 5],
    queryFn: () => getSectorRotation(5),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  })

  const sectors = data?.sectors || []
  const leaders = data?.leaders || []
  const laggards = data?.laggards || []
  const coverage = data?.coveredSymbols ?? 0
  const universe = data?.universeSize ?? 0

  // Scale bars relative to the widest absolute return across sectors
  const maxAbs = sectors.reduce((a, s) => Math.max(a, Math.abs(s.avgReturn || 0)), 0.001)

  return (
    <div className="bg-surface border border-border rounded-lg p-4 h-full">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-text-primary tracking-tight">
          Sector Rotation ({data?.lookbackDays || 5}d)
        </h3>
        <span className="text-[10px] text-text-dim font-mono">
          {coverage}/{universe} symbols
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1,2,3,4].map(i => <div key={i} className="h-4 bg-elevated rounded animate-pulse" />)}
        </div>
      ) : sectors.length === 0 ? (
        <p className="text-xs text-text-dim">
          No sector data yet. Enable Polygon in Settings to map symbols to sectors.
        </p>
      ) : (
        <>
          {leaders.length > 0 && (
            <div className="mb-3">
              <p className="text-[10px] font-mono text-accent-green uppercase mb-1.5">Leaders</p>
              <div className="space-y-1">
                {leaders.map(s => <SectorRow key={s.name} sector={s} maxAbs={maxAbs} />)}
              </div>
            </div>
          )}
          {laggards.length > 0 && (
            <div>
              <p className="text-[10px] font-mono text-accent-red uppercase mb-1.5">Laggards</p>
              <div className="space-y-1">
                {laggards.map(s => <SectorRow key={s.name} sector={s} maxAbs={maxAbs} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SectorRow({ sector, maxAbs }) {
  const pct = (sector.avgReturn || 0) * 100
  const positive = pct >= 0
  const width = Math.min(100, (Math.abs(sector.avgReturn || 0) / maxAbs) * 100)
  return (
    <div
      className="grid grid-cols-[1fr_80px_48px] items-center gap-2 text-[11px] font-mono"
      title={sector.topSymbols?.map(t => `${t.symbol} ${(t.ret * 100).toFixed(1)}%`).join(' · ')}
    >
      <span className="truncate text-text-primary">{sector.name}</span>
      <div className="relative h-2 bg-elevated rounded-full overflow-hidden">
        <div
          className={clsx('absolute top-0 bottom-0 rounded-full', positive ? 'left-1/2 bg-accent-green/60' : 'right-1/2 bg-accent-red/60')}
          style={{ width: `${width / 2}%` }}
        />
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-border" />
      </div>
      <span className={clsx('text-right', positive ? 'text-accent-green' : 'text-accent-red')}>
        {positive ? '+' : ''}{pct.toFixed(2)}%
      </span>
    </div>
  )
}

const TICKER_LABELS = { SPY: 'S&P 500', QQQ: 'Nasdaq 100', IWM: 'Russell 2000', DIA: 'Dow 30' }

function TickerCard({ ticker }) {
  const [flash, setFlash] = useState(null)
  const prevPrice = useRef(null)

  // Overlay live websocket price if available
  const live = livePrices[ticker.symbol]
  const price = live?.price || ticker.price
  const isLive = live && (Date.now() - live.updated < 30000)

  useEffect(() => {
    if (prevPrice.current !== null && price !== prevPrice.current) {
      setFlash(price > prevPrice.current ? 'green' : 'red')
      const t = setTimeout(() => setFlash(null), 600)
      return () => clearTimeout(t)
    }
    prevPrice.current = price
  }, [price])

  return (
    <div className={clsx(
      'flex-1 bg-surface border border-border rounded-lg p-3 relative overflow-hidden transition-colors',
      flash === 'green' && 'animate-flash-green',
      flash === 'red' && 'animate-flash-red',
    )}>
      <div className={clsx(
        'absolute inset-x-0 top-0 h-0.5',
        ticker.change > 0 ? 'bg-gradient-to-r from-accent-green/60 to-accent-green/0' :
        ticker.change < 0 ? 'bg-gradient-to-r from-accent-red/60 to-accent-red/0' :
        'bg-gradient-to-r from-accent-blue/30 to-accent-blue/0',
      )} />
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-text-dim uppercase tracking-wide">
          {TICKER_LABELS[ticker.symbol] || ticker.symbol}
        </span>
        <div className="flex items-center gap-1">
          {isLive && <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" title="Live" />}
          <span className="text-[10px] font-mono text-text-dim">{ticker.symbol}</span>
        </div>
      </div>
      <div className="flex items-end justify-between">
        <span className="font-mono text-lg font-semibold text-text-primary">
          ${price.toFixed(2)}
        </span>
        <span className={clsx(
          'font-mono text-xs font-medium',
          ticker.change > 0 ? 'text-accent-green' : ticker.change < 0 ? 'text-accent-red' : 'text-text-muted',
        )}>
          {ticker.change > 0 ? '+' : ''}{ticker.change.toFixed(2)}%
        </span>
      </div>
    </div>
  )
}

function MarketTickers() {
  const { data: tickers } = useMarketTickers()

  if (!tickers?.length) {
    return (
      <div className="flex gap-4">
        {['SPY', 'QQQ', 'IWM', 'DIA'].map(s => (
          <div key={s} className="flex-1 bg-surface border border-border rounded-lg p-3 animate-pulse">
            <div className="h-4 bg-elevated rounded w-16 mb-2" />
            <div className="h-6 bg-elevated rounded w-20" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex gap-4">
      {tickers.map(t => <TickerCard key={t.symbol} ticker={t} />)}
    </div>
  )
}

function OrderToasts() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    return onOrderUpdate((data) => {
      const id = Date.now()
      const label = data.event === 'fill' ? 'Filled' :
        data.event === 'partial_fill' ? 'Partial Fill' :
        data.event === 'canceled' ? 'Canceled' :
        data.event === 'rejected' ? 'Rejected' : data.event

      setToasts(prev => [...prev.slice(-4), {
        id,
        event: data.event,
        label,
        symbol: data.symbol,
        side: data.side,
        qty: data.filledQty || data.qty,
        price: data.filledAvgPrice,
      }])

      // Auto-dismiss after 6s
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id))
      }, 6000)
    })
  }, [])

  if (!toasts.length) return null

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 pointer-events-none">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={clsx(
            'px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm pointer-events-auto animate-slide-in',
            toast.event === 'fill' || toast.event === 'partial_fill'
              ? 'bg-accent-green/10 border-accent-green/30'
              : 'bg-accent-red/10 border-accent-red/30',
          )}
        >
          <div className="flex items-center gap-2">
            <span className={clsx(
              'text-xs font-semibold uppercase',
              toast.event === 'fill' || toast.event === 'partial_fill' ? 'text-accent-green' : 'text-accent-red',
            )}>
              {toast.label}
            </span>
            <span className="font-mono text-sm font-bold text-text-primary">{toast.symbol}</span>
          </div>
          <div className="text-xs text-text-muted font-mono mt-0.5">
            {toast.side} {toast.qty} {toast.price ? `@ $${Number(toast.price).toFixed(2)}` : ''}
          </div>
        </div>
      ))}
    </div>
  )
}

function NewsFeed() {
  const { data: news } = useMarketNews(12)

  return (
    <div className="bg-surface border border-border rounded-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-bold text-text-primary tracking-tight">Market News</h3>
        <span className="text-[10px] text-text-dim">Alpaca News API</span>
      </div>
      <div className="divide-y divide-border max-h-[300px] overflow-y-auto">
        {!news?.length ? (
          <div className="px-4 py-8 text-center text-text-dim text-xs">Loading news...</div>
        ) : (
          news.map(article => {
            const thumbUrl = article.images?.find(img => img.size === 'thumb' || img.size === 'small')?.url
              || article.images?.[0]?.url
            return (
              <a
                key={article.id}
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-4 py-3 hover:bg-elevated/50 transition-colors cursor-pointer"
              >
                <div className="flex items-start gap-3">
                  {thumbUrl && (
                    <img
                      src={thumbUrl}
                      alt=""
                      className="w-16 h-16 rounded object-cover flex-shrink-0 bg-elevated"
                      loading="lazy"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary leading-snug mb-1 hover:text-accent-blue transition-colors">
                      {article.headline}
                    </p>
                    {article.summary && (
                      <p className="text-xs text-text-dim line-clamp-2 mb-1.5">{article.summary}</p>
                    )}
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-[10px] text-text-dim">{article.source}</span>
                      <span className="text-[10px] text-text-dim">
                        {formatDistanceToNow(parseISO(article.created_at), { addSuffix: true })}
                      </span>
                      {article.symbols?.length > 0 && (
                        <div className="flex gap-1">
                          {article.symbols.slice(0, 4).map(s => (
                            <span key={s} className="px-1.5 py-0.5 text-[9px] font-mono font-medium bg-accent-blue/10 text-accent-blue rounded">
                              {s}
                            </span>
                          ))}
                          {article.symbols.length > 4 && (
                            <span className="text-[9px] text-text-dim">+{article.symbols.length - 4}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </a>
            )
          })
        )}
      </div>
    </div>
  )
}

function LlmCostCard() {
  const [expanded, setExpanded] = useState(true)
  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 30_000,
    staleTime: 15_000,
  })
  const { data: agentsData } = useAgents()

  const llm = status?.llmUsage
  const guard = status?.cycleGuard
  const fullUsage = agentsData?.llmUsage

  const costCap = fullUsage?.dailyCostCapUsd || 5
  const costPct = llm ? (llm.estimatedCostUsd / costCap) * 100 : 0
  const totalTokens = llm ? llm.totalInputTokens + llm.totalOutputTokens : 0
  const cacheHitRate = llm && totalTokens > 0
    ? ((llm.cacheReadTokens || 0) / (totalTokens + (llm.cacheReadTokens || 0)) * 100).toFixed(0)
    : null

  const retries = llm?.jsonRetries || { success: 0, failure: 0, byAgent: {} }
  const retryTotal = (retries.success || 0) + (retries.failure || 0)
  const retryColor = (retries.failure || 0) > 5
    ? 'text-accent-red'
    : retryTotal > 10
      ? 'text-accent-amber'
      : retryTotal > 0
        ? 'text-text-muted'
        : undefined

  // Per-agent cost breakdown — sorted by cost desc
  const byAgent = fullUsage?.byAgent || {}
  const retryByAgent = retries.byAgent || {}
  const agentRows = Object.entries(byAgent)
    .map(([name, s]) => ({
      name,
      calls: s.calls || 0,
      costUsd: s.costUsd || 0,
      inputTokens: s.inputTokens || 0,
      outputTokens: s.outputTokens || 0,
      retrySuccess: retryByAgent[name]?.success || 0,
      retryFailure: retryByAgent[name]?.failure || 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
  const totalAgentCost = agentRows.reduce((sum, r) => sum + r.costUsd, 0) || 1

  return (
    <div className="bg-surface border border-border rounded-lg">
      <div className="flex items-center justify-between px-3 pt-2 pb-1 border-b border-border/50">
        <h3 className="text-sm font-bold text-text-primary tracking-tight">LLM Cost & Efficiency</h3>
        <span className="text-[10px] text-text-dim font-mono">resets midnight UTC</span>
      </div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center flex-wrap gap-x-6 gap-y-1 px-3 py-2 hover:bg-elevated/30 transition-colors"
      >
        <Metric
          label="Cost"
          value={`$${llm?.estimatedCostUsd?.toFixed(2) || '0.00'}`}
          sub={`${costPct.toFixed(0)}% of $${costCap}`}
          color={costPct > 80 ? 'text-accent-red' : costPct > 50 ? 'text-accent-amber' : 'text-accent-green'}
        />
        <Metric label="Calls" value={llm?.callCount ?? '—'} sub={`${totalTokens.toLocaleString()} tok`} />
        <Metric
          label="Cache"
          value={cacheHitRate != null ? `${cacheHitRate}%` : '—'}
          color={cacheHitRate && +cacheHitRate > 50 ? 'text-accent-green' : undefined}
        />
        <Metric
          label="Retries"
          value={retryTotal > 0 ? `${retries.success}/${retries.failure}` : '0'}
          sub={retryTotal > 0 ? 'ok/fail' : 'none'}
          color={retryColor}
        />
        <Metric
          label="Skipped"
          value={guard?.hitRate || '—'}
          sub={guard ? `${guard.skippedCount}/${guard.totalChecks}` : ''}
          color={guard?.skippedCount > 0 ? 'text-accent-green' : undefined}
        />
        <Metric
          label="Up"
          value={status?.uptime_seconds != null ? formatUptime(status.uptime_seconds) : '—'}
          sub={status?.market_open ? 'open' : 'closed'}
        />
        <span className="ml-auto text-[10px] text-text-dim font-mono flex items-center gap-1">
          {agentRows.length > 0 && `${agentRows.length} agents`}
          <svg className={clsx('w-3 h-3 transition-transform', expanded && 'rotate-90')} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2">
          {agentRows.length === 0 ? (
            <p className="text-xs text-text-dim font-mono py-2">No agent activity yet today.</p>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center gap-3 text-[9px] text-text-dim font-mono uppercase tracking-wide pb-1">
                <span className="w-32">Agent</span>
                <span className="w-16 text-right">Cost</span>
                <span className="w-14 text-right">Calls</span>
                <span className="flex-1 text-right">Tokens (in/out)</span>
                <span className="w-16 text-right">Retries</span>
                <span className="w-16 text-right">% of total</span>
              </div>
              {agentRows.map((r) => {
                const pct = (r.costUsd / totalAgentCost) * 100
                const retryTxt = (r.retrySuccess || r.retryFailure)
                  ? `${r.retrySuccess}/${r.retryFailure}`
                  : '—'
                const retryCellColor = r.retryFailure > 2
                  ? 'text-accent-red'
                  : r.retryFailure > 0 || r.retrySuccess > 5
                    ? 'text-accent-amber'
                    : 'text-text-dim'
                return (
                  <div key={r.name} className="flex items-center gap-3 text-[11px] font-mono hover:bg-elevated/30 px-1 py-0.5 rounded">
                    <span className="w-32 text-text-primary truncate">{r.name}</span>
                    <span className={clsx('w-16 text-right', pct > 40 ? 'text-accent-red' : pct > 20 ? 'text-accent-amber' : 'text-text-muted')}>
                      ${r.costUsd.toFixed(3)}
                    </span>
                    <span className="w-14 text-right text-text-muted">{r.calls}</span>
                    <span className="flex-1 text-right text-text-dim">
                      {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                    </span>
                    <span className={clsx('w-16 text-right', retryCellColor)}>{retryTxt}</span>
                    <span className="w-16 text-right text-text-muted">{pct.toFixed(1)}%</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, sub, color }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] text-text-dim font-mono">{label}</span>
      <span className={clsx('text-sm font-mono font-semibold', color || 'text-text-primary')}>{value}</span>
      {sub && <span className="text-[9px] text-text-dim font-mono">{sub}</span>}
    </div>
  )
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function LlmStatusBanner() {
  const { data: agentsData } = useAgents()
  const usage = agentsData?.llmUsage
  if (!usage || usage.available !== false) return null

  const tokens = (usage.totalInputTokens || 0) + (usage.totalOutputTokens || 0)
  const tokenPct = usage.dailyTokenCap ? (tokens / usage.dailyTokenCap) * 100 : 0
  const costPct = usage.dailyCostCapUsd ? (usage.estimatedCostUsd / usage.dailyCostCapUsd) * 100 : 0

  return (
    <div className="bg-accent-amber/10 border border-accent-amber/30 rounded-lg px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-accent-amber animate-pulse flex-shrink-0" />
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-semibold text-accent-amber">Agents Throttled</span>
            <span className="text-xs font-mono text-text-muted">— {usage.unavailableReason}</span>
          </div>
          <div className="flex items-center gap-4 text-[11px] font-mono text-text-muted">
            <span>Tokens: <span className="text-text-primary">{tokens.toLocaleString()}</span> / {usage.dailyTokenCap?.toLocaleString()} ({tokenPct.toFixed(0)}%)</span>
            <span>Cost: <span className="text-text-primary">${usage.estimatedCostUsd?.toFixed(2)}</span> / ${usage.dailyCostCapUsd?.toFixed(2)} ({costPct.toFixed(0)}%)</span>
            <span>Resets at midnight UTC</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function computeStats(performance, allTrades, openTrades) {
  const trades = allTrades || []
  const perf = performance || []

  const closedTrades = trades.filter(t => t.status === 'closed')
  const todayTrades = closedTrades.filter(t => t.closed_at && isToday(parseISO(t.closed_at)))
  const weekTrades = closedTrades.filter(t => t.closed_at && isThisWeek(parseISO(t.closed_at)))

  const todayPnl = todayTrades.reduce((sum, t) => sum + Number(t.pnl || 0), 0)

  const todayPerf = perf.find(p => isToday(parseISO(p.trade_date)))
  const sorted = [...perf].sort((a, b) => b.trade_date.localeCompare(a.trade_date))
  const yesterdayPerf = sorted.length > 1 ? sorted[1] : null
  const yesterdayPnl = yesterdayPerf ? Number(yesterdayPerf.total_pnl || 0) : null

  const wins = closedTrades.filter(t => Number(t.pnl || 0) > 0).length
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0

  const weekWins = weekTrades.filter(t => Number(t.pnl || 0) > 0).length
  const weekWinRate = weekTrades.length > 0 ? (weekWins / weekTrades.length) * 100 : null

  return {
    todayPnl: todayTrades.length > 0 ? todayPnl : (todayPerf ? Number(todayPerf.total_pnl) : 0),
    yesterdayPnl,
    winRate,
    weekWinRate,
    openCount: openTrades?.length || 0,
    totalTrades: trades.length,
    weekTrades: weekTrades.length,
  }
}
