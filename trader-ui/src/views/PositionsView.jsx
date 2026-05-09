import PositionsTable from '../components/positions/PositionsTable'

export default function PositionsView() {
  return (
    <div className="space-y-2">
      <h2 className="page-title">Open Positions</h2>
      <PositionsTable />
    </div>
  )
}
