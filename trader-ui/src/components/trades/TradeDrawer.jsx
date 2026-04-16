import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { format, parseISO } from 'date-fns'
import Badge from '../shared/Badge'
import PnlCell from '../shared/PnlCell'
import { getTrade } from '../../api/client'

export default function TradeDrawer({ trade, onClose }) {
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Fetch enriched detail (signals + decisions)
  const { data: detail } = useQuery({
    queryKey: ['trade-detail', trade?.id],
    queryFn: () => getTrade(trade.id),
    enabled: !!trade?.id,
    staleTime: 30000,
  })

  if (!trade) return null

  const t = detail || trade
  const entry = Number(t.entry_price)
  const stop = Number(t.stop_loss)
  const target = Number(t.take_profit)
  const exit = t.exit_price ? Number(t.exit_price) : null
  const pnl = t.pnl ? Number(t.pnl) : null
  const pnlPct = t.pnl_pct ? Number(t.pnl_pct) : (pnl && entry ? (pnl / (entry * Number(t.qty))) * 100 : null)

  // Mini P&L bar
  const range = target - stop
  const entryPct = range > 0 ? ((entry - stop) / range) * 100 : 50
  const currentPct = exit != null && range > 0 ? ((exit - stop) / range) * 100 : null

  const signals = detail?.signals || []
  const decisions = detail?.decisions || []
  const sellSignal = signals.find(s => s.signal === 'SELL')
  const buySignal = detail?.entrySignal || signals.find(s => s.signal === 'BUY')

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} />

      <div className="fixed right-0 top-0 bottom-0 w-[520px] bg-surface border-l border-border z-50 overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-surface z-10">
          <div className="flex items-center gap-3">
            <h3 className="font-mono font-bold text-lg">{t.symbol}</h3>
            <Badge variant={t.status === 'open' ? 'open' : 'closed'}>{t.status}</Badge>
            <Badge variant={t.side?.toLowerCase() === 'buy' ? 'buy' : 'sell'}>{t.side}</Badge>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Trade details grid */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Detail label="Quantity" value={t.qty} mono />
            <Detail label="Entry Price" value={`$${entry.toFixed(2)}`} mono />
            <Detail label="Stop Loss" value={`$${stop.toFixed(2)}`} mono className="text-accent-red/70" />
            <Detail label="Take Profit" value={`$${target.toFixed(2)}`} mono className="text-accent-green/70" />
            {exit != null && <Detail label="Exit Price" value={`$${exit.toFixed(2)}`} mono />}
            {t.exit_reason && <Detail label="Exit Reason" value={<ExitReasonBadge reason={t.exit_reason} />} />}
            <Detail label="Opened" value={format(parseISO(t.created_at), 'MMM d, h:mm a')} />
            {t.closed_at && <Detail label="Closed" value={format(parseISO(t.closed_at), 'MMM d, h:mm a')} />}
            {t.scale_ins_count > 0 && (
              <Detail
                label="Scale-ins"
                value={`${t.scale_ins_count}× (${t.original_qty || '?'} → ${t.qty})`}
                mono
                className="text-accent-amber"
              />
            )}
          </div>

          {/* P&L summary */}
          {pnl != null && (
            <div className="border border-border rounded-lg p-4">
              <p className="text-xs text-text-muted uppercase tracking-wide mb-2">Profit / Loss</p>
              <PnlCell dollar={pnl} pct={pnlPct} />
            </div>
          )}

          {/* Mini P&L bar */}
          <div className="border border-border rounded-lg p-4">
            <p className="text-xs text-text-muted uppercase tracking-wide mb-3">Price Range (Stop -> Target)</p>
            <div className="relative h-2 bg-elevated rounded-full">
              <div
                className="absolute top-1/2 -translate-y-1/2 w-2 h-4 bg-accent-blue rounded-sm"
                style={{ left: `${Math.min(Math.max(entryPct, 0), 100)}%` }}
                title={`Entry: $${entry.toFixed(2)}`}
              />
              {currentPct != null && (
                <div
                  className={`absolute top-1/2 -translate-y-1/2 w-2 h-4 rounded-sm ${pnl >= 0 ? 'bg-accent-green' : 'bg-accent-red'}`}
                  style={{ left: `${Math.min(Math.max(currentPct, 0), 100)}%` }}
                  title={`Exit: $${exit.toFixed(2)}`}
                />
              )}
            </div>
            <div className="flex justify-between mt-2 text-[10px] font-mono text-text-dim">
              <span>Stop ${stop.toFixed(2)}</span>
              <span>Target ${target.toFixed(2)}</span>
            </div>
          </div>

          {/* Entry Decision */}
          {buySignal && (
            <Section title="Entry Reason">
              <ReasonCard signal={buySignal} kind="buy" />
            </Section>
          )}

          {/* Sell Reason — prominent */}
          {sellSignal && (
            <Section title="Sell Reason" emphasis>
              <ReasonCard signal={sellSignal} kind="sell" exitReason={t.exit_reason} />
            </Section>
          )}

          {/* Decision Timeline */}
          {decisions.length > 0 && (
            <Section title={`Orchestrator Decisions (${decisions.length})`}>
              <div className="space-y-2">
                {decisions.map(d => <DecisionCard key={d.id} decision={d} />)}
              </div>
            </Section>
          )}

          {/* Fallback — no enriched data */}
          {!buySignal && !sellSignal && decisions.length === 0 && (
            <div className="border border-border rounded-lg p-4 text-center text-text-dim text-xs">
              No agent decisions or signals linked to this trade. It may have been placed via chat or manual override.
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Section({ title, children, emphasis }) {
  return (
    <div>
      <h4 className={clsx(
        'text-xs font-semibold uppercase tracking-wide mb-2',
        emphasis ? 'text-accent-red' : 'text-text-muted',
      )}>
        {title}
      </h4>
      {children}
    </div>
  )
}

function ReasonCard({ signal, kind, exitReason }) {
  return (
    <div className={clsx(
      'border rounded-lg p-4',
      kind === 'buy' ? 'border-accent-green/20 bg-accent-green/5' : 'border-accent-red/20 bg-accent-red/5',
    )}>
      <div className="flex items-center justify-between mb-2">
        <span className={clsx(
          'text-xs font-mono font-semibold',
          kind === 'buy' ? 'text-accent-green' : 'text-accent-red',
        )}>
          {signal.signal}
        </span>
        <span className="text-[10px] font-mono text-text-dim">
          ${Number(signal.close).toFixed(2)} at {format(parseISO(signal.created_at), 'h:mm:ss a')}
        </span>
      </div>
      {exitReason && kind === 'sell' && (
        <div className="mb-2">
          <ExitReasonBadge reason={exitReason} />
        </div>
      )}
      <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
        {signal.reason || 'No reason recorded'}
      </p>
    </div>
  )
}

function DecisionCard({ decision }) {
  const inputs = typeof decision.agent_inputs === 'string'
    ? safeParse(decision.agent_inputs) : decision.agent_inputs
  const supporting = inputs?.supporting || []
  const dissenting = inputs?.dissenting || []
  const agentInputs = inputs?.inputs || {}
  const calibration = inputs?.calibration || {}

  // "Tipping agent" = the supporting agent whose calibrated (adjusted)
  // confidence is highest. That's the vote that moved the orchestrator
  // most in favor of the action. If there are no supporters, we fall
  // back to the highest-adjusted agent overall so the user still learns
  // which voice carried the loudest weight.
  const tippingAgent = (() => {
    const pool = supporting.length > 0 ? supporting : Object.keys(agentInputs)
    let best = null
    let bestAdj = -Infinity
    for (const name of pool) {
      const adj = agentInputs[name]?.adjustedConfidence ?? agentInputs[name]?.confidence ?? 0
      if (adj > bestAdj) { bestAdj = adj; best = name }
    }
    return best
  })()

  return (
    <div className="border border-border rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className={clsx(
          'text-xs font-mono font-semibold px-2 py-0.5 rounded',
          decision.action === 'BUY' && 'bg-accent-green/10 text-accent-green',
          decision.action === 'SELL' && 'bg-accent-red/10 text-accent-red',
          decision.action === 'HOLD' && 'bg-text-muted/10 text-text-muted',
        )}>
          {decision.action}
        </span>
        <span className="text-[10px] font-mono text-text-dim">
          conf {(decision.confidence * 100).toFixed(0)}%
        </span>
        <span className="text-[10px] text-text-dim ml-auto">
          {format(parseISO(decision.created_at), 'h:mm:ss a')}
        </span>
      </div>
      <p className="text-xs text-text-primary leading-relaxed mb-2">{decision.reasoning}</p>
      {(supporting.length > 0 || dissenting.length > 0) && (
        <div className="flex flex-wrap gap-1 text-[10px] font-mono">
          {supporting.map(a => (
            <span key={a} className="px-1.5 py-0.5 bg-accent-green/10 text-accent-green rounded">+{a}</span>
          ))}
          {dissenting.map(a => (
            <span key={a} className="px-1.5 py-0.5 bg-accent-red/10 text-accent-red rounded">-{a}</span>
          ))}
        </div>
      )}
      {Object.keys(agentInputs).length > 0 && (
        <AgentBreakdown
          agentInputs={agentInputs}
          calibration={calibration}
          supporting={supporting}
          dissenting={dissenting}
          tippingAgent={tippingAgent}
        />
      )}
    </div>
  )
}

