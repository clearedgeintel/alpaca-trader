import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { getConfig, getPositions, getTrades } from '../api/client'

// Common Alpaca crypto pairs — matches CRYPTO_SYMBOLS in src/asset-classes.js
const DEFAULT_PAIRS = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'DOGE/USD', 'AVAX/USD', 'LINK/USD', 'DOT/USD', 'MATIC/USD']

export default function CryptoView() {
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: getConfig, staleTime: 30_000 })
  const { data: positions } = useQuery({ queryKey: ['positions'], queryFn: getPositions, refetchInterval: 15_000 })
  const { data: allTrades } = useQuery({ queryKey: ['trades'], queryFn: () => getTrades({ limit: 200 }), staleTime: 30_000 })

  // CRYPTO_WATCHLIST from config, falls back to default pairs. Config endpoint
  // exposes it as part of cryptoWatchlist once we wire it.
  const watchlist = config?.cryptoWatchlist?.length ? config.cryptoWatchlist : DEFAULT_PAIRS

  const cryptoPositions = (positions || []).filter((p) => p.symbol?.includes('/'))
  const cryptoTrades = (allTrades || []).filter((t) => t.symbol?.includes('/'))
  const closedCryptoTrades = cryptoTrades.filter((t) => t.status === 'closed')
  const realizedPnl = closedCryptoTrades.reduce((a, t) => a + Number(t.pnl || 0), 0)
  const unrealizedPnl = cryptoPositions.reduce((a, p) => a + Number(p.unrealized_pl || 0), 0)
  const wins = closedCryptoTrades.filter((t) => Number(t.pnl) > 0).length
  const winRate = closedCryptoTrades.length > 0 ? (wins / closedCryptoTrades.length) * 100 : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Crypto</h2>
          <p className="text-xs text-text-dim mt-0.5">24/7 markets — agents analyze every cycle regardless of equity market hours.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-mono font-medium text-accent-green bg-accent-green/10 border border-accent-green/30 rounded">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" /> 24/7 OPEN
        </span>
      </div>

      {!config?.cryptoWatchlist?.length && (
        <div className="bg-accent-amber/5 border border-accent-amber/30 rounded-lg p-4 text-sm text-text-muted">
          <p className="font-semibold text-accent-amber mb-1">No CRYPTO_WATCHLIST configured.</p>
          <p className="text-xs">
            Set <code className="text-text-primary">CRYPTO_WATCHLIST=BTC/USD,ETH/USD,SOL/USD</code> in <code>.env</code> and restart. Until then,
            the bot won't trade crypto automatically — but you can still inspect any pair below by clicking through to the Market view.
          </p>
        </div>
      )}

      {/* P&L summary */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          label="Open Crypto Positions"
          value={cryptoPositions.length}
        />
        <StatCard
          label="Unrealized P&L"
          value={`${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}`}
          trend={unrealizedPnl > 0 ? 'up' : unrealizedPnl < 0 ? 'down' : 'neutral'}
        />
        <StatCard
          label="Realized P&L (all time)"
          value={`${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`}
          trend={realizedPnl > 0 ? 'up' : realizedPnl < 0 ? 'down' : 'neutral'}
        />
        <StatCard
          label="Crypto Win Rate"
          value={winRate != null ? `${winRate.toFixed(0)}%` : '—'}
          delta={`${closedCryptoTrades.length} closed`}
        />
      </div>

      {/* Watchlist */}
      <section className="bg-surface border border-border rounded-lg p-5">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Watchlist</h3>
        <div className="flex flex-wrap gap-2">
          {watchlist.map((sym) => (
            <Link
              key={sym}
              to={`/market?symbol=${encodeURIComponent(sym)}`}
              className="px-3 py-2 text-sm font-mono bg-elevated border border-border rounded text-text-primary hover:border-accent-blue hover:text-accent-blue transition-colors"
            >
              {sym}
            </Link>
          ))}
        </div>
        <p className="text-[10px] text-text-dim mt-3">
          Click any pair to open the full chart + manual order panel in the Market view. All risk parameters, agent analysis, and position scaling apply to crypto just like equities.
        </p>
      </section>

      {/* Open positions */}
      <section className="bg-surface border border-border rounded-lg p-5">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Open Positions</h3>
        {cryptoPositions.length === 0 ? (
          <p className="text-xs text-text-dim">No open crypto positions.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] text-text-dim font-mono uppercase border-b border-border">
                <th className="text-left py-2">Symbol</th>
                <th className="text-right py-2">Qty</th>
                <th className="text-right py-2">Entry</th>
                <th className="text-right py-2">Current</th>
                <th className="text-right py-2">P&L</th>
                <th className="text-right py-2">%</th>
              </tr>
            </thead>
            <tbody>
              {cryptoPositions.map((p) => {
                const pnl = Number(p.unrealized_pl)
                const pnlPct = Number(p.unrealized_plpc) * 100
                return (
                  <tr key={p.symbol} className="border-b border-border/40 hover:bg-elevated/30">
                    <td className="py-2 font-mono">
                      <Link to={`/market?symbol=${encodeURIComponent(p.symbol)}`} className="text-text-primary hover:text-accent-blue">
                        {p.symbol}
                      </Link>
                    </td>
                    <td className="py-2 text-right font-mono">{Number(p.qty).toFixed(6)}</td>
                    <td className="py-2 text-right font-mono">${Number(p.avg_entry_price).toFixed(2)}</td>
                    <td className="py-2 text-right font-mono">${Number(p.current_price).toFixed(2)}</td>
                    <td className={clsx('py-2 text-right font-mono', pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-text-muted')}>
                      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                    </td>
                    <td className={clsx('py-2 text-right font-mono', pnlPct > 0 ? 'text-accent-green' : pnlPct < 0 ? 'text-accent-red' : 'text-text-muted')}>
                      {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Recent closed trades */}
      <section className="bg-surface border border-border rounded-lg p-5">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Recent Crypto Trades</h3>
        {closedCryptoTrades.length === 0 ? (
          <p className="text-xs text-text-dim">No closed crypto trades yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] text-text-dim font-mono uppercase border-b border-border">
                <th className="text-left py-2">Symbol</th>
                <th className="text-right py-2">Qty</th>
                <th className="text-right py-2">Entry → Exit</th>
                <th className="text-right py-2">P&L</th>
                <th className="text-right py-2">Exit Reason</th>
              </tr>
            </thead>
            <tbody>
              {closedCryptoTrades.slice(0, 20).map((t) => {
                const pnl = Number(t.pnl)
                return (
                  <tr key={t.id} className="border-b border-border/40 hover:bg-elevated/30">
                    <td className="py-2 font-mono">{t.symbol}</td>
                    <td className="py-2 text-right font-mono">{Number(t.qty).toFixed(6)}</td>
                    <td className="py-2 text-right font-mono text-xs">
                      ${Number(t.entry_price).toFixed(2)} → ${Number(t.exit_price || 0).toFixed(2)}
                    </td>
                    <td className={clsx('py-2 text-right font-mono', pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-text-muted')}>
                      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                    </td>
                    <td className="py-2 text-right text-[10px] font-mono text-text-muted">{t.exit_reason || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function StatCard({ label, value, trend, delta }) {
  const trendColor = trend === 'up' ? 'text-accent-green' : trend === 'down' ? 'text-accent-red' : 'text-text-primary'
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <p className="text-xs text-text-muted uppercase tracking-wide">{label}</p>
      <p className={clsx('text-xl font-mono font-bold mt-1', trendColor)}>{value}</p>
      {delta && <p className="text-[10px] text-text-dim font-mono mt-1">{delta}</p>}
    </div>
  )
}
