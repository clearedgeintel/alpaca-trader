import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import { format, parseISO } from 'date-fns'
import { usePerformance } from '../../hooks/useQueries'
import { LoadingChart } from '../shared/LoadingState'

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  return (
    <div className="bg-elevated border border-border rounded px-3 py-2 text-xs">
      <p className="text-text-muted mb-1">{label}</p>
      <p className="font-mono text-text-primary">
        Portfolio: ${Number(d.portfolio_value).toLocaleString('en-US', { minimumFractionDigits: 2 })}
      </p>
      {d.daily_pnl != null && (
        <p className={`font-mono ${d.daily_pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
          Daily P&L: {d.daily_pnl >= 0 ? '+' : ''}${Number(d.daily_pnl).toFixed(2)}
        </p>
      )}
      {d.win_rate != null && (
        <p className="font-mono text-text-muted">Win Rate: {(d.win_rate * 100).toFixed(1)}%</p>
      )}
    </div>
  )
}

export default function PortfolioChart() {
  const { data, isLoading, isError } = usePerformance()

  if (isLoading) return <LoadingChart />
  if (isError) return (
    <div className="bg-surface border border-border rounded-lg p-3 h-[180px] flex items-center justify-center text-text-muted text-sm">
      Unable to load performance data
    </div>
  )

  const chartData = (data || []).map(d => ({
    ...d,
    date: format(parseISO(d.trade_date), 'MMM d'),
  }))

  if (!chartData.length) return (
    <div className="bg-surface border border-border rounded-lg p-3 h-[180px] flex items-center justify-center text-text-muted text-sm">
      No performance data yet
    </div>
  )

  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={chartData}>
          <CartesianGrid stroke="#1a1b1e" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: '#6b7280', fontSize: 11, fontFamily: 'JetBrains Mono' }}
            axisLine={{ stroke: '#1e2228' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: '#6b7280', fontSize: 11, fontFamily: 'JetBrains Mono' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
            width={55}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={chartData[0]?.portfolio_value} stroke="#374151" strokeDasharray="3 3" />
          <Line
            type="monotone"
            dataKey="portfolio_value"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: '#3b82f6' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
