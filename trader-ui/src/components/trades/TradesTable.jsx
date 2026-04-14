import { useState, useMemo } from 'react'
import { format, parseISO, isToday, isThisWeek, isThisMonth } from 'date-fns'
import { useAllTrades } from '../../hooks/useQueries'
import { LoadingTable } from '../shared/LoadingState'
import Badge from '../shared/Badge'
import PnlCell from '../shared/PnlCell'
import TradeDrawer from './TradeDrawer'
import clsx from 'clsx'

const PAGE_SIZE = 25

export default function TradesTable() {
  const { data: trades, isLoading, isError } = useAllTrades()
  const [statusFilter, setStatusFilter] = useState('all')
  const [symbolSearch, setSymbolSearch] = useState('')
  const [dateRange, setDateRange] = useState('all')
  const [page, setPage] = useState(0)
  const [selectedTrade, setSelectedTrade] = useState(null)

  const filtered = useMemo(() => {
    let result = trades || []

    if (statusFilter !== 'all') {
      result = result.filter(t => t.status === statusFilter)
    }

    if (symbolSearch) {
      const q = symbolSearch.toUpperCase()
      result = result.filter(t => t.symbol.toUpperCase().includes(q))
    }

    if (dateRange !== 'all') {
      result = result.filter(t => {
        const d = parseISO(t.created_at)
        if (dateRange === 'today') return isToday(d)
        if (dateRange === 'week') return isThisWeek(d)
        if (dateRange === 'month') return isThisMonth(d)
        return true
      })
    }

    return result
  }, [trades, statusFilter, symbolSearch, dateRange])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  if (isLoading) return <LoadingTable rows={10} cols={10} />
  if (isError) return (
    <div className="bg-surface border border-border rounded-lg p-8 text-center text-text-muted">
      Unable to load trades data
    </div>
  )

  return (
    <>
      {/* Filter Bar */}
      <div className="flex items-center gap-4 mb-4">
        {/* Status Toggle */}
        <div className="flex bg-elevated rounded overflow-hidden border border-border">
          {['all', 'open', 'closed'].map(s => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(0) }}
              className={clsx(
                'px-3 py-1.5 text-xs font-mono uppercase transition-colors',
                statusFilter === s
                  ? 'bg-accent-blue/20 text-accent-blue'
                  : 'text-text-muted hover:text-text-primary'
              )}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Symbol Search */}
        <input
          type="text"
          placeholder="Search symbol..."
          value={symbolSearch}
          onChange={e => { setSymbolSearch(e.target.value); setPage(0) }}
          className="bg-elevated border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder-text-dim outline-none focus:border-accent-blue/50 w-40 font-mono"
        />

        {/* Date Range */}
        <div className="flex bg-elevated rounded overflow-hidden border border-border">
          {[
            { key: 'today', label: 'Today' },
            { key: 'week', label: 'This Week' },
            { key: 'month', label: 'This Month' },
            { key: 'all', label: 'All Time' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => { setDateRange(key); setPage(0) }}
              className={clsx(
                'px-3 py-1.5 text-xs font-mono transition-colors',
                dateRange === key
                  ? 'bg-accent-blue/20 text-accent-blue'
                  : 'text-text-muted hover:text-text-primary'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="ml-auto text-xs text-text-dim font-mono">
          {filtered.length} trade{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="bg-surface border border-border rounded-lg p-8 text-center text-text-muted text-sm">
          No trades match your filters
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-text-muted uppercase tracking-wide">
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Symbol</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-left">Entry</th>
                <th className="px-4 py-3 text-left">Exit</th>
                <th className="px-4 py-3 text-left">P&L $</th>
                <th className="px-4 py-3 text-left">P&L %</th>
                <th className="px-4 py-3 text-left">Exit Reason</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {paged.map(trade => {
                const pnl = trade.pnl ? Number(trade.pnl) : null
                const entry = Number(trade.entry_price)
                const pnlPct = trade.pnl_pct ? Number(trade.pnl_pct) : (pnl && entry && trade.qty ? (pnl / (entry * Number(trade.qty))) * 100 : null)

                return (
                  <tr
                    key={trade.id}
                    onClick={() => setSelectedTrade(trade)}
                    className="border-b border-border hover:bg-elevated/50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2 text-text-muted">
                      {format(parseISO(trade.created_at), 'MMM d, h:mm a')}
                    </td>
                    <td className="px-4 py-2 font-mono font-bold">{trade.symbol}</td>
                    <td className="px-4 py-2 font-mono text-right">{trade.qty}</td>
                    <td className="px-4 py-2 font-mono">${entry.toFixed(2)}</td>
                    <td className="px-4 py-2 font-mono">
                      {trade.exit_price ? `$${Number(trade.exit_price).toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <PnlCell dollar={pnl} />
                    </td>
                    <td className="px-4 py-2">
                      <PnlCell pct={pnlPct} />
                    </td>
                    <td className="px-4 py-2 text-text-muted text-xs">
                      {trade.exit_reason || '—'}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={trade.status === 'open' ? 'open' : 'closed'}>{trade.status}</Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-3 py-1.5 text-xs font-mono bg-elevated border border-border rounded text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Prev
          </button>
          <span className="text-xs font-mono text-text-muted">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-3 py-1.5 text-xs font-mono bg-elevated border border-border rounded text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}

      {/* Drawer */}
      {selectedTrade && (
        <TradeDrawer trade={selectedTrade} onClose={() => setSelectedTrade(null)} />
      )}
    </>
  )
}
