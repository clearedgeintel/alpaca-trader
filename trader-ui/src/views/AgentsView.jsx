import { useState, useEffect } from 'react'
import clsx from 'clsx'
import Badge from '../components/shared/Badge'
import { LoadingCards } from '../components/shared/LoadingState'
import { useAgents, useRegimeReport, useNewsReport, useScreenerReport, useMetricsSummary, useMetricsLeaderboard, useAgentCalibration } from '../hooks/useQueries'
import { useQuery } from '@tanstack/react-query'
import { getPromptPerformance, activatePrompt, getKellyRecommendations, setRuntimeConfig, clearRuntimeConfig, getConfig } from '../api/client'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { getPersona } from '../lib/agentPersonas'
import { onAgentActivity } from '../hooks/useSocket'

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

          {/* Live Activity Feed */}
          <LiveActivityFeed />

          {/* Agent Calibration */}
          <CalibrationPanel />

          {/* Prompt A/B Performance — closed-trade outcomes per prompt version */}
          <PromptPerformancePanel />

          {/* Kelly / half-Kelly sizing recommendations per watchlist symbol */}
          <KellyPanel />

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

function CalibrationPanel() {
  const { data: cal } = useAgentCalibration(30)
  const entries = cal ? Object.entries(cal) : []

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Agent Calibration (30d)</h3>
        <span className="text-[10px] text-text-dim">Weights orchestrator's use of each agent's confidence</span>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-text-dim">No historical data yet. All agents use the cold-start weight of 0.5 until <code className="text-text-muted">agent_performance</code> has &gt;=10 closed trades per agent.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {entries.map(([name, data]) => {
            const persona = getPersona(name)
            const coldStart = data.sampleSize < 10
            const effectiveWeight = coldStart ? 0.5 : data.winRate
            return (
              <div key={name} className="flex items-center gap-3 px-3 py-2 bg-elevated rounded">
                <span className={clsx('w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold bg-gradient-to-br', persona.gradient, `text-${persona.color}`)}>
                  {persona.avatar}
                </span>
                <span className="text-xs text-text-primary font-semibold w-20">{persona.displayName}</span>
                <div className="flex-1">
                  <div className="h-1.5 bg-base rounded-full overflow-hidden">
                    <div
                      className={clsx('h-full rounded-full',
                        effectiveWeight >= 0.6 ? 'bg-accent-green' :
                        effectiveWeight >= 0.4 ? 'bg-accent-amber' : 'bg-accent-red',
                      )}
                      style={{ width: `${effectiveWeight * 100}%` }}
                    />
                  </div>
                </div>
                <span className="text-xs font-mono text-text-primary w-10 text-right">{(effectiveWeight * 100).toFixed(0)}%</span>
                <span className="text-[10px] font-mono text-text-dim w-16 text-right">
                  {coldStart ? `cold (${data.sampleSize})` : `${data.sampleSize} trades`}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Side-by-side comparison of each prompt version's real-world track record.
 * Reads GET /api/prompts/:agent/performance which joins agent_decisions
 * against trades (via signal_id) to surface per-version win rate and P&L.
 * Only the orchestrator is wired for now — extending to other agents
 * requires adding prompt_version_id to agent_reports.
 */
function PromptPerformancePanel() {
  const [agent] = useState('orchestrator')
  const [days, setDays] = useState(30)
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['prompt-performance', agent, days],
    queryFn: () => getPromptPerformance(agent, days),
    staleTime: 60_000,
  })
  const [busyVersion, setBusyVersion] = useState(null)

  async function handleActivate(version) {
    if (!confirm(`Activate "${version}"? All new decisions will use this prompt immediately (5-min registry cache).`)) return
    setBusyVersion(version)
    try {
      await activatePrompt(agent, version)
      await refetch()
    } catch (err) { alert(`Activate failed: ${err.message}`) }
    setBusyVersion(null)
  }

  const versions = data?.versions || []
  const baseline = data?.baseline

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
          Prompt A/B Performance ({agent})
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-dim font-mono">Window:</span>
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={clsx(
                'px-2 py-0.5 text-[10px] font-mono rounded',
                days === d ? 'bg-accent-blue text-white' : 'bg-elevated text-text-muted hover:text-text-primary'
              )}
            >{d}d</button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1,2].map(i => <div key={i} className="h-6 bg-elevated rounded animate-pulse" />)}
        </div>
      ) : versions.length === 0 && !baseline ? (
        <p className="text-xs text-text-dim">
          No prompt versions yet. Add one via <code className="text-text-muted">POST /api/prompts/{agent}/activate</code> with a new version label + prompt body. Existing decisions will carry the "unversioned" baseline until new versions are created.
        </p>
      ) : (
        <div>
          <div className="grid grid-cols-[90px_48px_48px_48px_58px_56px_60px_70px_60px] gap-x-2 text-[10px] font-mono text-text-dim uppercase mb-1 px-2">
            <span>Version</span>
            <span className="text-right">Dec</span>
            <span className="text-right">Buy</span>
            <span className="text-right">Sell</span>
            <span className="text-right">AvgConf</span>
            <span className="text-right">Closed</span>
            <span className="text-right">WinRate</span>
            <span className="text-right">P&L</span>
            <span />
          </div>
          <div className="space-y-1">
            {versions.map(v => (
              <PromptVersionRow
                key={v.version_id}
                version={v}
                onActivate={() => handleActivate(v.version)}
                busy={busyVersion === v.version}
              />
            ))}
            {baseline && <PromptVersionRow version={{ version: 'hardcoded (baseline)', ...baseline }} isBaseline />}
          </div>
        </div>
      )}
    </div>
  )
}