/**
 * Per-agent attribution: reported confidence vs calibrated (adjusted)
 * confidence, win-rate over its 30-day sample, cold-start flag, and
 * the "tipping agent" highlight (amber ★). Reads the calibration
 * snapshot that the orchestrator persists in agent_inputs.calibration.
 */
function AgentBreakdown({ agentInputs, calibration, supporting, dissenting, tippingAgent }) {
  const rows = Object.entries(agentInputs)
    .map(([name, r]) => {
      const cal = calibration[name] || {}
      const adjusted = r?.adjustedConfidence ?? r?.confidence ?? 0
      return {
        name,
        signal: r?.signal || '--',
        reported: r?.reportedConfidence ?? r?.confidence ?? 0,
        adjusted,
        winRate: cal.winRate,
        sampleSize: cal.sampleSize,
        coldStart: cal.sampleSize == null || cal.sampleSize < 10,
        role: supporting.includes(name) ? 'support' : dissenting.includes(name) ? 'dissent' : 'neutral',
      }
    })
    .sort((a, b) => b.adjusted - a.adjusted)

  return (
    <div className="mt-3 border-t border-border/50 pt-2">
      <p className="text-[10px] font-mono text-text-dim uppercase tracking-wide mb-1.5">
        Agent breakdown — reported vs calibrated
      </p>
      <div className="space-y-1.5">
        {rows.map(row => (
          <AgentRow key={row.name} {...row} isTipping={row.name === tippingAgent} />
        ))}
      </div>
    </div>
  )
}

