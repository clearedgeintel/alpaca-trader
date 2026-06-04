import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { getRecap, recapDownloadUrl, getRecapStatus, dispatchRecap, getRecapArchive, recapArchiveUrl } from '../api/client'
import { formatDistanceToNow, parseISO } from 'date-fns'

/**
 * /recap — Today's Recap + Range Report Card.
 *
 * Two tabs:
 *   - Today: auto-shows today's recap with download / print actions.
 *   - Range: date pickers + presets + Generate; renders the same template
 *     against the chosen window.
 *
 * Print-friendly: a .print-only and .no-print class shape lets Cmd+P render
 * just the recap surface. The dashboard chrome (sidebar, tabs) drops out.
 *
 * The rendered surface is data-driven; we don't fetch the server-side
 * markdown for in-app display — we render the structured ReportObject so
 * formatting matches the rest of the dashboard's voice. Download buttons
 * pull markdown / HTML from the same endpoint with format= parameters.
 */

const PRESETS = [
  { key: 'today',  label: 'Today',  range: () => { const t = todayET(); return [t, t]; } },
  { key: '7d',     label: 'Last 7 days',  range: () => { const t = todayET(); return [shiftDays(t, -6), t]; } },
  { key: '30d',    label: 'Last 30 days', range: () => { const t = todayET(); return [shiftDays(t, -29), t]; } },
  { key: '90d',    label: 'Last 90 days', range: () => { const t = todayET(); return [shiftDays(t, -89), t]; } },
  { key: 'mtd',    label: 'Month to date',  range: () => { const t = todayET(); return [t.slice(0, 8) + '01', t]; } },
  { key: 'ytd',    label: 'Year to date',   range: () => { const t = todayET(); return [t.slice(0, 4) + '-01-01', t]; } },
]

