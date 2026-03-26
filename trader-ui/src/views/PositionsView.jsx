import PositionsTable from '../components/positions/PositionsTable'

export default function PositionsView() {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Open Positions</h2>
      <PositionsTable />
    </div>
  )
}
