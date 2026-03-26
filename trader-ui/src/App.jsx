import { Routes, Route } from 'react-router-dom'
import Sidebar from './components/layout/Sidebar'
import TopBar from './components/layout/TopBar'
import DashboardView from './views/DashboardView'
import PositionsView from './views/PositionsView'
import TradesView from './views/TradesView'
import SignalsView from './views/SignalsView'

export default function App() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 ml-[220px]">
        <TopBar />
        <main className="p-6">
          <Routes>
            <Route path="/" element={<DashboardView />} />
            <Route path="/positions" element={<PositionsView />} />
            <Route path="/trades" element={<TradesView />} />
            <Route path="/signals" element={<SignalsView />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
