import { Routes, Route } from 'react-router-dom'
import { useSocket } from './hooks/useSocket'
import Sidebar from './components/layout/Sidebar'
import TopBar from './components/layout/TopBar'
import DashboardView from './views/DashboardView'
import AgentsView from './views/AgentsView'
import DecisionsView from './views/DecisionsView'
import PositionsView from './views/PositionsView'
import TradesView from './views/TradesView'
import SignalsView from './views/SignalsView'
import AnalyticsView from './views/AnalyticsView'
import TimelineView from './views/TimelineView'
import SettingsView from './views/SettingsView'
import ChatView from './views/ChatView'
import MarketView from './views/MarketView'
import UniverseView from './views/UniverseView'
import HelpView from './views/HelpView'

export default function App() {
  useSocket()

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 ml-[220px]">
        <TopBar />
        <main className="p-6">
          <Routes>
            <Route path="/" element={<DashboardView />} />
            <Route path="/agents" element={<AgentsView />} />
            <Route path="/decisions" element={<DecisionsView />} />
            <Route path="/analytics" element={<AnalyticsView />} />
            <Route path="/timeline" element={<TimelineView />} />
            <Route path="/positions" element={<PositionsView />} />
            <Route path="/trades" element={<TradesView />} />
            <Route path="/signals" element={<SignalsView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="/chat" element={<ChatView />} />
            <Route path="/market" element={<MarketView />} />
            <Route path="/universe" element={<UniverseView />} />
            <Route path="/help" element={<HelpView />} />
            <Route path="/help/:slug" element={<HelpView />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
