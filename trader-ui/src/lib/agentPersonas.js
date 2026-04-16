// Agent personas — human names, avatars, and accent colors
// The key matches the agent.name returned by the API
const AGENT_PERSONAS = {
  'market-screener': {
    displayName: 'Scout',
    title: 'Market Screener',
    avatar: 'S',
    color: 'accent-blue',
    gradient: 'from-blue-500/20 to-cyan-500/20',
    borderColor: 'border-blue-500/30',
  },
  'risk-manager': {
    displayName: 'Vega',
    title: 'Risk Manager',
    avatar: 'V',
    color: 'accent-red',
    gradient: 'from-red-500/20 to-orange-500/20',
    borderColor: 'border-red-500/30',
  },
  'market-regime': {
    displayName: 'Atlas',
    title: 'Market Regime',
    avatar: 'A',
    color: 'accent-amber',
    gradient: 'from-amber-500/20 to-yellow-500/20',
    borderColor: 'border-amber-500/30',
  },
  'technical-analysis': {
    displayName: 'Quant',
    title: 'Technical Analyst',
    avatar: 'Q',
    color: 'accent-green',
    gradient: 'from-green-500/20 to-emerald-500/20',
    borderColor: 'border-green-500/30',
  },
  'news-sentinel': {
    displayName: 'Herald',
    title: 'News Sentinel',
    avatar: 'H',
    color: 'accent-blue',
    gradient: 'from-indigo-500/20 to-blue-500/20',
    borderColor: 'border-indigo-500/30',
  },
  orchestrator: {
    displayName: 'Nexus',
    title: 'Orchestrator',
    avatar: 'N',
    color: 'accent-blue',
    gradient: 'from-violet-500/20 to-purple-500/20',
    borderColor: 'border-violet-500/30',
  },
  execution: {
    displayName: 'Striker',
    title: 'Execution Agent',
    avatar: 'X',
    color: 'accent-green',
    gradient: 'from-emerald-500/20 to-green-500/20',
    borderColor: 'border-emerald-500/30',
  },
  'breakout-agent': {
    displayName: 'Rupture',
    title: 'Breakout Agent',
    avatar: 'R',
    color: 'accent-amber',
    gradient: 'from-orange-500/20 to-amber-500/20',
    borderColor: 'border-orange-500/30',
  },
  'mean-reversion': {
    displayName: 'Bounce',
    title: 'Mean-Reversion Agent',
    avatar: 'B',
    color: 'accent-blue',
    gradient: 'from-cyan-500/20 to-blue-500/20',
    borderColor: 'border-cyan-500/30',
  },
}

const DEFAULT_PERSONA = {
  displayName: 'Agent',
  title: 'Agent',
  avatar: '?',
  color: 'text-muted',
  gradient: 'from-gray-500/20 to-gray-600/20',
  borderColor: 'border-gray-500/30',
}

export function getPersona(agentName) {
  return AGENT_PERSONAS[agentName] || { ...DEFAULT_PERSONA, displayName: agentName, title: agentName }
}

export default AGENT_PERSONAS
