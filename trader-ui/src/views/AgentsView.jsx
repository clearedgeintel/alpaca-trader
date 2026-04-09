import clsx from 'clsx'
import Badge from '../components/shared/Badge'
import { LoadingCards } from '../components/shared/LoadingState'
import { useAgents, useRegimeReport, useNewsReport, useScreenerReport, useMetricsSummary, useMetricsLeaderboard } from '../hooks/useQueries'
import { formatDistanceToNow, parseISO } from 'date-fns'

export default function AgentsView() {
  const { data: agentsData, isLoading } = useAgents()
  const { data: regimeData } = useRegimeReport()
  const { data: newsData } = useNewsReport()
  const { data: screenerData } = useScreenerReport()

  const { data: metricsSummary } = useMetricsSummary()
  const { data: leaderboard } = useMetricsLeaderboard()

  const agents = agentsData?.agents || []
  const llmUsage = agentsData?.llmUsage || {}
  const mode = agentsData?.mode || 'legacy'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-primary">Agent Agency</h2>
        <Badge variant={mode === 'agency' ? 'buy' : 'paper'}>
          {mode === 'agency' ? 'AGENCY MODE' : 'LEGACY MODE'}
        </Badge>
      </div>

      {isLoading ? (
        <LoadingCards count={6} />
      ) : (
        <>
          {/* Agent Status Grid */}
          <div className="grid grid-cols-3 gap-4">
            {agents.map((agent) => (
              <AgentCard key={agent.name} agent={agent} />
            ))}
          </div>

          {/* Screener Panel */}
          <ScreenerPanel data={screenerData} />

          {/* Market Regime Panel */}
          <RegimePanel data={regimeData} />

          {/* News Sentiment Panel */}
          <NewsPanel data={newsData} />

          {/* LLM Usage */}
          <LlmUsagePanel usage={llmUsage} />

          {/* Agent Performance Metrics */}
          <AgentMetricsPanel data={metricsSummary} />

          {/* Agent Leaderboard */}
          <AgentLeaderboardPanel data={leaderboard} />
        </>
      )}
    </div>
  )
}

