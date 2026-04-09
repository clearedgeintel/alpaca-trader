import { useState, useRef, useEffect } from 'react'
import { askChat } from '../api/client'

const SUGGESTED_QUESTIONS = [
  "What's my portfolio value and buying power?",
  "Show me the most active stocks right now",
  "What's the current price of NVDA?",
  "Show my recent trade history",
  "What regime is the market in?",
  "What are the top movers today?",
  "How are my agents performing?",
  "Show my P&L for the past week",
]

function newSessionId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export default function ChatView() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionId, setSessionId] = useState(newSessionId)
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
        tokens: result.tokensUsed,
        toolCalls: result.toolCalls || [],
      }])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'error', text: `Error: ${err.message}` }])
    }

    setLoading(false)
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Trading Assistant</h2>
          <p className="text-xs text-text-muted">
            Ask questions, get live quotes, check positions, or place trades. Powered by Claude + Alpaca API.
          </p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={() => { setMessages([]); setSessionId(newSessionId()) }}
            className="text-xs text-text-dim hover:text-text-muted transition-colors px-2 py-1 rounded border border-border hover:border-text-dim"
          >
            Clear chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2">
        {messages.length === 0 && (
          <div className="text-center py-12">
            <p className="text-text-muted text-sm mb-4">Try asking:</p>
            <div className="flex flex-wrap gap-2 justify-center max-w-2xl mx-auto">
              {SUGGESTED_QUESTIONS.map(q => (
                <button
                  key={q}
                  onClick={() => handleSend(q)}
                  className="px-3 py-1.5 bg-elevated border border-border rounded text-xs text-text-muted hover:text-text-primary hover:border-accent-blue transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] rounded-lg px-4 py-3 ${
              msg.role === 'user'
                ? 'bg-accent-blue/20 border border-accent-blue/30 text-text-primary'
                : msg.role === 'error'
                ? 'bg-accent-red/10 border border-accent-red/30 text-accent-red'
                : 'bg-surface border border-border text-text-primary'
            }`}>
              <div className="text-sm whitespace-pre-wrap">{msg.text}</div>

              {/* Tool calls badge */}
              {msg.toolCalls?.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <div className="flex flex-wrap gap-1">
                    {msg.toolCalls.map((tc, j) => (
                      <span
                        key={j}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono ${
                          tc.success
                            ? 'bg-accent-green/10 text-accent-green border border-accent-green/20'
                            : 'bg-accent-red/10 text-accent-red border border-accent-red/20'
                        }`}
                        title={tc.error || JSON.stringify(tc.input)}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${tc.success ? 'bg-accent-green' : 'bg-accent-red'}`} />
                        {tc.tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {msg.tokens && (
                <div className="text-xs text-text-dim mt-2 text-right">{msg.tokens.toLocaleString()} tokens</div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-surface border border-border rounded-lg px-4 py-3">
              <div className="flex items-center gap-2 text-text-muted text-sm">
                <span className="w-2 h-2 rounded-full bg-accent-blue animate-pulse" />
                Thinking...
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="Ask about your portfolio, get quotes, or place trades..."
          className="flex-1 bg-surface border border-border rounded-lg px-4 py-2.5 text-sm text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue"
          disabled={loading}
        />
        <button
          onClick={() => handleSend()}
          disabled={loading || !input.trim()}
          className="px-5 py-2.5 bg-accent-blue text-white text-sm font-medium rounded-lg hover:bg-accent-blue/80 disabled:opacity-40 transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  )
}
