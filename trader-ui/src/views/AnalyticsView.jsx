import { useState, useEffect } from 'react'
import clsx from 'clsx'
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { useAnalytics } from '../hooks/useQueries'
import { runBacktest, runWalkForward, runMonteCarlo, getAttribution } from '../api/client'
import StatCard from '../components/shared/StatCard'
import { LoadingCards, LoadingChart } from '../components/shared/LoadingState'

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  return (
    <div className="bg-elevated border border-border rounded px-3 py-2 text-xs">
      <p className="text-text-muted mb-1">{label}</p>
      {d.equity != null && (
        <p className="font-mono text-text-primary">
          Equity: ${Number(d.equity).toLocaleString('en-US', { minimumFractionDigits: 2 })}
        </p>
      )}
      {d.pnl != null && (
        <p className={`font-mono ${d.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
          P&L: {d.pnl >= 0 ? '+' : ''}${Number(d.pnl).toFixed(2)}
        </p>
      )}
      {d.drawdown != null && (
        <p className="font-mono text-accent-red">Drawdown: -{d.drawdown.toFixed(2)}%</p>
      )}
    </div>
  )
}

export default function AnalyticsView() {
  const { data, isLoading } = useAnalytics()
  const [backtestResult, setBacktestResult] = useState(null)
  const [btLoading, setBtLoading] = useState(false)
  const [btDays, setBtDays] = useState(90)

  const summary = data?.summary
  const equityCurve = (data?.equityCurve || []).map(d => ({
    ...d,
    label: format(parseISO(d.date), 'MMM d'),
  }))
  const bySymbol = data?.bySymbol || {}
  const byExitReason = data?.byExitReason || {}

  async function handleBacktest() {
    setBtLoading(true)
    try {
      const result = await runBacktest({ days: btDays })
      setBacktestResult(result)
    } catch (err) {
      console.error('Backtest failed', err)
    }
    setBtLoading(false)
  }

  const btSummary = backtestResult?.summary
  const btCurve = (backtestResult?.equityCurve || []).map(d => ({
    ...d,
    label: format(parseISO(d.date), 'MMM d'),
  }))

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Portfolio Analytics</h2>

      {/* Summary Stats */}
      {isLoading ? (
        <LoadingCards count={6} />
      ) : summary ? (
        <div className="grid grid-cols-6 gap-3">
          <StatCard label="Total P&L" value={`$${summary.totalPnl.toFixed(2)}`} trend={summary.totalPnl >= 0 ? 'up' : 'down'} />
          <StatCard label="Win Rate" value={`${summary.winRate}%`} trend={summary.winRate >= 50 ? 'up' : 'down'} />
          <StatCard label="Profit Factor" value={String(summary.profitFactor)} trend={summary.profitFactor >= 1 ? 'up' : 'down'} />
          <StatCard label="Sharpe Ratio" value={String(summary.sharpeRatio)} trend={summary.sharpeRatio >= 1 ? 'up' : 'down'} />
          <StatCard label="Max Drawdown" value={`${summary.maxDrawdown}%`} trend="down" />
          <StatCard label="W/L" value={`${summary.wins}/${summary.losses}`} trend="neutral" />
        </div>
      ) : (
        <p className="text-text-muted text-sm">No analytics data yet</p>
      )}

      {/* Equity Curve */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-text-muted mb-3">Equity Curve</h3>
        {isLoading ? <LoadingChart /> : equityCurve.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={equityCurve}>
              <CartesianGrid stroke="#1a1b1e" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#9ca3af', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: '#1e2228' }} tickLine={false} />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} width={55} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="equity" stroke="#3b82f6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : <p className="text-text-muted text-sm text-center py-8">No equity data</p>}
      </div>

      {/* Drawdown Chart */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-text-muted mb-3">Drawdown</h3>
        {equityCurve.length > 0 ? (
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={equityCurve}>
              <CartesianGrid stroke="#1a1b1e" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#9ca3af', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: '#1e2228' }} tickLine={false} />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={v => `-${v}%`} width={50} reversed />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="drawdown" stroke="#ef4444" fill="#ef4444" fillOpacity={0.15} />
            </AreaChart>
          </ResponsiveContainer>
        ) : null}
      </div>

      {/* Per-symbol breakdown */}
      {Object.keys(bySymbol).length > 0 && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-text-muted mb-3">By Symbol</h3>
          <div className="grid grid-cols-4 gap-3">
            {Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl).map(([sym, s]) => (
              <div key={sym} className="bg-elevated rounded p-3">
                <p className="font-mono text-sm font-semibold text-text-primary">{sym}</p>
                <p className={`font-mono text-xs ${s.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                  {s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)}
                </p>
                <p className="text-xs text-text-muted">{s.trades} trades, {s.winRate}% win</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Exit reason breakdown */}
      {Object.keys(byExitReason).length > 0 && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-text-muted mb-3">Exit Reasons</h3>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={Object.entries(byExitReason).map(([reason, d]) => ({ reason, count: d.count, pnl: d.pnl }))}>
              <CartesianGrid stroke="#1a1b1e" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="reason" tick={{ fill: '#9ca3af', fontSize: 11 }} axisLine={{ stroke: '#1e2228' }} tickLine={false} />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip />
              <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Backtesting */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-text-muted mb-3">Backtesting</h3>
        <div className="flex items-center gap-3 mb-4">
          <label className="text-xs text-text-muted">Days:</label>
          <input
            type="number" min="7" max="365" value={btDays}
            onChange={e => setBtDays(parseInt(e.target.value) || 90)}
            className="bg-elevated border border-border rounded px-2 py-1 text-sm font-mono text-text-primary w-20"
          />
          <button
            onClick={handleBacktest} disabled={btLoading}
            className="px-4 py-1.5 bg-accent-blue text-white text-sm font-medium rounded hover:bg-accent-blue/80 disabled:opacity-50"
          >
            {btLoading ? 'Running...' : 'Run Backtest'}
          </button>
        </div>

        {btSummary && (
          <div className="space-y-4">
            <div className="grid grid-cols-6 gap-3">
              <StatCard label="Return" value={`${btSummary.totalReturn}%`} trend={btSummary.totalReturn >= 0 ? 'up' : 'down'} />
              <StatCard label="Win Rate" value={`${btSummary.winRate}%`} trend={btSummary.winRate >= 50 ? 'up' : 'down'} />
              <StatCard label="Sharpe" value={String(btSummary.sharpeRatio)} trend={btSummary.sharpeRatio >= 1 ? 'up' : 'down'} />
              <StatCard label="Max DD" value={`${btSummary.maxDrawdown}%`} trend="down" />
              <StatCard label="Profit Factor" value={String(btSummary.profitFactor)} trend={btSummary.profitFactor >= 1 ? 'up' : 'down'} />
              <StatCard label="Trades" value={String(btSummary.totalTrades)} trend="neutral" />
            </div>
            {btCurve.length > 0 && (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={btCurve}>
                  <CartesianGrid stroke="#1a1b1e" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#9ca3af', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: '#1e2228' }} tickLine={false} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 11, fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} width={55} />
                  <ReferenceLine y={btSummary.startingCapital} stroke="#374151" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="equity" stroke="#22c55e" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        )}
      </div>

      {/* Walk-forward + Monte Carlo + Attribution panels */}
      <WalkForwardPanel />
      <MonteCarloPanel />
      <AttributionPanel />
    </div>
  )
}

function WalkForwardPanel() {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [days, setDays] = useState(180)

  async function run() {
    setLoading(true)
    try {
      setResult(await runWalkForward({ days, windowDays: 60, stepDays: 30 }))
    } catch (err) { console.error('Walk-forward failed', err) }
    setLoading(false)
  }

  const agg = result?.aggregate
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-muted">Walk-Forward Robustness</h3>
        <div className="flex items-center gap-2">
          <input type="number" min="30" max="730" value={days} onChange={e => setDays(parseInt(e.target.value) || 180)}
            className="bg-elevated border border-border rounded px-2 py-1 text-xs font-mono w-20" />
          <button onClick={run} disabled={loading}
            className="px-3 py-1 bg-accent-blue text-white text-xs font-medium rounded hover:bg-accent-blue/80 disabled:opacity-50">
            {loading ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>
      {!agg ? (
        <p className="text-xs text-text-dim">Rolling 60-day windows step by 30 days. Use to check whether the strategy works across time or only on lucky periods.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-6 gap-3">
            <StatCard label="Windows" value={String(agg.windowCount)} trend="neutral" />
            <StatCard label="Avg Return" value={`${agg.avgReturn}%`} trend={agg.avgReturn >= 0 ? 'up' : 'down'} />
            <StatCard label="Std Return" value={`${agg.stdReturn}%`} trend="neutral" />
            <StatCard label="Avg Sharpe" value={String(agg.avgSharpe)} trend={agg.avgSharpe >= 1 ? 'up' : 'down'} />
            <StatCard label="Robustness" value={`${(agg.robustness * 100).toFixed(0)}%`}
              delta={`${agg.positiveWindows}/${agg.windowCount} positive`} trend={agg.robustness >= 0.5 ? 'up' : 'down'} />
            <StatCard label="Avg Max DD" value={`${agg.avgMaxDrawdown.toFixed(1)}%`} trend="down" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead className="text-text-muted border-b border-border">
                <tr>
                  <th className="text-left py-2 pr-3">Window</th>
                  <th className="text-right py-2 px-2">Return</th>
                  <th className="text-right py-2 px-2">Sharpe</th>
                  <th className="text-right py-2 px-2">Max DD</th>
                  <th className="text-right py-2 px-2">Win %</th>
                  <th className="text-right py-2 px-2">Trades</th>
                </tr>
              </thead>
              <tbody>
                {result.windows.map((w, i) => (
                  <tr key={i} className="border-b border-border/30">
                    <td className="py-1.5 pr-3 text-text-muted">{w.startDate} → {w.endDate}</td>
                    <td className={clsx('py-1.5 px-2 text-right',
                      w.summary.totalReturn > 0 ? 'text-accent-green' : w.summary.totalReturn < 0 ? 'text-accent-red' : 'text-text-muted')}>
                      {w.summary.totalReturn > 0 ? '+' : ''}{w.summary.totalReturn}%
                    </td>
                    <td className="py-1.5 px-2 text-right">{w.summary.sharpeRatio}</td>
                    <td className="py-1.5 px-2 text-right text-accent-red">{w.summary.maxDrawdown}%</td>
                    <td className="py-1.5 px-2 text-right">{w.summary.winRate}%</td>
                    <td className="py-1.5 px-2 text-right">{w.tradeCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function MonteCarloPanel() {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [days, setDays] = useState(90)
  const [iters, setIters] = useState(50)

  async function run() {
    setLoading(true)
    try {
      setResult(await runMonteCarlo({ days, iterations: iters }))
    } catch (err) { console.error('Monte Carlo failed', err) }
    setLoading(false)
  }

  const d = result?.distribution
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-muted">Monte Carlo Slippage Distribution</h3>
        <div className="flex items-center gap-2">
          <input type="number" min="7" max="365" value={days} onChange={e => setDays(parseInt(e.target.value) || 90)}
            className="bg-elevated border border-border rounded px-2 py-1 text-xs font-mono w-16" title="days" />
          <input type="number" min="5" max="200" value={iters} onChange={e => setIters(parseInt(e.target.value) || 50)}
            className="bg-elevated border border-border rounded px-2 py-1 text-xs font-mono w-16" title="iterations" />
          <button onClick={run} disabled={loading}
            className="px-3 py-1 bg-accent-blue text-white text-xs font-medium rounded hover:bg-accent-blue/80 disabled:opacity-50">
            {loading ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>
      {!d ? (
        <p className="text-xs text-text-dim">Runs the backtest N times with randomized slippage. Answer: what's the 5th-percentile outcome if fills go against us?</p>
      ) : (
        <div className="grid grid-cols-6 gap-3">
          <StatCard label="Iterations" value={String(d.iterations)} trend="neutral" />
          <StatCard label="Mean Return" value={`${d.mean}%`} trend={d.mean >= 0 ? 'up' : 'down'} />
          <StatCard label="Std Dev" value={`${d.stdDev}%`} trend="neutral" />
          <StatCard label="P5 (worst)" value={`${d.p05}%`} trend="down" />
          <StatCard label="P50 (median)" value={`${d.p50}%`} trend={d.p50 >= 0 ? 'up' : 'down'} />
          <StatCard label="Prob > 0" value={`${(d.probPositive * 100).toFixed(0)}%`} trend={d.probPositive >= 0.5 ? 'up' : 'down'} />
        </div>
      )}
    </div>
  )
}

function AttributionPanel() {
  const [data, setData] = useState(null)
  const [days] = useState(90)
  useEffect(() => { getAttribution(days).then(setData).catch(e => console.error('Attribution failed', e)) }, [days])

  if (!data) return null
  const dims = [
    { title: 'By Regime', rows: data.byRegime },
    { title: 'By Exit Reason', rows: data.byExitReason },
    { title: 'By Hold Duration', rows: data.byHoldDuration },
    { title: 'By Day of Week', rows: data.byDayOfWeek },
    { title: 'By Sector', rows: data.bySector },
  ]
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-sm font-medium text-text-muted mb-3">
        Performance Attribution ({data.windowDays}d · {data.totalTrades} trades · ${data.totalPnl.toFixed(2)} P&L)
      </h3>
      <div className="grid grid-cols-2 gap-4">
        {dims.map(dim => (
          <div key={dim.title} className="border border-border rounded p-3">
            <p className="text-xs text-text-muted uppercase tracking-wide mb-2">{dim.title}</p>
            {dim.rows.length === 0 ? (
              <p className="text-xs text-text-dim">No data</p>
            ) : (
              <table className="w-full text-xs font-mono">
                <tbody>
                  {dim.rows.slice(0, 8).map(r => (
                    <tr key={r.key} className="border-b border-border/30">
                      <td className="py-1 text-text-primary">{r.key}</td>
                      <td className="py-1 text-right text-text-muted">{r.count}</td>
                      <td className="py-1 text-right">{r.winRate}%</td>
                      <td className={clsx('py-1 text-right',
                        r.pnl > 0 ? 'text-accent-green' : r.pnl < 0 ? 'text-accent-red' : 'text-text-muted')}>
                        {r.pnl > 0 ? '+' : ''}${r.pnl.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