function AgentRow({ name, signal, reported, adjusted, winRate, sampleSize, coldStart, role, isTipping }) {
  const delta = adjusted - reported
  const roleColor = role === 'support' ? 'text-accent-green' : role === 'dissent' ? 'text-accent-red' : 'text-text-muted'
  return (
    <div className={clsx(
      'grid grid-cols-[110px_44px_1fr_80px] items-center gap-2 text-[10px] font-mono',
      isTipping && 'bg-accent-amber/5 -mx-1 px-1 py-0.5 rounded'
    )}>
      <div className="flex items-center gap-1 min-w-0">
        {isTipping && <span className="text-accent-amber" title="Tipping agent">★</span>}
        <span className={clsx('truncate', roleColor)} title={name}>{name}</span>
      </div>
      <span className={clsx(
        'px-1 py-0.5 rounded text-center text-[9px] font-semibold',
        signal === 'BUY' && 'bg-accent-green/10 text-accent-green',
        signal === 'SELL' && 'bg-accent-red/10 text-accent-red',
        (signal === 'HOLD' || signal === '--') && 'bg-elevated text-text-muted',
      )}>{signal}</span>
      <ConfidenceBar reported={reported} adjusted={adjusted} />
      <div className="text-right text-[9px] text-text-dim">
        {coldStart ? (
          <span title={`Cold-start (${sampleSize ?? 0} trades) — neutral 0.5 weight`} className="text-text-muted">
            cold ({sampleSize ?? 0})
          </span>
        ) : (
          <span title={`${sampleSize} closed trades in 30d${delta !== 0 ? ` · delta ${delta > 0 ? '+' : ''}${(delta * 100).toFixed(0)}%` : ''}`}>
            {(winRate * 100).toFixed(0)}% · n={sampleSize}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Thin bar: grey track = reported confidence, coloured fill = adjusted.
 * If adjusted < reported (low-calibration agent dampened), the grey
 * tail is visible past the fill; if adjusted > reported (trusted agent
 * amplified, rare), fill runs past the reported tick.
 */
function ConfidenceBar({ reported, adjusted }) {
  const repPct = Math.min(100, Math.max(0, reported * 100))
  const adjPct = Math.min(100, Math.max(0, adjusted * 100))
  return (
    <div className="relative h-2 bg-elevated rounded-full overflow-hidden" title={`reported ${repPct.toFixed(0)}% → calibrated ${adjPct.toFixed(0)}%`}>
      <div className="absolute inset-y-0 left-0 bg-text-muted/30" style={{ width: `${repPct}%` }} />
      <div className="absolute inset-y-0 left-0 bg-accent-blue/70" style={{ width: `${adjPct}%` }} />
      {repPct > 0 && repPct < 100 && (
        <div className="absolute inset-y-0 w-px bg-text-dim" style={{ left: `${repPct}%` }} />
      )}
    </div>
  )
}

const EXIT_REASON_LABELS = {
  stop_loss: { label: 'Stop Loss Hit', color: 'red' },
  take_profit: { label: 'Take Profit Hit', color: 'green' },
  trailing_stop: { label: 'Trailing Stop', color: 'amber' },
  orchestrator_sell: { label: 'Agent Decision', color: 'blue' },
  bracket_stop: { label: 'Bracket Stop', color: 'red' },
  chat_manual: { label: 'Manual (Chat)', color: 'blue' },
  partial_exit: { label: 'Partial Exit', color: 'amber' },
  drawdown_breaker: { label: 'Drawdown Breaker', color: 'red' },
}

function ExitReasonBadge({ reason }) {
  const meta = EXIT_REASON_LABELS[reason] || { label: reason, color: 'muted' }
  const colorClasses = {
    red: 'bg-accent-red/10 text-accent-red border-accent-red/30',
    green: 'bg-accent-green/10 text-accent-green border-accent-green/30',
    amber: 'bg-accent-amber/10 text-accent-amber border-accent-amber/30',
    blue: 'bg-accent-blue/10 text-accent-blue border-accent-blue/30',
    muted: 'bg-elevated text-text-muted border-border',
  }
  return (
    <span className={clsx('inline-block px-2 py-0.5 text-[11px] font-mono font-medium rounded border', colorClasses[meta.color])}>
      {meta.label}
    </span>
  )
}

function safeParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

function Detail({ label, value, mono, className }) {
  return (
    <div>
      <p className="text-xs text-text-muted">{label}</p>
      <div className={`${mono ? 'font-mono' : ''} text-text-primary ${className || ''}`}>{value}</div>
    </div>
  )
}
