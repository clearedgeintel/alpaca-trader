import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import Badge from '../shared/Badge'
import PnlCell from '../shared/PnlCell'
import ClosePositionButton from './ClosePositionButton'

const ROW_OCC_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/
const isOccSymbol = (s) => typeof s === 'string' && ROW_OCC_RE.test(s)

export default function PositionRow({ position }) {
  const prevPrice = useRef(null)
  const [flash, setFlash] = useState(null)

  const currentPrice = Number(position.current_price)
  const avgEntry = Number(position.avg_entry_price)
  const qty = Number(position.qty)
  const marketValue = Number(position.market_value)
  const unrealizedPl = Number(position.unrealized_pl)
  const unrealizedPlPct = Number(position.unrealized_plpc) * 100
  const changeTodayPct = Number(position.change_today) * 100
  const side = position.side || 'long'

  useEffect(() => {
    if (prevPrice.current !== null && currentPrice !== prevPrice.current) {
      setFlash(currentPrice > prevPrice.current ? 'green' : 'red')
      const t = setTimeout(() => setFlash(null), 800)
      return () => clearTimeout(t)
    }
    prevPrice.current = currentPrice
  }, [currentPrice])

  return (
    <tr
      className={clsx(
        'border-b border-border transition-colors',
        flash === 'green' && 'animate-flash-green',
        flash === 'red' && 'animate-flash-red',
      )}
    >
      <td className="px-4 py-2 font-mono font-bold text-text-primary">
        {position.symbol}
        {isOccSymbol(position.symbol) && (
          <span className="ml-2 text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue">
            opt
          </span>
        )}
      </td>
      <td className="px-4 py-2">
        <Badge variant={side === 'long' ? 'buy' : 'sell'}>
          {side}
        </Badge>
      </td>
      <td className="px-4 py-2 font-mono text-right">{qty}</td>
      <td className="px-4 py-2 font-mono">${avgEntry.toFixed(2)}</td>
      <td className="px-4 py-2 font-mono">${currentPrice.toFixed(isOccSymbol(position.symbol) ? 3 : 2)}</td>
      <td className="px-4 py-2 font-mono">${marketValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td className="px-4 py-2"><PnlCell dollar={unrealizedPl} /></td>
      <td className="px-4 py-2"><PnlCell pct={unrealizedPlPct} /></td>
      <td className="px-4 py-2">
        <span className={clsx(
          'font-mono text-xs',
          changeTodayPct > 0 ? 'text-accent-green' : changeTodayPct < 0 ? 'text-accent-red' : 'text-text-muted',
        )}>
          {changeTodayPct > 0 ? '+' : ''}{changeTodayPct.toFixed(2)}%
        </span>
      </td>
      <td className="px-4 py-2 text-right">
        <ClosePositionButton position={position} />
      </td>
    </tr>
  )
}