function PromptVersionRow({ version: v, onActivate, busy, isBaseline }) {
  const winRate = v.win_rate
  const pnlColor = v.total_pnl > 0 ? 'text-accent-green' : v.total_pnl < 0 ? 'text-accent-red' : 'text-text-muted'
  return (
    <div
      className={clsx(
        'grid grid-cols-[90px_48px_48px_48px_58px_56px_60px_70px_60px] gap-x-2 items-center text-[11px] font-mono px-2 py-1.5 rounded',
        v.is_active ? 'bg-accent-blue/10 border border-accent-blue/30' : 'bg-elevated',
      )}
    >
      <span className={clsx('truncate', isBaseline && 'text-text-dim')}>
        {v.is_active && <span className="text-accent-blue mr-1">●</span>}
        {v.version}
        {v.notes && <span className="text-text-dim ml-1" title={v.notes}> i</span>}
      </span>
      <span className="text-right text-text-primary">{v.total_decisions}</span>
      <span className="text-right text-accent-green">{v.buys}</span>
      <span className="text-right text-accent-red">{v.sells}</span>
      <span className="text-right text-text-primary">{v.total_decisions > 0 ? (v.avg_confidence * 100).toFixed(0) + '%' : '—'}</span>
      <span className="text-right text-text-muted">{v.closed_trades}</span>
      <span className={clsx('text-right', winRate == null ? 'text-text-dim' : winRate >= 0.5 ? 'text-accent-green' : 'text-accent-red')}>
        {winRate == null ? '—' : (winRate * 100).toFixed(0) + '%'}
      </span>
      <span className={clsx('text-right', pnlColor)}>
        {v.closed_trades > 0 ? `${v.total_pnl >= 0 ? '+' : ''}$${v.total_pnl.toFixed(0)}` : '—'}
      </span>
      <span className="text-right">
        {!isBaseline && !v.is_active && (
          <button
            onClick={onActivate}
            disabled={busy}
            className="px-1.5 py-0.5 text-[9px] font-mono bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 disabled:opacity-40"
          >
            {busy ? '…' : 'Activate'}
          </button>
        )}
      </span>
    </div>
  )
}

/**
 * Per-symbol Kelly recommendation table. Kelly suggests the fraction of
 * capital to risk based on historical win rate + win/loss ratio; we
 * show the half-Kelly figure (safer in practice) and the resulting
 * multiplier applied to the base RISK_PCT. Toggle at the top flips
 * KELLY_ENABLED so the execution-agent actually uses the multiplier.
 */
