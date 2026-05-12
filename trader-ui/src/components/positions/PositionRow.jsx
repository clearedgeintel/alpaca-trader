import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import Badge from '../shared/Badge'
import PnlCell from '../shared/PnlCell'
import StockLogo from '../shared/StockLogo'
import ClosePositionButton from './ClosePositionButton'
import { isOccSymbol, formatOptionLabel, parseOccSymbol } from '../../lib/optionSymbol'

// Risk-status pill: bucket the position by distance from stop. Computed
// off the DB trade row's stop_loss; falls back to "—" when no stop exists
// (manual entries, legacy rows). Three buckets keep it scannable:
//   SAFE    — > 30% headroom to stop (or in profit)
//   WATCH   — 10-30% headroom to stop
//   AT RISK — < 10% headroom to stop (about to trigger)
function riskStatus(currentPrice, entry, stop, unrealizedPct) {
  if (!stop || stop <= 0 || !currentPrice || currentPrice <= 0) return null
  const distToStop = (currentPrice - stop) / currentPrice
  if (distToStop <= 0) return { label: 'STOPPED', color: 'text-accent-red', bg: 'bg-accent-red/15' }
  if (distToStop < 0.10) return { label: 'AT RISK', color: 'text-accent-red', bg: 'bg-accent-red/15' }
  if (distToStop < 0.30) return { label: 'WATCH', color: 'text-accent-amber', bg: 'bg-accent-amber/15' }
  return { label: 'SAFE', color: 'text-accent-green', bg: 'bg-accent-green/15' }
}

export default function PositionRow({ position, trade }) {
  const prevPrice = useRef(null)
  const [flash, setFlash] = useState(null)

  const currentPrice = Number(position.current_price)
  const avgEntry = Number(position.avg_entry_price)
  const qty = Number(position.qty)
  const marketValue = Number(position.market_value)
  const unrealizedPl = Number(position.unrealized_pl)
  const unrealizedPlPct = Number(position.unrealized_plpc) * 100
  const changeTodayPct = Number(position.change_today) * 100
  // Day $ — Alpaca exposes unrealized_intraday_pl when subscribed; fall back
  // to deriving it from change_today + market_value if missing.
  const dayPlDollar = position.unrealized_intraday_pl != null
    ? Number(position.unrealized_intraday_pl)
    : marketValue && changeTodayPct
      ? marketValue * (changeTodayPct / 100) / (1 + changeTodayPct / 100)
      : 0
  const side = position.side || 'long'
  const stop = trade?.stop_loss ? Number(trade.stop_loss) : null
  const target = trade?.take_profit ? Number(trade.take_profit) : null
  const risk = riskStatus(currentPrice, avgEntry, stop, unrealizedPlPct)

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
          <StockLogo
            symbol={isOccSymbol(position.symbol) ? parseOccSymbol(position.symbol)?.underlying : position.symbol}
            size={24}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
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
          </div>
        </div>
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
      <td>
        <PnlCell dollar={dayPlDollar} />
        <span className={clsx(
          'block font-mono text-[10px] mt-0.5',
          changeTodayPct > 0 ? 'text-accent-green' : changeTodayPct < 0 ? 'text-accent-red' : 'text-text-muted',
        )}>
          {changeTodayPct > 0 ? '+' : ''}{changeTodayPct.toFixed(2)}%
        </span>
      </td>
      <td>
        <PnlCell dollar={unrealizedPl} />
        <span className={clsx(
          'block font-mono text-[10px] mt-0.5',
          unrealizedPlPct > 0 ? 'text-accent-green' : unrealizedPlPct < 0 ? 'text-accent-red' : 'text-text-muted',
        )}>
          {unrealizedPlPct > 0 ? '+' : ''}{unrealizedPlPct.toFixed(2)}%
        </span>
      </td>
      <td className="font-mono">
        {stop ? (
          <span className="text-accent-red">${stop.toFixed(2)}</span>
        ) : (
          <span className="text-text-dim">—</span>
        )}
      </td>
      <td className="font-mono">
        {target ? (
          <span className="text-accent-green">${target.toFixed(2)}</span>
        ) : (
          <span className="text-text-dim">—</span>
        )}
      </td>
      <td>
        {risk ? (
          <span className={clsx(
            'inline-block text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded tracking-wide',
            risk.color,
            risk.bg,
          )}>
            {risk.label}
          </span>
        ) : (
          <span className="text-text-dim font-mono text-xs">—</span>
        )}
      </td>
      <td className="text-right">
        <ClosePositionButton position={position} />
      </td>
    </tr>
  )
}
