import { useState } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { getAttribution } from '../../api/client'

// v2 Phase 1 — Trade Retro. Reads the existing /api/analytics/attribution
// slices and runs a small ruleset to emit concrete, ranked findings the
// operator can act on. No new analytics endpoint, no ML — just hypotheses
// over slices the backend already computes.
//
// Findings hide when based on < MIN_N trades to avoid coin-flip noise.
const MIN_N = 8

// Each rule takes the attribution payload and returns a finding or null.
// Findings: { id, severity, title, detail, slice, action? }
//   severity: 'red' (losing) | 'amber' (watch) | 'green' (working)
function buildFindings(attr) {
  if (!attr) return []
  const findings = []

  // Overall expectancy headline
  if (attr.totalTrades >= MIN_N) {
    const net = attr.totalPnl
    findings.push({
      id: 'overall',
      severity: net > 0 ? 'green' : 'red',
      title: net > 0
        ? `Net +$${net.toFixed(0)} over ${attr.totalTrades} trades (last ${attr.windowDays}d)`
        : `Net −$${Math.abs(net).toFixed(0)} over ${attr.totalTrades} trades (last ${attr.windowDays}d)`,
      detail: net > 0 ? 'System is net positive in this window.' : 'System is bleeding — findings below show where.',
      slice: null,
    })
  }

  // Exit-reason: are manual/forced closes worse than disciplined stops?
  emitSliceExtremes(findings, attr.byExitReason, 'exit reason', {
    lowWinThreshold: 35,
    idPrefix: 'exit',
  })

  // Day-of-week clustering
  emitDayOfWeek(findings, attr.byDayOfWeek)

  // Hold-duration: are same-day exits worse than swings?
  emitSliceExtremes(findings, attr.byHoldDuration, 'hold duration', {
    lowWinThreshold: 35,
    idPrefix: 'hold',
  })

  // Regime: which regime should we stop trading in?
  emitSliceExtremes(findings, attr.byRegime, 'regime', {
    lowWinThreshold: 35,
    idPrefix: 'regime',
    action: (row) => ({
      label: `Gate BUYs in ${row.key}`,
      hint: 'Settings → Signal Tuning can tighten regime behavior',
    }),
  })

  // Repeat-offender symbols
  emitSymbolOffenders(findings, attr.bySymbol)

  // Rank: red first, then amber, then green; within a tier by |pnl| impact
  const sev = { red: 0, amber: 1, green: 2 }
  return findings.sort((a, b) => {
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity]
    const ap = Math.abs(a.slice?.pnl || 0)
    const bp = Math.abs(b.slice?.pnl || 0)
    return bp - ap
  })
}

// Emit a finding for the worst-performing bucket in a slice when it clears
// the sample-size floor and is meaningfully losing.
function emitSliceExtremes(findings, slice, label, opts) {
  if (!Array.isArray(slice)) return
  const eligible = slice.filter((r) => r.count >= MIN_N && r.key !== 'unknown')
  if (eligible.length === 0) return
  const worst = [...eligible].sort((a, b) => a.winRate - b.winRate)[0]
  if (worst && worst.winRate < opts.lowWinThreshold && worst.pnl < 0) {
    findings.push({
      id: `${opts.idPrefix}-${worst.key}`,
      severity: 'red',
      title: `${label}: "${worst.key}" wins ${worst.winRate}% (n=${worst.count}), net −$${Math.abs(worst.pnl).toFixed(0)}`,
      detail: `Lowest win-rate ${label} bucket. Avg P&L $${worst.avgPnl}/trade.`,
      slice: worst,
      action: opts.action ? opts.action(worst) : null,
    })
  }
  // Also surface the best bucket if it's strongly positive (validation)
  const best = [...eligible].sort((a, b) => b.pnl - a.pnl)[0]
  if (best && best.winRate >= 55 && best.pnl > 0 && best.key !== worst?.key) {
    findings.push({
      id: `${opts.idPrefix}-best-${best.key}`,
      severity: 'green',
      title: `${label}: "${best.key}" wins ${best.winRate}% (n=${best.count}), net +$${best.pnl.toFixed(0)}`,
      detail: `Your best ${label} bucket — lean into it.`,
      slice: best,
    })
  }
}

