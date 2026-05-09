import clsx from 'clsx'
import StockLogo from './StockLogo'
import { isOccSymbol, parseOccSymbol } from '../../lib/optionSymbol'

// Standard symbol identity: logo + symbol [+ optional company name].
// Replaces ad-hoc `<StockLogo /> + symbol` clusters scattered across views
// so every table/card/header reads the same way.
//
// For OCC option symbols, the logo follows the underlying (AAPL logo on
// AAPL240419C00150000) and the symbol cell shows the underlying with a
// small "opt" badge — the long contract label is the caller's responsibility
// (see formatOptionLabel in lib/optionSymbol).

export default function SymbolIdentity({
  symbol,
  name,                  // optional company name (e.g. "Apple Inc.")
  size = 22,             // logo size in px
  variant = 'row',       // 'row' | 'header' | 'compact'
  showOptBadge = true,   // small "opt" pill when symbol is an option
  className,
}) {
  if (!symbol) return null

  const isOpt = isOccSymbol(symbol)
  const opt = isOpt ? parseOccSymbol(symbol) : null
  const logoSymbol = isOpt && opt ? opt.underlying : symbol

  const symbolFontClass =
    variant === 'header' ? 'text-2xl md:text-3xl font-bold' :
    variant === 'compact' ? 'text-xs font-semibold' :
    'text-sm font-semibold'

  return (
    <div className={clsx('flex items-center gap-2 min-w-0', className)}>
      <StockLogo symbol={logoSymbol} size={size} />
      <div className="flex flex-col min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={clsx('font-mono text-text-primary truncate', symbolFontClass)}>
            {isOpt && opt ? opt.underlying : symbol}
          </span>
          {isOpt && showOptBadge && (
            <span className="text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue flex-shrink-0">
              opt
            </span>
          )}
        </div>
        {name && variant !== 'compact' && (
          <span className="text-[10px] text-text-muted truncate leading-tight">{name}</span>
        )}
      </div>
    </div>
  )
}
