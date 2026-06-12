/**
 * formatQty(qty, symbol) — display-side qty formatter.
 *
 * Rule:
 *   - Crypto pair (symbol contains '/'): 6 decimals (BTC needs 8, most alts 4-6 — 6 is the safe middle)
 *   - Whole-number qty: 0 decimals (no clutter on the common case)
 *   - Fractional qty: 4 decimals (matches the FRACTIONAL_SHARES_ENABLED precision)
 *
 * Why a single helper instead of inlining: until 2026-06-11 the positions
 * UI hard-coded `qtyDecimals = isCrypto ? 6 : 0`. After fractional shares
 * shipped, equity positions can be 0.1667 share but rendered as "0" (or
 * worse, silently rounded so the operator couldn't tell). One helper means
 * the dashboard cards, positions table, recent-trades list, and market
 * view all show the same shape.
 */
export function formatQty(qty, symbol) {
  const n = Number(qty)
  if (!Number.isFinite(n)) return '—'
  if (typeof symbol === 'string' && symbol.includes('/')) {
    // Strip trailing zeros so 0.500000 → 0.5
    return n.toFixed(6).replace(/\.?0+$/, '')
  }
  if (Number.isInteger(n)) return String(n)
  // Fractional equity / ETF: show 4 decimals, strip trailing zeros
  return n.toFixed(4).replace(/\.?0+$/, '')
}
