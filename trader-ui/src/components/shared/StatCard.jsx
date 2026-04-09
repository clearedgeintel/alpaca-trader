import clsx from 'clsx'

export default function StatCard({ label, value, delta, deltaLabel, trend = 'neutral' }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 relative overflow-hidden">
      {/* Subtle accent glow based on trend */}
      <div className={clsx(
        'absolute inset-x-0 top-0 h-0.5',
        trend === 'up' && 'bg-gradient-to-r from-accent-green/60 to-accent-green/0',
        trend === 'down' && 'bg-gradient-to-r from-accent-red/60 to-accent-red/0',
        trend === 'neutral' && 'bg-gradient-to-r from-accent-blue/30 to-accent-blue/0',
      )} />
      <p className="text-xs text-text-muted uppercase tracking-wide mb-2">{label}</p>
      <p className={clsx(
        'font-mono text-2xl font-semibold',
        trend === 'up' && 'text-accent-green',
        trend === 'down' && 'text-accent-red',
        trend === 'neutral' && 'text-text-primary',
      )}>{value}</p>
      {(delta !== undefined && delta !== null) && (
        <p
          className={clsx(
            'font-mono text-xs mt-1',
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
