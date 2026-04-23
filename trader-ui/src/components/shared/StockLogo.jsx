import { useState } from 'react'
import clsx from 'clsx'

/**
 * Stock / crypto logo tile. Tries public ticker logo CDNs; falls back to
 * a colored initials tile if none return a valid image.
 *
 * Uses a module-level cache so we don't re-attempt a logo we already
 * know is 404 (prevents flicker on scroll/re-render).
 */
const failed = new Set() // symbols whose logos 404'd in this session

// Deterministic color based on symbol — so AAPL is always the same blue-ish
function tileColor(symbol) {
  const hash = [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0)
  const palette = [
    'from-blue-500/30 to-indigo-500/30',
    'from-emerald-500/30 to-teal-500/30',
    'from-amber-500/30 to-orange-500/30',
    'from-violet-500/30 to-purple-500/30',
    'from-cyan-500/30 to-sky-500/30',
    'from-rose-500/30 to-pink-500/30',
    'from-lime-500/30 to-green-500/30',
  ]
  return palette[hash % palette.length]
}

export default function StockLogo({ symbol, size = 24, className }) {
  const [broken, setBroken] = useState(failed.has(symbol))

  // Crypto pairs (BTC/USD) — strip the slash for the tile initials
  const clean = (symbol || '').toUpperCase()
  const initials = clean.includes('/') ? clean.split('/')[0].slice(0, 3) : clean.slice(0, 4)

  // For crypto, skip CDN lookup since they won't be there
  const isCrypto = clean.includes('/')
  const useFallback = broken || isCrypto

  if (useFallback) {
    return (
      <div
        className={clsx(
          'flex items-center justify-center rounded-full bg-gradient-to-br flex-shrink-0 font-mono font-bold text-text-primary',
          tileColor(clean),
          className,
        )}
        style={{ width: size, height: size, fontSize: Math.max(8, size * 0.38) }}
        title={clean}
      >
        {initials}
      </div>
    )
  }

  // Same-origin proxy — avoids desktop ad/tracker blockers that silently
  // drop requests to finance-data domains like financialmodelingprep.com.
  // Backend caches upstream hits + misses and sets long browser Cache-Control.
  const apiBase = import.meta.env.VITE_API_BASE_URL || '/api'
  return (
    <img
      src={`${apiBase}/logo/${clean}`}
      alt={clean}
      width={size}
      height={size}
      loading="lazy"
      className={clsx('rounded-full bg-elevated object-contain flex-shrink-0', className)}
      style={{ width: size, height: size }}
      onError={() => {
        failed.add(clean)
        setBroken(true)
      }}
    />
  )
}
