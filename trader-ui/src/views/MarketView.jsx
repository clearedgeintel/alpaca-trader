import { useState, useEffect, useMemo, useRef } from 'react'
import { createChart, CandlestickSeries, HistogramSeries, LineSeries } from 'lightweight-charts'
import clsx from 'clsx'
import { useMarketBars, useMarketSnapshot, useMarketNews } from '../hooks/useQueries'
import { formatDistanceToNow, parseISO } from 'date-fns'

/**
 * Compute session-anchored VWAP. For intraday timeframes the accumulator
 * resets at each trading-day boundary (ET). For daily/weekly bars we
 * treat the entire visible range as one session (cumulative VWAP).
 * Returns `[{ time: unixSec, value: vwap }]`.
 */
function computeSessionVwap(bars, timeframe) {
  if (!bars?.length) return []
  const intraday = timeframe !== '1Day' && timeframe !== '1Week'
  const out = []
  let sumPV = 0
  let sumV = 0
  let currentDay = null

  for (const b of bars) {
    const d = new Date(b.t)
    // Use UTC date as the session key; good enough since Alpaca returns
    // US-market bars and the reset fires once per calendar day either way.
    const dayKey = d.toISOString().slice(0, 10)
    if (intraday && dayKey !== currentDay) {
      sumPV = 0
      sumV = 0
      currentDay = dayKey
    }
    const tp = (b.h + b.l + b.c) / 3
    sumPV += tp * b.v
    sumV += b.v
    out.push({
      time: Math.floor(d.getTime() / 1000),
      value: sumV > 0 ? sumPV / sumV : b.c,
    })
  }
  return out
}

/**
 * Bucket bar volume by price level for a volume profile. Each bar's volume
 * is assigned to the bucket containing its close price — simple and cheap.
 * Returns `{ buckets: [{priceLow, priceHigh, volume}], pocIndex, maxVol }`.
 */
function computeVolumeProfile(bars, numBuckets = 50) {
  if (!bars?.length) return null
  let lo = Infinity
  let hi = -Infinity
  for (const b of bars) {
    if (b.l < lo) lo = b.l
    if (b.h > hi) hi = b.h
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null

  const step = (hi - lo) / numBuckets
  const buckets = Array.from({ length: numBuckets }, (_, i) => ({
    priceLow: lo + i * step,
    priceHigh: lo + (i + 1) * step,
    volume: 0,
  }))
  for (const b of bars) {
    const idx = Math.min(numBuckets - 1, Math.max(0, Math.floor((b.c - lo) / step)))
    buckets[idx].volume += b.v
  }
  let pocIndex = 0
  let maxVol = 0
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].volume > maxVol) { maxVol = buckets[i].volume; pocIndex = i }
  }
  return { buckets, pocIndex, maxVol, priceMin: lo, priceMax: hi }
}

const WATCHLIST = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'META', 'GOOGL', 'AMZN', 'IWM', 'DIA']

const TIMEFRAMES = [
  { label: '5m', value: '5Min', limit: 78 },
  { label: '15m', value: '15Min', limit: 80 },
  { label: '1H', value: '1Hour', limit: 100 },
  { label: '1D', value: '1Day', limit: 120 },
  { label: '1W', value: '1Week', limit: 104 },
]