function emitDayOfWeek(findings, slice) {
  if (!Array.isArray(slice)) return
  const eligible = slice.filter((r) => r.count >= MIN_N && r.key !== 'unknown')
  if (eligible.length < 2) return
  const sorted = [...eligible].sort((a, b) => a.avgPnl - b.avgPnl)
  const worst = sorted[0]
  const best = sorted[sorted.length - 1]
  if (worst.avgPnl < 0 && best.avgPnl > 0 && Math.abs(worst.avgPnl) > Math.abs(best.avgPnl) * 1.5) {
    findings.push({
      id: `dow-${worst.key}`,
      severity: 'amber',
      title: `${worst.key} avg −$${Math.abs(worst.avgPnl).toFixed(0)}/trade vs ${best.key} +$${best.avgPnl.toFixed(0)} (n=${worst.count})`,
      detail: `${worst.key} is your worst weekday. Consider a ${worst.key} gate.`,
      slice: worst,
    })
  }
}

function emitSymbolOffenders(findings, slice) {
  if (!Array.isArray(slice)) return
  // A symbol that's lost on most of >=4 trades is a repeat offender even
  // below the MIN_N floor — per-symbol counts are naturally smaller.
  const offenders = slice
    .filter((r) => r.count >= 4 && r.winRate <= 30 && r.pnl < 0)
    .sort((a, b) => a.pnl - b.pnl)
  for (const o of offenders.slice(0, 2)) {
    findings.push({
      id: `sym-${o.key}`,
      severity: 'red',
      title: `${o.key}: lost on ${o.losses}/${o.count} trades, net −$${Math.abs(o.pnl).toFixed(0)}`,
      detail: 'Repeat offender — drop from watchlist or stop trading it in this regime.',
      slice: o,
    })
  }
}

const SEV_STYLE = {
  red: { dot: 'bg-accent-red', text: 'text-accent-red', border: 'border-accent-red/30' },
  amber: { dot: 'bg-accent-amber', text: 'text-accent-amber', border: 'border-accent-amber/30' },
  green: { dot: 'bg-accent-green', text: 'text-accent-green', border: 'border-accent-green/30' },
}

