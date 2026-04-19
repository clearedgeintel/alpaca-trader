import { useMemo } from 'react'
import { useOpenTrades, usePositions, useStatus } from '../../hooks/useQueries'
import { LoadingTable } from '../shared/LoadingState'
import PositionRow from './PositionRow'

export default function PositionsTable() {
  const { data: trades, isLoading: tradesLoading } = useOpenTrades()
  const { data: positions, isLoading: posLoading, isError: posError } = usePositions()
  const { data: status } = useStatus()

  const isLoading = tradesLoading || posLoading
  const marketOpen = status?.market_open ?? false

  // Build a map of DB trades by symbol for supplementary data (stop, target, signal_id)
  const tradeMap = useMemo(() => {
    const map = {}
    if (trades) {
      for (const t of trades) {
        // Keep the most recent open trade per symbol
        if (!map[t.symbol] || new Date(t.created_at) > new Date(map[t.symbol].created_at)) {
          map[t.symbol] = t
        }
      }
    }
    return map
  }, [trades])

  if (isLoading) return <LoadingTable rows={5} cols={10} />

  if (posError) {
    return (
      <div className="bg-surface border border-border rounded-lg p-8 text-center text-text-muted">
        Unable to load positions data
      </div>
    )
  }

  if (!positions?.length) {
    return (
      <div className="bg-surface border border-border rounded-lg p-12 text-center">
        <p className="text-text-muted text-sm">No open positions — scanner is watching the market</p>
        {marketOpen && (
          <span className="inline-block mt-3 w-2 h-2 rounded-full bg-accent-green animate-pulse" />
        )}
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-lg overflow-x-auto">
      <table className="w-full text-sm min-w-[700px]">
        <thead>
          <tr className="border-b border-border text-xs text-text-muted uppercase tracking-wide">
            <th className="px-4 py-3 text-left">Symbol</th>
            <th className="px-4 py-3 text-left">Side</th>
            <th className="px-4 py-3 text-right">Qty</th>
            <th className="px-4 py-3 text-left">Avg Entry</th>
            <th className="px-4 py-3 text-left">Current</th>
            <th className="px-4 py-3 text-left">Market Value</th>
            <th className="px-4 py-3 text-left">P&L $</th>
            <th className="px-4 py-3 text-left">P&L %</th>
            <th className="px-4 py-3 text-left">Today %</th>
          </tr>
        </thead>
        <tbody>
          {positions.map(pos => (
            <PositionRow
              key={pos.asset_id || pos.symbol}
              position={pos}
              trade={tradeMap[pos.symbol]}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
