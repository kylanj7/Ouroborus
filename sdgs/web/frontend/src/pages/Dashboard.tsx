import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { getAggregateStats, AggregateStats } from '../api/client'

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

const PIE_COLORS = ['var(--accent-green)', 'var(--accent-blue)', 'var(--accent-yellow)', 'var(--accent-purple)', 'var(--accent-pink)']

export default function Dashboard() {
  const [stats, setStats] = useState<AggregateStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getAggregateStats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}><div className="spinner" /></div>
  }

  if (!stats) {
    return <div className="empty-state"><h3>Unable to load stats</h3></div>
  }

  const summaryCards = [
    { label: 'Datasets', value: String(stats.dataset_count), sub: `${stats.completed_datasets} completed` },
    { label: 'QA Pairs', value: formatNumber(stats.total_qa_pairs), sub: 'total generated' },
    { label: 'Papers', value: formatNumber(stats.paper_count), sub: 'in library' },
    { label: 'Training Runs', value: String(stats.training_count), sub: 'total' },
    { label: 'Total Tokens', value: formatNumber(stats.total_tokens), sub: `${formatNumber(stats.total_prompt_tokens)} prompt / ${formatNumber(stats.total_completion_tokens)} completion` },
    { label: 'GPU Energy', value: `${stats.total_gpu_kwh} kWh`, sub: 'estimated' },
    { label: 'Generation Time', value: formatDuration(stats.total_generation_seconds), sub: 'total pipeline time' },
    { label: 'Active Jobs', value: String(stats.running_datasets), sub: `${stats.failed_datasets} failed` },
  ]

  // Token bar chart data
  const tokenChartData = stats.per_dataset.map((d) => ({
    name: d.topic.length > 25 ? d.topic.slice(0, 22) + '...' : d.topic,
    prompt: d.prompt_tokens,
    completion: d.completion_tokens,
    qa_pairs: d.qa_pairs,
  }))

  // QA pairs pie chart data
  const qaPieData = stats.per_dataset
    .filter((d) => d.qa_pairs > 0)
    .map((d) => ({
      name: d.topic.length > 20 ? d.topic.slice(0, 17) + '...' : d.topic,
      value: d.qa_pairs,
    }))

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Aggregate usage and cost tracking</p>
      </div>

      {/* Summary cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '12px',
        marginBottom: '24px',
      }}>
        {summaryCards.map((c) => (
          <div key={c.label} className="card" style={{ padding: '14px 18px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              {c.label}
            </div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>
              {c.value}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              {c.sub}
            </div>
          </div>
        ))}
      </div>

      {/* Charts */}
      {stats.per_dataset.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '16px' }}>
          {/* Token usage bar chart */}
          <div className="card">
            <h3 style={{ fontSize: '14px', fontWeight: 500, marginBottom: '16px' }}>Token Usage by Dataset</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={tokenChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} angle={-25} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={formatNumber} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', fontSize: '12px' }}
                  labelStyle={{ color: 'var(--text-secondary)' }}
                  formatter={(v: number) => formatNumber(v)}
                />
                <Bar dataKey="prompt" name="Prompt" stackId="tokens" fill="var(--accent-blue)" />
                <Bar dataKey="completion" name="Completion" stackId="tokens" fill="var(--accent-green)" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* QA pairs distribution pie chart */}
          <div className="card">
            <h3 style={{ fontSize: '14px', fontWeight: 500, marginBottom: '16px' }}>QA Pair Distribution</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={qaPieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                  labelLine={false}
                  fontSize={11}
                >
                  {qaPieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', fontSize: '12px' }}
                  formatter={(v: number) => `${v} pairs`}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}
