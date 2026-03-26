import { useEffect, useRef, useState } from 'react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import Badge from '../shared/Badge'
import PnlCell from '../shared/PnlCell'

export default function PositionRow({ trade, position }) {
  const prevPrice = useRef(null)
  const [flash, setFlash] = useState(null)

  const currentPrice = position?.current_price ? Number(position.current_price) : null
  const entryPrice = Number(trade.entry_price)
  const qty = Number(trade.qty)

  useEffect(() => {
    if (currentPrice !== null && prevPrice.current !== null && currentPrice !== prevPrice.current) {
      setFlash(currentPrice > prevPrice.current ? 'green' : 'red')
      const t = setTimeout(() => setFlash(null), 800)
      return () => clearTimeout(t)
    }
    prevPrice.current = currentPrice
  }, [currentPrice])

  const pnlDollar = currentPrice != null ? (currentPrice - entryPrice) * qty : null
  const pnlPct = currentPrice != null ? ((currentPrice - entryPrice) / entryPrice) * 100 : null

  const duration = trade.created_at
    ? formatDistanceToNow(parseISO(trade.created_at), { addSuffix: false })
    : '—'

  return (
    <tr
      className={`border-b border-border transition-colors ${
        flash === 'green' ? 'animate-flash-green' : flash === 'red' ? 'animate-flash-red' : ''
      }`}
    >
      <td className="px-4 py-2 font-mono font-bold text-text-primary">{trade.symbol}</td>
      <td className="px-4 py-2">
        <Badge variant={trade.side?.toLowerCase() === 'buy' ? 'buy' : 'sell'}>
          {trade.side}
        </Badge>
      </td>
      <td className="px-4 py-2 font-mono text-right">{qty}</td>
      <td className="px-4 py-2 font-mono">${entryPrice.toFixed(2)}</td>
      <td className="px-4 py-2 font-mono">
        {currentPrice != null ? `$${currentPrice.toFixed(2)}` : '—'}
      </td>
      <td className="px-4 py-2 font-mono text-accent-red/70">${Number(trade.stop_loss).toFixed(2)}</td>
      <td className="px-4 py-2 font-mono text-accent-green/70">${Number(trade.take_profit).toFixed(2)}</td>
      <td className="px-4 py-2"><PnlCell dollar={pnlDollar} /></td>
      <td className="px-4 py-2"><PnlCell pct={pnlPct} /></td>
      <td className="px-4 py-2 text-text-muted text-sm">{duration}</td>
    </tr>
  )
}