export default function TradeRetroCard() {
  const [days, setDays] = useState(30)
  const [expanded, setExpanded] = useState(true)
  const { data, isLoading } = useQuery({
    queryKey: ['attribution', days],
    queryFn: () => getAttribution(days),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const attr = data
  const findings = buildFindings(attr)
  const hasData = attr && attr.totalTrades > 0
  const enoughData = attr && attr.totalTrades >= MIN_N

  return (
    <div className="bg-surface border border-border rounded-lg">
      <div className="flex items-center justify-between px-3 pt-2 pb-1 border-b border-border/50">
        <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-2 text-left">
          <svg className={clsx('w-3 h-3 text-text-dim transition-transform', expanded && 'rotate-90')} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <h3 className="text-sm font-bold text-text-primary tracking-tight">Trade Retro</h3>
        </button>
        <div className="flex items-center gap-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={clsx(
                'px-1.5 py-0.5 text-[10px] font-mono rounded',
                days === d ? 'bg-accent-blue/20 text-accent-blue' : 'text-text-dim hover:text-text-primary',
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {expanded && (
        <div className="p-3 space-y-2">
          {isLoading ? (
            <p className="text-xs text-text-dim font-mono">Loading attribution…</p>
          ) : !hasData ? (
            <p className="text-xs text-text-dim font-mono">No closed trades in this window yet.</p>
          ) : !enoughData ? (
            <p className="text-xs text-text-muted font-mono">
              Only {attr.totalTrades} closed trade{attr.totalTrades === 1 ? '' : 's'} — need ≥ {MIN_N} for reliable
              findings. Net so far: {attr.totalPnl >= 0 ? '+' : '−'}${Math.abs(attr.totalPnl).toFixed(0)}.
            </p>
          ) : (
            <>
              {findings.map((f) => <FindingRow key={f.id} finding={f} />)}
              <StrategyMaeMfeTable byStrategy={attr.byStrategy} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Per-strategy MAE/MFE summary. Two things a pro needs to know at a glance:
//   1. Avg MAE close to typical stop-pct = stops well-placed; much wider
//      means noise is picking off stops before the trade had a chance.
//   2. MFE-capture %: realized pnl / avg MFE. < 40% = we exit at the
//      reversal trough; > 70% = we let winners run.
function StrategyMaeMfeTable({ byStrategy }) {
  if (!Array.isArray(byStrategy) || byStrategy.length === 0) return null
  const rows = byStrategy.filter((r) => r.count >= 3 && r.avgMaePct != null)
  if (rows.length === 0) return null
  return (
    <div className="rounded border border-border/60 bg-elevated/30 p-2">
      <p className="text-[10px] font-mono text-text-dim uppercase tracking-wide mb-1">
        Per-strategy MAE / MFE (capture %)
      </p>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2 text-[11px] font-mono">
            <span className="flex-1 text-text-primary truncate">{r.key}</span>
            <span className="text-text-dim">n={r.count}</span>
            <span className="w-14 text-right" title="avg max-adverse-excursion">
              MAE <span className="text-accent-red">{r.avgMaePct?.toFixed(1)}%</span>
            </span>
            <span className="w-14 text-right" title="avg max-favorable-excursion">
              MFE <span className="text-accent-green">+{r.avgMfePct?.toFixed(1)}%</span>
            </span>
            {r.mfeCapturePct != null && (
              <span
                className={clsx(
                  'w-12 text-right',
                  r.mfeCapturePct >= 70 ? 'text-accent-green'
                    : r.mfeCapturePct >= 40 ? 'text-accent-amber'
                      : 'text-accent-red',
                )}
                title="realized pnl as % of max favorable excursion — higher = let winners run"
              >
                {r.mfeCapturePct.toFixed(0)}%
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function FindingRow({ finding }) {
  const [open, setOpen] = useState(false)
  const style = SEV_STYLE[finding.severity] || SEV_STYLE.amber
  return (
    <div className={clsx('rounded border bg-elevated/30 p-2', style.border)}>
      <div className="flex items-start gap-2">
        <span className={clsx('w-2 h-2 rounded-full mt-1 flex-shrink-0', style.dot)} />
        <div className="flex-1 min-w-0">
          <p className={clsx('text-[11px] font-mono font-semibold leading-snug', style.text)}>{finding.title}</p>
          {finding.detail && <p className="text-[10px] text-text-dim font-mono mt-0.5 leading-snug">{finding.detail}</p>}
          {finding.action && (
            <p className="text-[10px] text-accent-blue font-mono mt-1">
              → {finding.action.label}
              {finding.action.hint && <span className="text-text-dim"> ({finding.action.hint})</span>}
            </p>
          )}
          {finding.slice && (
            <button onClick={() => setOpen((v) => !v)} className="text-[9px] text-text-dim font-mono mt-1 hover:text-text-muted">
              {open ? 'hide' : 'show'} numbers
            </button>
          )}
          {open && finding.slice && (
            <div className="mt-1 grid grid-cols-4 gap-1 text-[9px] font-mono text-text-muted">
              <span>n={finding.slice.count}</span>
              <span>W {finding.slice.wins}</span>
              <span>L {finding.slice.losses}</span>
              <span className={finding.slice.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}>
                ${finding.slice.pnl.toFixed(0)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
