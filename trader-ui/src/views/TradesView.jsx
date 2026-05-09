import TradesTable from '../components/trades/TradesTable'

export default function TradesView() {
  return (
    <div className="space-y-2">
      <h2 className="page-title">Trade History</h2>
      <TradesTable />
    </div>
  )
}
