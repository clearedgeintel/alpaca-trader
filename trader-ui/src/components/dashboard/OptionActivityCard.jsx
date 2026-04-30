import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { formatDistanceToNow, isToday, parseISO } from 'date-fns'
import { useAllTrades, useOpenTrades, useAccount } from '../../hooks/useQueries'
import { getConfig } from '../../api/client'
import StockLogo from '../shared/StockLogo'

/**
 * Options activity dashboard card. Surfaces:
 *   - Open option position count + aggregate Greeks (Δ, Θ, V at entry)
 *   - Per-underlying delta-notional bars (long/short, color-coded)
 *   - Today's flow: opens, closes, realized P&L on closed contracts
 *
 * Data is pulled from the existing trades + positions queries — zero
 * new API calls. Greeks are entry-time snapshots (not live), which is
 * fine for a directional dashboard view; precise risk lives in the
 * risk-agent's aggregate-delta gate at execution time.
 *
 * Hidden entirely when:
 *   - OPTIONS_ENABLED is off AND there are no option trades anywhere
 * (so users who never use options never see this card).
 */
export default function OptionActivityCard() {
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: getConfig, staleTime: 60_000 })
  const optionsEnabled = config?.optionsEnabled === true
  const { data: openTrades = [] } = useOpenTrades()
  const { data: allTrades = [] } = useAllTrades()
  const { data: account } = useAccount()

  // Filter to option rows. The DB column is option_type (call|put);
  // equities have NULL there.
  const openOptions = useMemo(() => openTrades.filter((t) => t.option_type), [openTrades])
  const allOptions = useMemo(() => allTrades.filter((t) => t.option_type), [allTrades])

  // Today's events
  const today = useMemo(() => {
    const opens = []
    const closes = []
    let realizedPnl = 0
    let realizedCount = 0
    for (const t of allOptions) {
      const opened = t.created_at ? parseISO(t.created_at) : null
      const closed = t.closed_at ? parseISO(t.closed_at) : null
      if (opened && isToday(opened)) opens.push(t)
      if (closed && isToday(closed)) {
        closes.push(t)
        realizedCount++
        realizedPnl += Number(t.pnl) || 0
      }
    }
    return { opens, closes, realizedPnl, realizedCount }
  }, [allOptions])

  // Aggregate open Greeks. Δ-notional uses entry premium as a fallback
  // for the underlying price proxy when current_price hasn't been
  // updated by the monitor yet. It's a directional view, not precise.
  const exposure = useMemo(() => {
    let totalDelta = 0
    let totalTheta = 0
    let totalVega = 0
    let totalPremium = 0
    let totalDeltaNotional = 0
    const byUnderlying = {}
    for (const t of openOptions) {
      const qty = Number(t.qty) || 0
      const mult = t.contract_multiplier || 100
      const delta = t.delta != null ? Number(t.delta) : null
      const theta = t.theta != null ? Number(t.theta) : null
      const vega = t.vega != null ? Number(t.vega) : null
      const premium = Number(t.current_price) || Number(t.entry_price) || 0
      totalPremium += premium * qty * mult
      if (delta != null) totalDelta += delta * qty * mult
      if (theta != null) totalTheta += theta * qty * mult
      if (vega != null) totalVega += vega * qty * mult

      // Δ-notional needs an underlying price. We don't have it on the
      // option row directly; approximate via strike when delta is high
      // (ATM contracts have strike ≈ spot). Better than dropping it.
      const strike = t.strike != null ? Number(t.strike) : 0
      const dn = delta != null && strike > 0 ? Math.abs(delta) * qty * mult * strike : 0
      totalDeltaNotional += dn

      const u = t.underlying || 'unknown'
      if (!byUnderlying[u]) byUnderlying[u] = { underlying: u, delta: 0, deltaNotional: 0, count: 0, premium: 0 }
      byUnderlying[u].delta += (delta != null ? delta : 0) * qty * mult
      byUnderlying[u].deltaNotional += dn
      byUnderlying[u].count += 1
      byUnderlying[u].premium += premium * qty * mult
    }
    const groups = Object.values(byUnderlying).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    return {
      totalDelta,
      totalTheta,
      totalVega,
      totalPremium,
      totalDeltaNotional,
      groups,
    }
  }, [openOptions])

  const portfolioValue = Number(account?.portfolio_value) || 0
  const deltaPct = portfolioValue > 0 ? (exposure.totalDeltaNotional / portfolioValue) * 100 : null
  const premiumPct = portfolioValue > 0 ? (exposure.totalPremium / portfolioValue) * 100 : null

  // Hide entirely when options are off AND there's no historical option
  // activity. This keeps the dashboard clean for equity-only users.
  if (!optionsEnabled && openOptions.length === 0 && allOptions.length === 0) {
    return null
  }

  const empty = openOptions.length === 0 && today.opens.length === 0 && today.closes.length === 0

  return (
    <div className="bg-surface border border-border rounded-lg shadow-sm shadow-black/20">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div>
          <h3 className="text-sm font-bold text-text-primary tracking-tight">
            Option Activity
            {openOptions.length > 0 && (
              <span className="ml-1.5 text-text-dim font-mono text-xs font-normal">
                ({openOptions.length} open)
              </span>
            )}
          </h3>
          {!optionsEnabled && (
            <p className="text-[10px] text-accent-amber font-mono mt-0.5">
              Options trading disabled — showing existing positions only
            </p>
          )}
        </div>
        <Link to="/positions" className="text-[11px] text-text-dim hover:text-accent-blue font-mono">view all →</Link>
      </div>

      {empty ? (
        <div className="p-6 text-xs text-text-dim text-center">
          {optionsEnabled
            ? 'No option positions yet. Open one from the chain browser or via the agency.'
            : 'No option activity recorded.'}
        </div>
      ) : (
        <div className="p-3 space-y-3">
          {/* Top metrics row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Tile
              label="Open Δ"
              value={exposure.totalDelta.toFixed(0)}
              sub={deltaPct != null ? `${deltaPct.toFixed(1)}% notional` : ''}
              color={exposure.totalDelta > 0 ? 'text-accent-green' : exposure.totalDelta < 0 ? 'text-accent-red' : 'text-text-primary'}
              hint="Net delta share-equivalent across all open contracts"
            />
            <Tile
              label="Daily Θ"
              value={`$${exposure.totalTheta.toFixed(2)}`}
              sub="per day"
              color="text-accent-amber"
              hint="Premium decay per day across the option book"
            />
            <Tile
              label="Premium"
              value={`$${exposure.totalPremium.toFixed(0)}`}
              sub={premiumPct != null ? `${premiumPct.toFixed(1)}% pv` : ''}
              hint="Total dollars at risk in option premium"
            />
            <Tile
              label="Today P&L"
              value={`${today.realizedPnl >= 0 ? '+' : ''}$${today.realizedPnl.toFixed(2)}`}
              sub={today.realizedCount > 0 ? `${today.realizedCount} closed` : 'no closes'}
              color={today.realizedPnl > 0 ? 'text-accent-green' : today.realizedPnl < 0 ? 'text-accent-red' : 'text-text-muted'}
              hint="Realized P&L on options closed today"
            />
          </div>

          {/* Delta heatmap — per-underlying bars centered on zero */}
          {exposure.groups.length > 0 && (
            <DeltaHeatmap groups={exposure.groups} portfolioValue={portfolioValue} />
          )}

          {/* Today's flow */}
          {(today.opens.length > 0 || today.closes.length > 0) && (
            <TodayFlow opens={today.opens} closes={today.closes} />
          )}
        </div>
      )}
    </div>
  )
}

