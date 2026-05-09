import clsx from 'clsx'

export default function PnlCell({ dollar, pct }) {
  if (dollar == null && pct == null) {
    return <span className="font-mono text-text-dim">--</span>
  }

  const baseValue = dollar ?? pct ?? 0
  const isPositive = baseValue > 0
  const isNegative = baseValue < 0
  const color = isPositive ? 'text-accent-green' : isNegative ? 'text-accent-red' : 'text-text-muted'

  const fmtDollar = dollar != null
    ? `${isPositive ? '+' : ''}$${Math.abs(dollar).toFixed(2)}`
    : ''
  const fmtPct = pct != null
    ? `${isPositive ? '+' : isNegative ? '-' : ''}${Math.abs(pct).toFixed(2)}%`
    : ''

  return (
    <span className={clsx('font-mono text-[13px] font-medium whitespace-nowrap', color)}>
      {fmtDollar}{fmtDollar && fmtPct ? '  ' : ''}{fmtPct}
    </span>
  )
}
