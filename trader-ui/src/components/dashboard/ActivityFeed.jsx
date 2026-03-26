import { useMemo } from 'react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useSignals, useAllTrades } from '../../hooks/useQueries'
import Badge from '../shared/Badge'

export default function ActivityFeed() {
  const { data: signals } = useSignals(20)
  const { data: trades } = useAllTrades()

  const items = useMemo(() => {
    const feed = []

    if (signals) {
      for (const s of signals.slice(0, 20)) {
        feed.push({
          id: `sig-${s.id}`,
          time: s.created_at,
          type: 'signal',
          symbol: s.symbol,
          detail: `${s.signal} — RSI ${Number(s.rsi).toFixed(1)}, EMA9 ${Number(s.ema9).toFixed(2)}`,
          signal: s.signal,
        })
      }
    }

    if (trades) {
      for (const t of trades.slice(0, 20)) {
        if (t.status === 'open') {
          feed.push({
            id: `trade-open-${t.id}`,
            time: t.created_at,
            type: 'open',
            symbol: t.symbol,
            detail: `Qty ${t.qty} @ $${Number(t.entry_price).toFixed(2)}`,
          })
        }
        if (t.status === 'closed' && t.closed_at) {
          feed.push({
            id: `trade-close-${t.id}`,
            time: t.closed_at,
            type: 'close',
            symbol: t.symbol,
            pnl: t.pnl,
            detail: `P&L ${Number(t.pnl) >= 0 ? '+' : ''}$${Number(t.pnl).toFixed(2)}`,
          })
        }
      }
    }

    feed.sort((a, b) => new Date(b.time) - new Date(a.time))
    return feed.slice(0, 20)
  }, [signals, trades])

  if (!items.length) {
    return (
      <div className="bg-surface border border-border rounded-lg p-4 text-center text-text-muted text-sm py-8">
        No recent activity
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-lg">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Activity Feed</h3>
      </div>
      <div className="divide-y divide-border max-h-[400px] overflow-y-auto">
        {items.map(item => (
          <div key={item.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
            <span className="text-xs text-text-dim font-mono w-16 shrink-0">
              {formatDistanceToNow(parseISO(item.time), { addSuffix: false })}
            </span>

            {item.type === 'signal' && <Badge variant="scan">SCAN</Badge>}
            {item.type === 'open' && <Badge variant="buy">OPEN</Badge>}
            {item.type === 'close' && <Badge variant="closed">CLOSE</Badge>}

            <span className="font-mono font-semibold text-text-primary">{item.symbol}</span>

            <span className={
              item.type === 'close'
                ? Number(item.pnl) >= 0 ? 'text-accent-green' : 'text-accent-red'
                : 'text-text-muted'
            }>
              {item.detail}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
