import { useEffect, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useAccount, useStatus, useOpenTrades, useIsAnyFetching } from '../../hooks/useQueries'

export default function TopBar() {
  const { data: account, isError: accountError } = useAccount()
  const { data: status, isError: statusError } = useStatus()
  const { data: openTrades } = useOpenTrades()
  const isFetching = useIsAnyFetching()
  const isOffline = accountError && statusError

  const prevValue = useRef(null)
  const [flash, setFlash] = useState(null)

  const portfolioValue = account?.portfolio_value ?? account?.equity ?? null
  const buyingPower = account?.buying_power ?? null
  const openCount = openTrades?.length ?? 0
  const marketOpen = status?.market_open ?? false
  const lastScan = status?.last_scan ?? null

  useEffect(() => {
    if (portfolioValue !== null && prevValue.current !== null) {
      if (portfolioValue > prevValue.current) setFlash('green')
      else if (portfolioValue < prevValue.current) setFlash('red')
    }
    prevValue.current = portfolioValue
    if (flash) {
      const t = setTimeout(() => setFlash(null), 800)
      return () => clearTimeout(t)
    }
  }, [portfolioValue, flash])

  return (
    <header className="sticky top-0 z-40 h-14 bg-surface border-b border-border flex items-center justify-between px-6">
      <div className="flex items-center gap-8">
        {/* Portfolio Value */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted uppercase tracking-wide">Portfolio</span>
          <span
            className={`font-mono text-lg font-semibold transition-colors ${
              flash === 'green' ? 'text-accent-green' : flash === 'red' ? 'text-accent-red' : 'text-text-primary'
            }`}
          >
            {portfolioValue !== null ? `$${Number(portfolioValue).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
          </span>
        </div>

        {/* Buying Power */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted uppercase tracking-wide">Buying Power</span>
          <span className="font-mono text-sm text-text-muted">
            {buyingPower !== null ? `$${Number(buyingPower).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
          </span>
        </div>

        {/* Open Positions Count */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted uppercase tracking-wide">Open</span>
          <span className="font-mono text-sm text-accent-blue">{openCount}</span>
        </div>
      </div>

      <div className="flex items-center gap-6">
        {/* API Offline */}
        {isOffline && (
          <span className="flex items-center gap-1.5 text-xs font-mono font-semibold text-accent-red">
            <span className="w-2 h-2 rounded-full bg-accent-red" />
            API OFFLINE
          </span>
        )}

        {/* Market Status */}
        {!isOffline && (
          <span className="flex items-center gap-1.5 text-xs font-mono">
            <span
              className={`w-2 h-2 rounded-full ${
                marketOpen ? 'bg-accent-green animate-pulse' : 'bg-text-dim'
              }`}
            />
            <span className={marketOpen ? 'text-accent-green' : 'text-text-muted'}>
              {marketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}
            </span>
          </span>
        )}

        {/* Last Scan */}
        {lastScan && (
          <span className="text-xs text-text-muted" title={lastScan}>
            Last scan: {formatDistanceToNow(new Date(lastScan), { addSuffix: true })}
          </span>
        )}

        {/* Live Indicator */}
        {isFetching && (
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
            LIVE
          </span>
        )}
      </div>
    </header>
  )
}
