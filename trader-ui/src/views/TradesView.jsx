import TradesTable from '../components/trades/TradesTable'
import ReconcileBanner from '../components/trades/ReconcileBanner'

export default function TradesView() {
  return (
    <div className="space-y-2">
      <h2 className="page-title">Trade History</h2>
      <ReconcileBanner />
      <TradesTable />
    </div>
  )
}
