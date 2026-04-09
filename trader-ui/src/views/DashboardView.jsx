import { useState, useRef, useEffect } from 'react'
import clsx from 'clsx'
import StatCard from '../components/shared/StatCard'
import PortfolioChart from '../components/dashboard/PortfolioChart'
import ActivityFeed from '../components/dashboard/ActivityFeed'
import { LoadingCards } from '../components/shared/LoadingState'
import { usePerformance, useAllTrades, useOpenTrades, useMarketTickers, useMarketNews } from '../hooks/useQueries'
import { askChat } from '../api/client'
import { isToday, isThisWeek, parseISO, formatDistanceToNow } from 'date-fns'

function newSessionId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export default function DashboardView() {
  const { data: performance, isLoading: perfLoading } = usePerformance()
  const { data: allTrades, isLoading: tradesLoading } = useAllTrades()
  const { data: openTrades } = useOpenTrades()

  const isLoading = perfLoading || tradesLoading
  const stats = computeStats(performance, allTrades, openTrades)

  return (
    <div className="space-y-6">
      {/* Market Ticker Bar */}
      <MarketTickers />

      {isLoading ? (
        <LoadingCards count={4} />
      ) : (
        <div className="grid grid-cols-4 gap-4">
          <StatCard
            label="Today's P&L"
            value={stats.todayPnl != null ? `${stats.todayPnl >= 0 ? '+' : '-'}$${Math.abs(stats.todayPnl).toFixed(2)}` : '$0.00'}
            delta={stats.yesterdayPnl != null ? `vs $${stats.yesterdayPnl.toFixed(2)} yesterday` : null}
            trend={stats.todayPnl > 0 ? 'up' : stats.todayPnl < 0 ? 'down' : 'neutral'}
          />
          <StatCard
            label="Win Rate"
            value={`${stats.winRate.toFixed(1)}%`}
            delta={stats.weekWinRate != null ? `${stats.weekWinRate.toFixed(1)}% last 7d` : null}
            trend={stats.winRate >= 50 ? 'up' : 'down'}
          />
          <StatCard
            label="Open Positions"
            value={String(stats.openCount)}
          />
          <StatCard
            label="Total Trades"
            value={String(stats.totalTrades)}
            delta={`${stats.weekTrades} this week`}
            trend="neutral"
          />
        </div>
      )}

      {/* Two-column layout: chart + chat */}
      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-3">
          <PortfolioChart />
        </div>
        <div className="col-span-2">
          <MiniChat />
        </div>
      </div>

      {/* News + Activity */}
      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-3">
          <NewsFeed />
        </div>
        <div className="col-span-2">
          <ActivityFeed />
        </div>
      </div>
    </div>
  )
}

const TICKER_LABELS = { SPY: 'S&P 500', QQQ: 'Nasdaq 100', IWM: 'Russell 2000', DIA: 'Dow 30' }

