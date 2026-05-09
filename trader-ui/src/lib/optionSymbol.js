// Shared OCC option-symbol helpers. Replaces the regex copies that had
// drifted into PositionRow / DashboardView / ClosePositionButton.
//
// OCC layout: ROOT(1-6) + YYMMDD + (C|P) + STRIKE(8 digits, 1/1000ths)
//   AAPL240419C00150000 → AAPL, 2024-04-19, Call, $150.00

const OCC_RE = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/

export function isOccSymbol(s) {
  return typeof s === 'string' && OCC_RE.test(s)
}

export function parseOccSymbol(s) {
  const m = OCC_RE.exec(String(s || ''))
  if (!m) return null
  const yy = parseInt(m[2], 10)
  const mm = parseInt(m[3], 10)
  const dd = parseInt(m[4], 10)
  const year = yy < 70 ? 2000 + yy : 1900 + yy
  return {
    underlying: m[1],
    expiration: `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
    expirationYear: year,
    expirationMonth: mm,
    expirationDay: dd,
    type: m[5] === 'C' ? 'call' : 'put',
    typeShort: m[5],
    strike: parseInt(m[6], 10) / 1000,
  }
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "AAPL $150 Call exp Apr 19" — the long-form label for headings/tooltips.
// Beginners see what they're trading without decoding the symbol.
export function formatOptionLabel(s, { includeYear = false } = {}) {
  const p = parseOccSymbol(s)
  if (!p) return s
  const monthName = SHORT_MONTHS[p.expirationMonth - 1] || `M${p.expirationMonth}`
  const yearPart = includeYear ? ` '${String(p.expirationYear).slice(-2)}` : ''
  const typeName = p.type === 'call' ? 'Call' : 'Put'
  const strikeFmt = Number.isInteger(p.strike) ? `$${p.strike}` : `$${p.strike.toFixed(2)}`
  return `${p.underlying} ${strikeFmt} ${typeName} exp ${monthName} ${p.expirationDay}${yearPart}`
}

// "AAPL $150C 4/19" — compact form for tight rows.
export function formatOptionLabelShort(s) {
  const p = parseOccSymbol(s)
  if (!p) return s
  const strikeFmt = Number.isInteger(p.strike) ? `${p.strike}` : `${p.strike.toFixed(2)}`
  return `${p.underlying} $${strikeFmt}${p.typeShort} ${p.expirationMonth}/${p.expirationDay}`
}

// Days-to-expiry from an OCC symbol (or a YYYY-MM-DD string). Uses the
// 4pm ET expiry close convention.
export function daysToExpiry(s) {
  let dateStr
  if (typeof s === 'string' && s.includes('-')) dateStr = s
  else {
    const p = parseOccSymbol(s)
    if (!p) return null
    dateStr = p.expiration
  }
  const expiryMs = Date.parse(`${dateStr}T16:00:00-04:00`)
  if (!Number.isFinite(expiryMs)) return null
  return Math.floor((expiryMs - Date.now()) / 86_400_000)
}
