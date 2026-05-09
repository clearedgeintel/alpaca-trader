import clsx from 'clsx'

// "What am I actually buying?" risk panel for a long single-leg option.
// Shows the three numbers a beginner needs to read before a trade:
//   Max loss  = premium paid (per contract × multiplier × qty)
//   Break-even = strike + premium (call) or strike - premium (put)
//   Max gain  = unlimited (call) or strike-premium-floored (put)
//
// We deliberately do NOT show this for short / spread positions — the
// math changes (margin, defined-risk caps, etc.) and we don't want
// beginners to read "max loss = premium" in a context where it doesn't
// apply. Only renders when type is call or put AND qty > 0.

export default function OptionRiskPanel({
  type,            // 'call' | 'put'
  strike,          // number (per share)
  premium,         // number (per share)
  qty,             // number of contracts
  multiplier = 100,
  underlyingPrice = null, // optional — colors break-even by distance
  className,
}) {
  if (!type || !premium || !strike || !qty) return null
  const contracts = Math.max(1, Math.floor(qty))
  const totalPremium = +(premium * multiplier * contracts).toFixed(2)
  const breakEven = type === 'call'
    ? +(strike + premium).toFixed(2)
    : +(strike - premium).toFixed(2)
  const maxGain = type === 'call'
    ? null  // unlimited
    : +((strike - premium) * multiplier * contracts).toFixed(2)

  // Break-even distance vs current price (for color cue)
  let breakEvenPctAway = null
  if (underlyingPrice && underlyingPrice > 0) {
    breakEvenPctAway = ((breakEven - underlyingPrice) / underlyingPrice) * 100
    if (type === 'put') breakEvenPctAway = -breakEvenPctAway  // puts profit on downside
  }
  const beColor = breakEvenPctAway == null
    ? 'text-text-primary'
    : breakEvenPctAway <= 0
      ? 'text-accent-green'
      : breakEvenPctAway > 5
        ? 'text-accent-red'
        : 'text-accent-amber'

  return (
    <div className={clsx('rounded border border-border/60 bg-elevated/40 p-2', className)}>
      <div className="text-[9px] font-mono text-text-dim uppercase tracking-wide mb-1">
        What you're buying
      </div>
      <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
        <RiskTile
          label="Max loss"
          value={`$${totalPremium.toFixed(0)}`}
          sub={`${contracts}× $${premium.toFixed(2)} × ${multiplier}`}
          color="text-accent-red"
        />
        <RiskTile
          label="Break-even"
          value={`$${breakEven.toFixed(2)}`}
          sub={breakEvenPctAway != null
            ? breakEvenPctAway > 0
              ? `${breakEvenPctAway.toFixed(1)}% ${type === 'call' ? 'above' : 'below'}`
              : 'already past'
            : type === 'call' ? 'strike + premium' : 'strike − premium'}
          color={beColor}
        />
        <RiskTile
          label="Max gain"
          value={maxGain == null ? 'unlimited' : `$${maxGain.toFixed(0)}`}
          sub={maxGain == null ? 'theoretical' : 'if stock → $0'}
          color="text-accent-green"
        />
      </div>
      {breakEvenPctAway != null && breakEvenPctAway > 0 && (
        <p className="mt-1.5 text-[9px] text-text-dim leading-snug">
          Stock needs to {type === 'call' ? 'rise' : 'fall'} past <span className="text-text-primary">${breakEven.toFixed(2)}</span> by expiry to profit. Below that you lose part or all of the premium.
        </p>
      )}
    </div>
  )
}

function RiskTile({ label, value, sub, color }) {
  return (
    <div className="flex flex-col">
      <span className="text-[8px] text-text-dim uppercase tracking-wide">{label}</span>
      <span className={clsx('text-sm font-bold leading-tight', color)}>{value}</span>
      {sub && <span className="text-[8px] text-text-dim leading-tight mt-0.5">{sub}</span>}
    </div>
  )
}
