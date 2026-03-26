import { useEffect } from 'react'
import { format, parseISO } from 'date-fns'
import Badge from '../shared/Badge'
import PnlCell from '../shared/PnlCell'

export default function TradeDrawer({ trade, onClose }) {
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  if (!trade) return null

  const entry = Number(trade.entry_price)
  const stop = Number(trade.stop_loss)
  const target = Number(trade.take_profit)
  const exit = trade.exit_price ? Number(trade.exit_price) : null
  const pnl = trade.pnl ? Number(trade.pnl) : null
  const pnlPct = trade.pnl_pct ? Number(trade.pnl_pct) : (pnl && entry ? (pnl / (entry * Number(trade.qty))) * 100 : null)

  // Mini P&L bar: number line from stop to target
  const range = target - stop
  const entryPct = range > 0 ? ((entry - stop) / range) * 100 : 50
  const currentPct = exit != null && range > 0 ? ((exit - stop) / range) * 100 : null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 w-[420px] bg-surface border-l border-border z-50 overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="font-mono font-bold text-lg">{trade.symbol}</h3>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Status + Side */}
          <div className="flex gap-2">
            <Badge variant={trade.status === 'open' ? 'open' : 'closed'}>{trade.status}</Badge>
            <Badge variant={trade.side?.toLowerCase() === 'buy' ? 'buy' : 'sell'}>{trade.side}</Badge>
          </div>

          {/* Trade details */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Detail label="Quantity" value={trade.qty} mono />
            <Detail label="Entry Price" value={`$${entry.toFixed(2)}`} mono />
            <Detail label="Stop Loss" value={`$${stop.toFixed(2)}`} mono className="text-accent-red/70" />
            <Detail label="Take Profit" value={`$${target.toFixed(2)}`} mono className="text-accent-green/70" />
            {exit != null && <Detail label="Exit Price" value={`$${exit.toFixed(2)}`} mono />}
            {trade.exit_reason && <Detail label="Exit Reason" value={trade.exit_reason} />}
            <Detail label="Opened" value={format(parseISO(trade.created_at), 'MMM d, h:mm a')} />
            {trade.closed_at && <Detail label="Closed" value={format(parseISO(trade.closed_at), 'MMM d, h:mm a')} />}
          </div>

          {/* P&L */}
          {pnl != null && (
            <div className="border border-border rounded-lg p-4">
              <p className="text-xs text-text-muted uppercase tracking-wide mb-2">Profit / Loss</p>
              <PnlCell dollar={pnl} pct={pnlPct} />
            </div>
          )}

          {/* Mini P&L bar */}
          <div className="border border-border rounded-lg p-4">
            <p className="text-xs text-text-muted uppercase tracking-wide mb-3">Price Range</p>
            <div className="relative h-2 bg-elevated rounded-full">
              {/* Entry marker */}
              <div
                className="absolute top-1/2 -translate-y-1/2 w-2 h-4 bg-accent-blue rounded-sm"
                style={{ left: `${Math.min(Math.max(entryPct, 0), 100)}%` }}
                title={`Entry: $${entry.toFixed(2)}`}
              />
              {/* Current/Exit marker */}
              {currentPct != null && (
                <div
                  className={`absolute top-1/2 -translate-y-1/2 w-2 h-4 rounded-sm ${pnl >= 0 ? 'bg-accent-green' : 'bg-accent-red'}`}
                  style={{ left: `${Math.min(Math.max(currentPct, 0), 100)}%` }}
                  title={`Exit: $${exit.toFixed(2)}`}
                />
              )}
            </div>
            <div className="flex justify-between mt-2 text-[10px] font-mono text-text-dim">
              <span>Stop ${stop.toFixed(2)}</span>
              <span>Target ${target.toFixed(2)}</span>
            </div>
          </div>

          {/* Signal info */}
          {trade.signal_reason && (
            <div className="border border-border rounded-lg p-4">
              <p className="text-xs text-text-muted uppercase tracking-wide mb-2">Signal</p>
              <p className="text-sm text-text-muted">{trade.signal_reason}</p>
              {trade.signal_rsi && (
                <p className="font-mono text-xs text-text-dim mt-1">
                  RSI: {Number(trade.signal_rsi).toFixed(1)} | EMA9: {Number(trade.signal_ema9).toFixed(2)} | EMA21: {Number(trade.signal_ema21).toFixed(2)}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Detail({ label, value, mono, className }) {
  return (
    <div>
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`${mono ? 'font-mono' : ''} text-text-primary ${className || ''}`}>{value}</p>
    </div>
  )
}
