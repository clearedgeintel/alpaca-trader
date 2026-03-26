import clsx from 'clsx'

export default function PnlCell({ dollar, pct }) {
  if (dollar == null && pct == null) {
    return <span className="font-mono text-text-dim">—</span>
  }

  const isPositive = (dollar ?? 0) > 0
  const isNegative = (dollar ?? 0) < 0
  const color = isPositive ? 'text-accent-green' : isNegative ? 'text-accent-red' : 'text-text-muted'

  const fmtDollar = dollar != null
    ? `${isPositive ? '+' : ''}$${Math.abs(dollar).toFixed(2)}`
    : ''
  const fmtPct = pct != null
    ? `${isPositive ? '+' : isNegative ? '-' : ''}${Math.abs(pct).toFixed(2)}%`
    : ''

  return (
    <span className={clsx('font-mono text-sm whitespace-nowrap', color)}>
      {fmtDollar}{fmtDollar && fmtPct ? '  ' : ''}{fmtPct}
    </span>
  )
}
