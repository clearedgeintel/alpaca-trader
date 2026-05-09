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
    <header className="sticky top-0 z-40 h-12 bg-surface/95 border-b border-border backdrop-blur flex items-center justify-between px-3 md:px-4">
      <div className="flex items-center gap-3 md:gap-6 ml-10 md:ml-0">
        <div className="flex items-baseline gap-1.5 md:gap-2">
          <span className="hidden md:inline text-[10px] text-text-dim uppercase tracking-[0.12em]">Portfolio</span>
          <span
            className={`font-mono text-sm md:text-lg font-semibold leading-none transition-colors ${
              flash === 'green' ? 'text-accent-green' : flash === 'red' ? 'text-accent-red' : 'text-text-primary'
            }`}
          >
            {portfolioValue !== null ? `$${Number(portfolioValue).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '--'}
          </span>
        </div>

        <div className="hidden md:flex items-baseline gap-2">
          <span className="text-[10px] text-text-dim uppercase tracking-[0.12em]">Buying Power</span>
          <span className="font-mono text-sm text-text-primary">
            {buyingPower !== null ? `$${Number(buyingPower).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '--'}
          </span>
        </div>

        <div className="flex items-baseline gap-1.5 md:gap-2">
          <span className="hidden md:inline text-[10px] text-text-dim uppercase tracking-[0.12em]">Open</span>
          <span className="font-mono text-sm font-semibold text-accent-blue">{openCount}</span>
        </div>
      </div>

      <div className="flex items-center gap-3 md:gap-5">
        {isOffline && (
          <span className="flex items-center gap-1.5 text-xs font-mono font-semibold text-accent-red">
            <span className="w-2 h-2 rounded-full bg-accent-red" />
            API OFFLINE
          </span>
        )}

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

        {lastScan && safeDistanceToNow(lastScan) && (
          <span className="hidden lg:inline text-[11px] text-text-dim" title={lastScan}>
            Scan {safeDistanceToNow(lastScan)}
          </span>
        )}

        {isFetching && (
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
            <span className="hidden md:inline">LIVE</span>
          </span>
        )}
      </div>
    </header>
  )
}

function safeDistanceToNow(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  try {
    return formatDistanceToNow(date, { addSuffix: true })
  } catch {
    return null
  }
}
