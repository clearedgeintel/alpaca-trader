import clsx from 'clsx'

export default function StatCard({ label, value, delta, deltaLabel, trend = 'neutral' }) {
  return (
    <div className="bg-surface border border-border rounded p-2.5 relative overflow-hidden">
      <div className={clsx(
        'absolute inset-x-0 top-0 h-px',
        trend === 'up' && 'bg-accent-green/60',
        trend === 'down' && 'bg-accent-red/60',
        trend === 'neutral' && 'bg-accent-blue/30',
      )} />
      <p className="text-[10px] text-text-muted uppercase tracking-wide mb-1">{label}</p>
      <p className={clsx(
        'font-mono text-lg font-semibold leading-tight',
        trend === 'up' && 'text-accent-green',
        trend === 'down' && 'text-accent-red',
        trend === 'neutral' && 'text-text-primary',
      )}>{value}</p>
      {(delta !== undefined && delta !== null) && (
        <p
          className={clsx(
            'font-mono text-[10px] mt-0.5',
            trend === 'up' && 'text-accent-green/70',
            trend === 'down' && 'text-accent-red/70',
            trend === 'neutral' && 'text-text-muted'
          )}
        >
          {delta}
          {deltaLabel && <span className="text-text-muted ml-1">{deltaLabel}</span>}
        </p>
      )}
    </div>
  )
}
