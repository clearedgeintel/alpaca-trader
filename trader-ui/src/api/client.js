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
export const getAttribution        = (days = 90) => fetchJson(`${BASE}/analytics/attribution?days=${days}`)

// Alerts
export const getAlertChannels      = () => fetchJson(`${BASE}/alerts/channels`)
export const getAlertHistory       = (limit = 50) => fetchJson(`${BASE}/alerts/history?limit=${limit}`)
export const testAlertSend         = (channel) => postJson('/alerts/test', { channel })
export const sendDigestNow         = () => postJson('/alerts/digest', {})
