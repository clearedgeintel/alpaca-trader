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
  const [lastResult, setLastResult] = useState(null)
  const { data, refetch } = useQuery({
    queryKey: ['reconcile-preview'],
    queryFn: getReconcilePreview,
    staleTime: 60_000,
    refetchInterval: 5 * 60 * 1000,
  })

  if (!data) return null
  const missingInDb = data.missingInDb || []
  const missingInBroker = data.missingInBroker || []
  const hasDrift = missingInDb.length > 0 || missingInBroker.length > 0

  // Even when there's no drift, show a tiny "in sync" pill if we recently
  // reconciled — confirms the action worked. Otherwise stay hidden.
  if (!hasDrift && !lastResult) return null

  async function go() {
    setBusy(true)
    try {
      const result = await reconcilePositions()
      setLastResult(result)
      await refetch()
      queryClient.invalidateQueries({ queryKey: ['trades'] })
      queryClient.invalidateQueries({ queryKey: ['positions'] })
    } catch (err) {
      setLastResult({ error: err.message })
    }
    setBusy(false)
    setConfirmOpen(false)
  }

  // Result panel — appears after a reconcile run, shows counts + per-row failures.
  if (lastResult && !hasDrift) {
    return <ResultPanel result={lastResult} onDismiss={() => setLastResult(null)} />
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
            Alpaca: <span className="text-text-primary">{data.alpacaCount ?? '?'}</span> open positions ·
            DB: <span className="text-text-primary">{data.dbOpenCount ?? '?'}</span> open trades
            {missingInDb.length > 0 && (
              <><br /><span className="text-accent-amber">{missingInDb.length}</span> position{missingInDb.length === 1 ? '' : 's'} held in Alpaca but not tracked in this bot.</>
            )}
            {missingInBroker.length > 0 && (
              <><br /><span className="text-accent-amber">{missingInBroker.length}</span> open trade row{missingInBroker.length === 1 ? '' : 's'} no longer at Alpaca (closed externally?).</>
            )}
          </p>

          {lastResult && <PartialResultStrip result={lastResult} />}

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

// Shown when the last reconcile run completed but the diff is now clean —
// confirms what was done without leaving a stale banner once drift is gone.
function ResultPanel({ result, onDismiss }) {
  const failures = result.failures || []
  if (result.error) {
    return (
      <div className="rounded-lg border border-accent-red/40 bg-accent-red/5 p-3 mb-2">
        <div className="flex items-start gap-2">
          <span className="text-sm">✗</span>
          <div className="flex-1">
            <p className="text-xs font-mono text-accent-red">Reconcile failed: {result.error}</p>
            <button onClick={onDismiss} className="mt-1 text-[10px] font-mono text-text-dim hover:text-text-primary">dismiss</button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className={clsx(
      'rounded-lg border p-3 mb-2',
      failures.length === 0 ? 'border-accent-green/40 bg-accent-green/5' : 'border-accent-amber/40 bg-accent-amber/5',
    )}>
      <div className="flex items-start gap-2">
        <span className="text-sm">{failures.length === 0 ? '✓' : '⚠'}</span>
        <div className="flex-1">
          <p className={clsx('text-xs font-mono', failures.length === 0 ? 'text-accent-green' : 'text-accent-amber')}>
            Reconciled — inserted {result.inserted ?? 0}, closed {result.closed ?? 0}{failures.length > 0 ? `, ${failures.length} failures` : ''}.
          </p>
          {failures.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[10px] font-mono text-accent-red">
              {failures.map((f, i) => (
                <li key={i}>{f.symbol} ({f.op}): {f.error}</li>
              ))}
            </ul>
          )}
          <button onClick={onDismiss} className="mt-1 text-[10px] font-mono text-text-dim hover:text-text-primary">dismiss</button>
        </div>
      </div>
    </div>
  )
}

// Same shape as ResultPanel but inlined when drift still remains after a
// partial reconcile — failures need to stay visible while the operator
// decides what to do.
function PartialResultStrip({ result }) {
  const failures = result.failures || []
  if (!result.error && failures.length === 0) return null
  return (
    <div className="rounded border border-accent-red/30 bg-accent-red/5 p-2 mt-2">
      {result.error && <p className="text-[10px] font-mono text-accent-red">Last run error: {result.error}</p>}
      {failures.length > 0 && (
        <>
          <p className="text-[10px] uppercase tracking-wide text-text-dim font-mono">Last run had {failures.length} failure(s):</p>
          <ul className="space-y-0.5 text-[10px] font-mono text-accent-red mt-1">
            {failures.map((f, i) => <li key={i}>{f.symbol} ({f.op}): {f.error}</li>)}
          </ul>
        </>
      )}
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