function AgentCard({ agent }) {
  const isActive = agent.runCount > 0
  const hasReport = agent.hasReport

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-sm font-semibold text-text-primary">{agent.name}</span>
        <span
          className={clsx(
            'w-2 h-2 rounded-full',
            agent.running ? 'bg-accent-amber animate-pulse' :
            agent.enabled ? 'bg-accent-green' : 'bg-text-dim'
          )}
        />
      </div>

      <div className="space-y-2 text-xs font-mono">
        <div className="flex justify-between text-text-muted">
          <span>Status</span>
          <span className={clsx(
            agent.running ? 'text-accent-amber' :
            agent.enabled ? 'text-accent-green' : 'text-text-dim'
          )}>
            {agent.running ? 'Running' : agent.enabled ? 'Idle' : 'Disabled'}
          </span>
        </div>

        <div className="flex justify-between text-text-muted">
          <span>Cycles</span>
          <span className="text-text-primary">{agent.runCount}</span>
        </div>

        {agent.lastDurationMs != null && (
          <div className="flex justify-between text-text-muted">
            <span>Latency</span>
            <span className={clsx(
              'text-text-primary',
              agent.lastDurationMs > 5000 && 'text-accent-red',
              agent.lastDurationMs > 2000 && agent.lastDurationMs <= 5000 && 'text-accent-amber',
            )}>
              {(agent.lastDurationMs / 1000).toFixed(1)}s
            </span>
          </div>
        )}

        {agent.lastRunAt && (
          <div className="flex justify-between text-text-muted">
            <span>Last Run</span>
            <span className="text-text-primary">
              {formatDistanceToNow(parseISO(agent.lastRunAt), { addSuffix: true })}
            </span>
          </div>
        )}

        {hasReport && (
          <>
            <div className="flex justify-between text-text-muted">
              <span>Signal</span>
              <span className={clsx(
                agent.lastSignal === 'BUY' && 'text-accent-green',
                agent.lastSignal === 'SELL' && 'text-accent-red',
                agent.lastSignal === 'HOLD' && 'text-text-muted',
                agent.lastSignal === 'ACTIVE' && 'text-accent-blue',
              )}>
                {agent.lastSignal || '—'}
              </span>
            </div>

            <div className="flex justify-between text-text-muted">
              <span>Confidence</span>
              <ConfidenceBar value={agent.lastConfidence} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ConfidenceBar({ value }) {
  if (value == null) return <span className="text-text-dim">—</span>
  const pct = Math.round(value * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="w-12 h-1.5 bg-elevated rounded-full overflow-hidden">
        <div
          className={clsx(
            'h-full rounded-full',
            pct >= 70 ? 'bg-accent-green' : pct >= 40 ? 'bg-accent-amber' : 'bg-accent-red'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-text-primary">{pct}%</span>
    </div>
  )
}

function RegimePanel({ data }) {
  const regime = data?.currentParams?.regime || 'unknown'
  const report = data?.report

  const regimeColors = {
    trending_bull: 'text-accent-green',
    trending_bear: 'text-accent-red',
    range_bound: 'text-accent-amber',
    high_vol_selloff: 'text-accent-red',
    recovery: 'text-accent-blue',
  }

  const regimeLabels = {
    trending_bull: 'Trending Bull',
    trending_bear: 'Trending Bear',
    range_bound: 'Range Bound',
    high_vol_selloff: 'High Vol Selloff',
    recovery: 'Recovery',
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Market Regime</h3>

      <div className="flex items-center gap-6">
        <div>
          <span className={clsx('font-mono text-xl font-bold', regimeColors[regime] || 'text-text-muted')}>
            {regimeLabels[regime] || regime}
          </span>
        </div>

        {data?.currentParams && (
          <div className="flex gap-4 text-xs font-mono text-text-muted">
            <span>Stop: <span className="text-text-primary">{(data.currentParams.stop_pct * 100).toFixed(1)}%</span></span>
            <span>Target: <span className="text-text-primary">{(data.currentParams.target_pct * 100).toFixed(1)}%</span></span>
            <span>Scale: <span className="text-text-primary">{data.currentParams.position_scale}x</span></span>
            <span>Bias: <span className={clsx(
              data.currentParams.bias === 'long' && 'text-accent-green',
              data.currentParams.bias === 'avoid' && 'text-accent-red',
              data.currentParams.bias === 'defensive' && 'text-accent-red',
              data.currentParams.bias === 'neutral' && 'text-accent-amber',
              data.currentParams.bias === 'selective_long' && 'text-accent-blue',
            )}>{data.currentParams.bias}</span></span>
          </div>
        )}
      </div>

      {report?.reasoning && (
        <p className="text-xs text-text-muted mt-2">{report.reasoning}</p>
      )}
    </div>
  )
}

function NewsPanel({ data }) {
  const report = data?.report
  const alerts = data?.alerts || []

  const sentiment = report?.data?.overallSentiment ?? 0
  const urgency = report?.data?.overallUrgency || 'low'

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">News Sentiment</h3>

      <div className="flex items-center gap-6 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">Sentiment:</span>
          <span className={clsx(
            'font-mono text-sm font-semibold',
            sentiment > 0.2 ? 'text-accent-green' :
            sentiment < -0.2 ? 'text-accent-red' : 'text-text-muted'
          )}>
            {sentiment > 0 ? '+' : ''}{sentiment.toFixed(2)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">Urgency:</span>
          <Badge variant={urgency === 'critical' ? 'sell' : urgency === 'high' ? 'paper' : 'open'}>
            {urgency}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">Articles:</span>
          <span className="font-mono text-sm text-text-primary">{report?.data?.articleCount ?? 0}</span>
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-1">
          {alerts.map((alert, i) => (
            <div key={i} className="flex items-center gap-2 text-xs px-2 py-1.5 bg-elevated rounded">
              <Badge variant={alert.impact?.includes('bearish') ? 'sell' : 'buy'}>
                {alert.impact}
              </Badge>
              <span className="font-mono text-text-primary">{alert.symbol}</span>
              <span className="text-text-muted truncate">{alert.headline}</span>
            </div>
          ))}
        </div>
      )}

      {alerts.length === 0 && (
        <p className="text-xs text-text-dim">No active alerts</p>
      )}
    </div>
  )
}

function ScreenerPanel({ data }) {
  const watchlist = data?.watchlist || []
  const candidates = data?.candidates || []
  const marketTheme = data?.marketTheme || ''
  const report = data?.report

  const rankedSymbols = report?.data?.watchlist || []

  const categoryColors = {
    momentum: 'text-accent-green',
    breakout: 'text-accent-blue',
    bounce: 'text-accent-amber',
    volume_spike: 'text-accent-green',
    sector_strength: 'text-accent-blue',
    watchlist: 'text-text-muted',
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Market Screener</h3>
        <span className="text-xs font-mono text-text-muted">
          {candidates.length} scanned / {watchlist.length} selected
        </span>
      </div>

      {marketTheme && (
        <p className="text-sm text-text-primary mb-3">{marketTheme}</p>
      )}

      {rankedSymbols.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {rankedSymbols.map((item, i) => (
            <div key={item.symbol || i} className="flex items-center gap-3 px-3 py-2 bg-elevated rounded text-xs font-mono">
              <span className="text-text-primary font-semibold w-12">{item.symbol}</span>
              <ConfidenceBar value={item.score} />
              <span className={clsx('text-[10px] uppercase', categoryColors[item.category] || 'text-text-muted')}>
                {item.category}
              </span>
              <span className="text-text-dim truncate flex-1 text-[11px]">{item.reasoning}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-dim">No screening data yet. Enable agency mode to start.</p>
      )}
    </div>
  )
}

function LlmUsagePanel({ usage }) {
  if (!usage || !usage.callCount) return null

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">LLM Usage (Today)</h3>

      <div className="flex gap-6 text-xs font-mono mb-3">
        <div>
          <span className="text-text-muted">Calls: </span>
          <span className="text-text-primary">{usage.callCount}</span>
        </div>
        <div>
          <span className="text-text-muted">Input: </span>
          <span className="text-text-primary">{(usage.totalInputTokens / 1000).toFixed(1)}k</span>
        </div>
        <div>
          <span className="text-text-muted">Output: </span>
          <span className="text-text-primary">{(usage.totalOutputTokens / 1000).toFixed(1)}k</span>
        </div>
        <div>
          <span className="text-text-muted">Est. Cost: </span>
          <span className="text-accent-amber">${usage.estimatedCostUsd?.toFixed(4) || '0.00'}</span>
        </div>
      </div>

      {/* Per-agent breakdown */}
      {usage.byAgent && Object.keys(usage.byAgent).length > 0 && (
        <div className="border-t border-border pt-2 space-y-1">
          {Object.entries(usage.byAgent).map(([name, data]) => (
            <div key={name} className="flex justify-between text-xs font-mono text-text-muted">
              <span>{name}</span>
              <span>
                {data.calls} calls / {(data.inputTokens / 1000).toFixed(1)}k in / ${data.costUsd?.toFixed(4)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AgentMetricsPanel({ data }) {
  if (!data || data.length === 0) return null

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Agent Performance (7d)</h3>

      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-text-muted border-b border-border">
              <th className="text-left py-2 pr-4">Agent</th>
              <th className="text-right py-2 px-2">Cycles</th>
              <th className="text-right py-2 px-2">Avg Latency</th>
              <th className="text-right py-2 px-2">Min/Max</th>
              <th className="text-right py-2 px-2">LLM Calls</th>
              <th className="text-right py-2 px-2">Tokens</th>
              <th className="text-right py-2 px-2">Cost</th>
              <th className="text-right py-2 px-2">Errors</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.agent_name} className="border-b border-border/50 hover:bg-elevated/50">
                <td className="py-2 pr-4 text-text-primary font-semibold">{row.agent_name}</td>
                <td className="text-right py-2 px-2 text-text-primary">{row.total_cycles}</td>
                <td className="text-right py-2 px-2">
                  <span className={clsx(
                    Number(row.avg_latency_ms) > 5000 ? 'text-accent-red' :
                    Number(row.avg_latency_ms) > 2000 ? 'text-accent-amber' : 'text-accent-green'
                  )}>
                    {Number(row.avg_latency_ms).toLocaleString()}ms
                  </span>
                </td>
                <td className="text-right py-2 px-2 text-text-muted">
                  {Number(row.min_latency_ms).toLocaleString()}/{Number(row.max_latency_ms).toLocaleString()}ms
                </td>
                <td className="text-right py-2 px-2 text-text-primary">{row.total_llm_calls}</td>
                <td className="text-right py-2 px-2 text-text-muted">
                  {((Number(row.total_input_tokens) + Number(row.total_output_tokens)) / 1000).toFixed(1)}k
                </td>
                <td className="text-right py-2 px-2 text-accent-amber">${Number(row.total_cost_usd).toFixed(4)}</td>
                <td className="text-right py-2 px-2">
                  <span className={Number(row.total_errors) > 0 ? 'text-accent-red' : 'text-text-dim'}>
                    {row.total_errors}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AgentLeaderboardPanel({ data }) {
  if (!data || data.length === 0) return null

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Agent Leaderboard (30d)</h3>

      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-text-muted border-b border-border">
              <th className="text-left py-2 pr-4">Agent</th>
              <th className="text-right py-2 px-2">Decisions</th>
              <th className="text-right py-2 px-2">Correct</th>
              <th className="text-right py-2 px-2">Wrong</th>
              <th className="text-right py-2 px-2">Win Rate</th>
              <th className="text-right py-2 px-2">P&L Impact</th>
              <th className="text-right py-2 px-2">Avg Conf.</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={row.agent} className="border-b border-border/50 hover:bg-elevated/50">
                <td className="py-2 pr-4 text-text-primary font-semibold">
                  {i === 0 && row.winRate != null && <span className="mr-1">*</span>}
                  {row.agent}
                </td>
                <td className="text-right py-2 px-2 text-text-primary">{row.decisions}</td>
                <td className="text-right py-2 px-2 text-accent-green">{row.correct}</td>
                <td className="text-right py-2 px-2 text-accent-red">{row.wrong}</td>
                <td className="text-right py-2 px-2">
                  {row.winRate != null ? (
                    <span className={clsx(
                      row.winRate >= 60 ? 'text-accent-green' :
                      row.winRate >= 40 ? 'text-accent-amber' : 'text-accent-red'
                    )}>
                      {row.winRate}%
                    </span>
                  ) : (
                    <span className="text-text-dim">--</span>
                  )}
                </td>
                <td className="text-right py-2 px-2">
                  <span className={row.totalPnl >= 0 ? 'text-accent-green' : 'text-accent-red'}>
                    {row.totalPnl >= 0 ? '+' : ''}${row.totalPnl.toFixed(2)}
                  </span>
                </td>
                <td className="text-right py-2 px-2 text-text-muted">{(row.avgConfidence * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
