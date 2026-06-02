import { useMemo, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { useOpenTrades, usePositions, useStatus } from '../../hooks/useQueries'
import { LoadingTable } from '../shared/LoadingState'
import Badge from '../shared/Badge'
import StockLogo from '../shared/StockLogo'
import PositionRow from './PositionRow'
import ClosePositionButton from './ClosePositionButton'
import { parseOccSymbol, formatOptionLabel } from '../../lib/optionSymbol'

// Risk severity used for sort + default ordering. Higher = worse =
// surfaced first when sorted desc. Mirrored exactly in PositionRow so
// the displayed pill label always matches the sort bucket.
const RISK_RANK = { STOPPED: 4, 'AT RISK': 3, WATCH: 2, SAFE: 1 }
function computeRiskRank(currentPrice, stop) {
  if (!stop || stop <= 0 || !currentPrice || currentPrice <= 0) return 0
  const dist = (currentPrice - stop) / currentPrice
  if (dist <= 0) return RISK_RANK.STOPPED
  if (dist < 0.10) return RISK_RANK['AT RISK']
  if (dist < 0.30) return RISK_RANK.WATCH
  return RISK_RANK.SAFE
}

// Sort keys map to functions that pull the comparable scalar out of an
// enriched row. Adding a column = one line here + a SortableTh in the
// header.
const SORT_KEYS = {
  symbol: (r) => r.position.symbol,
  qty: (r) => Math.abs(Number(r.position.qty) || 0),
  mktValue: (r) => Math.abs(Number(r.position.market_value) || 0),
  dayPct: (r) => Number(r.position.change_today) || 0,
  totalDollar: (r) => Number(r.position.unrealized_pl) || 0,
  totalPct: (r) => Number(r.position.unrealized_plpc) || 0,
  // Sort by risk rank, tiebreak by absolute dollar P&L so the biggest
  // dollar losers within a risk bucket bubble to the top.
  risk: (r) => r.riskRank * 1_000_000 + Math.abs(Number(r.position.unrealized_pl) || 0),
}

const STORAGE_KEY = 'positions-sort'
const DEFAULT_SORT = { key: 'risk', dir: 'desc' }

function loadSort() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SORT
    const parsed = JSON.parse(raw)
    if (parsed?.key in SORT_KEYS && (parsed.dir === 'asc' || parsed.dir === 'desc')) return parsed
  } catch { /* fall through */ }
  return DEFAULT_SORT
}

