import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { ClosedLoopCycle } from '../../api/client'

interface BenchmarkChartProps {
  cycles: ClosedLoopCycle[]
  targetScore: number
}

const LINE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']

export default function BenchmarkChart({ cycles, targetScore }: BenchmarkChartProps) {
  if (cycles.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 280,
          color: 'var(--text-muted)',
          fontSize: 13,
        }}
      >
        Chart will appear after the first cycle completes.
      </div>
    )
  }

  const data = cycles.map((c) => ({ cycle: c.cycle, ...c.benchmark_scores }))

  const firstScores = cycles[0].benchmark_scores
  const dynamicKeys = Object.keys(firstScores).filter((k) => k !== 'average')

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
        <XAxis
          dataKey="cycle"
          stroke="var(--text-muted)"
          fontSize={11}
          label={{ value: 'Cycle', position: 'insideBottom', offset: -2, fill: 'var(--text-muted)', fontSize: 10 }}
        />
        <YAxis
          domain={[0, 100]}
          stroke="var(--text-muted)"
          fontSize={11}
          tickFormatter={(v) => `${v}%`}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            fontSize: 12,
          }}
          labelStyle={{ color: 'var(--text-primary)', fontWeight: 600 }}
          formatter={(value: number, name: string) => [`${value.toFixed(1)}%`, name]}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <ReferenceLine
          y={targetScore}
          stroke="#ef4444"
          strokeDasharray="6 3"
          label={{ value: `Target ${targetScore}%`, fill: '#ef4444', fontSize: 10 }}
        />
        {dynamicKeys.map((key, idx) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            stroke={LINE_COLORS[idx % LINE_COLORS.length]}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        ))}
        {'average' in firstScores && (
          <Line
            type="monotone"
            dataKey="average"
            stroke="#ffffff"
            strokeWidth={3}
            strokeDasharray="6 3"
            dot={{ r: 4 }}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  )
}
