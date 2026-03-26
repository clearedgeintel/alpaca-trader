import clsx from 'clsx'

export default function StatCard({ label, value, delta, deltaLabel, trend = 'neutral' }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <p className="text-xs text-text-muted uppercase tracking-wide mb-2">{label}</p>
      <p className="font-mono text-2xl font-semibold text-text-primary">{value}</p>
      {(delta !== undefined && delta !== null) && (
        <p
          className={clsx(
            'font-mono text-xs mt-1',
            trend === 'up' && 'text-accent-green',
            trend === 'down' && 'text-accent-red',
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
