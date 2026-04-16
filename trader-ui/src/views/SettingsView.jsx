import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { getConfig, getStrategies, setSymbolStrategy, setDefaultStrategy, clearSymbolStrategy, exportStrategyConfig, importStrategyConfig, getWatchlist, addToWatchlist, removeFromWatchlist, getDecisions, getAlertChannels, getAlertHistory, testAlertSend, sendDigestNow, setRuntimeConfig, clearRuntimeConfig, getDatasourceStats } from '../api/client'
import { formatDistanceToNow, parseISO } from 'date-fns'

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
  const [newSymbol, setNewSymbol] = useState('')
  const { data: watchlistData } = useQuery({ queryKey: ['watchlist'], queryFn: getWatchlist, staleTime: 30000 })

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

  async function handleClearOverride(sym) {
    if (!confirm(`Reset ${sym} to the default strategy?`)) return
    await clearSymbolStrategy(sym)
    queryClient.invalidateQueries({ queryKey: ['strategies'] })
    queryClient.invalidateQueries({ queryKey: ['config'] })
  }

  async function handleExport() {
    try {
      const data = await exportStrategyConfig()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `strategy-config_${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) { alert(`Export failed: ${err.message}`) }
  }

  async function handleImport(e) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const payload = JSON.parse(text)
      // /api/config/export wraps output in `{success, data: {...}}`. Accept either
      // the raw inner payload (strategies/watchlist/...) or the wrapped form.
      const inner = payload.data || payload
      const result = await importStrategyConfig({ strategies: inner.strategies })
      alert(`Imported ${result.imported} strategy entries.`)
      queryClient.invalidateQueries({ queryKey: ['strategies'] })
      queryClient.invalidateQueries({ queryKey: ['config'] })
    } catch (err) {
      alert(`Import failed: ${err.message}`)
    } finally {
      e.target.value = '' // allow re-importing the same file
    }
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

        {/* Risk Parameters — editable, hot-reload via runtime-config */}
        <RiskParamsSection config={config} overriddenKeys={config?.overriddenKeys || []} onSaved={() => queryClient.invalidateQueries({ queryKey: ['config'] })} />

        {/* Signal Tuning — loosen to trade more aggressively */}
        <SignalTuningSection config={config} overriddenKeys={config?.overriddenKeys || []} onSaved={() => queryClient.invalidateQueries({ queryKey: ['config'] })} />

        {/* LLM Cost Controls — editable, hot-reload */}
        <CostControlsSection config={config} overriddenKeys={config?.overriddenKeys || []} onSaved={() => queryClient.invalidateQueries({ queryKey: ['config'] })} />

        {/* Data Sources — Polygon enrichment status + toggle */}
        <DataSourcesSection onToggled={() => queryClient.invalidateQueries({ queryKey: ['datasource-stats'] })} />

        {/* Watchlist Manager */}
        <Section title="Watchlist">
          <div className="flex flex-wrap gap-2 mb-3">
            {(watchlistData?.symbols || config?.watchlist || []).map(sym => (
              <span key={sym} className="inline-flex items-center gap-1.5 px-2 py-1 bg-elevated rounded font-mono text-xs text-text-primary group">
                {sym}
                <button
                  onClick={async () => { await removeFromWatchlist(sym); queryClient.invalidateQueries({ queryKey: ['watchlist'] }); queryClient.invalidateQueries({ queryKey: ['config'] }); }}
                  className="text-text-dim hover:text-accent-red transition-colors opacity-0 group-hover:opacity-100"
                  title={`Remove ${sym}`}
                >x</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newSymbol}
              onChange={e => setNewSymbol(e.target.value.toUpperCase())}
              onKeyDown={async e => {
                if (e.key === 'Enter' && newSymbol.trim()) {
                  await addToWatchlist(newSymbol.trim());
                  setNewSymbol('');
                  queryClient.invalidateQueries({ queryKey: ['watchlist'] });
                  queryClient.invalidateQueries({ queryKey: ['config'] });
                }
              }}
              placeholder="Add symbol..."
              className="bg-elevated border border-border rounded px-2 py-1 text-sm font-mono text-text-primary w-28"
            />
            <button
              onClick={async () => {
                if (!newSymbol.trim()) return;
                await addToWatchlist(newSymbol.trim());
                setNewSymbol('');
                queryClient.invalidateQueries({ queryKey: ['watchlist'] });
                queryClient.invalidateQueries({ queryKey: ['config'] });
              }}
              className="px-3 py-1 bg-accent-blue text-white text-xs font-medium rounded hover:bg-accent-blue/80"
            >Add</button>
          </div>
          <p className="text-xs text-text-muted mt-3">
            {watchlistData?.source === 'runtime' ? 'Custom watchlist (saved to DB).' : 'Default watchlist.'} The screener also discovers dynamic symbols from market movers.
          </p>
        </Section>

        {/* Per-Symbol Strategy Overrides */}
        <Section title="Symbol Strategy Overrides">
          <div className="space-y-3">
            {strategies?.overrides && Object.keys(strategies.overrides).length > 0 ? (
              <div className="space-y-1">
                {Object.entries(strategies.overrides).map(([sym, mode]) => (
                  <div key={sym} className="flex items-center justify-between py-1.5 group">
                    <span className="font-mono text-sm text-text-primary">{sym}</span>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-mono px-2 py-0.5 rounded ${
                        mode === 'rules' ? 'bg-accent-green/10 text-accent-green' :
                        mode === 'llm' ? 'bg-accent-blue/10 text-accent-blue' :
                        'bg-accent-amber/10 text-accent-amber'
                      }`}>{mode}</span>
                      <button
                        onClick={() => handleClearOverride(sym)}
                        title={`Reset ${sym} to default`}
                        className="text-text-dim hover:text-accent-red transition-colors opacity-0 group-hover:opacity-100 text-sm leading-none w-5"
                      >x</button>
                    </div>
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
          <div className="flex flex-wrap gap-3">
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
            <button
              onClick={handleExport}
              className="px-4 py-2 bg-elevated text-text-primary text-sm font-medium rounded hover:bg-border transition-colors"
              title="Download strategy + watchlist + risk-params JSON"
            >
              Export Strategy Config
            </button>
            <label className="px-4 py-2 bg-elevated text-text-primary text-sm font-medium rounded hover:bg-border transition-colors cursor-pointer">
              Import Strategy Config
              <input type="file" accept="application/json" onChange={handleImport} className="hidden" />
            </label>
          </div>
          <p className="text-[10px] text-text-dim mt-2">
            Strategy config export includes default + per-symbol overrides + watchlist + risk params. Import merges strategies into the running config (watchlist &amp; risk params require editing their own sections).
          </p>
        </Section>
      </div>

      {/* Notifications */}
      <NotificationsPanel />

      {/* Admin Logs */}
      <DecisionLogs />
    </div>
  )
}

