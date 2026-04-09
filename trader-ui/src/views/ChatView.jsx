import { useState, useRef, useEffect } from 'react'
import { askChat } from '../api/client'

export default function ChatView() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend() {
    const question = input.trim()
    if (!question || loading) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: question }])
    setLoading(true)

    try {
      const result = await askChat(question)
      setMessages(prev => [...prev, { role: 'assistant', text: result.answer, tokens: result.tokensUsed }])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'error', text: `Error: ${err.message}` }])
    }

    setLoading(false)
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <h2 className="text-lg font-semibold text-text-primary mb-4">Trading Assistant</h2>
      <p className="text-xs text-text-muted mb-4">
        Ask questions about your portfolio, trades, agents, strategy, or market conditions. The assistant has access to your live account data.
      </p>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2">
        {messages.length === 0 && (
          <div className="text-center py-12">
            <p className="text-text-muted text-sm mb-4">Try asking:</p>
            <div className="flex flex-wrap gap-2 justify-center">
              {[
                "What's my current P&L today?",
                "Why did we sell SOXS?",
                "What regime is the market in?",
                "Which symbols should I add to the watchlist?",
                "How is my win rate trending?",
                "What's my biggest risk right now?",
              ].map(q => (
                <button
                  key={q}
                  onClick={() => { setInput(q); }}
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
              {msg.tokens && (
                <div className="text-xs text-text-dim mt-2 text-right">{msg.tokens} tokens</div>
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
          placeholder="Ask about your portfolio, trades, or strategy..."
          className="flex-1 bg-surface border border-border rounded-lg px-4 py-2.5 text-sm text-text-primary placeholder-text-dim focus:outline-none focus:border-accent-blue"
          disabled={loading}
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="px-5 py-2.5 bg-accent-blue text-white text-sm font-medium rounded-lg hover:bg-accent-blue/80 disabled:opacity-40 transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  )
}
