import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('UI render failure', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="min-h-screen bg-base text-text-primary p-4 md:p-6">
        <div className="app-panel max-w-2xl p-4">
          <p className="app-section-title mb-2">Interface Error</p>
          <h1 className="text-lg font-semibold text-text-primary mb-2">The trading UI hit a rendering problem.</h1>
          <p className="text-sm text-text-muted mb-3">
            The app shell stayed online, but one screen failed to render. Refresh once; if it comes back, the issue was likely a transient data value.
          </p>
          <pre className="max-h-56 overflow-auto rounded bg-base p-3 text-xs text-accent-red font-mono whitespace-pre-wrap">
            {this.state.error?.message || String(this.state.error)}
          </pre>
        </div>
      </div>
    )
  }
}