function MarketTickers() {
  const { data: tickers } = useMarketTickers()

  if (!tickers?.length) {
    return (
      <div className="flex gap-4">
        {['SPY', 'QQQ', 'IWM', 'DIA'].map(s => (
          <div key={s} className="flex-1 bg-surface border border-border rounded-lg p-3 animate-pulse">
            <div className="h-4 bg-elevated rounded w-16 mb-2" />
            <div className="h-6 bg-elevated rounded w-20" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex gap-4">
      {tickers.map(t => (
        <div key={t.symbol} className="flex-1 bg-surface border border-border rounded-lg p-3 relative overflow-hidden">
          <div className={clsx(
            'absolute inset-x-0 top-0 h-0.5',
            t.change > 0 ? 'bg-gradient-to-r from-accent-green/60 to-accent-green/0' :
            t.change < 0 ? 'bg-gradient-to-r from-accent-red/60 to-accent-red/0' :
            'bg-gradient-to-r from-accent-blue/30 to-accent-blue/0',
          )} />
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-text-dim uppercase tracking-wide">
              {TICKER_LABELS[t.symbol] || t.symbol}
            </span>
            <span className="text-[10px] font-mono text-text-dim">{t.symbol}</span>
          </div>
          <div className="flex items-end justify-between">
            <span className="font-mono text-lg font-semibold text-text-primary">
              ${t.price.toFixed(2)}
            </span>
            <span className={clsx(
              'font-mono text-xs font-medium',
              t.change > 0 ? 'text-accent-green' : t.change < 0 ? 'text-accent-red' : 'text-text-muted',
            )}>
              {t.change > 0 ? '+' : ''}{t.change.toFixed(2)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function NewsFeed() {
  const { data: news } = useMarketNews(12)

  return (
    <div className="bg-surface border border-border rounded-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">Market News</h3>
        <span className="text-[10px] text-text-dim">Alpaca News API</span>
      </div>
      <div className="divide-y divide-border max-h-[400px] overflow-y-auto">
        {!news?.length ? (
          <div className="px-4 py-8 text-center text-text-dim text-xs">Loading news...</div>
        ) : (
          news.map(article => (
            <div key={article.id} className="px-4 py-3 hover:bg-elevated/50 transition-colors">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary leading-snug mb-1">{article.headline}</p>
                  {article.summary && (
                    <p className="text-xs text-text-dim line-clamp-2 mb-1.5">{article.summary}</p>
                  )}
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-text-dim">{article.source}</span>
                    <span className="text-[10px] text-text-dim">
                      {formatDistanceToNow(parseISO(article.created_at), { addSuffix: true })}
                    </span>
                    {article.symbols?.length > 0 && (
                      <div className="flex gap-1">
                        {article.symbols.slice(0, 4).map(s => (
                          <span key={s} className="px-1.5 py-0.5 text-[9px] font-mono font-medium bg-accent-blue/10 text-accent-blue rounded">
                            {s}
                          </span>
                        ))}
                        {article.symbols.length > 4 && (
                          <span className="text-[9px] text-text-dim">+{article.symbols.length - 4}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function MiniChat() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionId] = useState(newSessionId)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend(text) {
    const question = (text || input).trim()
    if (!question || loading) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: question }])
    setLoading(true)

    try {
      const result = await askChat(question, sessionId)
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: result.answer,
        toolCalls: result.toolCalls || [],
      }])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'error', text: err.message }])
    }

    setLoading(false)
  }

  const quickQuestions = [
    "What's my portfolio status?",
    "Top movers today?",
    "Latest agent decisions?",
  ]

  return (
    <div className="bg-surface border border-border rounded-lg flex flex-col h-[350px]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-violet-500/20 to-blue-500/20 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-accent-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
          </div>
          <span className="text-xs font-semibold text-text-primary">Trading Assistant</span>
        </div>
        <a href="/chat" className="text-[10px] text-text-dim hover:text-accent-blue transition-colors">
          Open full chat &rarr;
        </a>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 && (
          <div className="flex flex-col gap-1.5 pt-4">
            {quickQuestions.map(q => (
              <button
                key={q}
                onClick={() => handleSend(q)}
                className="text-left px-3 py-2 bg-elevated border border-border rounded text-xs text-text-muted hover:text-text-primary hover:border-accent-blue/50 transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 ${
              msg.role === 'user'
                ? 'bg-accent-blue/20 border border-accent-blue/30 text-text-primary'
                : msg.role === 'error'
                ? 'bg-accent-red/10 border border-accent-red/30 text-accent-red'
                : 'bg-elevated border border-border text-text-primary'
            }`}>
              <div className="text-xs whitespace-pre-wrap leading-relaxed">{msg.text}</div>
              {msg.toolCalls?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {msg.toolCalls.map((tc, j) => (
                    <span key={j} className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono ${
                      tc.success ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'
                    }`}>
                      <span className={`w-1 h-1 rounded-full ${tc.success ? 'bg-accent-green' : 'bg-accent-red'}`} />
                      {tc.tool}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-elevated border border-border rounded-lg px-3 py-2">
              <div className="flex items-center gap-1.5 text-text-muted text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse" />
                Thinking...
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2 px-3 pb-3">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="Ask anything..."
          className="flex-1 bg-elevated border border-border rounded px-3 py-2 text-xs text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue"
          disabled={loading}
        />
        <button
          onClick={() => handleSend()}
          disabled={loading || !input.trim()}
          className="px-3 py-2 bg-accent-blue text-white text-xs font-medium rounded hover:bg-accent-blue/80 disabled:opacity-40 transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  )
}

function computeStats(performance, allTrades, openTrades) {
  const trades = allTrades || []
  const perf = performance || []

  const closedTrades = trades.filter(t => t.status === 'closed')
  const todayTrades = closedTrades.filter(t => t.closed_at && isToday(parseISO(t.closed_at)))
  const weekTrades = closedTrades.filter(t => t.closed_at && isThisWeek(parseISO(t.closed_at)))

  const todayPnl = todayTrades.reduce((sum, t) => sum + Number(t.pnl || 0), 0)

  const todayPerf = perf.find(p => isToday(parseISO(p.trade_date)))
  const sorted = [...perf].sort((a, b) => b.trade_date.localeCompare(a.trade_date))
  const yesterdayPerf = sorted.length > 1 ? sorted[1] : null
  const yesterdayPnl = yesterdayPerf ? Number(yesterdayPerf.total_pnl || 0) : null

  const wins = closedTrades.filter(t => Number(t.pnl || 0) > 0).length
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0

  const weekWins = weekTrades.filter(t => Number(t.pnl || 0) > 0).length
  const weekWinRate = weekTrades.length > 0 ? (weekWins / weekTrades.length) * 100 : null

  return {
    todayPnl: todayTrades.length > 0 ? todayPnl : (todayPerf ? Number(todayPerf.total_pnl) : 0),
    yesterdayPnl,
    winRate,
    weekWinRate,
    openCount: openTrades?.length || 0,
    totalTrades: trades.length,
    weekTrades: weekTrades.length,
  }
}
