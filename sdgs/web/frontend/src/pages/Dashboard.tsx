import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { Database, FileText, Cpu, Zap, Clock, Gauge, Activity, BarChart3 } from 'lucide-react'
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

const PIE_COLORS = [
  '#22C55E', '#3B82F6', '#F59E0B', '#A78BFA', '#F43F5E',
  '#06B6D4', '#F97316', '#4ADE80', '#818CF8', '#FB7185',
  '#2DD4BF', '#FBBF24', '#60A5FA', '#C084FC', '#34D399',
  '#38BDF8', '#FB923C', '#F87171',
]

interface StatCardProps {
  icon: typeof Database
  label: string
  value: string
  sub: string
  gradient: string
  iconColor: string
  glowColor: string
}

function StatCard({ icon: Icon, label, value, sub, gradient, iconColor, glowColor }: StatCardProps) {
  return (
    <div
      style={{
        background: 'rgba(15, 23, 42, 0.5)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        borderRadius: '16px',
        padding: '24px 22px',
        position: 'relative',
        overflow: 'hidden',
        cursor: 'default',
        transition: 'all 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget
        el.style.borderColor = 'rgba(255,255,255,0.12)'
        el.style.transform = 'translateY(-3px)'
        el.style.boxShadow = `0 16px 48px rgba(0,0,0,0.4), 0 0 30px ${glowColor}`
      }}
      onMouseLeave={e => {
        const el = e.currentTarget
        el.style.borderColor = 'rgba(255,255,255,0.06)'
        el.style.transform = 'translateY(0)'
        el.style.boxShadow = 'none'
      }}
    >
      {/* Corner glow */}
      <div style={{
        position: 'absolute',
        top: '-30px',
        right: '-30px',
        width: '100px',
        height: '100px',
        background: `radial-gradient(circle, ${glowColor}, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      {/* Inner top highlight */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: '1px',
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)',
      }} />

      <div style={{
        width: '42px',
        height: '42px',
        borderRadius: '13px',
        background: gradient,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: '18px',
        boxShadow: `0 4px 14px ${glowColor}`,
      }}>
        <Icon size={20} color="#fff" strokeWidth={2} />
      </div>

      <div style={{
        fontSize: '28px',
        fontWeight: 700,
        color: '#fff',
        letterSpacing: '-0.04em',
        lineHeight: 1,
        marginBottom: '6px',
        fontFeatureSettings: '"tnum"',
      }}>
        {value}
      </div>
      <div style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500 }}>
        {label}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
        {sub}
      </div>
    </div>
  )
}

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
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <div className="spinner" style={{ width: 32, height: 32 }} />
      </div>
    )
  }

  if (!stats) {
    return <div className="empty-state"><h3>Unable to load stats</h3></div>
  }

  const tokenChartData = stats.per_dataset.map((d) => ({
    name: d.topic.length > 18 ? d.topic.slice(0, 15) + '...' : d.topic,
    prompt: d.prompt_tokens,
    completion: d.completion_tokens,
  }))

  const qaPieData = stats.per_dataset
    .filter((d) => d.qa_pairs > 0)
    .map((d) => ({
      name: d.topic.length > 16 ? d.topic.slice(0, 13) + '...' : d.topic,
      value: d.qa_pairs,
    }))

  const paperTopicData = (stats.paper_by_topic || [])
    .map((t) => ({
      name: t.topic.length > 25 ? t.topic.slice(0, 22) + '...' : t.topic,
      fullName: t.topic,
      value: t.count,
    }))

  const tooltipStyle = {
    background: 'rgba(8, 12, 28, 0.92)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '12px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
    backdropFilter: 'blur(20px)',
    fontSize: '12px',
    padding: '12px 16px',
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '36px' }}>
        <h1 style={{
          fontSize: '32px',
          fontWeight: 800,
          letterSpacing: '-0.04em',
          lineHeight: 1.1,
          marginBottom: '8px',
        }}>
          <span style={{
            background: 'linear-gradient(135deg, #4ADE80 0%, #8B5CF6 50%, #F97316 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}>
            Dashboard
          </span>
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '15px', fontWeight: 400 }}>
          Overview of your training pipeline
        </p>
      </div>

      {/* Stats Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '16px',
        marginBottom: '32px',
      }}>
        <StatCard
          icon={Database} label="QA Datasets" value={String(stats.dataset_count)}
          sub={`${stats.completed_datasets} completed`}
          gradient="linear-gradient(135deg, #4ADE80, #22C55E)" iconColor="#4ADE80" glowColor="rgba(74,222,128,0.15)"
        />
        <StatCard
          icon={BarChart3} label="QA Pairs" value={formatNumber(stats.total_qa_pairs)}
          sub="total generated"
          gradient="linear-gradient(135deg, #8B5CF6, #7C3AED)" iconColor="#8B5CF6" glowColor="rgba(139,92,246,0.15)"
        />
        <StatCard
          icon={FileText} label="Papers" value={formatNumber(stats.paper_count)}
          sub="in library"
          gradient="linear-gradient(135deg, #F97316, #EA580C)" iconColor="#F97316" glowColor="rgba(249,115,22,0.15)"
        />
        <StatCard
          icon={Cpu} label="Training Runs" value={String(stats.training_count)}
          sub="total"
          gradient="linear-gradient(135deg, #4ADE80, #8B5CF6)" iconColor="#4ADE80" glowColor="rgba(74,222,128,0.12)"
        />
        <StatCard
          icon={Zap} label="Total Tokens" value={formatNumber(stats.total_tokens)}
          sub={`${formatNumber(stats.total_prompt_tokens)} prompt`}
          gradient="linear-gradient(135deg, #8B5CF6, #F97316)" iconColor="#8B5CF6" glowColor="rgba(139,92,246,0.12)"
        />
        <StatCard
          icon={Gauge} label="GPU Energy" value={`${stats.total_gpu_kwh} kWh`}
          sub="estimated"
          gradient="linear-gradient(135deg, #F97316, #4ADE80)" iconColor="#F97316" glowColor="rgba(249,115,22,0.12)"
        />
        <StatCard
          icon={Clock} label="Gen Time" value={formatDuration(stats.total_generation_seconds)}
          sub="pipeline time"
          gradient="linear-gradient(135deg, #22C55E, #06B6D4)" iconColor="#22C55E" glowColor="rgba(74,222,128,0.12)"
        />
        <StatCard
          icon={Activity} label="Active Jobs" value={String(stats.running_datasets)}
          sub={`${stats.failed_datasets} failed`}
          gradient="linear-gradient(135deg, #8B5CF6, #4ADE80)" iconColor="#8B5CF6" glowColor="rgba(139,92,246,0.12)"
        />
      </div>

      {/* Charts */}
      {stats.per_dataset.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: '16px', marginBottom: '20px' }}>
          {/* Token usage */}
          <div style={{
            background: 'rgba(15, 23, 42, 0.5)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '18px',
            padding: '28px',
            position: 'relative',
            overflow: 'hidden',
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <div>
                <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>Token Usage</h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>by dataset</p>
              </div>
              <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: 'var(--text-muted)' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 3, background: '#3B82F6' }} /> Prompt
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 3, background: '#22C55E' }} /> Completion
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={tokenChartData} barCategoryGap="25%">
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#475569' }} angle={-30} textAnchor="end" height={55} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickFormatter={formatNumber} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#94A3B8', marginBottom: '6px', fontWeight: 500 }} formatter={(v: number) => formatNumber(v)} cursor={{ fill: 'rgba(0,0,0,0.3)' }} />
                <Bar dataKey="prompt" name="Prompt" stackId="tokens" fill="#3B82F6" radius={[0, 0, 0, 0]} />
                <Bar dataKey="completion" name="Completion" stackId="tokens" fill="#22C55E" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* QA Distribution -- donut */}
          <div style={{
            background: 'rgba(15, 23, 42, 0.5)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '18px',
            padding: '28px',
            position: 'relative',
            overflow: 'hidden',
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)' }} />
            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>QA Distribution</h3>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>pairs per dataset</p>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={qaPieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={65}
                  outerRadius={100}
                  paddingAngle={3}
                  strokeWidth={0}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={{ stroke: 'rgba(255,255,255,0.08)', strokeWidth: 1 }}
                  fontSize={10}
                >
                  {qaPieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${v} pairs`} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Paper topic distribution */}
      {paperTopicData.length > 0 && (
        <div style={{
          background: 'rgba(15, 23, 42, 0.5)',
          backdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '18px',
          padding: '28px',
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)' }} />
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>PDF's by Category</h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{paperTopicData.length} categories</p>
          </div>
          <ResponsiveContainer width="100%" height={Math.max(260, paperTopicData.length * 38 + 40)}>
            <BarChart data={paperTopicData} layout="vertical" margin={{ left: 10, right: 30, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: '#475569' }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="fullName" width={180} tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#fff' }} formatter={(v: number) => [`${v} papers`, 'Count']} cursor={{ fill: 'rgba(0,0,0,0.3)' }} />
              <Bar dataKey="value" name="Papers" radius={[0, 8, 8, 0]} barSize={22}>
                {paperTopicData.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
