import { useMemo } from 'react'
import { useOpenTrades, usePositions, useStatus } from '../../hooks/useQueries'
import { LoadingTable } from '../shared/LoadingState'
import PositionRow from './PositionRow'

export default function PositionsTable() {
  const { data: trades, isLoading: tradesLoading, isError: tradesError } = useOpenTrades()
  const { data: positions, isLoading: posLoading } = usePositions()
  const { data: status } = useStatus()

  const isLoading = tradesLoading || posLoading
  const marketOpen = status?.market_open ?? false

  const positionMap = useMemo(() => {
    const map = {}
    if (positions) {
      for (const p of positions) {
        map[p.symbol] = p
      }
    }
    return map
  }, [positions])

  if (isLoading) return <LoadingTable rows={5} cols={10} />

  if (tradesError) {
    return (
      <div className="bg-surface border border-border rounded-lg p-8 text-center text-text-muted">
        Unable to load positions data
      </div>
    )
  }

  if (!trades?.length) {
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
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-text-muted uppercase tracking-wide">
            <th className="px-4 py-3 text-left">Symbol</th>
            <th className="px-4 py-3 text-left">Side</th>
            <th className="px-4 py-3 text-right">Qty</th>
            <th className="px-4 py-3 text-left">Entry</th>
            <th className="px-4 py-3 text-left">Current</th>
            <th className="px-4 py-3 text-left">Stop</th>
            <th className="px-4 py-3 text-left">Target</th>
            <th className="px-4 py-3 text-left">P&L $</th>
            <th className="px-4 py-3 text-left">P&L %</th>
            <th className="px-4 py-3 text-left">Duration</th>
          </tr>
        </thead>
        <tbody>
          {trades.map(trade => (
            <PositionRow
              key={trade.id}
              trade={trade}
              position={positionMap[trade.symbol]}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
