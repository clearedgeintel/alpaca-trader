import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import StockLogo from '../shared/StockLogo'
import ClosePositionButton from './ClosePositionButton'
import { isOccSymbol, formatOptionLabel, parseOccSymbol } from '../../lib/optionSymbol'
import { formatQty } from '../../lib/formatQty'

// Risk-status pill: bucket the position by distance from stop. Mirrors
// computeRiskRank in PositionsTable.jsx exactly so the pill the user
// sees always matches the sort bucket.
function riskStatus(currentPrice, stop) {
  if (!stop || stop <= 0 || !currentPrice || currentPrice <= 0) return null
  const distToStop = (currentPrice - stop) / currentPrice
  if (distToStop <= 0) return { label: 'STOPPED', color: 'text-accent-red', bg: 'bg-accent-red/15' }
  if (distToStop < 0.10) return { label: 'AT RISK', color: 'text-accent-red', bg: 'bg-accent-red/15' }
  if (distToStop < 0.30) return { label: 'WATCH', color: 'text-accent-amber', bg: 'bg-accent-amber/15' }
  return { label: 'SAFE', color: 'text-accent-green', bg: 'bg-accent-green/15' }
}

// Side glyph: green ▲ for long, red ▼ for short. Sits in front of qty so
// the eye picks up direction without scanning a separate column.
function sideGlyph(side) {
  if (side === 'short') return { ch: '▼', color: 'text-accent-red' }
  return { ch: '▲', color: 'text-accent-green' }
}

// Mini-bar showing where current price sits between stop (left) and
// target (right). Clamped to [0, 100]. Returns null when either
// boundary is missing — the cell then just shows the textual values.
function stopTargetMarker(currentPrice, stop, target) {
  if (!stop || !target || stop <= 0 || target <= 0 || stop >= target) return null
  const pct = ((currentPrice - stop) / (target - stop)) * 100
  return Math.max(0, Math.min(100, pct))
}

