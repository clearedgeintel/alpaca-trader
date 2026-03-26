import TradesTable from '../components/trades/TradesTable'

export default function TradesView() {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Trade History</h2>
      <TradesTable />
    </div>
  )
}
