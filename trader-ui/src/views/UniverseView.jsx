import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { useMarketUniverse } from '../hooks/useQueries'
import { formatDistanceToNow, parseISO } from 'date-fns'

const SOURCE_COLORS = {
  userWatchlist: 'accent-blue',
  alpacaMostActive: 'accent-amber',
  alpacaGainers: 'accent-green',
  alpacaLosers: 'accent-red',
  pennyStocks: 'accent-amber',
  discoveryPool: 'text-muted',
}

const SOURCE_LABELS = {
  userWatchlist: 'User Watchlist',
  alpacaMostActive: 'Most Active',
  alpacaGainers: 'Top Gainers',
  alpacaLosers: 'Top Losers',
  pennyStocks: 'Penny Stocks',
  discoveryPool: 'Discovery Pool',
}

export default function UniverseView() {
  const { data, isLoading } = useMarketUniverse()
  const [activeTab, setActiveTab] = useState('all')

  const sources = data?.sources || {}
  const dynamicWl = data?.dynamicWatchlist || []
  const candidates = data?.candidates || []
  const userWl = data?.userWatchlist || []
  const discoveryPool = data?.discoveryPool || []
  const marketTheme = data?.marketTheme

  const totalSources = Object.values(sources).reduce((sum, s) => sum + (s.count || 0), 0)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Symbol Universe</h2>
          <p className="text-xs text-text-muted mt-0.5">
            All symbols currently being monitored across all discovery sources
          </p>
        </div>
        {data?.lastUpdate && (
          <span className="text-xs text-text-dim font-mono">
            Updated {formatDistanceToNow(parseISO(data.lastUpdate), { addSuffix: true })}
          </span>
        )}
      </div>

      {marketTheme && (
        <div className="bg-surface border border-accent-blue/20 rounded-lg p-4">
          <p className="text-[10px] text-accent-blue uppercase tracking-wide font-semibold mb-1">Today's Market Theme</p>
          <p className="text-sm text-text-primary">{marketTheme}</p>
        </div>
      )}

      {/* Source breakdown cards */}
      <div className="grid grid-cols-6 gap-3">
        {Object.entries(sources).map(([key, s]) => (
          <div key={key} className={clsx(
            'bg-surface border border-border rounded-lg p-3 relative overflow-hidden',
          )}>
            <div className={clsx('absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r',
              `from-${SOURCE_COLORS[key]}/60 to-${SOURCE_COLORS[key]}/0`)} />
            <p className="text-[10px] text-text-dim uppercase tracking-wide mb-1">{SOURCE_LABELS[key]}</p>
            <p className="font-mono text-2xl font-semibold text-text-primary">{s.count}</p>
            <p className="text-[10px] text-text-dim mt-1 leading-tight line-clamp-2">{s.description}</p>
          </div>
        ))}
      </div>

      {/* Coverage summary */}
      <div className="grid grid-cols-3 gap-4">
        <CoverageCard
          label="Active Watchlist"
          value={dynamicWl.length}
          subtitle="Symbols passed to TA agent this cycle"
          color="accent-blue"
        />
        <CoverageCard
          label="Candidates Scanned"
          value={candidates.length}
          subtitle="After hard filters (price/volume/change)"
          color="accent-amber"
        />
        <CoverageCard
          label="Total Sources Hit"
          value={totalSources}
          subtitle="Pre-dedup count across all sources"
          color="accent-green"
        />
      </div>

      {/* API cost note */}
      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Cost Notes</h3>
        <ul className="text-xs text-text-muted space-y-1 list-disc list-inside">
          <li>Alpaca screener/data APIs are <span className="text-accent-green">free + unlimited</span> on paper accounts</li>
          <li>Real cost is LLM tokens — Technical Agent runs Claude per symbol per cycle</li>
          <li>Reduce cost: shrink active watchlist or increase scan interval (Settings)</li>
          <li>Increase coverage: nothing — you're already pulling Alpaca's broadest screeners</li>
        </ul>
      </div>

      {/* Tabbed symbol lists */}
      <div className="bg-surface border border-border rounded-lg">
        <div className="flex border-b border-border">
          {[
            { key: 'all', label: 'Active', list: dynamicWl },
            { key: 'user', label: 'My Watchlist', list: userWl },
            { key: 'candidates', label: 'Top Candidates', list: candidates.map(c => c.symbol) },
            { key: 'pool', label: 'Discovery Pool', list: discoveryPool },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={clsx(
                'px-4 py-3 text-xs font-medium transition-colors',
                activeTab === tab.key
                  ? 'text-text-primary border-b-2 border-accent-blue -mb-px'
                  : 'text-text-muted hover:text-text-primary'
              )}
            >
              {tab.label} <span className="text-text-dim font-mono">({tab.list.length})</span>
            </button>
          ))}
        </div>

        <div className="p-4">
          {activeTab === 'all' && <SymbolGrid symbols={dynamicWl} />}
          {activeTab === 'user' && <SymbolGrid symbols={userWl} />}
          {activeTab === 'candidates' && <CandidatesTable candidates={candidates} />}
          {activeTab === 'pool' && <SymbolGrid symbols={discoveryPool} />}
        </div>
      </div>

      {isLoading && <p className="text-xs text-text-dim text-center">Loading universe...</p>}
    </div>
  )
}

