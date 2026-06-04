import { useState } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { getHonestStats } from '../../api/client'

// "Honest P&L" card. The retro card surfaces per-bucket findings; this card
// answers a sharper question — "is the headline net even real, or does one
// trade carry it?" Mirrors the lib at src/lib/honest-stats.ts:
//   - Raw stats (all closed trades)
//   - Robust stats (MAD-outlier-stripped)
//   - One-trade-carries-book warning when largest win > 40% of gross profit
//   - byClass + byExitReason tables behind a details toggle
//
// Header color is red on purpose: the card exists to push back on flattering
// dashboard numbers. The other amber/blue cards are for context; this one is
// for "stop fooling yourself."
const MONEY = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString()
const PCT = (n) => `${Math.round(n * 100)}%`
const PF = (n) => (n == null ? 'inf' : n.toFixed(2))

export default function HonestStatsCard() {
  const [days, setDays] = useState(30)
  const [expanded, setExpanded] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['honest-stats', days],
    queryFn: () => getHonestStats(days),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const r = data
  const hasData = r && r.raw && r.raw.n > 0

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="h-1 bg-accent-red/70" />
      <div className="flex items-center justify-between px-3 pt-2 pb-1 border-b border-border/50 bg-accent-red/5">
        <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-2 text-left">
          <svg className={clsx('w-3 h-3 text-text-dim transition-transform', expanded && 'rotate-90')} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <h3 className="text-sm font-bold text-text-primary tracking-tight">Honest P&amp;L</h3>
          <span className="text-[10px] text-text-dim font-mono">outlier-stripped view</span>
        </button>
        <div className="flex items-center gap-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={clsx(
                'px-1.5 py-0.5 text-[10px] font-mono rounded',
                days === d ? 'bg-accent-red/20 text-accent-red' : 'text-text-dim hover:text-text-primary',
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="p-3 space-y-2">
        {isLoading ? (
          <p className="text-xs text-text-dim font-mono">Loading…</p>
        ) : !hasData ? (
          <p className="text-xs text-text-dim font-mono">No closed trades in this window yet.</p>
        ) : (
          <>
            <RawVsRobust raw={r.raw} robust={r.robust} outliers={r.outliers?.length || 0} />

            {r.oneTradeCarriesBook && r.largestWin > 0 && (
              <CarryWarning r={r} />
            )}

            {r.outliers?.length > 0 && (
              <OutliersChips outliers={r.outliers} />
            )}

            {expanded && (
              <>
                <GroupTable title="By asset class" map={r.byClass} />
                <GroupTable title="By exit reason" map={r.byExitReason} />
              </>
            )}

            {!expanded && (
              <button
                onClick={() => setExpanded(true)}
                className="text-[10px] text-text-dim font-mono hover:text-accent-red"
              >
                show full breakdown →
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// Raw vs Robust comparison — two stacked rows so the eye spots the divergence.
function RawVsRobust({ raw, robust, outliers }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <StatBlock label="Raw" sub={`all ${raw.n} closed`} stats={raw} accent="text-text-primary" />
      <StatBlock
        label="Robust"
        sub={outliers ? `${outliers} outlier${outliers === 1 ? '' : 's'} stripped` : 'no outliers'}
        stats={robust}
        accent="text-accent-red"
      />
    </div>
  )
}

function StatBlock({ label, sub, stats, accent }) {
  const net = stats.net
  return (
    <div className="rounded border border-border/60 bg-elevated/30 p-2">
      <p className={clsx('text-[9px] font-mono uppercase tracking-wide', accent)}>{label}</p>
      <p className={clsx('text-base font-mono font-bold mt-0.5', net >= 0 ? 'text-accent-green' : 'text-accent-red')}>
        {MONEY(net)}
      </p>
      <div className="flex items-center gap-2 text-[10px] font-mono text-text-dim mt-1">
        <span>n={stats.n}</span>
        <span>·</span>
        <span>win {PCT(stats.winRate)}</span>
        <span>·</span>
        <span>pf {PF(stats.profitFactor)}</span>
      </div>
      <p className="text-[9px] text-text-dim font-mono mt-0.5">{sub}</p>
    </div>
  )
}

// The "one trade carries the book" warning. The whole point of the card.
function CarryWarning({ r }) {
  return (
    <div className="rounded border border-accent-red/40 bg-accent-red/5 p-2">
      <p className="text-[11px] font-mono font-semibold text-accent-red leading-snug">
        ⚠ Largest win {MONEY(r.largestWin)} = {PCT(r.largestWinPctOfGrossProfit)} of all gross profit
      </p>
      <p className="text-[10px] font-mono text-text-muted leading-snug mt-1">
        Net excluding the largest win: <span className={r.netExcludingLargestWin >= 0 ? 'text-accent-green' : 'text-accent-red'}>{MONEY(r.netExcludingLargestWin)}</span>
      </p>
      <p className="text-[10px] font-mono text-text-dim leading-snug mt-1">
        One trade is carrying the book. Treat the raw net as unrepeatable until the pattern shows up in more than one position.
      </p>
    </div>
  )
}

function OutliersChips({ outliers }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[9px] font-mono text-text-dim uppercase tracking-wide">Outliers</span>
      {outliers.map((o) => (
        <span
          key={`${o.symbol}-${o.pnl}`}
          className={clsx(
            'text-[10px] font-mono px-1.5 py-0.5 rounded',
            o.pnl >= 0 ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red',
          )}
          title="MAD-outlier (|x − median| > 5 × scaled MAD)"
        >
          {o.symbol} {MONEY(o.pnl)}
        </span>
      ))}
    </div>
  )
}

// Generic byClass / byExitReason table. Sorted by net desc so the carriers
// and the bleeders flank the middle. Hides buckets below the noise floor.
function GroupTable({ title, map }) {
  const rows = Object.entries(map || {})
    .map(([key, s]) => ({ key, ...s }))
    .filter((r) => r.n >= 3)
    .sort((a, b) => b.net - a.net)
  if (rows.length === 0) return null
  return (
    <div className="rounded border border-border/60 bg-elevated/30 p-2">
      <p className="text-[10px] font-mono text-text-dim uppercase tracking-wide mb-1">{title}</p>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2 text-[11px] font-mono">
            <span className="text-text-primary truncate">{r.key}</span>
            <span className="text-text-dim w-10 text-right">n={r.n}</span>
            <span className="text-text-dim w-10 text-right">{PCT(r.winRate)}</span>
            <span className={clsx('w-16 text-right', r.net >= 0 ? 'text-accent-green' : 'text-accent-red')}>
              {MONEY(r.net)}
            </span>
            <span className="text-text-dim w-10 text-right">pf {PF(r.profitFactor)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
