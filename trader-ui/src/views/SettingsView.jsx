import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getConfig, getStrategies, setSymbolStrategy, setDefaultStrategy } from '../api/client'

const BASE = import.meta.env.VITE_API_BASE_URL || '/api'

function Section({ title, children }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-5">
      <h3 className="text-sm font-semibold text-text-primary mb-4">{title}</h3>
      {children}
    </div>
  )
}

function ParamRow({ label, value, unit }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <span className="text-sm text-text-muted">{label}</span>
      <span className="font-mono text-sm text-text-primary">{value}{unit && <span className="text-text-muted ml-1">{unit}</span>}</span>
    </div>
  )
}

export default function SettingsView() {
  const queryClient = useQueryClient()
  const { data: config, isLoading } = useQuery({ queryKey: ['config'], queryFn: getConfig, staleTime: 30000 })
  const { data: strategies } = useQuery({ queryKey: ['strategies'], queryFn: getStrategies, staleTime: 30000 })
  const { data: tradingMode } = useQuery({
    queryKey: ['trading-mode'],
    queryFn: () => fetch(`${BASE}/trading-mode`).then(r => r.json()).then(j => j.data),
    staleTime: 60000,
  })

  const [defaultMode, setDefaultMode] = useState('hybrid')
  const [symbolOverride, setSymbolOverride] = useState('')
  const [symbolMode, setSymbolMode] = useState('rules')

  useEffect(() => {
    if (strategies?.default) setDefaultMode(strategies.default)
  }, [strategies])

  async function handleDefaultStrategy(mode) {
    setDefaultMode(mode)
    await setDefaultStrategy(mode)
    queryClient.invalidateQueries({ queryKey: ['strategies'] })
    queryClient.invalidateQueries({ queryKey: ['config'] })
  }

  async function handleSymbolStrategy() {
    if (!symbolOverride.trim()) return
    await setSymbolStrategy(symbolOverride.trim().toUpperCase(), symbolMode)
    setSymbolOverride('')
    queryClient.invalidateQueries({ queryKey: ['strategies'] })
    queryClient.invalidateQueries({ queryKey: ['config'] })
  }

  if (isLoading) {
    return <div className="text-text-muted text-sm">Loading settings...</div>
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Settings</h2>

      {/* Paper/Live Banner */}
      {tradingMode && (
        <div className={`rounded-lg p-4 border ${
          tradingMode.mode === 'paper'
            ? 'bg-accent-amber/5 border-accent-amber/20'
            : 'bg-accent-red/5 border-accent-red/20'
        }`}>
          <div className="flex items-center gap-3">
            <span className={`w-3 h-3 rounded-full ${
              tradingMode.mode === 'paper' ? 'bg-accent-amber' : 'bg-accent-red animate-pulse'
            }`} />
            <span className={`font-mono text-sm font-semibold ${
              tradingMode.mode === 'paper' ? 'text-accent-amber' : 'text-accent-red'
            }`}>
              {tradingMode.mode === 'paper' ? 'PAPER TRADING' : 'LIVE TRADING'}
            </span>
            <span className="text-xs text-text-muted">{tradingMode.baseUrl}</span>
          </div>
          {tradingMode.mode === 'live' && (
            <p className="text-xs text-accent-red mt-2">
              Real money at risk. To switch to paper, update ALPACA_BASE_URL in .env to https://paper-api.alpaca.markets and restart.
            </p>
          )}
          {tradingMode.mode === 'paper' && (
            <p className="text-xs text-text-muted mt-2">
              To switch to live trading, update ALPACA_BASE_URL and API keys in .env and restart. Ensure thorough paper testing first.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        {/* Mode & Strategy */}
        <Section title="Trading Mode">
          <div className="space-y-3">
            <ParamRow label="Current Mode" value={config?.mode?.toUpperCase() || 'LEGACY'} />
            <ParamRow label="Agency Mode" value={config?.useAgency ? 'Enabled' : 'Disabled'} />

            <div className="pt-2">
              <label className="text-xs text-text-muted block mb-2">Default Strategy</label>
              <div className="flex gap-2">
                {['rules', 'hybrid', 'llm'].map(mode => (
                  <button
                    key={mode}
                    onClick={() => handleDefaultStrategy(mode)}
                    className={`px-3 py-1.5 text-xs font-mono font-medium rounded transition-colors ${
                      defaultMode === mode
                        ? 'bg-accent-blue text-white'
                        : 'bg-elevated text-text-muted hover:text-text-primary'
                    }`}
                  >
                    {mode.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Section>

        {/* Risk Parameters */}
        <Section title="Risk Parameters">
          <ParamRow label="Risk Per Trade" value={(config?.riskPct * 100)?.toFixed(1)} unit="%" />
          <ParamRow label="Stop Loss" value={(config?.stopPct * 100)?.toFixed(1)} unit="%" />
          <ParamRow label="Take Profit" value={(config?.targetPct * 100)?.toFixed(1)} unit="%" />
          <ParamRow label="Max Position" value={(config?.maxPosPct * 100)?.toFixed(0)} unit="%" />
          <ParamRow label="Trailing ATR Mult" value={config?.trailingAtrMult} unit="x" />
          <ParamRow label="Max Drawdown" value={(config?.maxDrawdownPct * 100)?.toFixed(0)} unit="%" />
        </Section>

        {/* Watchlist */}
        <Section title="Static Watchlist">
          <div className="flex flex-wrap gap-2">
            {(config?.watchlist || []).map(sym => (
              <span key={sym} className="px-2 py-1 bg-elevated rounded font-mono text-xs text-text-primary">
                {sym}
              </span>
            ))}
          </div>
          <p className="text-xs text-text-muted mt-3">
            In legacy mode the scanner also discovers dynamic symbols from Alpaca screeners.
          </p>
        </Section>

        {/* Per-Symbol Strategy Overrides */}
        <Section title="Symbol Strategy Overrides">
          <div className="space-y-3">
            {strategies?.overrides && Object.keys(strategies.overrides).length > 0 ? (
              <div className="space-y-1">
                {Object.entries(strategies.overrides).map(([sym, mode]) => (
                  <div key={sym} className="flex items-center justify-between py-1.5">
                    <span className="font-mono text-sm text-text-primary">{sym}</span>
                    <span className={`text-xs font-mono px-2 py-0.5 rounded ${
                      mode === 'rules' ? 'bg-accent-green/10 text-accent-green' :
                      mode === 'llm' ? 'bg-accent-blue/10 text-accent-blue' :
                      'bg-accent-amber/10 text-accent-amber'
                    }`}>{mode}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted">No overrides — all symbols use default strategy.</p>
            )}

            <div className="flex gap-2 pt-2 border-t border-border">
              <input
                type="text"
                value={symbolOverride}
                onChange={e => setSymbolOverride(e.target.value)}
                placeholder="SYMBOL"
                className="bg-elevated border border-border rounded px-2 py-1 text-sm font-mono text-text-primary w-24"
              />
              <select
                value={symbolMode}
                onChange={e => setSymbolMode(e.target.value)}
                className="bg-elevated border border-border rounded px-2 py-1 text-sm font-mono text-text-primary"
              >
                <option value="rules">rules</option>
                <option value="hybrid">hybrid</option>
                <option value="llm">llm</option>
              </select>
              <button
                onClick={handleSymbolStrategy}
                className="px-3 py-1 bg-accent-blue text-white text-xs font-medium rounded hover:bg-accent-blue/80"
              >
                Set
              </button>
            </div>
          </div>
        </Section>

        {/* Asset Classes */}
        <Section title="Asset Class Risk Profiles">
          {config?.assetClasses && Object.entries(config.assetClasses).map(([cls, params]) => (
            <div key={cls} className="mb-3 last:mb-0">
              <p className="text-xs font-semibold text-accent-blue mb-1">{params.label}</p>
              <div className="grid grid-cols-3 gap-x-4 text-xs">
                <span className="text-text-muted">Risk: <span className="text-text-primary font-mono">{(params.riskPct * 100)}%</span></span>
                <span className="text-text-muted">Stop: <span className="text-text-primary font-mono">{(params.stopPct * 100)}%</span></span>
                <span className="text-text-muted">Target: <span className="text-text-primary font-mono">{(params.targetPct * 100)}%</span></span>
              </div>
            </div>
          ))}
        </Section>

        {/* Export */}
        <Section title="Data Export">
          <div className="flex gap-3">
            <a
              href="/api/export/trades"
              className="px-4 py-2 bg-elevated text-text-primary text-sm font-medium rounded hover:bg-border transition-colors"
            >
              Export Trades CSV
            </a>
            <a
              href="/api/export/taxlots"
              className="px-4 py-2 bg-elevated text-text-primary text-sm font-medium rounded hover:bg-border transition-colors"
            >
              Export Tax Lots CSV
            </a>
          </div>
        </Section>
      </div>
    </div>
  )
}
