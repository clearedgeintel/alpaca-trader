import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { getReconcilePreview, reconcilePositions } from '../../api/client'
import { formatQty } from '../../lib/formatQty'

/**
 * Banner that surfaces when /api/positions (Alpaca's open positions) and the
 * `trades` DB table disagree. Common causes:
 *   - Positions opened manually in Alpaca's web UI
 *   - A previous bot run wrote to a different DB
 *   - Trade INSERT failed after Alpaca order placed (orphan partial txn)
 *
 * One-click reconcile inserts placeholder trade rows for Alpaca-only
 * positions (tagged strategy_pool='reconciled', stop/target NULL so the
 * monitor uses config defaults) and marks DB-only open trades as closed
 * with exit_reason='reconciled'.
 */
export default function ReconcileBanner() {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const { data, refetch } = useQuery({
    queryKey: ['reconcile-preview'],
    queryFn: getReconcilePreview,
    staleTime: 60_000,
    refetchInterval: 5 * 60 * 1000,
  })

  if (!data) return null
  const missingInDb = data.missingInDb || []
  const missingInBroker = data.missingInBroker || []
  if (missingInDb.length === 0 && missingInBroker.length === 0) return null

  async function go() {
    setBusy(true)
    try {
      const result = await reconcilePositions()
      alert(`Reconciled: ${result.inserted} inserted, ${result.closed} closed.`)
      await refetch()
      queryClient.invalidateQueries({ queryKey: ['trades'] })
      queryClient.invalidateQueries({ queryKey: ['positions'] })
    } catch (err) {
      alert(`Reconcile failed: ${err.message}`)
    }
    setBusy(false)
    setConfirmOpen(false)
  }

  return (
    <div className="rounded-lg border border-accent-amber/40 bg-accent-amber/5 p-4 mb-2">
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none">⚠</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-accent-amber">
            Trade history is out of sync with your Alpaca account
          </p>
          <p className="text-[11px] text-text-dim font-mono mt-1 leading-snug">
            {missingInDb.length > 0 && (
              <span>
                <span className="text-accent-amber">{missingInDb.length}</span> position{missingInDb.length === 1 ? '' : 's'} held in Alpaca but not tracked in this bot.
              </span>
            )}
            {missingInDb.length > 0 && missingInBroker.length > 0 && <br />}
            {missingInBroker.length > 0 && (
              <span>
                <span className="text-accent-amber">{missingInBroker.length}</span> open trade row{missingInBroker.length === 1 ? '' : 's'} no longer at Alpaca (closed externally?).
              </span>
            )}
          </p>

          {confirmOpen ? (
            <ConfirmDetail
              missingInDb={missingInDb}
              missingInBroker={missingInBroker}
              onConfirm={go}
              onCancel={() => setConfirmOpen(false)}
              busy={busy}
            />
          ) : (
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => setConfirmOpen(true)}
                className="px-3 py-1.5 text-xs font-mono font-semibold bg-accent-amber/20 text-accent-amber border border-accent-amber/40 rounded hover:bg-accent-amber/30"
              >
                Reconcile from broker
              </button>
              <span className="text-[10px] text-text-dim font-mono">
                creates missing trade rows so the bot tracks them + closes orphan DB rows
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ConfirmDetail({ missingInDb, missingInBroker, onConfirm, onCancel, busy }) {
  return (
    <div className="mt-2 space-y-2">
      {missingInDb.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-text-dim font-mono mb-1">
            Will INSERT as new trade rows ({missingInDb.length})
          </p>
          <div className="bg-elevated/40 border border-border/60 rounded p-2 space-y-0.5 max-h-40 overflow-y-auto">
            {missingInDb.map((p) => (
              <div key={p.symbol} className="text-[11px] font-mono flex items-center gap-2">
                <span className="text-text-primary w-16">{p.symbol}</span>
                <span className="text-text-dim">qty {formatQty(p.qty, p.symbol)}</span>
                <span className="text-text-dim">@ ${p.avgEntryPrice?.toFixed(2)}</span>
                <span className="text-text-dim">= ${Math.abs(p.marketValue).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {missingInBroker.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-text-dim font-mono mb-1">
            Will CLOSE existing trade rows ({missingInBroker.length})
          </p>
          <div className="bg-elevated/40 border border-border/60 rounded p-2 space-y-0.5 max-h-40 overflow-y-auto">
            {missingInBroker.map((t) => (
              <div key={t.id} className="text-[11px] font-mono flex items-center gap-2">
                <span className="text-text-primary w-16">{t.symbol}</span>
                <span className="text-text-dim">qty {formatQty(t.qty, t.symbol)}</span>
                <span className="text-text-dim">pool: {t.strategyPool || 'unknown'}</span>
                <span className="text-text-dim">marked exit_reason=reconciled</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={onConfirm}
          disabled={busy}
          className={clsx(
            'px-3 py-1.5 text-xs font-mono font-semibold rounded',
            busy
              ? 'bg-elevated text-text-dim'
              : 'bg-accent-amber/30 text-accent-amber border border-accent-amber/50 hover:bg-accent-amber/40',
          )}
        >
          {busy ? 'Reconciling…' : 'Confirm reconcile'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-1.5 text-xs font-mono bg-elevated text-text-muted border border-border rounded hover:text-text-primary disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