function Tile({ label, value, sub, color, hint }) {
  return (
    <div className="bg-elevated rounded px-2 py-1.5" title={hint}>
      <p className="text-[9px] text-text-dim font-mono uppercase tracking-wide">{label}</p>
      <p className={clsx('font-mono text-sm font-semibold', color || 'text-text-primary')}>{value}</p>
      {sub && <p className="text-[9px] text-text-dim font-mono">{sub}</p>}
    </div>
  )
}

/**
 * Per-underlying delta heatmap. Bars are centered horizontally so
 * positive (long) extends right and negative (short) extends left.
 * Width is proportional to that underlying's delta-notional vs
 * the largest absolute exposure in the set.
 */
function DeltaHeatmap({ groups, portfolioValue }) {
  const maxAbsDelta = groups.reduce((m, g) => Math.max(m, Math.abs(g.delta)), 0) || 1

  return (
    <div>
      <p className="text-[10px] text-text-dim font-mono uppercase tracking-wide mb-1.5">Delta exposure by underlying</p>
      <div className="space-y-1">
        {groups.slice(0, 8).map((g) => {
          const widthPct = (Math.abs(g.delta) / maxAbsDelta) * 50
          const isLong = g.delta >= 0
          const notionalPct = portfolioValue > 0 ? (g.deltaNotional / portfolioValue) * 100 : null
          return (
            <div key={g.underlying} className="flex items-center gap-2 text-[11px] font-mono">
              <span className="w-12 truncate text-text-primary">{g.underlying}</span>
              {/* Bar with zero in the middle */}
              <div className="flex-1 relative h-2.5 bg-elevated rounded overflow-hidden">
                <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                {isLong ? (
                  <div
                    className="absolute inset-y-0 left-1/2 bg-accent-green/60"
                    style={{ width: `${widthPct}%` }}
                  />
                ) : (
                  <div
                    className="absolute inset-y-0 right-1/2 bg-accent-red/60"
                    style={{ width: `${widthPct}%` }}
                  />
                )}
              </div>
              <span
                className={clsx(
                  'w-16 text-right',
                  isLong ? 'text-accent-green' : 'text-accent-red',
                )}
              >
                {isLong ? '+' : ''}
                {g.delta.toFixed(0)} Δ
              </span>
              <span className="w-14 text-right text-text-dim text-[10px]">
                {g.count}× {notionalPct != null ? `${notionalPct.toFixed(1)}%` : ''}
              </span>
            </div>
          )
        })}
      </div>
      {groups.length > 8 && (
        <p className="text-[9px] text-text-dim font-mono mt-1">…and {groups.length - 8} more underlyings</p>
      )}
    </div>
  )
}

