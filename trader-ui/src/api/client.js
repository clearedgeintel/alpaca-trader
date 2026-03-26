const BASE = import.meta.env.VITE_API_BASE_URL || '/api'

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  return res.json()
}

export const getStatus      = () => fetchJson(`${BASE}/status`)
export const getAccount     = () => fetchJson(`${BASE}/account`)
export const getPositions   = () => fetchJson(`${BASE}/positions`)
export const getTrades      = (params = {}) => fetchJson(`${BASE}/trades?${new URLSearchParams(params)}`)
export const getTrade       = (id) => fetchJson(`${BASE}/trades/${id}`)
export const getSignals     = (limit = 50) => fetchJson(`${BASE}/signals?limit=${limit}`)
export const getPerformance = () => fetchJson(`${BASE}/performance`)