function todayET() {
  // Best-effort ET today. Server is the source of truth; this is just default
  // values for the picker.
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const y = et.getFullYear(), m = String(et.getMonth() + 1).padStart(2, '0'), d = String(et.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function shiftDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function RecapView() {
  const [tab, setTab] = useState('today')
  const [from, setFrom] = useState(todayET())
  const [to, setTo] = useState(todayET())
  // The Range tab waits for a Generate click — initial render shouldn't fire
  // a fetch with stale defaults. Today tab auto-loads.
  const [rangeArmed, setRangeArmed] = useState(false)

  const activeFrom = tab === 'today' ? todayET() : from
  const activeTo = tab === 'today' ? todayET() : to
  // Archive tab uses its own query — skip the today/range fetch there.
  const enabled = tab === 'today' || (tab === 'range' && rangeArmed)

  const { data, isLoading, isFetching, refetch, error: queryError } = useQuery({
    queryKey: ['recap', activeFrom, activeTo],
    queryFn: () => getRecap(activeFrom, activeTo),
    enabled,
    staleTime: 60_000,
    refetchInterval: tab === 'today' ? 5 * 60 * 1000 : false,
  })

  // Status reads whether PDF is wired so the actions row can offer it.
  const { data: status } = useQuery({
    queryKey: ['recap-status'],
    queryFn: getRecapStatus,
    staleTime: 60_000,
  })
  const pdfAvailable = status?.pdfAvailable === true

  function applyPreset(p) {
    const [f, t] = p.range()
    setFrom(f); setTo(t)
    setRangeArmed(true)
  }

  return (
    <div className="space-y-3">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-surface { background: white !important; color: black !important; }
          .print-surface * { color: inherit !important; background: transparent !important; border-color: #ccc !important; }
          .print-surface a { color: #1d4ed8 !important; }
        }
      `}</style>

      <div className="no-print">
        <h2 className="page-title">Recap & Report Card</h2>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border mt-2">
          {[
            { key: 'today', label: "Today's Recap" },
            { key: 'range', label: 'Range Report Card' },
            { key: 'archive', label: 'Archive' },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={clsx(
                'px-3 py-2 text-xs font-mono font-semibold uppercase tracking-wide transition-colors',
                tab === t.key ? 'text-accent-blue border-b-2 border-accent-blue -mb-px' : 'text-text-muted hover:text-text-primary',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'range' && (
          <div className="bg-surface border border-border rounded-lg p-4 mt-3">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wide text-text-dim font-mono">From</label>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => { setFrom(e.target.value); setRangeArmed(false); }}
                  className="bg-elevated border border-border rounded px-2 py-1 text-xs font-mono text-text-primary outline-none focus:border-accent-blue/50"
                />
                <label className="text-[10px] uppercase tracking-wide text-text-dim font-mono">To</label>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => { setTo(e.target.value); setRangeArmed(false); }}
                  className="bg-elevated border border-border rounded px-2 py-1 text-xs font-mono text-text-primary outline-none focus:border-accent-blue/50"
                />
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {PRESETS.filter((p) => p.key !== 'today').map((p) => (
                  <button
                    key={p.key}
                    onClick={() => applyPreset(p)}
                    className="px-2 py-1 text-[10px] font-mono bg-elevated text-text-muted border border-border rounded hover:text-text-primary"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => { setRangeArmed(true); refetch(); }}
                disabled={!from || !to}
                className="ml-auto px-4 py-1.5 text-xs font-mono font-semibold bg-accent-blue/20 text-accent-blue border border-accent-blue/40 rounded hover:bg-accent-blue/30 disabled:opacity-40"
              >
                Generate report
              </button>
            </div>
          </div>
        )}

        {/* Actions row — print + download + manual dispatch */}
        {tab !== 'archive' && data && (
          <div className="flex items-center gap-2 flex-wrap mt-3">
            <button
              onClick={() => window.print()}
              className="px-3 py-1.5 text-xs font-mono bg-elevated text-text-muted border border-border rounded hover:text-text-primary"
              title="Print or Save as PDF"
            >
              🖨 Print / Save as PDF
            </button>
            <a
              href={recapDownloadUrl(activeFrom, activeTo, 'md')}
              download
              className="px-3 py-1.5 text-xs font-mono bg-elevated text-text-muted border border-border rounded hover:text-text-primary"
            >
              ⬇ Markdown
            </a>
            <a
              href={recapDownloadUrl(activeFrom, activeTo, 'html')}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs font-mono bg-elevated text-text-muted border border-border rounded hover:text-text-primary"
            >
              ⬇ HTML
            </a>
            {pdfAvailable && (
              <a
                href={recapDownloadUrl(activeFrom, activeTo, 'pdf')}
                download
                className="px-3 py-1.5 text-xs font-mono bg-accent-red/10 text-accent-red border border-accent-red/40 rounded hover:bg-accent-red/20"
                title="Server-rendered PDF (uses local Chrome)"
              >
                ⬇ PDF
              </a>
            )}
            {tab === 'today' && <DispatchButton date={activeFrom} />}
            <span className="ml-auto text-[10px] text-text-dim font-mono">
              {isFetching ? 'refreshing…' : data?.meta?.generatedAt ? `generated ${formatDistanceToNow(parseISO(data.meta.generatedAt))} ago` : ''}
            </span>
          </div>
        )}

        {tab === 'today' && <DeliveryStatusStrip />}
      </div>

      {/* Render surface */}
      {tab === 'archive' ? (
        <ArchiveTab />
      ) : isLoading && enabled ? (
        <div className="bg-surface border border-border rounded-lg p-8 text-center text-text-dim font-mono text-sm">Loading recap…</div>
      ) : queryError ? (
        <div className="bg-surface border border-accent-red/40 rounded-lg p-4 text-accent-red font-mono text-sm">
          Recap failed: {queryError.message}
        </div>
      ) : data ? (
        <RecapSurface report={data} />
      ) : (
        <div className="bg-surface border border-border rounded-lg p-8 text-center text-text-dim font-mono text-sm">
          {tab === 'range' ? 'Choose a date range or click a preset, then Generate.' : 'Loading…'}
        </div>
      )}
    </div>
  )
}

// -- Archive tab -----------------------------------------------------------
// Lists previously-dispatched recaps with their headline numbers and
// per-row download buttons for PDF / HTML / Markdown.
function ArchiveTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['recap-archive'],
    queryFn: () => getRecapArchive(180),
    staleTime: 60_000,
  })
  if (isLoading) return <div className="bg-surface border border-border rounded-lg p-8 text-center text-text-dim font-mono text-sm">Loading archive…</div>
  if (error) return <div className="bg-surface border border-accent-red/40 rounded-lg p-4 text-accent-red font-mono text-sm">Archive failed: {error.message}</div>
  const entries = data?.entries || []
  const dir = data?.dir
  const pdfAvailable = data?.pdfAvailable === true

  if (entries.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-lg p-8 text-center space-y-2">
        <p className="text-text-muted text-sm">No recaps in the archive yet.</p>
        <p className="text-text-dim font-mono text-xs">
          Recaps land here daily at the dispatch time. Drop directory: {dir
            ? <code className="bg-elevated px-1.5 py-0.5 rounded">{dir}</code>
            : <span className="text-accent-red">disabled (set RECAP_FILE_DIR)</span>}
        </p>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="h-1 bg-accent-blue/70" />
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-accent-blue/5">
        <h3 className="text-sm font-bold text-text-primary tracking-tight">Recap Archive <span className="text-text-dim font-mono text-xs font-normal">({entries.length})</span></h3>
        <span className="text-[10px] text-text-dim font-mono">{dir}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] tabular-nums">
          <thead className="bg-base/40 text-[10px] uppercase tracking-[0.1em] text-text-dim">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Date</th>
              <th className="px-3 py-2 text-right font-semibold">Net P&amp;L</th>
              <th className="px-3 py-2 text-right font-semibold">Closed</th>
              <th className="px-3 py-2 text-right font-semibold">Win %</th>
              <th className="px-3 py-2 text-left font-semibold">Largest Win</th>
              <th className="px-3 py-2 text-left font-semibold">Largest Loss</th>
              <th className="px-3 py-2 text-left font-semibold">Regime</th>
              <th className="px-3 py-2 text-left font-semibold">Flags</th>
              <th className="px-3 py-2 text-right font-semibold">Download</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <ArchiveRow key={e.date} entry={e} pdfAvailable={pdfAvailable} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ArchiveRow({ entry, pdfAvailable }) {
  const fmtMoneyShort = (n) => {
    if (n == null || !Number.isFinite(n)) return '—'
    return (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString()
  }
  const net = entry.netPnl ?? 0
  const winPct = (entry.winRate ?? 0) * 100
  return (
    <tr className="border-b border-border/40 hover:bg-elevated/40">
      <td className="px-3 py-2 font-mono font-semibold text-text-primary">{entry.date}</td>
      <td className={clsx('px-3 py-2 text-right font-mono font-semibold', net > 0 ? 'text-accent-green' : net < 0 ? 'text-accent-red' : 'text-text-muted')}>
        {fmtMoneyShort(net)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-text-muted">{entry.nClosed ?? 0}</td>
      <td className={clsx('px-3 py-2 text-right font-mono', winPct >= 50 ? 'text-accent-green' : winPct >= 30 ? 'text-accent-amber' : 'text-accent-red')}>
        {winPct.toFixed(0)}%
      </td>
      <td className="px-3 py-2 font-mono text-text-muted">{entry.largestWinSymbol || '—'}</td>
      <td className="px-3 py-2 font-mono text-text-muted">{entry.largestLossSymbol || '—'}</td>
      <td className="px-3 py-2 font-mono text-text-dim">{entry.regime || '—'}</td>
      <td className="px-3 py-2">
        {entry.oneTradeCarriesBook && (
          <span className="inline-block text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded bg-accent-red/15 text-accent-red" title="One trade carried the book on this day">
            CARRY
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1">
          {entry.formats?.pdf && pdfAvailable && (
            <a
              href={recapArchiveUrl(entry.date, 'pdf')}
              download
              className="px-1.5 py-0.5 text-[10px] font-mono bg-accent-red/15 text-accent-red rounded hover:bg-accent-red/25"
              title="Download PDF"
            >
              PDF
            </a>
          )}
          {entry.formats?.html && (
            <a
              href={recapArchiveUrl(entry.date, 'html')}
              target="_blank"
              rel="noopener noreferrer"
              className="px-1.5 py-0.5 text-[10px] font-mono bg-elevated text-text-muted rounded hover:text-text-primary"
              title="Open HTML"
            >
              HTML
            </a>
          )}
          {entry.formats?.md && (
            <a
              href={recapArchiveUrl(entry.date, 'md')}
              download
              className="px-1.5 py-0.5 text-[10px] font-mono bg-elevated text-text-muted rounded hover:text-text-primary"
              title="Download Markdown"
            >
              MD
            </a>
          )}
        </div>
      </td>
    </tr>
  )
}

// Delivery status strip — shows what the dispatcher is wired to. Reads the
// /api/recap/status endpoint so the operator can see at a glance whether
// the markdown will land on disk + whether email will go out.
function DeliveryStatusStrip() {
  const { data } = useQuery({
    queryKey: ['recap-status'],
    queryFn: getRecapStatus,
    staleTime: 60_000,
  })
  if (!data) return null
  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap text-[10px] font-mono text-text-dim">
      <span className="uppercase tracking-wide">Daily dispatch:</span>
      <span>fires at <span className="text-text-primary">{data.dispatchTimeEt} ET</span></span>
      <span>·</span>
      <span>
        file →{' '}
        {data.fileDir ? <span className="text-accent-green">{data.fileDir}</span> : <span className="text-text-dim">disabled</span>}
      </span>
      <span>·</span>
      <span>
        email →{' '}
        {data.emailConfigured
          ? <span className="text-accent-green">{data.emailTo.join(', ')}</span>
          : <span className="text-text-dim">not configured (set SMTP_HOST + RECAP_EMAIL_TO)</span>}
      </span>
    </div>
  )
}

function DispatchButton({ date }) {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState(null)
  async function go() {
    if (!confirm('Run the dispatcher now? Drops markdown to disk and sends email (if SMTP configured).')) return
    setBusy(true); setFeedback(null)
    try {
      const result = await dispatchRecap(date)
      setFeedback({ ok: true, text: `Dispatched. ${result.filePath ? `File: ${result.filePath}.` : ''} ${result.emailSent ? 'Email attempted.' : 'Email skipped.'}` })
    } catch (err) {
      setFeedback({ ok: false, text: err.message })
    }
    setBusy(false)
  }
  return (
    <>
      <button
        onClick={go}
        disabled={busy}
        className="px-3 py-1.5 text-xs font-mono bg-accent-blue/15 text-accent-blue border border-accent-blue/40 rounded hover:bg-accent-blue/25 disabled:opacity-40"
        title="Dispatch the recap now — drops markdown + sends email"
      >
        {busy ? '…' : '🚀 Dispatch now'}
      </button>
      {feedback && (
        <span className={clsx('text-[10px] font-mono', feedback.ok ? 'text-accent-green' : 'text-accent-red')}>
          {feedback.text}
        </span>
      )}
    </>
  )
}

// -- Surface ---------------------------------------------------------------
function RecapSurface({ report }) {
  const { meta, headline, honestStats, marketSummary, trades, agentActivity, sectorBreakdown, news, notesToInvestigate } = report
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden print-surface">
      {/* Header band */}
      <div className="h-1 bg-accent-blue/70" />
      <div className="px-5 py-4 border-b border-border bg-accent-blue/5">
        <h3 className="text-base font-bold text-text-primary tracking-tight">
          {meta.type === 'daily' ? 'Daily Recap' : 'Trading Report Card'}
          <span className="ml-2 text-xs text-text-dim font-mono font-normal">— {meta.period.label}</span>
        </h3>
        <p className="text-[10px] text-text-dim font-mono mt-1">
          Honest-stats discipline: numbers as observed, not flattered. Findings flagged 🔴 act on; 🟡 worth checking; 🟢 validation.
        </p>
      </div>

      <div className="p-5 space-y-5">
        <HeadlineBlock meta={meta} headline={headline} />
        <HonestStatsBlock stats={honestStats} />
        {marketSummary.indexes?.length > 0 && <MarketBlock summary={marketSummary} />}
        {sectorBreakdown?.length > 0 && <SectorBlock rows={sectorBreakdown} />}
        {trades.opens.length > 0 && <TradesOpenedBlock rows={trades.opens} />}
        {trades.closes.length > 0 && <TradesClosedBlock rows={trades.closes} />}
        <AgentActivityBlock activity={agentActivity} />
        {news.headlines?.length > 0 && <NewsBlock headlines={news.headlines} />}
        {notesToInvestigate?.length > 0 && <InvestigateBlock notes={notesToInvestigate} />}
      </div>
    </div>
  )
}

const fmtMoney = (n) => {
  if (n == null || !Number.isFinite(n)) return '—'
  return (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString()
}
const fmtPct = (n, d = 2) => {
  if (n == null || !Number.isFinite(n)) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(d) + '%'
}
const fmtTimeET = (iso) => {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }) + ' ET'
  } catch { return iso }
}

function HeadlineBlock({ meta, headline }) {
  const net = headline.netPnl
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat label="Portfolio" big value={fmtMoney(meta.portfolioValue)} sub={meta.portfolioStartValue ? `from ${fmtMoney(meta.portfolioStartValue)}` : null} />
      <Stat
        label="Net P&L"
        big
        value={fmtMoney(net)}
        valueColor={net > 0 ? 'text-accent-green' : net < 0 ? 'text-accent-red' : 'text-text-muted'}
        sub={headline.portfolioPct != null ? fmtPct(headline.portfolioPct) : null}
      />
      <Stat label="Closed" big value={String(headline.nClosed)} sub={`${headline.nWins}W / ${headline.nLosses}L · ${(headline.winRate * 100).toFixed(0)}%`} />
      <Stat label="Opened" big value={String(headline.nOpened)} sub={headline.bestSetup ? `best pool: ${headline.bestSetup.pool}` : null} />

      {(headline.largestWin || headline.largestLoss) && (
        <div className="col-span-2 md:col-span-4 grid grid-cols-1 md:grid-cols-2 gap-2 mt-1">
          {headline.largestWin && (
            <div className="bg-elevated/40 border border-accent-green/30 rounded p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-text-dim font-mono">Largest win</p>
              <p className="font-mono text-sm">
                <span className="font-bold text-text-primary">{headline.largestWin.symbol}</span>
                {' '}
                <span className="text-accent-green">+{fmtMoney(headline.largestWin.pnl)}</span>
                {' '}
                <span className="text-text-dim">via {headline.largestWin.exitReason}</span>
                {headline.largestWin.holdMin != null && <span className="text-text-dim"> · {headline.largestWin.holdMin}m hold</span>}
              </p>
            </div>
          )}
          {headline.largestLoss && (
            <div className="bg-elevated/40 border border-accent-red/30 rounded p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-text-dim font-mono">Largest loss</p>
              <p className="font-mono text-sm">
                <span className="font-bold text-text-primary">{headline.largestLoss.symbol}</span>
                {' '}
                <span className="text-accent-red">{fmtMoney(headline.largestLoss.pnl)}</span>
                {' '}
                <span className="text-text-dim">via {headline.largestLoss.exitReason}</span>
                {headline.largestLoss.holdMin != null && <span className="text-text-dim"> · {headline.largestLoss.holdMin}m hold</span>}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, big, valueColor }) {
  return (
    <div className="bg-elevated/40 border border-border rounded p-3">
      <p className="text-[10px] uppercase tracking-wide text-text-dim font-mono">{label}</p>
      <p className={clsx('font-mono font-bold mt-1', big ? 'text-lg' : 'text-sm', valueColor || 'text-text-primary')}>{value}</p>
      {sub && <p className="text-[10px] text-text-dim font-mono mt-0.5">{sub}</p>}
    </div>
  )
}

function HonestStatsBlock({ stats }) {
  return (
    <Section title="Honest P&L">
      <div className="grid grid-cols-2 gap-2">
        <StatTable
          rows={[
            ['n', stats.raw.n],
            ['Win %', `${(stats.raw.winRate * 100).toFixed(0)}%`],
            ['Net', <span key="n" className={stats.raw.net >= 0 ? 'text-accent-green' : 'text-accent-red'}>{fmtMoney(stats.raw.net)}</span>],
            ['Profit Factor', stats.raw.profitFactor != null ? stats.raw.profitFactor.toFixed(2) : 'inf'],
          ]}
          header="Raw"
        />
        <StatTable
          rows={[
            ['n', stats.robust.n],
            ['Win %', `${(stats.robust.winRate * 100).toFixed(0)}%`],
            ['Net', <span key="n" className={stats.robust.net >= 0 ? 'text-accent-green' : 'text-accent-red'}>{fmtMoney(stats.robust.net)}</span>],
            ['Profit Factor', stats.robust.profitFactor != null ? stats.robust.profitFactor.toFixed(2) : 'inf'],
          ]}
          header="Robust (outliers stripped)"
        />
      </div>
      {stats.outliers?.length > 0 && (
        <p className="text-[11px] font-mono text-text-dim mt-2">
          <span className="uppercase tracking-wide">Outliers stripped:</span>{' '}
          {stats.outliers.map((o) => (
            <span key={`${o.symbol}-${o.pnl}`} className={clsx('inline-block mr-1.5 px-1.5 py-0.5 rounded', o.pnl >= 0 ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red')}>
              {o.symbol} {fmtMoney(o.pnl)}
            </span>
          ))}
        </p>
      )}
      {stats.oneTradeCarriesBook && (
        <div className="rounded border border-accent-red/40 bg-accent-red/5 p-3 mt-2">
          <p className="text-xs font-mono font-semibold text-accent-red">
            ⚠ Largest win {fmtMoney(stats.largestWin)} = {Math.round(stats.largestWinPctOfGrossProfit * 100)}% of all gross profit
          </p>
          <p className="text-[11px] font-mono text-text-muted mt-1">
            Net excluding it: <span className={stats.netExcludingLargestWin >= 0 ? 'text-accent-green' : 'text-accent-red'}>{fmtMoney(stats.netExcludingLargestWin)}</span>.
            Treat the raw net as unrepeatable.
          </p>
        </div>
      )}
      {(Object.keys(stats.byClass).length > 0 || Object.keys(stats.byExitReason).length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
          <BucketTable title="By asset class" map={stats.byClass} />
          <BucketTable title="By exit reason" map={stats.byExitReason} />
        </div>
      )}
    </Section>
  )
}

function StatTable({ rows, header }) {
  return (
    <div className="bg-elevated/40 border border-border rounded p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-text-dim font-mono mb-1">{header}</p>
      <div className="space-y-0.5 text-[11px] font-mono">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <span className="text-text-dim">{k}</span>
            <span className="text-text-primary">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function BucketTable({ title, map }) {
  const rows = Object.entries(map || {}).filter(([, s]) => s.n >= 2).sort(([, a], [, b]) => b.net - a.net)
  if (rows.length === 0) return null
  return (
    <div className="bg-elevated/30 border border-border rounded p-2">
      <p className="text-[10px] uppercase tracking-wide text-text-dim font-mono mb-1">{title}</p>
      <div className="space-y-1">
        {rows.map(([k, s]) => (
          <div key={k} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 text-[11px] font-mono items-center">
            <span className="text-text-primary truncate">{k}</span>
            <span className="text-text-dim w-10 text-right">n={s.n}</span>
            <span className="text-text-dim w-12 text-right">{(s.winRate * 100).toFixed(0)}%</span>
            <span className={clsx('w-20 text-right', s.net >= 0 ? 'text-accent-green' : 'text-accent-red')}>{fmtMoney(s.net)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MarketBlock({ summary }) {
  return (
    <Section title="Market Summary">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {summary.indexes.map((ix) => (
          <div key={ix.symbol} className="bg-elevated/40 border border-border rounded p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-text-dim font-mono">{ix.symbol}</p>
            <p className="font-mono font-bold text-sm text-text-primary">${ix.close.toFixed(2)}</p>
            <p className={clsx('text-[11px] font-mono', ix.changePct >= 0 ? 'text-accent-green' : 'text-accent-red')}>
              {ix.changePct >= 0 ? '▲' : '▼'} {fmtPct(ix.changePct)}
            </p>
          </div>
        ))}
      </div>
      {summary.regime && (
        <p className="text-[11px] font-mono text-text-dim mt-2">
          Regime at close (Atlas): <span className="text-accent-amber font-semibold">{summary.regime}</span>
        </p>
      )}
    </Section>
  )
}

function SectorBlock({ rows }) {
  return (
    <Section title="Sector P&L">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
        {rows.map((s) => (
          <div key={s.sector} className="grid grid-cols-[1fr_auto_auto] gap-2 text-[11px] font-mono items-center bg-elevated/30 border border-border/60 rounded px-2.5 py-1.5">
            <span className="text-text-primary">{s.sector}</span>
            <span className="text-text-dim">n={s.n}</span>
            <span className={clsx(s.totalPnl >= 0 ? 'text-accent-green' : 'text-accent-red')}>{fmtMoney(s.totalPnl)}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function TradesOpenedBlock({ rows }) {
  return (
    <Section title={`Trades Opened (${rows.length})`}>
      <div className="space-y-1.5">
        {rows.map((t) => (
          <div key={t.id} className="border-l-2 border-accent-blue/50 pl-2.5 py-1 text-[11px] font-mono">
            <p>
              <span className="text-text-dim">{fmtTimeET(t.createdAt)}</span>{' — '}
              BUY {t.qty} {t.optionType ? <span className="text-accent-amber">{t.optionType.toUpperCase()}</span> : null} <span className="font-bold text-text-primary">{t.symbol}</span> @ <span className="text-text-primary">${t.entryPrice.toFixed(2)}</span>
              {' '}<span className="text-text-dim">(risk {fmtMoney(t.riskDollars)}{t.confidence != null ? ` · ${(t.confidence * 100).toFixed(0)}% conf` : ''} · pool: {t.strategyPool || 'default'})</span>
            </p>
            {t.reasoning && <p className="text-[10px] text-text-dim italic mt-0.5 leading-snug">{t.reasoning}</p>}
          </div>
        ))}
      </div>
    </Section>
  )
}

function TradesClosedBlock({ rows }) {
  return (
    <Section title={`Trades Closed (${rows.length})`}>
      <div className="space-y-1">
        {rows.map((t) => (
          <div key={t.id} className="grid grid-cols-[auto_1fr_auto_auto] gap-2 items-center text-[11px] font-mono border-l-2 border-border pl-2.5 py-1">
            <span>{t.pnl > 0 ? '🟢' : t.pnl < 0 ? '🔴' : '⚪'}</span>
            <span>
              <span className="text-text-dim">{fmtTimeET(t.closedAt)}</span>{' — '}
              SOLD {t.qty} {t.optionType ? <span className="text-accent-amber">{t.optionType.toUpperCase()}</span> : null} <span className="font-bold text-text-primary">{t.symbol}</span>{' '}
              @ ${t.exitPrice != null ? t.exitPrice.toFixed(2) : '—'}
              <span className="text-text-dim"> · {t.holdMinutes != null ? (t.holdMinutes >= 60 ? `${(t.holdMinutes / 60).toFixed(1)}h` : `${t.holdMinutes}m`) : '?'} · exit: {t.exitReason}</span>
            </span>
            <span className={clsx(t.pnl >= 0 ? 'text-accent-green' : 'text-accent-red')}>{fmtMoney(t.pnl)}</span>
            <span className={clsx('text-[10px]', t.pnl >= 0 ? 'text-accent-green' : 'text-accent-red')}>{fmtPct(t.pnlPct)}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function AgentActivityBlock({ activity }) {
  const skipPairs = Object.entries(activity.skipReasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
  return (
    <Section title="Agent Activity">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Cycles run" value={String(activity.cyclesRun)} />
        <Stat label="Raw decisions" value={String(activity.decisionsRaw)} />
        <Stat label="Executed" value={String(activity.decisionsExecuted)} valueColor="text-accent-green" />
        <Stat label="LLM cost" value={fmtMoney(activity.llmCost)} />
      </div>
      {skipPairs.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wide text-text-dim font-mono mb-1">Skip reasons</p>
          <div className="flex flex-wrap gap-1">
            {skipPairs.map(([reason, n]) => (
              <span key={reason} className="text-[10px] font-mono bg-elevated/60 border border-border rounded px-1.5 py-0.5 text-text-muted">
                {reason} <span className="text-text-dim">×{n}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </Section>
  )
}

function NewsBlock({ headlines }) {
  return (
    <Section title="News Highlights">
      <ul className="space-y-1.5">
        {headlines.slice(0, 6).map((h, i) => (
          <li key={i} className="text-[11px] font-mono text-text-muted">
            <span className="text-text-primary">{h.source}</span> — {h.url ? (
              <a href={h.url} target="_blank" rel="noopener noreferrer" className="hover:text-accent-blue">{h.headline}</a>
            ) : h.headline}
            {h.symbols?.length > 0 && (
              <span className="text-text-dim"> [{h.symbols.slice(0, 4).join(', ')}]</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}

function InvestigateBlock({ notes }) {
  return (
    <Section title="What to Investigate Next">
      <div className="space-y-1.5">
        {notes.map((n, i) => (
          <div
            key={i}
            className={clsx(
              'rounded border p-2',
              n.severity === 'red' ? 'border-accent-red/40 bg-accent-red/5' :
              n.severity === 'amber' ? 'border-accent-amber/40 bg-accent-amber/5' :
              n.severity === 'green' ? 'border-accent-green/40 bg-accent-green/5' :
              'border-border bg-elevated/30',
            )}
          >
            <p className={clsx(
              'text-[11px] font-mono leading-snug',
              n.severity === 'red' ? 'text-accent-red' :
              n.severity === 'amber' ? 'text-accent-amber' :
              n.severity === 'green' ? 'text-accent-green' :
              'text-text-muted',
            )}>
              {n.severity === 'red' ? '🔴 ' : n.severity === 'amber' ? '🟡 ' : n.severity === 'green' ? '🟢 ' : '• '}
              {n.text}
            </p>
          </div>
        ))}
      </div>
    </Section>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-text-primary tracking-tight uppercase mb-2 border-b border-border/40 pb-1">{title}</h4>
      {children}
    </div>
  )
}
