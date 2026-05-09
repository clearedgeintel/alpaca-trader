import { useState } from 'react'
import clsx from 'clsx'

// Plain-English explanations keyed by Greek symbol or label. Each entry
// is two lines: a one-sentence definition, then a numeric intuition that
// uses the *current* value if provided. Beginners see what the number
// means, not just the number.
//
// Intentionally limited to delta / theta / iv — gamma + vega require more
// background than a hover tooltip can carry. Add later if/when the
// beginner-mode toggle ships.

function intuition(kind, value) {
  if (value == null || !Number.isFinite(value)) return null
  switch (kind) {
    case 'delta': {
      const pctITM = Math.abs(value) * 100
      return `Δ ${value.toFixed(2)} → moves about $${Math.abs(value).toFixed(2)} per $1 stock move. Rough ${pctITM.toFixed(0)}% chance to finish in-the-money.`
    }
    case 'theta': {
      const perDay = Math.abs(value)
      const perDayPerContract = perDay * 100
      return `θ ${value.toFixed(3)} → loses ~$${perDayPerContract.toFixed(0)}/day per contract from time decay (per $1 stock change held flat).`
    }
    case 'iv': {
      const pct = value * 100
      return `IV ${value.toFixed(2)} → market expects ~${pct.toFixed(0)}% annualized stdev. Higher IV = pricier premium.`
    }
    case 'gamma': {
      return `γ ${value.toFixed(3)} → how much delta itself moves per $1 stock move. Higher gamma = more sensitivity at-the-money.`
    }
    case 'vega': {
      return `ν ${value.toFixed(2)} → premium changes by this much per 1-percentage-point change in IV.`
    }
    default:
      return null
  }
}

const DEFINITIONS = {
  delta: 'How much the option price moves per $1 move in the stock. Also a rough probability of expiring in-the-money.',
  theta: 'Daily decay. Long options lose this much per day from time alone (premium burn).',
  iv: 'Implied volatility — the market’s expected annualized stdev priced into the option. Drives premium.',
  gamma: 'Rate of change of delta. Highest near at-the-money; flatter deep ITM/OTM.',
  vega: 'Sensitivity to a 1% change in implied volatility. Long options have positive vega.',
}

export default function GreekTooltip({ kind, value, children, className }) {
  const [open, setOpen] = useState(false)
  const def = DEFINITIONS[kind]
  const num = intuition(kind, value)

  return (
    <span className={clsx('relative inline-flex items-center gap-1', className)}>
      {children}
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        className="w-3.5 h-3.5 rounded-full border border-text-dim/50 text-[8px] font-bold text-text-dim hover:text-accent-blue hover:border-accent-blue flex items-center justify-center leading-none"
        aria-label={`What is ${kind}?`}
      >
        ?
      </button>
      {open && (
        <span className="absolute z-50 left-1/2 -translate-x-1/2 top-full mt-1 w-60 bg-surface border border-border rounded-lg shadow-xl p-2.5 text-[10px] font-mono normal-case tracking-normal text-left pointer-events-none">
          <span className="block text-text-primary font-semibold mb-1 capitalize">{kind === 'iv' ? 'Implied Volatility' : kind}</span>
          {def && <span className="block text-text-muted leading-snug mb-1.5">{def}</span>}
          {num && <span className="block text-text-primary leading-snug">{num}</span>}
        </span>
      )}
    </span>
  )
}
