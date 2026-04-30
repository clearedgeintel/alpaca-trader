import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { placeManualOrder } from '../../api/client'

/**
 * Inline "Sell to Close" control for an open position. Shipped today
 * for option positions where active management matters most — but the
 * server's manual-trade endpoint handles equity SELL too, so callers
 * can opt in for any asset class by passing showForAll.
 *
 * UX:
 *   - Confirm dialog with the contract identity (or symbol).
 *   - Disabled during the request; shows ✓ on success, ✗ + tooltip on error.
 *   - stopPropagation so the wrapping row's <Link> doesn't navigate.
 *   - Invalidates ['positions'] + ['trades'] caches so the panels refresh.
 */
export default function ClosePositionButton({ position, label = 'Close', size = 'sm', showForAll = false }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null) // 'ok' | 'err' | null
  const [errMsg, setErrMsg] = useState(null)

  const symbol = position.symbol
  const qty = Number(position.qty)
  const isOption = isOccSymbol(symbol)

  if (!isOption && !showForAll) return null

  async function handleClose(e) {
    e.preventDefault()
    e.stopPropagation()
    if (busy) return

    const noun = isOption ? `contract${qty === 1 ? '' : 's'}` : qty < 1 ? '' : 'shares'
    const display = isOption ? prettyOcc(symbol) : symbol
    if (!confirm(`Sell to close ${qty} ${noun} of ${display}?`)) return

    setBusy(true); setDone(null); setErrMsg(null)
    try {
      await placeManualOrder({ symbol, qty, side: 'sell' })
      setDone('ok')
      queryClient.invalidateQueries({ queryKey: ['positions'] })
      queryClient.invalidateQueries({ queryKey: ['trades'] })
      queryClient.invalidateQueries({ queryKey: ['open-trades'] })
      // Reset the badge after a beat so the row doesn't read "✓" forever
      setTimeout(() => setDone(null), 4000)
    } catch (err) {
      setDone('err')
      setErrMsg(err.message || 'Close failed')
      setTimeout(() => { setDone(null); setErrMsg(null) }, 6000)
    } finally {
      setBusy(false)
    }
  }

  const sizing = size === 'xs'
    ? 'text-[10px] px-1.5 py-0.5'
    : 'text-[11px] px-2 py-1'

  return (
    <button
      onClick={handleClose}
      onMouseDown={(e) => e.stopPropagation()}
      disabled={busy}
      title={errMsg || (isOption ? 'Sell to close — settles to premium curve' : 'Sell to close')}
      className={clsx(
        'font-mono font-semibold uppercase rounded border transition-colors flex-shrink-0',
        sizing,
        done === 'ok' && 'bg-accent-green/20 text-accent-green border-accent-green/40',
        done === 'err' && 'bg-accent-red/20 text-accent-red border-accent-red/40',
        !done && 'bg-accent-red/10 text-accent-red border-accent-red/30 hover:bg-accent-red/20',
        busy && 'opacity-50 cursor-not-allowed',
      )}
    >
      {busy ? '…' : done === 'ok' ? '✓' : done === 'err' ? '✗' : label}
    </button>
  )
}

// Inline OCC detector (avoids importing asset-classes from frontend)
const OCC_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/
function isOccSymbol(s) {
  return typeof s === 'string' && OCC_RE.test(s)
}

// Pretty-print an OCC symbol for the confirm dialog: AAPL CALL $150 04-19
function prettyOcc(s) {
  const m = OCC_RE.exec(s)
  if (!m) return s
  const root = s.match(/^[A-Z]{1,6}/)?.[0] || s
  const mid = s.slice(root.length)
  const yy = mid.slice(0, 2), mm = mid.slice(2, 4), dd = mid.slice(4, 6)
  const cp = mid.slice(6, 7)
  const strike = parseInt(mid.slice(7), 10) / 1000
  return `${root} ${cp === 'C' ? 'CALL' : 'PUT'} $${strike} ${mm}-${dd}`
}
