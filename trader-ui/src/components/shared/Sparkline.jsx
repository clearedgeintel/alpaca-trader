export default function Sparkline({ value, threshold = 1.2 }) {
  const width = Math.min(Math.max((value / 2) * 100, 10), 100)
  const isHigh = value >= threshold

  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-2 bg-elevated rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${isHigh ? 'bg-accent-green' : 'bg-text-dim'}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className={`font-mono text-xs ${isHigh ? 'text-accent-green' : 'text-text-muted'}`}>
        {value.toFixed(1)}x
      </span>
    </div>
  )
}