export default function PositionRow({ position, trade }) {
  const prevPrice = useRef(null)
  const [flash, setFlash] = useState(null)

  const isOpt = isOccSymbol(position.symbol)
  const currentPrice = Number(position.current_price)
  const avgEntry = Number(position.avg_entry_price)
  const qty = Number(position.qty)
  const marketValue = Number(position.market_value)
  const unrealizedPl = Number(position.unrealized_pl)
  const unrealizedPlPct = Number(position.unrealized_plpc) * 100
  const changeTodayPct = Number(position.change_today) * 100
  // Day $ — Alpaca exposes unrealized_intraday_pl when subscribed; fall
  // back to deriving it from change_today + market_value if missing.
  const dayPlDollar = position.unrealized_intraday_pl != null
    ? Number(position.unrealized_intraday_pl)
    : marketValue && changeTodayPct
      ? marketValue * (changeTodayPct / 100) / (1 + changeTodayPct / 100)
      : 0
  const side = position.side || 'long'
  const sg = sideGlyph(side)
  const stop = trade?.stop_loss ? Number(trade.stop_loss) : null
  const target = trade?.take_profit ? Number(trade.take_profit) : null
  const risk = riskStatus(currentPrice, stop)
  const priceDecimals = isOpt ? 3 : 2
  // Entry→Now delta as %. Color matches Total P&L direction.
  const entryDelta = avgEntry > 0 ? ((currentPrice - avgEntry) / avgEntry) * 100 : 0
  const stopTargetPos = stopTargetMarker(currentPrice, stop, target)
  const opt = isOpt ? parseOccSymbol(position.symbol) : null

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
      {/* Symbol — logo + ticker + opt micro-label */}
      <td>
        <div className="flex items-center gap-2 font-mono font-bold text-text-primary">
          <StockLogo symbol={opt ? opt.underlying : position.symbol} size={22} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span>{opt ? opt.underlying : position.symbol}</span>
              {isOpt && (
                <span className={clsx(
                  'text-[9px] font-mono font-bold uppercase px-1 py-0.5 rounded',
                  opt?.type === 'call' ? 'bg-accent-green/20 text-accent-green' : 'bg-accent-red/20 text-accent-red',
                )}>
                  {opt?.type?.[0]}{opt?.strike?.toFixed(0)}
                </span>
              )}
            </div>
            {isOpt && (
              <div className="text-[9px] font-normal normal-case tracking-normal text-text-muted leading-tight">
                {formatOptionLabel(position.symbol)}
              </div>
            )}
          </div>
        </div>
      </td>

      {/* Qty — with side glyph (▲ long / ▼ short) prefix */}
      <td className="text-right">
        <span className={clsx('mr-1.5 text-[10px]', sg.color)}>{sg.ch}</span>
        <span className="font-mono text-text-primary">{formatQty(qty, position.symbol)}</span>
      </td>

      {/* Entry → Now — combined cell with delta% chip */}
      <td className="font-mono">
        <div className="flex items-center gap-1.5">
          <span className="text-text-muted">${avgEntry.toFixed(priceDecimals)}</span>
          <span className="text-text-dim text-[10px]">→</span>
          <span className="text-text-primary">${currentPrice.toFixed(priceDecimals)}</span>
          <span className={clsx(
            'text-[10px] px-1 rounded',
            entryDelta > 0 ? 'text-accent-green bg-accent-green/10' : entryDelta < 0 ? 'text-accent-red bg-accent-red/10' : 'text-text-dim',
          )}>
            {entryDelta >= 0 ? '+' : ''}{entryDelta.toFixed(1)}%
          </span>
        </div>
      </td>

      {/* Market Value — right-aligned tabular */}
      <td className="text-right font-mono text-text-primary">
        ${marketValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </td>

      {/* Day — stacked $ over % */}
      <td className="text-right font-mono">
        <div className={clsx('font-semibold', dayPlDollar > 0 ? 'text-accent-green' : dayPlDollar < 0 ? 'text-accent-red' : 'text-text-muted')}>
          {dayPlDollar >= 0 ? '+' : '−'}${Math.abs(dayPlDollar).toFixed(2)}
        </div>
        <div className={clsx('text-[10px]', changeTodayPct > 0 ? 'text-accent-green' : changeTodayPct < 0 ? 'text-accent-red' : 'text-text-muted')}>
          {changeTodayPct > 0 ? '+' : ''}{changeTodayPct.toFixed(2)}%
        </div>
      </td>

      {/* Total P&L — stacked $ over % (biggest visual) */}
      <td className="text-right font-mono">
        <div className={clsx('font-bold', unrealizedPl > 0 ? 'text-accent-green' : unrealizedPl < 0 ? 'text-accent-red' : 'text-text-muted')}>
          {unrealizedPl >= 0 ? '+' : '−'}${Math.abs(unrealizedPl).toFixed(2)}
        </div>
        <div className={clsx('text-[10px]', unrealizedPlPct > 0 ? 'text-accent-green' : unrealizedPlPct < 0 ? 'text-accent-red' : 'text-text-muted')}>
          {unrealizedPlPct > 0 ? '+' : ''}{unrealizedPlPct.toFixed(2)}%
        </div>
      </td>

      {/* Stop · Target — combined cell with mini-bar marker. Bar shows
          where current sits between stop (left) and target (right). */}
      <td className="font-mono">
        {(stop || target) ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-[11px]">
              {stop ? (
                <span className="text-accent-red">${stop.toFixed(priceDecimals)}</span>
              ) : (
                <span className="text-text-dim">—</span>
              )}
              <span className="text-text-dim">·</span>
              {target ? (
                <span className="text-accent-green">${target.toFixed(priceDecimals)}</span>
              ) : (
                <span className="text-text-dim">—</span>
              )}
            </div>
            {stopTargetPos != null && (
              <div
                className="relative h-1 bg-elevated rounded-full overflow-hidden w-24"
                title={`Current ${stopTargetPos.toFixed(0)}% between stop and target`}
              >
                <div className="absolute inset-y-0 left-0 w-1 bg-accent-red/60" />
                <div className="absolute inset-y-0 right-0 w-1 bg-accent-green/60" />
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-text-primary border border-base shadow"
                  style={{ left: `calc(${stopTargetPos}% - 4px)` }}
                />
              </div>
            )}
          </div>
        ) : (
          <span className="text-text-dim">—</span>
        )}
      </td>

      {/* Risk — color-coded status pill */}
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

      {/* Close-position action — fixed right column */}
      <td className="text-right">
        <ClosePositionButton position={position} />
      </td>
    </tr>
  )
}
