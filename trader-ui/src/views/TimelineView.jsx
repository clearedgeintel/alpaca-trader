import { formatDistanceToNow, parseISO } from 'date-fns'
import { useDecisionTimeline } from '../hooks/useQueries'
import Badge from '../components/shared/Badge'

export default function TimelineView() {
  const { data, isLoading } = useDecisionTimeline(50)

  const decisions = data || []

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Decision Timeline</h2>
      <p className="text-sm text-text-muted">Agent inputs vs orchestrator decisions, linked to trade outcomes.</p>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-lg p-4 animate-pulse h-32" />
          ))}
        </div>
      ) : decisions.length === 0 ? (
        <div className="bg-surface border border-border rounded-lg p-8 text-center text-text-muted text-sm">
          No decisions yet. Enable agency mode and wait for a market-hours cycle.
        </div>
      ) : (
        <div className="relative">
          {/* Vertical timeline line */}
          <div className="absolute left-6 top-0 bottom-0 w-px bg-border" />

          <div className="space-y-4">
            {decisions.map((d, i) => {
              const inputs = d.agent_inputs || {}
              const supporting = inputs.supporting || []
              const dissenting = inputs.dissenting || []
              const agentDetails = inputs.inputs || {}
              const hasTrade = d.trade_status != null
              const tradeWon = d.pnl != null && Number(d.pnl) > 0

              return (
                <div key={d.id || i} className="relative pl-14">
                  {/* Timeline dot */}
                  <div className={`absolute left-[18px] top-4 w-3 h-3 rounded-full border-2 ${
                    d.action === 'BUY' ? 'bg-accent-green border-accent-green' :
                    d.action === 'SELL' ? 'bg-accent-red border-accent-red' :
                    'bg-text-dim border-text-dim'
                  }`} />

                  <div className="bg-surface border border-border rounded-lg p-4">
                    {/* Header */}
                    <div className="flex items-center gap-3 mb-2">
                      <span className="font-mono text-sm font-semibold text-text-primary">{d.symbol}</span>
                      <Badge variant={d.action === 'BUY' ? 'green' : d.action === 'SELL' ? 'red' : 'default'}>
                        {d.action}
                      </Badge>
                      <span className="font-mono text-xs text-accent-blue">
                        {(Number(d.confidence) * 100).toFixed(0)}% confidence
                      </span>

                      {hasTrade && (
                        <span className={`font-mono text-xs px-2 py-0.5 rounded ${
                          tradeWon ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'
                        }`}>
                          {tradeWon ? '+' : ''}${Number(d.pnl).toFixed(2)} ({d.exit_reason})
                        </span>
                      )}

                      {!hasTrade && d.trade_status == null && (
                        <span className="text-xs text-text-dim">no trade</span>
                      )}

                      <span className="ml-auto text-xs text-text-muted">
                        {d.created_at ? formatDistanceToNow(parseISO(d.created_at), { addSuffix: true }) : ''}
                      </span>
                    </div>

                    {/* Reasoning */}
                    <p className="text-sm text-text-muted mb-3">{d.reasoning}</p>

                    {/* Agent consensus */}
                    <div className="flex items-center gap-4 mb-2">
                      {supporting.length > 0 && (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-accent-green">Supporting:</span>
                          {supporting.map(a => (
                            <span key={a} className="text-xs font-mono bg-accent-green/10 text-accent-green px-1.5 py-0.5 rounded">{a}</span>
                          ))}
                        </div>
                      )}
                      {dissenting.length > 0 && (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-accent-red">Dissenting:</span>
                          {dissenting.map(a => (
                            <span key={a} className="text-xs font-mono bg-accent-red/10 text-accent-red px-1.5 py-0.5 rounded">{a}</span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Agent detail rows */}
                    {Object.keys(agentDetails).length > 0 && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        {Object.entries(agentDetails).map(([name, report]) => (
                          <div key={name} className="bg-elevated rounded p-2">
                            <p className="text-xs font-mono font-medium text-text-primary">{name}</p>
                            <div className="flex items-center gap-2 mt-1">
                              {report.signal && (
                                <Badge variant={report.signal === 'BUY' ? 'green' : report.signal === 'SELL' ? 'red' : 'default'} size="sm">
                                  {report.signal}
                                </Badge>
                              )}
                              {report.confidence != null && (
                                <span className="text-xs font-mono text-text-muted">
                                  {(Number(report.confidence) * 100).toFixed(0)}%
                                </span>
                              )}
                            </div>
                            {report.reasoning && (
                              <p className="text-xs text-text-dim mt-1 line-clamp-2">{report.reasoning}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
