import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { useOpenTrades, usePositions, useStatus } from '../../hooks/useQueries'
import { LoadingTable } from '../shared/LoadingState'
import Badge from '../shared/Badge'
import StockLogo from '../shared/StockLogo'
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
    <>
      {/* Desktop: full table */}
      <div className="hidden md:block bg-surface border border-border rounded-lg overflow-x-auto">
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

      {/* Mobile: card view */}
      <div className="md:hidden space-y-2">
        {positions.map((pos) => (
          <PositionCard key={pos.asset_id || pos.symbol} position={pos} />
        ))}
      </div>
    </>
  )
}

function PositionCard({ position }) {
  const currentPrice = Number(position.current_price)
  const avgEntry = Number(position.avg_entry_price)
  const qty = Number(position.qty)
  const marketValue = Number(position.market_value)
  const unrealizedPl = Number(position.unrealized_pl)
  const unrealizedPlPct = Number(position.unrealized_plpc) * 100
  const changeTodayPct = Number(position.change_today) * 100
  const side = position.side || 'long'
  const isCrypto = position.symbol?.includes('/')
  const qtyDecimals = isCrypto ? 6 : 0

  return (
    <Link
      to={`/market?symbol=${encodeURIComponent(position.symbol)}`}
      className="block bg-surface border border-border rounded-lg p-3 hover:bg-elevated/40 transition-colors"
    >
      {/* Row 1: logo + symbol + side | P&L $ + % */}
      <div className="flex items-center gap-2 mb-2">
        <StockLogo symbol={position.symbol} size={28} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-sm text-text-primary">{position.symbol}</span>
            <Badge variant={side === 'long' ? 'buy' : 'sell'}>{side}</Badge>
          </div>
          <div className="text-[10px] text-text-dim font-mono">
            Qty {qty.toFixed(qtyDecimals)} · MV ${marketValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="text-right">
          <div className={clsx('font-mono font-bold text-sm', unrealizedPl > 0 ? 'text-accent-green' : unrealizedPl < 0 ? 'text-accent-red' : 'text-text-muted')}>
            {unrealizedPl >= 0 ? '+' : ''}${unrealizedPl.toFixed(2)}
          </div>
          <div className={clsx('font-mono text-[10px]', unrealizedPlPct > 0 ? 'text-accent-green' : unrealizedPlPct < 0 ? 'text-accent-red' : 'text-text-muted')}>
            {unrealizedPlPct >= 0 ? '+' : ''}{unrealizedPlPct.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Row 2: entry → current + today change */}
      <div className="flex items-center gap-3 text-[11px] font-mono text-text-muted">
        <span className="text-text-primary">
          ${avgEntry.toFixed(2)} → ${currentPrice.toFixed(2)}
        </span>
        <span className="ml-auto text-text-dim">Today</span>
        <span
          className={clsx(
            'font-semibold',
            changeTodayPct > 0 ? 'text-accent-green' : changeTodayPct < 0 ? 'text-accent-red' : 'text-text-muted',
          )}
        >
          {changeTodayPct > 0 ? '+' : ''}{changeTodayPct.toFixed(2)}%
        </span>
      </div>
    </Link>
  )
}
