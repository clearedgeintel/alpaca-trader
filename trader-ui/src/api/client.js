const BASE = import.meta.env.VITE_API_BASE_URL || '/api'

async function fetchJson(url) {
  const res = await fetch(url)
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