/**
 * Compact "today's option flow" log — opens (▲) and closes (▼) with
 * timestamps. Shows up to 6 events newest first.
 */
function TodayFlow({ opens, closes }) {
  const events = []
  for (const t of opens) {
    events.push({ kind: 'open', t, ts: t.created_at })
  }
  for (const t of closes) {
    events.push({ kind: 'close', t, ts: t.closed_at })
  }
  events.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))

  return (
    <div>
      <p className="text-[10px] text-text-dim font-mono uppercase tracking-wide mb-1.5">Today</p>
      <div className="space-y-0.5">
        {events.slice(0, 6).map((e, i) => (
          <FlowRow key={i} event={e} />
        ))}
      </div>
    </div>
  )
}

function FlowRow({ event }) {
  const t = event.t
  const isOpen = event.kind === 'open'
  const pnl = !isOpen && t.pnl != null ? Number(t.pnl) : null
  const ts = event.ts ? formatDistanceToNow(parseISO(event.ts), { addSuffix: true }) : ''
  const isCall = t.option_type === 'call'

  return (
    <div className="flex items-center gap-2 text-[11px] font-mono px-1 py-0.5 rounded hover:bg-elevated/40">
      <span className={clsx('w-3 text-center', isOpen ? 'text-accent-blue' : 'text-text-muted')}>
        {isOpen ? '▲' : '▼'}
      </span>
      <StockLogo symbol={t.underlying || t.symbol} size={16} />
      <span className="text-text-primary w-10 truncate">{t.underlying || '—'}</span>
      <span className={clsx(
        'text-[9px] font-bold uppercase px-1 py-0.5 rounded',
        isCall ? 'bg-accent-green/20 text-accent-green' : 'bg-accent-red/20 text-accent-red',
      )}>
        {t.option_type}
      </span>
      <span className="text-text-dim w-14 text-right">${t.strike != null ? Number(t.strike).toFixed(0) : '—'}</span>
      <span className="text-text-dim w-10 text-right">×{t.qty}</span>
      {pnl != null ? (
        <span className={clsx(
          'flex-1 text-right',
          pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-text-muted',
        )}>
          {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
        </span>
      ) : (
        <span className="flex-1 text-right text-text-dim">opened</span>
      )}
      <span className="text-text-dim text-[10px] flex-shrink-0">{ts}</span>
    </div>
  )
}
