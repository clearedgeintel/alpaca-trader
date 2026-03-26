import clsx from 'clsx'

function SkeletonBlock({ className }) {
  return (
    <div
      className={clsx(
        'rounded bg-elevated bg-gradient-to-r from-elevated via-border to-elevated bg-[length:200%_100%] animate-shimmer',
        className
      )}
    />
  )
}

export function LoadingTable({ rows = 5, cols = 6 }) {
  return (
    <div className="space-y-3 p-4">
      {/* Header */}
      <div className="flex gap-4">
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonBlock key={i} className="h-4 flex-1" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonBlock key={c} className="h-8 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

export function LoadingCards({ count = 4 }) {
  return (
    <div className="grid grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-surface border border-border rounded-lg p-4 space-y-3">
          <SkeletonBlock className="h-3 w-20" />
          <SkeletonBlock className="h-8 w-32" />
          <SkeletonBlock className="h-3 w-16" />
        </div>
      ))}
    </div>
  )
}

export function LoadingChart() {
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <SkeletonBlock className="h-[220px] w-full" />
    </div>
  )
}

export default function LoadingState({ type = 'table', ...props }) {
  switch (type) {
    case 'cards': return <LoadingCards {...props} />
    case 'chart': return <LoadingChart {...props} />
    default: return <LoadingTable {...props} />
  }
}
