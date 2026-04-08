import { useState } from 'react'
import clsx from 'clsx'
import Badge from '../components/shared/Badge'
import { LoadingTable } from '../components/shared/LoadingState'
import { useDecisions } from '../hooks/useQueries'
import { format, parseISO } from 'date-fns'

export default function DecisionsView() {
  const { data: decisions, isLoading } = useDecisions(50)

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-text-primary">Orchestrator Decisions</h2>

      {isLoading ? (
        <LoadingTable rows={6} cols={6} />
      ) : !decisions || decisions.length === 0 ? (
        <div className="text-center text-text-muted text-sm py-8">
          No decisions yet. Enable agency mode (USE_AGENCY=true) to start.
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="divide-y divide-border">
            {decisions.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function DecisionRow({ decision }) {
  const [expanded, setExpanded] = useState(false)

  const inputs = decision.agent_inputs || {}
  const supporting = inputs.supporting || []
  const dissenting = inputs.dissenting || []

  return (
    <div>
      {/* Summary row */}
      <div
        className="flex items-center gap-4 px-4 py-3 hover:bg-elevated/50 cursor-pointer transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="font-mono text-sm font-semibold text-text-primary w-16">
          {decision.symbol}
        </span>

        <Badge variant={decision.action === 'BUY' ? 'buy' : decision.action === 'SELL' ? 'sell' : 'open'}>
          {decision.action}
        </Badge>

        <ConfidencePill value={decision.confidence} />

        <p className="flex-1 text-xs text-text-muted truncate">
          {decision.reasoning}
        </p>

        <span className="text-xs font-mono text-text-dim">
          {decision.created_at ? format(parseISO(decision.created_at), 'MMM d HH:mm') : '—'}
        </span>

        <svg
          className={clsx('w-4 h-4 text-text-dim transition-transform', expanded && 'rotate-180')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 bg-elevated/30 border-t border-border">
          <div className="grid grid-cols-2 gap-4 pt-3">
            {/* Reasoning */}
            <div>
              <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Reasoning</h4>
              <p className="text-sm text-text-primary leading-relaxed">{decision.reasoning}</p>
            </div>

            {/* Agent Consensus */}
            <div>
              <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Agent Consensus</h4>

              {supporting.length > 0 && (
                <div className="mb-2">
                  <span className="text-xs text-text-muted">Supporting: </span>
                  {supporting.map((name) => (
                    <span key={name} className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono bg-accent-green/10 text-accent-green rounded mr-1">
                      {name}
                    </span>
                  ))}
                </div>
              )}

              {dissenting.length > 0 && (
                <div className="mb-2">
                  <span className="text-xs text-text-muted">Dissenting: </span>
                  {dissenting.map((name) => (
                    <span key={name} className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono bg-accent-red/10 text-accent-red rounded mr-1">
                      {name}
                    </span>
                  ))}
                </div>
              )}

              {inputs.size_adjustment && inputs.size_adjustment !== 1.0 && (
                <div className="text-xs font-mono text-text-muted">
                  Size Adjustment: <span className="text-text-primary">{inputs.size_adjustment}x</span>
                </div>
              )}
            </div>
          </div>

          {/* Agent Inputs */}
          {inputs.inputs && Object.keys(inputs.inputs).length > 0 && (
            <div className="mt-3 pt-3 border-t border-border">
              <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Agent Inputs</h4>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(inputs.inputs).map(([agent, data]) => (
                  <div key={agent} className="bg-surface border border-border rounded p-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-mono font-semibold text-text-primary">{agent}</span>
                      {data.signal && (
                        <Badge variant={data.signal === 'BUY' ? 'buy' : data.signal === 'SELL' ? 'sell' : 'open'}>
                          {data.signal}
                        </Badge>
                      )}
                    </div>
                    {data.reasoning && (
                      <p className="text-[11px] text-text-muted leading-snug">{data.reasoning}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ConfidencePill({ value }) {
  if (value == null) return null
  const pct = Math.round(value * 100)
  return (
    <span className={clsx(
      'inline-flex items-center px-2 py-0.5 text-[10px] font-mono font-semibold rounded',
      pct >= 70 ? 'bg-accent-green/10 text-accent-green' :
      pct >= 40 ? 'bg-accent-amber/10 text-accent-amber' :
      'bg-accent-red/10 text-accent-red'
    )}>
      {pct}%
    </span>
  )
}