export default function PositionsTable() {
  const { data: trades, isLoading: tradesLoading } = useOpenTrades()
  const { data: positions, isLoading: posLoading, isError: posError } = usePositions()
  const { data: status } = useStatus()
  const [sort, setSort] = useState(loadSort)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sort)) } catch { /* quota / private-mode safe */ }
  }, [sort])

  const isLoading = tradesLoading || posLoading
  const marketOpen = status?.market_open ?? false

  // Build a map of DB trades by symbol for supplementary data (stop, target, signal_id)
  const tradeMap = useMemo(() => {
    const map = {}
    if (trades) {
      for (const t of trades) {
        if (!map[t.symbol] || new Date(t.created_at) > new Date(map[t.symbol].created_at)) {
          map[t.symbol] = t
        }
      }
    }
    return map
  }, [trades])

  // Enrich each position with the matching DB trade + a precomputed
  // risk rank. Done once per render so the sort comparator only does
  // cheap scalar lookups.
  const rows = useMemo(() => {
    if (!positions) return []
    return positions.map((p) => {
      const trade = tradeMap[p.symbol] || null
      const stop = trade?.stop_loss ? Number(trade.stop_loss) : null
      const riskRank = computeRiskRank(Number(p.current_price), stop)
      return { position: p, trade, riskRank }
    })
  }, [positions, tradeMap])

  const sortedRows = useMemo(() => {
    const fn = SORT_KEYS[sort.key] || SORT_KEYS.risk
    const copy = [...rows]
    copy.sort((a, b) => {
      const av = fn(a)
      const bv = fn(b)
      if (av < bv) return sort.dir === 'asc' ? -1 : 1
      if (av > bv) return sort.dir === 'asc' ? 1 : -1
      return 0
    })
    return copy
  }, [rows, sort])

  // Aggregate footer row — totals across the visible positions. Helpful
  // when scanning a long list; gives the eye an anchor.
  const totals = useMemo(() => {
    let mktValue = 0, dayDollar = 0, totalDollar = 0
    for (const r of rows) {
      const p = r.position
      mktValue += Number(p.market_value) || 0
      const mv = Number(p.market_value) || 0
      const dayPct = Number(p.change_today) || 0
      const day = p.unrealized_intraday_pl != null
        ? Number(p.unrealized_intraday_pl)
        : mv && dayPct ? mv * dayPct / (1 + dayPct) : 0
      dayDollar += day
      totalDollar += Number(p.unrealized_pl) || 0
    }
    return { mktValue, dayDollar, totalDollar }
  }, [rows])

  function handleSort(key) {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      // Default direction per column type: symbol asc (alpha), numeric desc (biggest first).
      return { key, dir: key === 'symbol' ? 'asc' : 'desc' }
    })
  }

  if (isLoading) return <LoadingTable rows={5} cols={9} />

  if (posError) {
    return (
      <div className="app-panel p-6 text-center text-sm">
        <p className="text-accent-red font-mono">Unable to load positions data</p>
        <p className="text-text-dim text-xs mt-1">Check Alpaca API connectivity / credentials</p>
      </div>
    )
  }

  if (!positions?.length) {
    return (
      <div className="app-panel p-8 text-center">
        <p className="text-text-muted text-sm">No open positions</p>
        <p className="text-text-dim text-xs mt-1 font-mono">
          {marketOpen ? 'Scanner is watching the market' : 'Market closed — scanner resumes at open'}
        </p>
        {marketOpen && (
          <span className="inline-block mt-3 w-2 h-2 rounded-full bg-accent-green animate-pulse" />
        )}
      </div>
    )
  }

  return (
    <>
      {/* Desktop: tight, sortable, zebra-striped table. min-w lowered
          from 1040 to 920 by merging entry/current and stop/target into
          combined cells. */}
      <div className="hidden md:block app-panel overflow-x-auto">
        <table className="positions-table min-w-[920px]">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              <SortableTh sort={sort} sortKey="symbol" onSort={handleSort} align="left">Symbol</SortableTh>
              <SortableTh sort={sort} sortKey="qty" onSort={handleSort} align="right">Qty</SortableTh>
              <th className="text-left">Entry → Now</th>
              <SortableTh sort={sort} sortKey="mktValue" onSort={handleSort} align="right">Market Value</SortableTh>
              <SortableTh sort={sort} sortKey="dayPct" onSort={handleSort} align="right">Day</SortableTh>
              <SortableTh sort={sort} sortKey="totalDollar" onSort={handleSort} align="right">Total P&amp;L</SortableTh>
              <th className="text-left">Stop · Target</th>
              <SortableTh sort={sort} sortKey="risk" onSort={handleSort} align="left">Risk</SortableTh>
              <th className="text-right">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => (
              <PositionRow
                key={r.position.asset_id || r.position.symbol}
                position={r.position}
                trade={r.trade}
              />
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="border-t-2 border-border bg-elevated/40 font-mono text-[11px]">
                <td className="px-2 py-1.5 font-bold text-text-muted uppercase tracking-wide" colSpan={3}>
                  Total · {rows.length} position{rows.length === 1 ? '' : 's'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-text-primary font-semibold">
                  ${totals.mktValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className={clsx('px-2 py-1.5 text-right tabular-nums font-semibold', totals.dayDollar > 0 ? 'text-accent-green' : totals.dayDollar < 0 ? 'text-accent-red' : 'text-text-muted')}>
                  {totals.dayDollar >= 0 ? '+' : '−'}${Math.abs(totals.dayDollar).toFixed(2)}
                </td>
                <td className={clsx('px-2 py-1.5 text-right tabular-nums font-semibold', totals.totalDollar > 0 ? 'text-accent-green' : totals.totalDollar < 0 ? 'text-accent-red' : 'text-text-muted')}>
                  {totals.totalDollar >= 0 ? '+' : '−'}${Math.abs(totals.totalDollar).toFixed(2)}
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Mobile: card view (unchanged shape, kept terse) */}
      <div className="md:hidden space-y-2">
        {sortedRows.map((r) => (
          <PositionCard key={r.position.asset_id || r.position.symbol} position={r.position} trade={r.trade} />
        ))}
      </div>
    </>
  )
}

// Sortable header cell — click to cycle dir, shows ▲/▼ when active.
// Default direction is encoded in handleSort upstream so numeric columns
// open as "biggest first" instead of "smallest first."
function SortableTh({ sort, sortKey, onSort, align = 'left', children }) {
  const active = sort.key === sortKey
  const arrow = !active ? '↕' : sort.dir === 'asc' ? '▲' : '▼'
  return (
    <th className={clsx(align === 'right' ? 'text-right' : 'text-left', 'select-none')}>
      <button
        onClick={() => onSort(sortKey)}
        className={clsx(
          'inline-flex items-center gap-1 hover:text-text-primary transition-colors',
          active ? 'text-accent-blue' : 'text-text-dim',
        )}
      >
        <span>{children}</span>
        <span className={clsx('text-[9px] font-mono', !active && 'opacity-40')}>{arrow}</span>
      </button>
    </th>
  )
}

// Mobile card view — preserved from prior implementation. Mobile users
// don't need column sort (the card stack handles density differently).
function PositionCard({ position, trade }) {
  const currentPrice = Number(position.current_price)
  const avgEntry = Number(position.avg_entry_price)
  const qty = Number(position.qty)
  const marketValue = Number(position.market_value)
  const unrealizedPl = Number(position.unrealized_pl)
  const unrealizedPlPct = Number(position.unrealized_plpc) * 100
  const changeTodayPct = Number(position.change_today) * 100
  const side = position.side || 'long'
  const isCrypto = position.symbol?.includes('/')
  const opt = (() => { const p = parseOccSymbol(position.symbol); return p ? { underlying: p.underlying, type: p.type, strike: p.strike } : null })()
  const qtyDecimals = isCrypto ? 6 : 0
  const priceDecimals = opt ? 3 : 2
  const stop = trade?.stop_loss ? Number(trade.stop_loss) : null
  const target = trade?.take_profit ? Number(trade.take_profit) : null

  return (
    <Link
      to={`/market?symbol=${encodeURIComponent(opt ? opt.underlying : position.symbol)}`}
      className="block bg-surface border border-border rounded-lg p-3 hover:bg-elevated/40 transition-colors"
    >
      <div className="flex items-center gap-2 mb-2">
        <StockLogo symbol={opt ? opt.underlying : position.symbol} size={28} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono font-bold text-sm text-text-primary">
              {opt ? opt.underlying : position.symbol}
            </span>
            {opt ? (
              <span className={clsx(
                'text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded',
                opt.type === 'call' ? 'bg-accent-green/20 text-accent-green' : 'bg-accent-red/20 text-accent-red',
              )}>
                {opt.type} ${opt.strike.toFixed(0)}
              </span>
            ) : (
              <Badge variant={side === 'long' ? 'buy' : 'sell'}>{side}</Badge>
            )}
          </div>
          {opt && (
            <div className="text-[10px] text-text-muted font-mono normal-case tracking-normal leading-tight mt-0.5">
              {formatOptionLabel(position.symbol)}
            </div>
          )}
          <div className="text-[10px] text-text-dim font-mono">
            Qty {qty.toFixed(qtyDecimals)} · MV ${marketValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="text-right">
          <div className={clsx('font-mono font-bold text-sm tabular-nums', unrealizedPl > 0 ? 'text-accent-green' : unrealizedPl < 0 ? 'text-accent-red' : 'text-text-muted')}>
            {unrealizedPl >= 0 ? '+' : '−'}${Math.abs(unrealizedPl).toFixed(2)}
          </div>
          <div className={clsx('font-mono text-[10px] tabular-nums', unrealizedPlPct > 0 ? 'text-accent-green' : unrealizedPlPct < 0 ? 'text-accent-red' : 'text-text-muted')}>
            {unrealizedPlPct >= 0 ? '+' : ''}{unrealizedPlPct.toFixed(2)}%
          </div>
        </div>
        <ClosePositionButton position={position} />
      </div>

      <div className="flex items-center gap-3 text-[11px] font-mono text-text-muted tabular-nums">
        <span className="text-text-primary">
          ${avgEntry.toFixed(priceDecimals)} → ${currentPrice.toFixed(priceDecimals)}
        </span>
        <span className="ml-auto text-text-dim">Today</span>
        <span className={clsx('font-semibold', changeTodayPct > 0 ? 'text-accent-green' : changeTodayPct < 0 ? 'text-accent-red' : 'text-text-muted')}>
          {changeTodayPct > 0 ? '+' : ''}{changeTodayPct.toFixed(2)}%
        </span>
      </div>

      {(stop || target) && (
        <div className="flex items-center gap-3 text-[10px] font-mono text-text-dim mt-1.5 tabular-nums">
          {stop && <span>Stop <span className="text-accent-red">${stop.toFixed(priceDecimals)}</span></span>}
          {target && <span>Target <span className="text-accent-green">${target.toFixed(priceDecimals)}</span></span>}
        </div>
      )}
    </Link>
  )
}