export default function MarketView() {
  const [symbol, setSymbol] = useState('SPY')
  const [customSymbol, setCustomSymbol] = useState('')
  const [tfIdx, setTfIdx] = useState(3) // default 1Day
  const [showVwap, setShowVwap] = useState(true)
  const [showVolumeProfile, setShowVolumeProfile] = useState(true)
  const tf = TIMEFRAMES[tfIdx]

  const { data: bars, isLoading: barsLoading } = useMarketBars(symbol, tf.value, tf.limit)
  const { data: snapData } = useMarketSnapshot(symbol)
  const { data: news } = useMarketNews(8)

  const snapshot = snapData?.snapshot
  const indicators = snapData?.indicators

  function handleCustomSymbol(e) {
    e.preventDefault()
    const s = customSymbol.trim().toUpperCase()
    if (s) { setSymbol(s); setCustomSymbol('') }
  }

  // Filter news for selected symbol
  const symbolNews = news?.filter(n => n.symbols?.includes(symbol)) || []
  const displayNews = symbolNews.length > 0 ? symbolNews : (news || []).slice(0, 5)

  return (
    <div className="space-y-6">
      {/* Header: symbol selector + timeframe */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-text-primary">Market</h2>
          <div className="flex gap-1 flex-wrap">
            {WATCHLIST.map(s => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={clsx(
                  'px-2.5 py-1 text-xs font-mono rounded transition-colors',
                  s === symbol
                    ? 'bg-accent-blue text-white'
                    : 'bg-elevated text-text-muted hover:text-text-primary border border-border hover:border-accent-blue/50'
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <form onSubmit={handleCustomSymbol} className="flex gap-1">
            <input
              type="text"
              value={customSymbol}
              onChange={e => setCustomSymbol(e.target.value)}
              placeholder="Symbol..."
              className="w-20 bg-elevated border border-border rounded px-2 py-1 text-xs font-mono text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue"
            />
            <button type="submit" className="px-2 py-1 bg-accent-blue/20 text-accent-blue text-xs rounded hover:bg-accent-blue/30">Go</button>
          </form>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            <OverlayToggle label="VWAP" active={showVwap} onToggle={() => setShowVwap(v => !v)} />
            <OverlayToggle label="VP" active={showVolumeProfile} onToggle={() => setShowVolumeProfile(v => !v)} />
          </div>
          <div className="w-px h-5 bg-border" />
          <div className="flex gap-1">
            {TIMEFRAMES.map((t, i) => (
              <button
                key={t.value}
                onClick={() => setTfIdx(i)}
                className={clsx(
                  'px-3 py-1.5 text-xs font-mono rounded transition-colors',
                  i === tfIdx
                    ? 'bg-accent-blue text-white'
                    : 'bg-elevated text-text-muted hover:text-text-primary border border-border'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Price header */}
      <SymbolHeader symbol={symbol} snapshot={snapshot} indicators={indicators} />

      {/* Chart + sidebar */}
      <div className="grid grid-cols-4 gap-6">
        <div className="col-span-3">
          <CandleChart bars={bars} loading={barsLoading} symbol={symbol} timeframe={tf.value} showVwap={showVwap} showVolumeProfile={showVolumeProfile} />
        </div>
        <div className="space-y-4">
          <StatsPanel snapshot={snapshot} indicators={indicators} />
          <SymbolNews articles={displayNews} symbol={symbol} />
        </div>
      </div>
    </div>
  )
}

function SymbolHeader({ symbol, snapshot, indicators }) {
  if (!snapshot) {
    return (
      <div className="flex items-end gap-4">
        <span className="font-mono text-3xl font-bold text-text-primary">{symbol}</span>
        <div className="h-8 w-32 bg-elevated rounded animate-pulse" />
      </div>
    )
  }

  const price = snapshot.latestTrade?.p || snapshot.minuteBar?.c || 0
  const prevClose = snapshot.prevDailyBar?.c || 0
  const change = prevClose ? ((price - prevClose) / prevClose * 100) : 0
  const changeDollar = price - prevClose

  return (
    <div className="flex items-end gap-6">
      <span className="font-mono text-3xl font-bold text-text-primary">{symbol}</span>
      <span className="font-mono text-3xl font-semibold text-text-primary">${price.toFixed(2)}</span>
      <div className="flex items-center gap-2 pb-1">
        <span className={clsx(
          'font-mono text-sm font-medium',
          change > 0 ? 'text-accent-green' : change < 0 ? 'text-accent-red' : 'text-text-muted',
        )}>
          {changeDollar >= 0 ? '+' : ''}{changeDollar.toFixed(2)} ({change >= 0 ? '+' : ''}{change.toFixed(2)}%)
        </span>
      </div>
      {indicators?.rsi != null && (
        <span className={clsx(
          'text-xs font-mono px-2 py-0.5 rounded',
          indicators.rsi > 70 ? 'bg-accent-red/10 text-accent-red' :
          indicators.rsi < 30 ? 'bg-accent-green/10 text-accent-green' :
          'bg-elevated text-text-muted',
        )}>
          RSI {indicators.rsi.toFixed(1)}
        </span>
      )}
    </div>
  )
}

function OverlayToggle({ label, active, onToggle }) {
  return (
    <button
      onClick={onToggle}
      title={label === 'VP' ? 'Volume Profile' : label}
      className={clsx(
        'px-2.5 py-1.5 text-[10px] font-mono font-semibold rounded transition-colors',
        active
          ? 'bg-accent-amber/20 text-accent-amber border border-accent-amber/30'
          : 'bg-elevated text-text-muted hover:text-text-primary border border-border'
      )}
    >
      {label}
    </button>
  )
}

function CandleChart({ bars, loading, symbol, timeframe, showVwap, showVolumeProfile }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const volumeSeriesRef = useRef(null)
  const vwapSeriesRef = useRef(null)

  const volumeProfile = useMemo(
    () => (showVolumeProfile ? computeVolumeProfile(bars || []) : null),
    [bars, showVolumeProfile]
  )

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: '#111318' },
        textColor: '#9ca3af',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1e2228' },
        horzLines: { color: '#1e2228' },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: '#3b82f6', width: 1, style: 2, labelBackgroundColor: '#3b82f6' },
        horzLine: { color: '#3b82f6', width: 1, style: 2, labelBackgroundColor: '#3b82f6' },
      },
      timeScale: {
        borderColor: '#1e2228',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#1e2228',
      },
      handleScroll: true,
      handleScale: true,
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    })

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    })

    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    })

    // VWAP line — dashed amber on main price scale
    const vwapSeries = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 1,
      lineStyle: 2, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
    })

    chartRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries
    vwapSeriesRef.current = vwapSeries

    const ro = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: entry.contentRect.width })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [])

  // Update data when bars change
  useEffect(() => {
    if (!bars?.length || !candleSeriesRef.current) return

    const candles = bars.map(b => ({
      time: Math.floor(new Date(b.t).getTime() / 1000),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
    }))

    const volumes = bars.map(b => ({
      time: Math.floor(new Date(b.t).getTime() / 1000),
      value: b.v,
      color: b.c >= b.o ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)',
    }))

    candleSeriesRef.current.setData(candles)
    volumeSeriesRef.current.setData(volumes)

    if (vwapSeriesRef.current) {
      vwapSeriesRef.current.setData(showVwap ? computeSessionVwap(bars, timeframe) : [])
    }

    if (chartRef.current) {
      chartRef.current.timeScale().fitContent()
    }
  }, [bars, timeframe, showVwap])

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface/80 z-10">
          <div className="flex items-center gap-2 text-text-muted text-sm">
            <span className="w-2 h-2 rounded-full bg-accent-blue animate-pulse" />
            Loading {symbol}...
          </div>
        </div>
      )}
      <div ref={containerRef} style={{ height: 500 }} />
      {volumeProfile && <VolumeProfileOverlay profile={volumeProfile} />}
    </div>
  )
}