function CoverageCard({ label, value, subtitle, color }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 relative overflow-hidden">
      <div className={clsx('absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r', `from-${color}/60 to-${color}/0`)} />
      <p className="text-xs text-text-muted uppercase tracking-wide mb-2">{label}</p>
      <p className="font-mono text-3xl font-semibold text-text-primary">{value}</p>
      <p className="text-xs text-text-dim mt-1">{subtitle}</p>
    </div>
  )
}

function SymbolGrid({ symbols }) {
  if (!symbols.length) {
    return <p className="text-xs text-text-dim text-center py-6">No symbols</p>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {symbols.map(s => (
        <Link
          key={s}
          to={`/market?symbol=${s}`}
          className="px-2.5 py-1 text-xs font-mono bg-elevated border border-border rounded text-text-primary hover:border-accent-blue hover:text-accent-blue transition-colors"
        >
          {s}
        </Link>
      ))}
    </div>
  )
}

function CandidatesTable({ candidates }) {
  if (!candidates.length) {
    return <p className="text-xs text-text-dim text-center py-6">No candidates yet — waiting for first screener cycle</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-text-muted border-b border-border">
            <th className="text-left py-2 pr-3">Symbol</th>
            <th className="text-right py-2 px-2">Price</th>
            <th className="text-right py-2 px-2">Change %</th>
            <th className="text-right py-2 px-2">Volume</th>
            <th className="text-right py-2 px-2">Gap %</th>
            <th className="text-center py-2 px-2">Watchlist</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c, i) => (
            <tr key={c.symbol || i} className="border-b border-border/30 hover:bg-elevated/30">
              <td className="py-1.5 pr-3 font-semibold">
                <Link to={`/market?symbol=${c.symbol}`} className="text-text-primary hover:text-accent-blue">{c.symbol}</Link>
              </td>
              <td className="py-1.5 px-2 text-right text-text-primary">${c.price?.toFixed(2)}</td>
              <td className={clsx(
                'py-1.5 px-2 text-right',
                c.changePct > 0 ? 'text-accent-green' : c.changePct < 0 ? 'text-accent-red' : 'text-text-muted',
              )}>
                {c.changePct > 0 ? '+' : ''}{c.changePct?.toFixed(2)}%
              </td>
              <td className="py-1.5 px-2 text-right text-text-muted">
                {c.volume ? `${(c.volume / 1e6).toFixed(2)}M` : '--'}
              </td>
              <td className={clsx(
                'py-1.5 px-2 text-right',
                Math.abs(c.gapPct) >= 2 ? 'text-accent-amber' : 'text-text-muted',
              )}>
                {c.gapPct ? `${c.gapPct > 0 ? '+' : ''}${c.gapPct?.toFixed(2)}%` : '--'}
              </td>
              <td className="py-1.5 px-2 text-center">
                {c.isFromWatchlist && <span className="text-accent-blue">★</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
