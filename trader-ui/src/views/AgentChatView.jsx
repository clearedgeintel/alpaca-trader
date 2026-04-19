import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { getAgentMessages } from '../api/client'
import { getPersona } from '../lib/agentPersonas'

/**
 * Teams-style conversation view of every agent's thoughts, reports,
 * decisions, and debate rounds. Grouped by thread (debate rounds
 * attach to their parent orchestrator decision).
 */
export default function AgentChatView() {
  const [agentFilter, setAgentFilter] = useState(null)
  const [symbolFilter, setSymbolFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('all') // all | report | decision | debate

  const { data, isLoading } = useQuery({
    queryKey: ['agent-messages', agentFilter, symbolFilter],
    queryFn: () =>
      getAgentMessages({
        limit: 200,
        agent: agentFilter || undefined,
        symbol: symbolFilter ? symbolFilter.toUpperCase() : undefined,
      }),
    staleTime: 15_000,
    refetchInterval: 30_000,
  })

  const messages = data?.messages || []

  // Group debate rounds under their parent decision. Non-debate messages
  // stand alone as top-level "thread parents."
  const threads = useMemo(() => buildThreads(messages, typeFilter), [messages, typeFilter])

  const allAgents = [
    'market-screener',
    'risk-manager',
    'market-regime',
    'technical-analysis',
    'news-sentinel',
    'breakout-agent',
    'mean-reversion',
    'orchestrator',
  ]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Agent Conversation</h2>
        <p className="text-xs text-text-dim mt-0.5">
          Live feed of every agent's reports, decisions, and debate rounds. Grouped by decision so you can see challenges + responses together.
        </p>
      </div>

      {/* Filter bar */}
      <div className="bg-surface border border-border rounded-lg p-2 md:p-3 flex items-center gap-2 md:gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-text-dim font-mono uppercase mr-1">Type:</span>
          {[
            { k: 'all', l: 'All' },
            { k: 'report', l: 'Reports' },
            { k: 'decision', l: 'Decisions' },
            { k: 'debate', l: 'Debates' },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => setTypeFilter(t.k)}
              className={clsx(
                'px-2 py-1 text-[10px] font-mono rounded',
                typeFilter === t.k ? 'bg-accent-blue text-white' : 'bg-elevated text-text-muted hover:text-text-primary',
              )}
            >
              {t.l}
            </button>
          ))}
        </div>

        <div className="hidden md:block w-px h-5 bg-border" />

        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[10px] text-text-dim font-mono uppercase mr-1">Agent:</span>
          <button
            onClick={() => setAgentFilter(null)}
            className={clsx(
              'px-2 py-1 text-[10px] font-mono rounded',
              agentFilter === null ? 'bg-accent-blue text-white' : 'bg-elevated text-text-muted hover:text-text-primary',
            )}
          >
            All
          </button>
          {allAgents.map((a) => {
            const persona = getPersona(a)
            return (
              <button
                key={a}
                onClick={() => setAgentFilter(a)}
                className={clsx(
                  'px-2 py-1 text-[10px] font-mono rounded',
                  agentFilter === a ? 'bg-accent-blue text-white' : 'bg-elevated text-text-muted hover:text-text-primary',
                )}
              >
                {persona.displayName}
              </button>
            )
          })}
        </div>

        <div className="w-px h-5 bg-border" />

        <input
          type="text"
          placeholder="Symbol (e.g., AAPL)"
          value={symbolFilter}
          onChange={(e) => setSymbolFilter(e.target.value)}
          className="bg-elevated border border-border rounded px-2 py-1 text-xs font-mono text-text-primary placeholder-text-dim w-32 outline-none focus:border-accent-blue/50"
        />

        <span className="ml-auto text-[10px] text-text-dim font-mono">
          {messages.length} messages {data?.total > messages.length && `(of ${data.total})`}
        </span>
      </div>

      {/* Conversation */}
      <div className="bg-surface border border-border rounded-lg p-2 md:p-4 space-y-3 md:space-y-4 min-h-[300px] md:min-h-[400px]">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 bg-elevated rounded animate-pulse" />
            ))}
          </div>
        ) : threads.length === 0 ? (
          <p className="text-sm text-text-dim text-center py-12">
            No messages match your filters. Try "All" across the board, or wait for the next agent cycle.
          </p>
        ) : (
          threads.map((thread) => <Thread key={thread.parent.id} thread={thread} />)
        )}
      </div>
    </div>
  )
}