/**
 * Canvas overlay that renders a horizontal volume-at-price histogram
 * on the right edge of the chart. Mapped to the bars' full price
 * range (min low → max high), so it reflects "volume by price for the
 * visible window" rather than tracking chart zoom/pan. Good v1 — a
 * future pass can sync with chart.priceScale('right').priceToCoordinate.
 */
function VolumeProfileOverlay({ profile }) {
  const { buckets, pocIndex, maxVol, priceMin, priceMax } = profile
  if (!buckets?.length || !maxVol) return null

  // Chart is 500px tall; lightweight-charts adds ~20px top margin for time scale,
  // and the volume histogram reserves 80% — so price area occupies roughly
  // y ∈ [0, 400]. Map each bucket linearly into that window.
  const priceAreaTop = 0
  const priceAreaHeight = 400
  const bucketHeight = priceAreaHeight / buckets.length
  const overlayWidth = 80 // px

  return (
    <div
      className="absolute top-0 right-0 pointer-events-none"
      style={{ width: overlayWidth, height: priceAreaHeight + priceAreaTop }}
      title={`Volume Profile · POC $${buckets[pocIndex].priceLow.toFixed(2)}-$${buckets[pocIndex].priceHigh.toFixed(2)}`}
    >
      {buckets.map((b, i) => {
        const pct = maxVol > 0 ? b.volume / maxVol : 0
        // Invert Y so high prices are at top (lightweight-charts orientation)
        const top = priceAreaTop + (buckets.length - 1 - i) * bucketHeight
        const w = pct * overlayWidth * 0.9 // leave 10% right margin
        const isPoc = i === pocIndex
        return (
          <div
            key={i}
            className={clsx(
              'absolute right-0',
              isPoc ? 'bg-accent-amber/50' : 'bg-accent-blue/30'
            )}
            style={{
              top: `${top}px`,
              height: `${Math.max(1, bucketHeight - 0.5)}px`,
              width: `${w}px`,
            }}
          />
        )
      })}
      <div className="absolute top-1 right-1 text-[9px] font-mono text-text-dim bg-surface/70 px-1 rounded">
        VP · POC ${buckets[pocIndex].priceLow.toFixed(2)}
      </div>
      <div className="absolute bottom-1 right-1 text-[9px] font-mono text-text-dim bg-surface/70 px-1 rounded">
        ${priceMin.toFixed(2)} – ${priceMax.toFixed(2)}
      </div>
    </div>
  )
}