// Editable risk parameters — each row hits PUT /api/runtime-config/:key on Save.
// `pct` rows accept percent input (15) and convert to decimal (0.15) for storage.
const RISK_FIELDS = [
  { key: 'RISK_PCT',         configKey: 'riskPct',         label: 'Risk Per Trade',  unit: '%', kind: 'pct',   step: 0.1,  min: 0.1,  max: 10  },
  { key: 'STOP_PCT',         configKey: 'stopPct',         label: 'Stop Loss',       unit: '%', kind: 'pct',   step: 0.1,  min: 0.5,  max: 20  },
  { key: 'TARGET_PCT',       configKey: 'targetPct',       label: 'Take Profit',     unit: '%', kind: 'pct',   step: 0.1,  min: 0.5,  max: 50  },
  { key: 'MAX_POS_PCT',      configKey: 'maxPosPct',       label: 'Max Position',    unit: '%', kind: 'pct',   step: 1,    min: 1,    max: 100 },
  { key: 'TRAILING_ATR_MULT',configKey: 'trailingAtrMult', label: 'Trailing ATR Mult', unit: 'x', kind: 'raw', step: 0.1,  min: 0.5,  max: 10  },
  { key: 'MAX_DRAWDOWN_PCT', configKey: 'maxDrawdownPct',  label: 'Max Drawdown',    unit: '%', kind: 'pct',   step: 1,    min: 1,    max: 50  },
]

