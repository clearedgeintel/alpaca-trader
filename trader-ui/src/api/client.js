const BASE = import.meta.env.VITE_API_BASE_URL || '/api'
const API_KEY = import.meta.env.VITE_API_KEY || null

async function fetchJson(url) {
  const headers = {}
  if (API_KEY) headers['x-api-key'] = API_KEY

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  const json = await res.json()
  return json.data ?? json
}

export const getStatus      = () => fetchJson(`${BASE}/status`)
export const getAccount     = () => fetchJson(`${BASE}/account`)
export const getPositions   = () => fetchJson(`${BASE}/positions`)
export const getTrades      = (params = {}) => fetchJson(`${BASE}/trades?${new URLSearchParams(params)}`)
export const getTrade       = (id) => fetchJson(`${BASE}/trades/${id}`)
export const getSignals     = (limit = 50) => fetchJson(`${BASE}/signals?limit=${limit}`)
export const getPerformance = () => fetchJson(`${BASE}/performance`)

// Agent endpoints
export const getAgents           = () => fetchJson(`${BASE}/agents`)
export const getDecisions        = (limit = 20) => fetchJson(`${BASE}/decisions?limit=${limit}`)
export const getDecision         = (id) => fetchJson(`${BASE}/decisions/${id}`)
export const getRiskReport       = () => fetchJson(`${BASE}/agents/risk/report`)
export const getRegimeReport     = () => fetchJson(`${BASE}/agents/regime/report`)
export const getTechnicalReport  = (symbol) => symbol
  ? fetchJson(`${BASE}/agents/technical/report?symbol=${symbol}`)
  : fetchJson(`${BASE}/agents/technical/report`)
export const getNewsReport       = () => fetchJson(`${BASE}/agents/news/report`)
export const getOrchestratorReport = () => fetchJson(`${BASE}/agents/orchestrator/report`)
export const getExecutionFills   = (limit = 20) => fetchJson(`${BASE}/agents/execution/fills?limit=${limit}`)
export const getScreenerReport   = () => fetchJson(`${BASE}/agents/screener/report`)
export const getAgentReports     = (name, limit = 20) => fetchJson(`${BASE}/agents/${name}/reports?limit=${limit}`)

// Config & settings
export const getConfig           = () => fetchJson(`${BASE}/config`)
export const getStrategies       = () => fetchJson(`${BASE}/strategies`)
export async function setSymbolStrategy(symbol, mode) {
  const headers = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/strategies/${symbol}`, { method: 'PUT', headers, body: JSON.stringify({ mode }) })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}
export async function setDefaultStrategy(mode) {
  const headers = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/strategies`, { method: 'PUT', headers, body: JSON.stringify({ default: mode }) })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}
export async function clearSymbolStrategy(symbol) {
  const headers = {}
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/strategies/${symbol}`, { method: 'DELETE', headers })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}

// Bulk export/import of strategy + watchlist config
export async function exportStrategyConfig() {
  const headers = {}
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/config/export`, { headers })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}
export async function importStrategyConfig(payload) {
  const headers = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/config/import`, { method: 'POST', headers, body: JSON.stringify(payload) })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}

// Datasource stats (Polygon usage, rate limits)
export const getDatasourceStats = () => fetchJson(`${BASE}/datasources/stats`)

// Sector rotation — N-day momentum by sector
export const getSectorRotation = (days = 5) => fetchJson(`${BASE}/sectors/rotation?days=${days}`)

// Kelly sizing — per-symbol risk multiplier suggestions from closed-trade history
export const getKellyRecommendations = (days = 60, minSampleSize = 20) =>
  fetchJson(`${BASE}/kelly?days=${days}&minSampleSize=${minSampleSize}`)

// Sentiment trends — per-symbol chronology and inflection detection
export const getSentimentTrend = (symbol, days = 7) =>
  fetchJson(`${BASE}/sentiment/trend/${symbol}?days=${days}`)
export const getSentimentShifts = (hours = 24, threshold = 0.4) =>
  fetchJson(`${BASE}/sentiment/shifts?hours=${hours}&threshold=${threshold}`)

// Prompt A/B — per-version decision + trade stats
export const getPromptPerformance = (agent, days = 30) =>
  fetchJson(`${BASE}/prompts/${agent}/performance?days=${days}`)

export async function activatePrompt(agent, version) {
  const headers = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/prompts/${agent}/activate`, {
    method: 'POST', headers, body: JSON.stringify({ version }),
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}

// Prompt A/B shadow mode — designate a candidate version, fetch comparison
export async function setShadowPrompt(agent, version) {
  const headers = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/prompts/${agent}/set-shadow`, {
    method: 'POST', headers, body: JSON.stringify({ version }),
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}
export async function clearShadowPrompt(agent) {
  const headers = {}
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/prompts/${agent}/clear-shadow`, { method: 'POST', headers })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}
export const getShadowComparison = (agent, days = 7) =>
  fetchJson(`${BASE}/prompts/${agent}/shadow-comparison?days=${days}`)

