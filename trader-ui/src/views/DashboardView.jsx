import StatCard from '../components/shared/StatCard'
import PortfolioChart from '../components/dashboard/PortfolioChart'
import ActivityFeed from '../components/dashboard/ActivityFeed'
import { LoadingCards } from '../components/shared/LoadingState'
import { usePerformance, useAllTrades, useOpenTrades } from '../hooks/useQueries'
import { isToday, isThisWeek, parseISO } from 'date-fns'

export default function DashboardView() {
  const { data: performance, isLoading: perfLoading } = usePerformance()
  const { data: allTrades, isLoading: tradesLoading } = useAllTrades()
  const { data: openTrades } = useOpenTrades()

  const isLoading = perfLoading || tradesLoading

  const stats = computeStats(performance, allTrades, openTrades)

  return (
    <div className="space-y-6">
      {isLoading ? (
        <LoadingCards count={4} />
      ) : (
        <div className="grid grid-cols-4 gap-4">
          <StatCard
            label="Today's P&L"
            value={stats.todayPnl != null ? `${stats.todayPnl >= 0 ? '+' : '-'}$${Math.abs(stats.todayPnl).toFixed(2)}` : '$0.00'}
            delta={stats.yesterdayPnl != null ? `vs $${stats.yesterdayPnl.toFixed(2)} yesterday` : null}
            trend={stats.todayPnl > 0 ? 'up' : stats.todayPnl < 0 ? 'down' : 'neutral'}
          />
          <StatCard
            label="Win Rate"
            value={`${stats.winRate.toFixed(1)}%`}
            delta={stats.weekWinRate != null ? `${stats.weekWinRate.toFixed(1)}% last 7d` : null}
            trend={stats.winRate >= 50 ? 'up' : 'down'}
          />
          <StatCard
            label="Open Positions"
            value={String(stats.openCount)}
          />
          <StatCard
            label="Total Trades"
            value={String(stats.totalTrades)}
            delta={`${stats.weekTrades} this week`}
            trend="neutral"
          />
        </div>
      )}

      <PortfolioChart />
      <ActivityFeed />
    </div>
  )
}

function computeStats(performance, allTrades, openTrades) {
  const trades = allTrades || []
  const perf = performance || []

  const closedTrades = trades.filter(t => t.status === 'closed')
  const todayTrades = closedTrades.filter(t => t.closed_at && isToday(parseISO(t.closed_at)))
  const weekTrades = closedTrades.filter(t => t.closed_at && isThisWeek(parseISO(t.closed_at)))

  const todayPnl = todayTrades.reduce((sum, t) => sum + Number(t.pnl || 0), 0)

  const todayPerf = perf.find(p => isToday(parseISO(p.trade_date)))
  const sorted = [...perf].sort((a, b) => b.trade_date.localeCompare(a.trade_date))
  const yesterdayPerf = sorted.length > 1 ? sorted[1] : null
  const yesterdayPnl = yesterdayPerf ? Number(yesterdayPerf.total_pnl || 0) : null

  const wins = closedTrades.filter(t => Number(t.pnl || 0) > 0).length
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0

  const weekWins = weekTrades.filter(t => Number(t.pnl || 0) > 0).length
  const weekWinRate = weekTrades.length > 0 ? (weekWins / weekTrades.length) * 100 : null

  return {
    todayPnl: todayTrades.length > 0 ? todayPnl : (todayPerf ? Number(todayPerf.total_pnl) : 0),
    yesterdayPnl,
    winRate,
    weekWinRate,
    openCount: openTrades?.length || 0,
    totalTrades: trades.length,
    weekTrades: weekTrades.length,
  }
}
