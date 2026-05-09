import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import Badge from '../shared/Badge'
import PnlCell from '../shared/PnlCell'
import ClosePositionButton from './ClosePositionButton'
import { isOccSymbol, formatOptionLabel } from '../../lib/optionSymbol'

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
        'transition-colors',
        flash === 'green' && 'animate-flash-green',
        flash === 'red' && 'animate-flash-red',
      )}
    >
      <td className="font-mono font-bold text-text-primary">
        <div className="flex items-center gap-2">
          <span>{position.symbol}</span>
          {isOccSymbol(position.symbol) && (
            <span className="text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue">
              opt
            </span>
          )}
        </div>
        {isOccSymbol(position.symbol) && (
          <div className="text-[10px] font-normal normal-case tracking-normal text-text-muted leading-tight mt-0.5">
            {formatOptionLabel(position.symbol)}
          </div>
        )}
      </td>
      <td>
        <Badge variant={side === 'long' ? 'buy' : 'sell'}>
          {side}
        </Badge>
      </td>
      <td className="font-mono text-right">{qty}</td>
      <td className="font-mono">${avgEntry.toFixed(2)}</td>
      <td className="font-mono">${currentPrice.toFixed(isOccSymbol(position.symbol) ? 3 : 2)}</td>
      <td className="font-mono">${marketValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td><PnlCell dollar={unrealizedPl} /></td>
      <td><PnlCell pct={unrealizedPlPct} /></td>
      <td>
        <span className={clsx(
          'font-mono text-xs',
          changeTodayPct > 0 ? 'text-accent-green' : changeTodayPct < 0 ? 'text-accent-red' : 'text-text-muted',
        )}>
          {changeTodayPct > 0 ? '+' : ''}{changeTodayPct.toFixed(2)}%
        </span>
      </td>
      <td className="text-right">
        <ClosePositionButton position={position} />
      </td>
    </tr>
  )
}
