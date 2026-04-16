import { useState, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import clsx from 'clsx'

// Vite: import every .md file in the wiki dir as a raw string
// Keys are like "/src/wiki/getting-started.md"
const wikiModules = import.meta.glob('../wiki/*.md', { query: '?raw', import: 'default', eager: true })

const WIKI_PAGES = Object.entries(wikiModules)
  .map(([path, content]) => {
    const slug = path.split('/').pop().replace('.md', '')
    const title = deriveTitle(content) || slug
    return { slug, title, content }
  })
  .sort((a, b) => {
    // Put getting-started first, then the rest alphabetically
    const order = ['getting-started', 'dashboard', 'agents-overview', 'features', 'going-live', 'troubleshooting', 'faq']
    const ai = order.indexOf(a.slug)
    const bi = order.indexOf(b.slug)
    if (ai === -1 && bi === -1) return a.slug.localeCompare(b.slug)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })

function deriveTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : null
}

export default function HelpView() {
  const { slug } = useParams()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  const activeSlug = slug || WIKI_PAGES[0]?.slug
  const activePage = WIKI_PAGES.find((p) => p.slug === activeSlug) || WIKI_PAGES[0]

  const filteredPages = useMemo(() => {
    if (!query.trim()) return WIKI_PAGES
    const q = query.toLowerCase()
    return WIKI_PAGES.filter(
      (p) => p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q) || p.content.toLowerCase().includes(q),
    )
  }, [query])

  return (
    <div className="flex gap-6 h-[calc(100vh-180px)]">
      {/* Sidebar */}
      <aside className="w-64 flex-shrink-0 bg-surface border border-border rounded-lg p-4 overflow-y-auto">
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Help & Wiki</h2>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-sm text-text-primary placeholder-text-dim outline-none focus:border-accent-blue/50 mb-4 font-mono"
        />
        <nav className="space-y-0.5">
          {filteredPages.map((p) => (
            <button
              key={p.slug}
              onClick={() => navigate(`/help/${p.slug}`)}
              className={clsx(
                'w-full text-left px-2 py-1.5 rounded text-sm font-mono transition-colors',
                activeSlug === p.slug
                  ? 'bg-accent-blue/20 text-accent-blue'
                  : 'text-text-muted hover:text-text-primary hover:bg-elevated',
              )}
            >
              {p.title}
            </button>
          ))}
          {filteredPages.length === 0 && (
            <p className="text-xs text-text-dim px-2 py-2">No pages match "{query}"</p>
          )}
        </nav>

        <div className="mt-6 pt-4 border-t border-border text-[10px] text-text-dim space-y-1">
          <p>{WIKI_PAGES.length} pages</p>
          <p>
            Source:{' '}
            <a
              href="https://github.com/clearedgeintel/alpaca-trader/tree/main/trader-ui/src/wiki"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-blue hover:underline"
            >
              trader-ui/src/wiki
            </a>
          </p>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 bg-surface border border-border rounded-lg p-8 overflow-y-auto">
        {activePage ? (
          <article className="prose prose-invert max-w-3xl">
            <ReactMarkdown components={markdownComponents}>{activePage.content}</ReactMarkdown>
          </article>
        ) : (
          <p className="text-text-muted">No page selected.</p>
        )}
      </main>
    </div>
  )
}

// Tailwind-friendly markdown renderers — we don't want the default HTML styles
const markdownComponents = {
  h1: ({ children }) => <h1 className="text-2xl font-bold text-text-primary mb-4 mt-0">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="text-lg font-semibold text-text-primary mt-6 mb-3 pb-1 border-b border-border">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="text-base font-semibold text-text-primary mt-4 mb-2">{children}</h3>,
  p: ({ children }) => <p className="text-sm text-text-muted leading-relaxed mb-3">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 mb-3 text-sm text-text-muted space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 text-sm text-text-muted space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }) => {
    // Internal wiki links look like #/help/slug
    if (href?.startsWith('#/help/')) {
      const slug = href.replace('#/help/', '')
      return (
        <Link to={`/help/${slug}`} className="text-accent-blue hover:underline">
          {children}
        </Link>
      )
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-blue hover:underline">
        {children}
      </a>
    )
  },
  code: ({ inline, children }) =>
    inline ? (
      <code className="bg-elevated text-accent-blue px-1 py-0.5 rounded text-xs font-mono">{children}</code>
    ) : (
      <code className="block bg-elevated text-text-primary p-3 rounded text-xs font-mono overflow-x-auto whitespace-pre mb-3">
        {children}
      </code>
    ),
  pre: ({ children }) => <pre className="mb-3 overflow-x-auto">{children}</pre>,
  table: ({ children }) => (
    <div className="overflow-x-auto mb-4">
      <table className="w-full text-xs border border-border rounded overflow-hidden">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-elevated text-text-muted">{children}</thead>,
  th: ({ children }) => <th className="px-3 py-2 text-left font-semibold border-b border-border">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2 border-b border-border/40 text-text-muted">{children}</td>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-accent-blue pl-4 italic text-text-muted my-3">{children}</blockquote>
  ),
  hr: () => <hr className="border-border my-6" />,
  strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
}