function KellyPanel() {
  const [days, setDays] = useState(60)
  const [minSampleSize, setMinSampleSize] = useState(20)
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['kelly', days, minSampleSize],
    queryFn: () => getKellyRecommendations(days, minSampleSize),
    staleTime: 60_000,
  })
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: getConfig, staleTime: 30_000 })
  const enabled = data?.enabled ?? false
  const overridden = (config?.overriddenKeys || []).includes('KELLY_ENABLED')
  const [busy, setBusy] = useState(false)

  async function handleToggle() {
    setBusy(true)
    try {
      if (enabled) await setRuntimeConfig('KELLY_ENABLED', false)
      else await setRuntimeConfig('KELLY_ENABLED', true)
      await refetch()
    } catch (err) {
      alert(`Toggle failed: ${err.message}`)
    }
    setBusy(false)
  }

  async function handleReset() {
    if (!confirm('Reset KELLY_ENABLED to default (off)?')) return
    setBusy(true)
    try {
      await clearRuntimeConfig('KELLY_ENABLED')
      await refetch()
    } catch (err) {
      alert(`Reset failed: ${err.message}`)
    }
    setBusy(false)
  }

  const results = data?.results || []
  const qualifying = results.filter((r) => r.source === 'kelly')

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
          Kelly Sizing ({days}d, min {minSampleSize} trades)
        </h3>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-text-dim font-mono">Window:</span>
            {[30, 60, 90].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={clsx(
                  'px-2 py-0.5 text-[10px] font-mono rounded',
                  days === d ? 'bg-accent-blue text-white' : 'bg-elevated text-text-muted hover:text-text-primary',
                )}
              >
                {d}d
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-text-dim font-mono">Min n:</span>
            {[10, 20, 50].map((n) => (
              <button
                key={n}
                onClick={() => setMinSampleSize(n)}
                className={clsx(
                  'px-2 py-0.5 text-[10px] font-mono rounded',
                  minSampleSize === n
                    ? 'bg-accent-blue text-white'
                    : 'bg-elevated text-text-muted hover:text-text-primary',
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 pl-2 border-l border-border">
            <span
              className={clsx(
                'text-[10px] font-mono font-semibold uppercase',
                enabled ? 'text-accent-green' : 'text-text-dim',
              )}
            >
              {enabled ? 'Active' : 'Off (suggest only)'}
            </span>
            <button
              onClick={handleToggle}
              disabled={busy}
              className="px-2 py-1 text-[10px] font-mono bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 disabled:opacity-40"
            >
              {busy ? '…' : enabled ? 'Disable' : 'Enable'}
            </button>
            {overridden && (
              <button
                onClick={handleReset}
                disabled={busy}
                className="px-2 py-1 text-[10px] font-mono bg-elevated text-text-muted rounded hover:text-accent-red disabled:opacity-40"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {!enabled && (
        <p className="text-[10px] text-text-dim mb-2">
          Suggestion mode — execution-agent still uses flat RISK_PCT. Enable when comfortable with the numbers below.
        </p>
      )}

      <div className="grid grid-cols-[80px_60px_56px_60px_60px_70px_60px_60px] gap-x-2 text-[10px] font-mono text-text-dim uppercase mb-1 px-2">
        <span>Symbol</span>
        <span className="text-right">Sample</span>
        <span className="text-right">Win%</span>
        <span className="text-right">AvgWin</span>
        <span className="text-right">AvgLoss</span>
        <span className="text-right">Kelly f</span>
        <span className="text-right">½-Kelly</span>
        <span className="text-right">Mult</span>
      </div>

      {isLoading ? (
        <div className="space-y-1">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-6 bg-elevated rounded animate-pulse" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <p className="text-xs text-text-dim">No recommendations available.</p>
      ) : (
        <div className="space-y-1">
          {results.map((r) => (
            <KellyRow key={r.symbol} r={r} />
          ))}
        </div>
      )}

      {results.length > 0 && (
        <p className="text-[10px] text-text-dim mt-3">
          {qualifying.length}/{results.length} symbols meet the min-sample threshold. Cold-start symbols default to 1.0x
          (base RISK_PCT). Full Kelly is halved then clamped to [0.5×, 2.0×] of base risk for safety.
        </p>
      )}
    </div>
  )
}

function KellyRow({ r }) {
  const cold = r.source !== 'kelly'
  const multColor = r.multiplier > 1.05 ? 'text-accent-green' : r.multiplier < 0.95 ? 'text-accent-red' : 'text-text-muted'
  return (
    <div
      className={clsx(
        'grid grid-cols-[80px_60px_56px_60px_60px_70px_60px_60px] gap-x-2 items-center text-[11px] font-mono px-2 py-1 rounded',
        cold ? 'bg-elevated/50' : 'bg-elevated',
      )}
      title={cold ? `Cold-start (${r.sampleSize}/${r.minSampleSize || 20}) — using base RISK_PCT` : ''}
    >
      <span className="text-text-primary font-semibold">{r.symbol}</span>
      <span className="text-right text-text-muted">
        {r.wins ?? 0}W / {r.losses ?? 0}L
      </span>
      <span className="text-right text-text-primary">{r.winRate != null ? (r.winRate * 100).toFixed(0) + '%' : '—'}</span>
      <span className="text-right text-accent-green">
        {r.avgWin != null ? '+' + (r.avgWin * 100).toFixed(1) + '%' : '—'}
      </span>
      <span className="text-right text-accent-red">{r.avgLoss != null ? '-' + (r.avgLoss * 100).toFixed(1) + '%' : '—'}</span>
      <span
        className={clsx(
          'text-right',
          r.kellyF == null ? 'text-text-dim' : r.kellyF < 0 ? 'text-accent-red' : 'text-text-primary',
        )}
      >
        {r.kellyF != null ? (r.kellyF * 100).toFixed(2) + '%' : '—'}
      </span>
      <span className="text-right text-text-muted">{r.halfKellyF != null ? (r.halfKellyF * 100).toFixed(2) + '%' : '—'}</span>
      <span className={clsx('text-right font-semibold', multColor)}>{r.multiplier?.toFixed(2) ?? '1.00'}×</span>
    </div>
  )
}

function LiveActivityFeed() {
  const [items, setItems] = useState([])
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused) return
    return onAgentActivity(setItems)
  }, [paused])

  return (
    <div className="bg-surface border border-border rounded-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-accent-green animate-pulse" />
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Live Agent Activity</h3>
          <span className="text-[10px] text-text-dim">{items.length} events</span>
        </div>
        <button
          onClick={() => setPaused(!paused)}
          className="text-[10px] text-text-dim hover:text-text-muted px-2 py-0.5 rounded border border-border hover:border-text-dim"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      <div className="max-h-[320px] overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-text-dim">
            Waiting for agent activity... (cycles run every 5 min during market hours)
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {items.map(item => <ActivityRow key={item.id} item={item} />)}
          </div>
        )}
      </div>
    </div>
  )
}

function ActivityRow({ item }) {
  const persona = getPersona(item.agent)
  const isError = item.signal === 'ERROR'
  const sigColor =
    item.signal === 'BUY' ? 'text-accent-green' :
    item.signal === 'SELL' ? 'text-accent-red' :
    item.signal === 'ACTIVE' ? 'text-accent-blue' :
    isError ? 'text-accent-red' : 'text-text-muted'

  return (
    <div className="px-4 py-2 hover:bg-elevated/30 transition-colors">
      <div className="flex items-start gap-3">
        <span className={clsx('w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 bg-gradient-to-br', persona.gradient, `text-${persona.color}`)}>
          {persona.avatar}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-text-primary">{persona.displayName}</span>
            <span className={clsx('text-[10px] font-mono font-bold', sigColor)}>
              {item.signal || 'HOLD'}
            </span>
            {item.symbol && <span className="font-mono text-xs text-text-primary">{item.symbol}</span>}
            {item.confidence != null && (
              <span className="text-[10px] font-mono text-text-dim">conf {(item.confidence * 100).toFixed(0)}%</span>
            )}
            <span className="text-[10px] font-mono text-text-dim">{(item.durationMs / 1000).toFixed(1)}s</span>
            {item.llmCalls > 0 && (
              <span className="text-[10px] font-mono text-text-dim">${item.llmCostUsd.toFixed(4)}</span>
            )}
            <span className="text-[10px] text-text-dim ml-auto">
              {formatDistanceToNow(new Date(item.receivedAt), { addSuffix: true })}
            </span>
          </div>
          {(item.reasoning || item.error) && (
            <p className={clsx('text-[11px] mt-0.5 line-clamp-2', isError ? 'text-accent-red' : 'text-text-muted')}>
              {item.error || item.reasoning}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function AgentCard({ agent }) {
  const hasReport = agent.hasReport
  const persona = getPersona(agent.name)

  return (
    <div className={clsx(
      'bg-surface border rounded-lg p-4 relative overflow-hidden',
      persona.borderColor,
    )}>
      {/* Gradient accent bar */}
      <div className={clsx('absolute inset-x-0 top-0 h-1 bg-gradient-to-r', persona.gradient)} />

      <div className="flex items-center gap-3 mb-3">
        {/* Avatar */}
        <div className={clsx(
          'w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold bg-gradient-to-br',
          persona.gradient,
          `text-${persona.color}`,
        )}>
          {persona.avatar}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-text-primary">{persona.displayName}</span>
            <span
              className={clsx(
                'w-2 h-2 rounded-full flex-shrink-0',
                agent.running ? 'bg-accent-amber animate-pulse' :
                agent.enabled ? 'bg-accent-green' : 'bg-text-dim'
              )}
            />
          </div>
          <span className="text-[11px] text-text-dim font-mono">{persona.title}</span>
        </div>
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
                {agent.lastSignal || '\u2014'}
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
  if (value == null) return <span className="text-text-dim">{'\u2014'}</span>
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
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-amber-500/20 to-yellow-500/20 flex items-center justify-center text-[10px] font-bold text-accent-amber">A</div>
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Market Regime</h3>
        <span className="text-[10px] text-text-dim ml-1">Atlas</span>
      </div>

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
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500/20 to-blue-500/20 flex items-center justify-center text-[10px] font-bold text-accent-blue">H</div>
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">News Sentiment</h3>
        <span className="text-[10px] text-text-dim ml-1">Herald</span>
      </div>

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
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500/20 to-cyan-500/20 flex items-center justify-center text-[10px] font-bold text-accent-blue">S</div>
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Market Screener</h3>
          <span className="text-[10px] text-text-dim ml-1">Scout</span>
        </div>
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
          {Object.entries(usage.byAgent).map(([name, data]) => {
            const persona = getPersona(name)
            return (
              <div key={name} className="flex justify-between text-xs font-mono text-text-muted">
                <span className="flex items-center gap-1.5">
                  <span className={clsx('w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold bg-gradient-to-br', persona.gradient, `text-${persona.color}`)}>
                    {persona.avatar}
                  </span>
                  {persona.displayName}
                </span>
                <span>
                  {data.calls} calls / {(data.inputTokens / 1000).toFixed(1)}k in / ${data.costUsd?.toFixed(4)}
                </span>
              </div>
            )
          })}
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
            {data.map((row) => {
              const persona = getPersona(row.agent_name)
              return (
                <tr key={row.agent_name} className="border-b border-border/50 hover:bg-elevated/50">
                  <td className="py-2 pr-4 text-text-primary font-semibold">
                    <span className="flex items-center gap-2">
                      <span className={clsx('w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold bg-gradient-to-br', persona.gradient, `text-${persona.color}`)}>
                        {persona.avatar}
                      </span>
                      {persona.displayName}
                    </span>
                  </td>
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
              )
            })}
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
            {data.map((row, i) => {
              const persona = getPersona(row.agent)
              return (
                <tr key={row.agent} className="border-b border-border/50 hover:bg-elevated/50">
                  <td className="py-2 pr-4 text-text-primary font-semibold">
                    <span className="flex items-center gap-2">
                      <span className={clsx('w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold bg-gradient-to-br', persona.gradient, `text-${persona.color}`)}>
                        {persona.avatar}
                      </span>
                      {i === 0 && row.winRate != null && <span className="text-accent-amber">*</span>}
                      {persona.displayName}
                    </span>
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
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
