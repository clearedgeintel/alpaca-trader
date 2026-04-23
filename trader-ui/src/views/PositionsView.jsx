import PositionsTable from '../components/positions/PositionsTable'

export default function PositionsView() {
  return (
    <div>
      <h2 className="text-base md:text-lg font-semibold mb-3 md:mb-4">Open Positions</h2>
      <PositionsTable />
    </div>
  )
}
