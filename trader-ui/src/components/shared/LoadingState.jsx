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
    <div className="app-panel space-y-2 p-3">
      {/* Header */}
      <div className="flex gap-3">
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonBlock key={i} className="h-3 flex-1" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonBlock key={c} className="h-7 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

export function LoadingCards({ count = 4 }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="app-panel p-3 space-y-2">
          <SkeletonBlock className="h-3 w-20" />
          <SkeletonBlock className="h-7 w-32" />
          <SkeletonBlock className="h-3 w-16" />
        </div>
      ))}
    </div>
  )
}

export function LoadingChart() {
  return (
    <div className="app-panel p-3">
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