function StatsPanel({ snapshot, indicators }) {
  if (!snapshot) {
    return (
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="space-y-3">
          {[1,2,3,4].map(i => <div key={i} className="h-4 bg-elevated rounded animate-pulse" />)}
        </div>
      </div>
    )
  }

  const daily = snapshot.dailyBar || {}
  const prev = snapshot.prevDailyBar || {}
  const price = snapshot.latestTrade?.p || daily.c || 0

  const stats = [
    { label: 'Open', value: `$${(daily.o || 0).toFixed(2)}` },
    { label: 'High', value: `$${(daily.h || 0).toFixed(2)}`, color: 'text-accent-green' },
    { label: 'Low', value: `$${(daily.l || 0).toFixed(2)}`, color: 'text-accent-red' },
    { label: 'Prev Close', value: `$${(prev.c || 0).toFixed(2)}` },
    { label: 'Volume', value: daily.v ? `${(daily.v / 1e6).toFixed(2)}M` : '--' },
    { label: 'Avg Volume', value: indicators?.avgVolume ? `${(indicators.avgVolume / 1e6).toFixed(2)}M` : '--' },
  ]

  const indicatorStats = []
  if (indicators?.rsi != null) indicatorStats.push({
    label: 'RSI (14)',
    value: indicators.rsi.toFixed(1),
    color: indicators.rsi > 70 ? 'text-accent-red' : indicators.rsi < 30 ? 'text-accent-green' : 'text-text-primary',
  })
  if (indicators?.ema9 != null) indicatorStats.push({
    label: 'EMA 9',
    value: `$${indicators.ema9.toFixed(2)}`,
    color: price > indicators.ema9 ? 'text-accent-green' : 'text-accent-red',
  })
  if (indicators?.ema21 != null) indicatorStats.push({
    label: 'EMA 21',
    value: `$${indicators.ema21.toFixed(2)}`,
    color: price > indicators.ema21 ? 'text-accent-green' : 'text-accent-red',
  })

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Stats</h3>
      <div className="space-y-2">
        {stats.map(s => (
          <div key={s.label} className="flex justify-between text-xs font-mono">
            <span className="text-text-muted">{s.label}</span>
            <span className={s.color || 'text-text-primary'}>{s.value}</span>
          </div>
        ))}
      </div>

      {indicatorStats.length > 0 && (
        <>
          <div className="border-t border-border my-3" />
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Indicators</h3>
          <div className="space-y-2">
            {indicatorStats.map(s => (
              <div key={s.label} className="flex justify-between text-xs font-mono">
                <span className="text-text-muted">{s.label}</span>
                <span className={s.color || 'text-text-primary'}>{s.value}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* RSI visual bar */}
      {indicators?.rsi != null && (
        <div className="mt-3">
          <div className="flex justify-between text-[10px] text-text-dim mb-1">
            <span>Oversold</span>
            <span>Overbought</span>
          </div>
          <div className="h-2 bg-elevated rounded-full overflow-hidden relative">
            <div className="absolute inset-y-0 left-[30%] w-px bg-accent-green/30" />
            <div className="absolute inset-y-0 left-[70%] w-px bg-accent-red/30" />
            <div
              className={clsx(
                'absolute top-0 h-full w-1.5 rounded-full -translate-x-1/2',
                indicators.rsi > 70 ? 'bg-accent-red' : indicators.rsi < 30 ? 'bg-accent-green' : 'bg-accent-blue',
              )}
              style={{ left: `${indicators.rsi}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function SymbolNews({ articles, symbol }) {
  if (!articles?.length) return null

  return (
    <div className="bg-surface border border-border rounded-lg">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">News</h3>
      </div>
      <div className="divide-y divide-border max-h-[300px] overflow-y-auto">
        {articles.map(article => (
          <a
            key={article.id}
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block px-4 py-2.5 hover:bg-elevated/50 transition-colors"
          >
            <p className="text-xs text-text-primary leading-snug mb-1 line-clamp-2">{article.headline}</p>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-dim">{article.source}</span>
              <span className="text-[10px] text-text-dim">
                {formatDistanceToNow(parseISO(article.created_at), { addSuffix: true })}
              </span>
              {article.symbols?.includes(symbol) && (
                <span className="px-1 py-0.5 text-[8px] font-mono bg-accent-blue/10 text-accent-blue rounded">MATCH</span>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}