function RiskParamsSection({ config, overriddenKeys, onSaved }) {
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(null)

  function displayValue(field) {
    const raw = config?.[field.configKey]
    if (raw == null) return ''
    return field.kind === 'pct' ? (raw * 100).toFixed(field.step < 1 ? 1 : 0) : String(raw)
  }

  async function handleSave(field) {
    const inputStr = edits[field.key]
    if (inputStr == null || inputStr === '') return
    const num = parseFloat(inputStr)
    if (!Number.isFinite(num) || num < field.min || num > field.max) {
      alert(`${field.label}: must be a number between ${field.min} and ${field.max}`)
      return
    }
    setSaving(field.key)
    try {
      const stored = field.kind === 'pct' ? num / 100 : num
      await setRuntimeConfig(field.key, stored)
      setEdits(e => { const next = { ...e }; delete next[field.key]; return next })
      onSaved?.()
    } catch (err) {
      alert(`Save failed: ${err.message}`)
    }
    setSaving(null)
  }

  async function handleClear(field) {
    if (!confirm(`Reset ${field.label} to default?`)) return
    setSaving(field.key)
    try {
      await clearRuntimeConfig(field.key)
      setEdits(e => { const next = { ...e }; delete next[field.key]; return next })
      onSaved?.()
    } catch (err) {
      alert(`Reset failed: ${err.message}`)
    }
    setSaving(null)
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">Risk Parameters</h3>
        <span className="text-[10px] text-text-dim font-mono">live · no restart</span>
      </div>
      <div className="space-y-1">
        {RISK_FIELDS.map(field => {
          const overridden = overriddenKeys.includes(field.key)
          const editing = edits[field.key] != null
          const current = displayValue(field)
          return (
            <div key={field.key} className="flex items-center justify-between gap-2 py-1.5 border-b border-border last:border-0">
              <span className="text-sm text-text-muted flex-1">
                {field.label}
                {overridden && <span className="ml-2 text-[10px] text-accent-amber font-mono">CUSTOM</span>}
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  step={field.step}
                  min={field.min}
                  max={field.max}
                  value={editing ? edits[field.key] : current}
                  onChange={e => setEdits(prev => ({ ...prev, [field.key]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave(field) }}
                  className="bg-elevated border border-border rounded px-2 py-1 text-sm font-mono text-text-primary w-20 text-right outline-none focus:border-accent-blue/50"
                />
                <span className="text-xs text-text-muted w-3">{field.unit}</span>
                <button
                  onClick={() => handleSave(field)}
                  disabled={!editing || saving === field.key}
                  className="px-2 py-1 text-[10px] font-mono bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {saving === field.key ? '…' : 'Save'}
                </button>
                {overridden && (
                  <button
                    onClick={() => handleClear(field)}
                    disabled={saving === field.key}
                    className="px-2 py-1 text-[10px] font-mono bg-elevated text-text-muted rounded hover:text-accent-red disabled:opacity-30"
                    title="Reset to default"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[10px] text-text-dim mt-3">
        Changes apply on the next trade cycle (within ~30s). Static defaults live in <code>src/config.js</code>.
      </p>
    </div>
  )
}

// LLM cost/token caps — identical UX to RiskParamsSection but with raw numeric values (no pct conversion)
const COST_FIELDS = [
  { key: 'LLM_DAILY_COST_CAP_USD',     configKey: 'llmDailyCostCapUsd',        label: 'Daily Cost Cap',          unit: '$',   prefix: true, step: 1,       min: 1,    max: 500        },
  { key: 'LLM_DAILY_TOKEN_CAP',        configKey: 'llmDailyTokenCap',          label: 'Daily Token Cap (safety)',unit: 'tok',               step: 100000,  min: 100000, max: 100000000 },
  { key: 'LLM_CIRCUIT_BREAKER_FAILURES',configKey:'llmCircuitBreakerFailures', label: 'Circuit Breaker Failures',unit: '',                  step: 1,       min: 1,    max: 20         },
]

function CostControlsSection({ config, overriddenKeys, onSaved }) {
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(null)

  async function handleSave(field) {
    const inputStr = edits[field.key]
    if (inputStr == null || inputStr === '') return
    const num = parseFloat(inputStr)
    if (!Number.isFinite(num) || num < field.min || num > field.max) {
      alert(`${field.label}: must be a number between ${field.min.toLocaleString()} and ${field.max.toLocaleString()}`)
      return
    }
    setSaving(field.key)
    try {
      await setRuntimeConfig(field.key, num)
      setEdits(e => { const next = { ...e }; delete next[field.key]; return next })
      onSaved?.()
    } catch (err) { alert(`Save failed: ${err.message}`) }
    setSaving(null)
  }

  async function handleClear(field) {
    if (!confirm(`Reset ${field.label} to default?`)) return
    setSaving(field.key)
    try {
      await clearRuntimeConfig(field.key)
      setEdits(e => { const next = { ...e }; delete next[field.key]; return next })
      onSaved?.()
    } catch (err) { alert(`Reset failed: ${err.message}`) }
    setSaving(null)
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">LLM Cost Controls</h3>
        <span className="text-[10px] text-text-dim font-mono">live · no restart</span>
      </div>
      <div className="space-y-1">
        {COST_FIELDS.map(field => {
          const overridden = overriddenKeys.includes(field.key)
          const editing = edits[field.key] != null
          const current = config?.[field.configKey] ?? ''
          return (
            <div key={field.key} className="flex items-center justify-between gap-2 py-1.5 border-b border-border last:border-0">
              <span className="text-sm text-text-muted flex-1">
                {field.label}
                {overridden && <span className="ml-2 text-[10px] text-accent-amber font-mono">CUSTOM</span>}
              </span>
              <div className="flex items-center gap-1.5">
                {field.prefix && <span className="text-xs text-text-muted">{field.unit}</span>}
                <input
                  type="number"
                  step={field.step}
                  min={field.min}
                  max={field.max}
                  value={editing ? edits[field.key] : current}
                  onChange={e => setEdits(prev => ({ ...prev, [field.key]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') handleSave(field) }}
                  className="bg-elevated border border-border rounded px-2 py-1 text-sm font-mono text-text-primary w-28 text-right outline-none focus:border-accent-blue/50"
                />
                {!field.prefix && <span className="text-xs text-text-muted w-8">{field.unit}</span>}
                <button
                  onClick={() => handleSave(field)}
                  disabled={!editing || saving === field.key}
                  className="px-2 py-1 text-[10px] font-mono bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {saving === field.key ? '…' : 'Save'}
                </button>
                {overridden && (
                  <button
                    onClick={() => handleClear(field)}
                    disabled={saving === field.key}
                    className="px-2 py-1 text-[10px] font-mono bg-elevated text-text-muted rounded hover:text-accent-red disabled:opacity-30"
                    title="Reset to default"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[10px] text-text-dim mt-3">
        Cost cap is the real bound — agents pause when spend hits it. Token cap is a safety net for runaway loops. Breaker opens after N consecutive failures.
      </p>
    </div>
  )
}

// Signal tuning — the three knobs that govern how aggressive the bot is about
// taking setups. All hot-reload via runtime-config; scan interval needs a restart.
const SIGNAL_FIELDS = [
  {
    key: 'ORCHESTRATOR_MIN_CONFIDENCE',
    configKey: 'orchestratorMinConfidence',
    label: 'Min Orchestrator Confidence',
    unit: '%',
    kind: 'pct',
    step: 1,
    min: 40,
    max: 95,
    hint: 'Filter on the orchestrator’s final decision. Lower = more trades, lower avg edge. Default 70%.',
  },
  {
    key: 'VOLUME_SPIKE_RATIO',
    configKey: 'volumeSpikeRatio',
    label: 'Volume Spike Ratio',
    unit: '×',
    kind: 'raw',
    step: 0.05,
    min: 0.5,
    max: 3,
    hint: 'Current bar volume vs 20-bar avg required to confirm a BUY. Lower = thin-volume breakouts allowed.',
  },
  {
    key: 'SCAN_INTERVAL_MS',
    configKey: 'scanIntervalMs',
    label: 'Scan Interval',
    unit: 'min',
    kind: 'min',
    step: 1,
    min: 1,
    max: 60,
    hint: 'How often every cycle runs. Requires a restart to take effect. LLM spend scales inversely.',
  },
]

function SignalTuningSection({ config, overriddenKeys, onSaved }) {
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(null)

  function toDisplay(field, raw) {
    if (raw == null) return ''
    if (field.kind === 'pct') return (raw * 100).toFixed(0)
    if (field.kind === 'min') return (raw / 60000).toFixed(0)
    return String(raw)
  }
  function toStored(field, num) {
    if (field.kind === 'pct') return num / 100
    if (field.kind === 'min') return Math.round(num * 60000)
    return num
  }

  async function handleSave(field) {
    const inputStr = edits[field.key]
    if (inputStr == null || inputStr === '') return
    const num = parseFloat(inputStr)
    if (!Number.isFinite(num) || num < field.min || num > field.max) {
      alert(`${field.label}: must be between ${field.min} and ${field.max} ${field.unit}`)
      return
    }
    setSaving(field.key)
    try {
      await setRuntimeConfig(field.key, toStored(field, num))
      setEdits(e => { const next = { ...e }; delete next[field.key]; return next })
      onSaved?.()
    } catch (err) { alert(`Save failed: ${err.message}`) }
    setSaving(null)
  }

  async function handleClear(field) {
    if (!confirm(`Reset ${field.label} to default?`)) return
    setSaving(field.key)
    try {
      await clearRuntimeConfig(field.key)
      setEdits(e => { const next = { ...e }; delete next[field.key]; return next })
      onSaved?.()
    } catch (err) { alert(`Reset failed: ${err.message}`) }
    setSaving(null)
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">Signal Tuning</h3>
        <span className="text-[10px] text-text-dim font-mono">live · no restart (except scan)</span>
      </div>
      <p className="text-xs text-text-dim mb-3">
        Loosen these to trade more aggressively. Lower confidence + lower volume gate = more setups pass through.
      </p>
      <div className="space-y-1">
        {SIGNAL_FIELDS.map(field => {
          const overridden = overriddenKeys.includes(field.key)
          const editing = edits[field.key] != null
          const current = toDisplay(field, config?.[field.configKey])
          return (
            <div key={field.key} className="py-2 border-b border-border last:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-text-muted flex-1">
                  {field.label}
                  {overridden && <span className="ml-2 text-[10px] text-accent-amber font-mono">CUSTOM</span>}
                  {field.key === 'SCAN_INTERVAL_MS' && <span className="ml-2 text-[10px] text-accent-red font-mono">RESTART REQ'D</span>}
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    step={field.step}
                    min={field.min}
                    max={field.max}
                    value={editing ? edits[field.key] : current}
                    onChange={e => setEdits(prev => ({ ...prev, [field.key]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') handleSave(field) }}
                    className="bg-elevated border border-border rounded px-2 py-1 text-sm font-mono text-text-primary w-20 text-right outline-none focus:border-accent-blue/50"
                  />
                  <span className="text-xs text-text-muted w-6">{field.unit}</span>
                  <button
                    onClick={() => handleSave(field)}
                    disabled={!editing || saving === field.key}
                    className="px-2 py-1 text-[10px] font-mono bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {saving === field.key ? '…' : 'Save'}
                  </button>
                  {overridden && (
                    <button
                      onClick={() => handleClear(field)}
                      disabled={saving === field.key}
                      className="px-2 py-1 text-[10px] font-mono bg-elevated text-text-muted rounded hover:text-accent-red disabled:opacity-30"
                      title="Reset to default"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
              <p className="text-[10px] text-text-dim mt-1">{field.hint}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DataSourcesSection({ onToggled }) {
  const { data: stats, refetch } = useQuery({
    queryKey: ['datasource-stats'],
    queryFn: getDatasourceStats,
    refetchInterval: 15000,
  })
  const polygon = stats?.polygon
  const [busy, setBusy] = useState(false)

  const statusColor = !polygon?.hasKey ? 'bg-text-dim'
    : polygon?.ratelimited ? 'bg-accent-red'
    : polygon?.enabled ? 'bg-accent-green'
    : 'bg-accent-amber'
  const statusLabel = !polygon?.hasKey ? 'Disabled (no API key)'
    : polygon?.ratelimited ? 'Rate-limited'
    : polygon?.enabled ? 'Active'
    : polygon?.runtimeEnabled === false ? 'Disabled (toggle off)'
    : 'Unavailable'

  async function handleToggle() {
    setBusy(true)
    try {
      const nextEnabled = !(polygon?.runtimeEnabled ?? true)
      if (nextEnabled) await clearRuntimeConfig('POLYGON_ENABLED')
      else await setRuntimeConfig('POLYGON_ENABLED', false)
      await refetch()
      onToggled?.()
    } catch (err) { alert(`Toggle failed: ${err.message}`) }
    setBusy(false)
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-5 col-span-2">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">Data Sources</h3>
        <span className="text-[10px] text-text-dim font-mono">Alpaca primary · Polygon enrichment</span>
      </div>

      <div className="bg-elevated rounded p-3 border border-border/50">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${statusColor}`} />
            <span className="font-mono text-sm font-semibold text-text-primary">Polygon.io</span>
            <span className="text-xs text-text-muted">{statusLabel}</span>
          </div>
          {polygon?.hasKey && (
            <button
              onClick={handleToggle}
              disabled={busy}
              className="px-2 py-1 text-[10px] font-mono bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 disabled:opacity-40"
            >
              {busy ? '…' : (polygon?.runtimeEnabled === false ? 'Enable' : 'Disable')}
            </button>
          )}
        </div>
        <div className="grid grid-cols-4 gap-3 text-[11px] font-mono">
          <span className="text-text-muted">Calls today: <span className="text-text-primary">{polygon?.calls ?? 0}</span></span>
          <span className="text-text-muted">Cache hits: <span className="text-text-primary">{polygon?.cacheHits ?? 0}</span></span>
          <span className="text-text-muted">Tokens left: <span className="text-text-primary">{polygon?.tokensRemaining ?? 0}/5</span></span>
          <span className="text-text-muted">Errors: <span className={polygon?.errors ? 'text-accent-red' : 'text-text-primary'}>{polygon?.errors ?? 0}</span></span>
        </div>
        {polygon?.lastError && (
          <p className="text-[10px] text-accent-red mt-2 font-mono truncate">Last error: {polygon.lastError}</p>
        )}
        {!polygon?.hasKey && (
          <p className="text-[10px] text-text-dim mt-2">Set <code>POLYGON_API_KEY</code> in .env to enable news sentiment insights, ticker fundamentals, and ex-dividend warnings. Free tier: 5 calls/min, EOD data only.</p>
        )}
      </div>
    </div>
  )
}

function NotificationsPanel() {
  const { data: channels } = useQuery({
    queryKey: ['alert-channels'],
    queryFn: getAlertChannels,
    staleTime: 60000,
  })
  const { data: history, refetch: refetchHistory } = useQuery({
    queryKey: ['alert-history'],
    queryFn: () => getAlertHistory(20),
    refetchInterval: 30000,
  })
  const [busy, setBusy] = useState(null)

  async function handleTest(channelName) {
    setBusy(channelName || 'all')
    try {
      await testAlertSend(channelName)
      await refetchHistory()
    } catch (err) {
      console.error('Test send failed', err)
    }
    setBusy(null)
  }

  async function handleDigest() {
    setBusy('digest')
    try {
      await sendDigestNow()
      await refetchHistory()
    } catch (err) {
      console.error('Send digest failed', err)
    }
    setBusy(null)
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-5">
      <h3 className="text-sm font-semibold text-text-primary mb-4">Notifications</h3>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <p className="text-xs text-text-muted uppercase tracking-wide mb-2">Channels</p>
          {!channels?.length ? (
            <p className="text-xs text-text-dim">
              No channels configured. Set <code>SLACK_WEBHOOK_URL</code>, <code>TELEGRAM_BOT_TOKEN</code>+<code>TELEGRAM_CHAT_ID</code>, <code>DISCORD_WEBHOOK_URL</code>, or <code>WEBHOOK_URL</code> in <code>.env</code> to receive alerts.
            </p>
          ) : (
            <div className="space-y-2">
              {channels.map(ch => (
                <div key={ch.name} className="flex items-center justify-between p-2 bg-elevated rounded">
                  <div>
                    <span className="font-mono text-sm text-text-primary capitalize">{ch.name}</span>
                    <span className="ml-2 text-[10px] font-mono text-text-dim">min: {ch.minimum}</span>
                  </div>
                  <button
                    onClick={() => handleTest(ch.name)}
                    disabled={busy === ch.name}
                    className="px-2 py-1 text-[10px] font-mono bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 disabled:opacity-40"
                  >
                    {busy === ch.name ? 'Sending…' : 'Test'}
                  </button>
                </div>
              ))}
              <div className="flex gap-2 pt-2 border-t border-border">
                <button
                  onClick={() => handleTest(null)}
                  disabled={busy === 'all'}
                  className="flex-1 px-3 py-1.5 text-xs bg-elevated text-text-primary rounded hover:bg-border disabled:opacity-40"
                >
                  {busy === 'all' ? 'Sending…' : 'Test all'}
                </button>
                <button
                  onClick={handleDigest}
                  disabled={busy === 'digest'}
                  className="flex-1 px-3 py-1.5 text-xs bg-elevated text-text-primary rounded hover:bg-border disabled:opacity-40"
                >
                  {busy === 'digest' ? 'Sending…' : 'Send digest now'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div>
          <p className="text-xs text-text-muted uppercase tracking-wide mb-2">Recent alerts</p>
          {!history?.length ? (
            <p className="text-xs text-text-dim">No alerts yet.</p>
          ) : (
            <div className="space-y-1 max-h-[260px] overflow-y-auto">
              {history.map((a, i) => (
                <div key={i} className="text-xs p-2 bg-elevated rounded">
                  <div className="flex items-center justify-between">
                    <span className={clsx(
                      'font-mono font-bold uppercase',
                      a.severity === 'critical' && 'text-accent-red',
                      a.severity === 'warn' && 'text-accent-amber',
                      a.severity === 'info' && 'text-accent-blue',
                    )}>{a.severity}</span>
                    <span className="text-text-dim text-[10px]">{formatDistanceToNow(parseISO(a.timestamp), { addSuffix: true })}</span>
                  </div>
                  <p className="text-text-primary mt-0.5 truncate" title={a.title}>{a.title}</p>
                  {a.suppressed && <span className="text-[10px] text-text-dim">(deduped)</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DecisionLogs() {
  const [expanded, setExpanded] = useState(false)
  const { data: decisions } = useQuery({
    queryKey: ['decisions', 30],
    queryFn: () => getDecisions(30),
    staleTime: 30000,
    enabled: expanded,
  })

  return (
    <div className="bg-surface border border-border rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <h3 className="text-sm font-semibold text-text-primary">Agent Decision Logs</h3>
        <span className="text-xs text-text-dim">{expanded ? 'Hide' : 'Show'}</span>
      </button>

      {expanded && (
        <div className="px-5 pb-5">
          {!decisions?.length ? (
            <p className="text-xs text-text-dim">No decisions logged yet.</p>
          ) : (
            <div className="space-y-2 max-h-[500px] overflow-y-auto">
              {decisions.map((d, i) => (
                <DecisionRow key={d.id || i} decision={d} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DecisionRow({ decision }) {
  const [open, setOpen] = useState(false)
  const d = decision

  return (
    <div className="bg-elevated rounded-lg border border-border/50">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
      >
        <span className={clsx(
          'text-xs font-mono font-semibold w-10',
          d.action === 'BUY' && 'text-accent-green',
          d.action === 'SELL' && 'text-accent-red',
          d.action === 'HOLD' && 'text-text-muted',
        )}>
          {d.action}
        </span>
        <span className="font-mono text-sm text-text-primary w-14">{d.symbol || '--'}</span>
        <span className="text-xs text-text-muted flex-1 truncate">{d.reasoning?.slice(0, 80)}</span>
        <span className={clsx(
          'text-xs font-mono',
          d.confidence >= 0.7 ? 'text-accent-green' : d.confidence >= 0.4 ? 'text-accent-amber' : 'text-text-dim',
        )}>
          {d.confidence ? `${(d.confidence * 100).toFixed(0)}%` : '--'}
        </span>
        <span className="text-[10px] text-text-dim">
          {d.created_at ? formatDistanceToNow(parseISO(d.created_at), { addSuffix: true }) : ''}
        </span>
      </button>
      {open && d.reasoning && (
        <div className="px-3 pb-3 border-t border-border/30">
          <p className="text-xs text-text-muted mt-2 whitespace-pre-wrap">{d.reasoning}</p>
          {d.supporting_agents && (
            <p className="text-[10px] text-accent-green mt-1">Supporting: {d.supporting_agents}</p>
          )}
          {d.dissenting_agents && (
            <p className="text-[10px] text-accent-red mt-1">Dissenting: {d.dissenting_agents}</p>
          )}
        </div>
      )}
    </div>
  )
}
