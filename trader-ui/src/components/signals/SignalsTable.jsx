import { useState } from 'react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useSignals } from '../../hooks/useQueries'
import { LoadingTable } from '../shared/LoadingState'
import Badge from '../shared/Badge'
import Sparkline from '../shared/Sparkline'

function rsiColor(rsi) {
  if (rsi == null) return 'text-text-dim'
  const v = Number(rsi)
  if (v < 30) return 'text-accent-red'
  if (v < 45) return 'text-accent-amber'
  if (v <= 70) return 'text-accent-green'
  return 'text-accent-amber'
}

const formatNum = (v, digits = 2) => (v == null || v === '' ? '--' : Number(v).toFixed(digits))
const formatPrice = (v) => (v == null || v === '' ? '--' : `$${Number(v).toFixed(2)}`)

export default function SignalsTable() {
  const [limit, setLimit] = useState(50)
  const { data: signals, isLoading, isError } = useSignals(limit)

  if (isLoading) return <LoadingTable rows={10} cols={9} />
  if (isError) return (
    <div className="bg-surface border border-border rounded-lg p-8 text-center text-text-muted">
      Unable to load signals data
    </div>
  )

  if (!signals?.length) {
    return (
      <div className="bg-surface border border-border rounded-lg p-8 text-center text-text-muted text-sm">
        No signals recorded yet
      </div>
    )
  }

  return (
    <>
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-text-muted uppercase tracking-wide">
              <th className="px-4 py-3 text-left">Time</th>
              <th className="px-4 py-3 text-left">Symbol</th>
              <th className="px-4 py-3 text-left">Signal</th>
              <th className="px-4 py-3 text-left">Close</th>
              <th className="px-4 py-3 text-left">EMA9</th>
              <th className="px-4 py-3 text-left">EMA21</th>
              <th className="px-4 py-3 text-left">RSI</th>
              <th className="px-4 py-3 text-left">Vol Ratio</th>
              <th className="px-4 py-3 text-center">Acted</th>
              <th className="px-4 py-3 text-left">Reason</th>
            </tr>
          </thead>
          <tbody>
            {signals.map(s => (
              <tr key={s.id} className="border-b border-border">
                <td className="px-4 py-2 text-text-muted text-xs" title={s.created_at}>
                  {formatDistanceToNow(parseISO(s.created_at), { addSuffix: true })}
                </td>
                <td className="px-4 py-2 font-mono font-bold">{s.symbol}</td>
                <td className="px-4 py-2">
                  <Badge variant={s.signal?.toLowerCase() === 'buy' ? 'buy' : 'sell'}>{s.signal}</Badge>
                </td>
                <td className="px-4 py-2 font-mono">{formatPrice(s.close_price ?? s.close)}</td>
                <td className="px-4 py-2 font-mono text-text-muted">{formatNum(s.ema9)}</td>
                <td className="px-4 py-2 font-mono text-text-muted">{formatNum(s.ema21)}</td>
                <td className={`px-4 py-2 font-mono ${rsiColor(s.rsi)}`}>
                  {s.rsi == null ? '--' : formatNum(s.rsi, 1)}
                </td>
                <td className="px-4 py-2">
                  {s.volume_ratio != null || s.vol_ratio != null
                    ? <Sparkline value={Number(s.volume_ratio ?? s.vol_ratio)} />
                    : <span className="text-text-dim text-xs font-mono">--</span>}
                </td>
                <td className="px-4 py-2 text-center">
                  {s.acted_on ? (
                    <span className="text-accent-green">&#10003;</span>
                  ) : (
                    <span className="text-text-dim">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-text-muted text-xs max-w-[200px] truncate" title={s.reason}>
                  {s.reason || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {signals.length >= limit && (
        <div className="flex justify-center mt-4">
          <button
            onClick={() => setLimit(l => l + 50)}
            className="px-4 py-2 text-xs font-mono bg-elevated border border-border rounded text-text-muted hover:text-text-primary transition-colors"
          >
            Load More
          </button>
        </div>
      )}
    </>
  )
}