// Runtime config — hot-reload risk params
export const getRuntimeConfig = () => fetchJson(`${BASE}/runtime-config`)
export async function setRuntimeConfig(key, value) {
  const headers = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/runtime-config/${key}`, { method: 'PUT', headers, body: JSON.stringify({ value }) })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}
export async function clearRuntimeConfig(key) {
  const headers = {}
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/runtime-config/${key}`, { method: 'DELETE', headers })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}

// Watchlist CRUD
export const getWatchlist = () => fetchJson(`${BASE}/watchlist`)
export async function addToWatchlist(symbol) {
  const headers = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/watchlist`, { method: 'POST', headers, body: JSON.stringify({ symbol }) })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}
export async function removeFromWatchlist(symbol) {
  const headers = {}
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/watchlist/${symbol}`, { method: 'DELETE', headers })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}

// LLM Chat
// Agent message feed (reports + decisions + debate rounds, chronological)
export async function getAgentMessages({ limit = 100, agent, symbol } = {}) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (agent) params.set('agent', agent)
  if (symbol) params.set('symbol', symbol)
  return fetchJson(`${BASE}/agents/messages?${params}`)
}

// Manual trade from Market view
export async function placeManualOrder({ symbol, qty, side, useSor = false }) {
  const headers = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/trades/manual`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ symbol, qty: Number(qty), side, useSor }),
  })
  const body = await res.json()
  if (!res.ok || !body.success) throw new Error(body.error || `API error: ${res.status}`)
  return body.data
}

export async function askChat(question, sessionId) {
  const headers = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}/chat`, { method: 'POST', headers, body: JSON.stringify({ question, sessionId }) })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()).data
}

// Agent metrics & observability
export const getMetricsSummary   = (days = 7) => fetchJson(`${BASE}/metrics/summary?days=${days}`)
export const getMetricsLeaderboard = (days = 30) => fetchJson(`${BASE}/metrics/leaderboard?days=${days}`)
export const getMetricsLatency   = (hours = 24) => fetchJson(`${BASE}/metrics/latency?hours=${hours}`)
export const getAgentCalibration = (days = 30) => fetchJson(`${BASE}/agents/calibration?days=${days}`)

// Market data
export const getMarketTickers   = () => fetchJson(`${BASE}/market/tickers`)
export const getMarketNews      = (limit = 15) => fetchJson(`${BASE}/market/news?limit=${limit}`)
export const getMarketBars      = (symbol, timeframe = '1Day', limit = 100) => fetchJson(`${BASE}/market/bars/${symbol}?timeframe=${timeframe}&limit=${limit}`)
export const getMarketSnapshot  = (symbol) => fetchJson(`${BASE}/market/snapshot/${symbol}`)
export const getMarketUniverse  = () => fetchJson(`${BASE}/market/universe`)
export const searchSymbols      = (q) => fetchJson(`${BASE}/market/search?q=${encodeURIComponent(q)}`)
export const getCycleLog        = (limit = 50, summarize = 20) => fetchJson(`${BASE}/diagnostics/cycle-log?limit=${limit}&summarize=${summarize}`)

// Options (Phase 2 endpoints — read-only)
export const getOptionChain     = (underlying, params = {}) => {
  const qs = new URLSearchParams({ underlying })
  if (params.expiration) qs.set('expiration', params.expiration)
  if (params.type) qs.set('type', params.type)
  if (params.strikePriceGte != null) qs.set('strikePriceGte', String(params.strikePriceGte))
  if (params.strikePriceLte != null) qs.set('strikePriceLte', String(params.strikePriceLte))
  if (params.limit) qs.set('limit', String(params.limit))
  return fetchJson(`${BASE}/options/chain?${qs}`)
}
export const getOptionGreeks    = (contract) => fetchJson(`${BASE}/options/greeks?contract=${encodeURIComponent(contract)}`)

// Analytics & backtesting
export const getAnalytics        = () => fetchJson(`${BASE}/analytics`)
export const getDecisionTimeline = (limit = 50) => fetchJson(`${BASE}/decisions/timeline?limit=${limit}`)
async function postJson(path, params) {
  const headers = { 'Content-Type': 'application/json' }
  if (API_KEY) headers['x-api-key'] = API_KEY
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(params) })
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  const json = await res.json()
  return json.data ?? json
}
export const runBacktest           = (params = {}) => postJson('/backtest', params)
export const runWalkForward        = (params = {}) => postJson('/backtest/walk-forward', params)
export const runMonteCarlo         = (params = {}) => postJson('/backtest/monte-carlo', params)
export const runReplay             = (params = {}) => postJson('/replay', params)
export const getAttribution        = (days = 90) => fetchJson(`${BASE}/analytics/attribution?days=${days}`)

// Alerts
export const getAlertChannels      = () => fetchJson(`${BASE}/alerts/channels`)
export const getAlertHistory       = (limit = 50) => fetchJson(`${BASE}/alerts/history?limit=${limit}`)
export const testAlertSend         = (channel) => postJson('/alerts/test', { channel })
export const sendDigestNow         = () => postJson('/alerts/digest', {})
