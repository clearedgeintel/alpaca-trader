import { useState } from 'react'
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { useAnalytics } from '../hooks/useQueries'
import { runBacktest } from '../api/client'
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
    </div>
  )
}