function buildThreads(messages, typeFilter) {
  // Bucket by threadId (debate rounds point at their parent decision)
  const byId = new Map()
  const parents = []
  const childrenOf = new Map()

  for (const m of messages) {
    byId.set(m.id, m)
    if (m.threadId) {
      if (!childrenOf.has(m.threadId)) childrenOf.set(m.threadId, [])
      childrenOf.get(m.threadId).push(m)
    } else {
      parents.push(m)
    }
  }

  // Apply type filter
  const filter = typeFilter
  const shouldKeep = (msg) => {
    if (filter === 'all') return true
    if (filter === 'report') return msg.type === 'report'
    if (filter === 'decision') return msg.type === 'decision'
    if (filter === 'debate') return msg.type === 'decision' || msg.type?.startsWith('debate_')
    return true
  }

  return parents
    .filter(shouldKeep)
    .map((parent) => {
      const children = (childrenOf.get(parent.id) || []).slice().sort((a, b) => a.roundIndex - b.roundIndex)
      // If filter is "debate", only include decisions that HAVE debate children
      if (filter === 'debate' && children.length === 0) return null
      return { parent, children }
    })
    .filter(Boolean)
}

function Thread({ thread }) {
  const { parent, children } = thread
  return (
    <div className="space-y-2">
      <Message msg={parent} />
      {children.length > 0 && (
        <div className="ml-4 md:ml-10 space-y-2 border-l-2 border-accent-amber/30 pl-2 md:pl-4 py-1">
          <p className="text-[9px] font-mono uppercase text-accent-amber tracking-wider">
            ⚔ Debate ({children.length / 2} round{children.length / 2 !== 1 ? 's' : ''})
          </p>
          {children.map((c) => (
            <Message key={c.id} msg={c} isDebateChild />
          ))}
        </div>
      )}
    </div>
  )
}

function Message({ msg, isDebateChild }) {
  const persona = getPersona(msg.agent)
  const typeMeta = TYPE_META[msg.type] || TYPE_META.report

  return (
    <div className={clsx('flex gap-3', isDebateChild && 'text-[13px]')}>
      <div
        className={clsx(
          'flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-xs font-mono font-bold bg-gradient-to-br',
          persona.gradient,
        )}
      >
        <span className={`text-${persona.color}`}>{persona.avatar}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className="text-sm font-semibold text-text-primary">{persona.displayName}</span>
          <span className="text-[10px] text-text-dim font-mono">{persona.title}</span>
          {msg.symbol && (
            <span className="text-[10px] font-mono bg-elevated px-1.5 py-0.5 rounded text-text-primary">{msg.symbol}</span>
          )}
          {msg.signal && msg.signal !== 'NONE' && (
            <span
              className={clsx(
                'text-[9px] font-mono font-semibold px-1.5 py-0.5 rounded',
                msg.signal === 'BUY' && 'bg-accent-green/10 text-accent-green',
                msg.signal === 'SELL' && 'bg-accent-red/10 text-accent-red',
                msg.signal === 'HOLD' && 'bg-elevated text-text-muted',
                (msg.signal === 'ACTIVE' || msg.signal === 'BULLISH' || msg.signal === 'BEARISH') &&
                  'bg-accent-blue/10 text-accent-blue',
              )}
            >
              {msg.signal}
            </span>
          )}
          {msg.confidence != null && (
            <span className="text-[10px] font-mono text-text-dim">
              conf {(msg.confidence * 100).toFixed(0)}%
            </span>
          )}
          <span className={clsx('text-[9px] font-mono font-semibold uppercase px-1.5 py-0.5 rounded', typeMeta.badgeClass)}>
            {typeMeta.label}
          </span>
          <span className="ml-auto text-[10px] text-text-dim font-mono">
            {msg.at ? formatDistanceToNow(parseISO(msg.at), { addSuffix: true }) : ''}
          </span>
        </div>
        {msg.reasoning && (
          <div className={clsx('bg-elevated rounded-lg px-3 py-2 text-text-primary leading-relaxed', isDebateChild ? 'text-xs' : 'text-sm')}>
            {msg.reasoning}
          </div>
        )}
        {msg.supporting?.length > 0 || msg.dissenting?.length > 0 ? (
          <div className="flex flex-wrap gap-1 mt-1">
            {msg.supporting?.map((a) => (
              <span key={`s-${a}`} className="text-[9px] font-mono px-1.5 py-0.5 bg-accent-green/10 text-accent-green rounded">
                +{a}
              </span>
            ))}
            {msg.dissenting?.map((a) => (
              <span key={`d-${a}`} className="text-[9px] font-mono px-1.5 py-0.5 bg-accent-red/10 text-accent-red rounded">
                -{a}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

const TYPE_META = {
  report: { label: 'Report', badgeClass: 'bg-elevated text-text-muted' },
  decision: { label: 'Decision', badgeClass: 'bg-accent-blue/20 text-accent-blue' },
  debate_challenge: { label: 'Challenge', badgeClass: 'bg-accent-red/20 text-accent-red' },
  debate_response: { label: 'Response', badgeClass: 'bg-accent-green/20 text-accent-green' },
}
