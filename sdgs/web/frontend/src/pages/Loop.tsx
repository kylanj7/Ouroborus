import { useEffect } from 'react'
import { useLoopStore } from '../store/loopStore'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import { Play, Square, RefreshCw, CheckCircle, AlertTriangle, XCircle, Clock } from 'lucide-react'

const STAGE_LABELS: Record<string, string> = {
  idle: 'Idle',
  generating: 'Generating Data',
  formatting: 'Formatting',
  transferring: 'Transferring to QFTL',
  training: 'Training Model',
  converting: 'Converting to GGUF',
  evaluating: 'Evaluating',
  analyzing: 'Analyzing Results',
}

const STOP_LABELS: Record<string, { label: string; color: string; icon: typeof CheckCircle }> = {
  TARGET_REACHED: { label: 'Target Reached', color: 'var(--accent-green)', icon: CheckCircle },
  REGRESSION_DETECTED: { label: 'Regression Detected', color: 'var(--status-failed)', icon: AlertTriangle },
  CONVERGED: { label: 'Converged (Plateau)', color: 'var(--accent-gold)', icon: Clock },
  MAX_EVOLUTIONS: { label: 'Max Evolutions', color: 'var(--accent-orange)', icon: XCircle },
  MANUAL_STOP: { label: 'Manual Stop', color: 'var(--text-secondary)', icon: Square },
  ABORTED: { label: 'Aborted', color: 'var(--status-failed)', icon: XCircle },
}

export default function Loop() {
  const { status, history, loading, error, fetchStatus, fetchHistory, start, stop, startPolling, stopPolling } = useLoopStore()

  useEffect(() => {
    fetchStatus()
    fetchHistory()
    startPolling()
    return () => stopPolling()
  }, [])

  const isRunning = status?.status === 'running'
  const evolutions = status?.evolutions ?? []
  const targetAccuracy = (status?.config_snapshot?.evolution as any)?.target_accuracy ?? 70

  const chartData = evolutions.map(e => ({
    evo: `Evo ${e.evolution}`,
    'Overall Score': +e.overall_score.toFixed(1),
    'Factual Accuracy': +e.factual_accuracy.toFixed(1),
    'Completeness': +e.completeness.toFixed(1),
    'Technical Precision': +e.technical_precision.toFixed(1),
    'Best Score': +e.best_score_so_far.toFixed(1),
  }))

  return (
    <div style={{ padding: '32px', maxWidth: 1200 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)' }}>Evolution Loop</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            Autonomous closed-loop: generate &rarr; train &rarr; evaluate &rarr; feedback
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => { fetchStatus(); fetchHistory() }} style={btnStyle('secondary')} title="Refresh">
            <RefreshCw size={16} />
          </button>
          {isRunning ? (
            <button onClick={stop} disabled={loading} style={btnStyle('danger')}>
              <Square size={16} /> Stop
            </button>
          ) : (
            <button onClick={() => start()} disabled={loading} style={btnStyle('primary')}>
              <Play size={16} /> Start Evolution
            </button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: 'rgba(255, 126, 179, 0.1)', border: '1px solid var(--status-failed)', borderRadius: 'var(--radius-sm)', marginBottom: 16, color: 'var(--status-failed)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Status Card */}
      {status && (
        <div style={cardStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 20 }}>
            <Stat label="Status" value={isRunning ? 'Running' : status.status} color={isRunning ? 'var(--status-running)' : 'var(--text-secondary)'} />
            <Stat label="Evolution" value={`${status.current_evolution} / ${(status.config_snapshot?.evolution as any)?.max_evolutions ?? '?'}`} />
            <Stat label="Stage" value={STAGE_LABELS[status.current_stage] ?? status.current_stage} color={isRunning ? 'var(--accent-cyan)' : undefined} />
            {evolutions.length > 0 && (
              <>
                <Stat label="Current Score" value={`${evolutions[evolutions.length - 1].overall_score.toFixed(1)}%`} color={evolutions[evolutions.length - 1].overall_score >= targetAccuracy ? 'var(--accent-green)' : 'var(--accent-blue)'} />
                <Stat label="Best Score" value={`${evolutions[evolutions.length - 1].best_score_so_far.toFixed(1)}%`} color="var(--accent-gold)" />
                <Stat label="Target" value={`${targetAccuracy}%`} />
              </>
            )}
            {status.stop_reason && (() => {
              const info = STOP_LABELS[status.stop_reason]
              if (!info) return <Stat label="Stop Reason" value={status.stop_reason} />
              const Icon = info.icon
              return (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Stop Reason</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: info.color, fontWeight: 600 }}>
                    <Icon size={16} /> {info.label}
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* Convergence Chart */}
      {chartData.length > 0 && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
            Convergence Chart
          </h2>
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis dataKey="evo" stroke="var(--text-muted)" fontSize={12} />
              <YAxis domain={[0, 100]} stroke="var(--text-muted)" fontSize={12} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}
                labelStyle={{ color: 'var(--text-primary)' }}
              />
              <Legend />
              <ReferenceLine y={targetAccuracy} stroke="var(--accent-green)" strokeDasharray="6 3" label={{ value: `Target ${targetAccuracy}%`, fill: 'var(--accent-green)', fontSize: 11 }} />
              <Line type="monotone" dataKey="Overall Score" stroke="var(--accent-blue)" strokeWidth={2} dot={{ r: 4 }} />
              <Line type="monotone" dataKey="Factual Accuracy" stroke="var(--accent-cyan)" strokeWidth={1} strokeDasharray="4 2" dot={false} />
              <Line type="monotone" dataKey="Completeness" stroke="var(--accent-purple)" strokeWidth={1} strokeDasharray="4 2" dot={false} />
              <Line type="monotone" dataKey="Technical Precision" stroke="var(--accent-gold)" strokeWidth={1} strokeDasharray="4 2" dot={false} />
              <Line type="monotone" dataKey="Best Score" stroke="var(--accent-green)" strokeWidth={1} strokeDasharray="2 2" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Evolution Table */}
      {evolutions.length > 0 && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
            Evolution History
          </h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  {['Evo', 'Score', 'Best', 'Delta', 'FA', 'CO', 'TP', 'Regr.', 'Plat.', 'Target'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {evolutions.map(e => (
                  <tr key={e.evolution} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={cellStyle}>{e.evolution}</td>
                    <td style={{ ...cellStyle, color: 'var(--accent-blue)', fontWeight: 600 }}>{e.overall_score.toFixed(1)}</td>
                    <td style={{ ...cellStyle, color: 'var(--accent-gold)' }}>{e.best_score_so_far.toFixed(1)}</td>
                    <td style={{ ...cellStyle, color: e.delta_from_previous >= 0 ? 'var(--accent-green)' : 'var(--status-failed)' }}>
                      {e.delta_from_previous >= 0 ? '+' : ''}{e.delta_from_previous.toFixed(1)}
                    </td>
                    <td style={cellStyle}>{e.factual_accuracy.toFixed(1)}</td>
                    <td style={cellStyle}>{e.completeness.toFixed(1)}</td>
                    <td style={cellStyle}>{e.technical_precision.toFixed(1)}</td>
                    <td style={{ ...cellStyle, color: e.consecutive_regressions > 0 ? 'var(--status-failed)' : 'var(--text-secondary)' }}>
                      {e.consecutive_regressions}
                    </td>
                    <td style={{ ...cellStyle, color: e.consecutive_plateaus > 0 ? 'var(--accent-gold)' : 'var(--text-secondary)' }}>
                      {e.consecutive_plateaus}
                    </td>
                    <td style={cellStyle}>{e.target_reached ? <CheckCircle size={14} color="var(--accent-green)" /> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Domain Breakdown */}
      {evolutions.length > 0 && Object.keys(evolutions[evolutions.length - 1].domain_scores).length > 0 && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
            Domain Scores (Latest)
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {Object.entries(evolutions[evolutions.length - 1].domain_scores).map(([domain, scores]) => (
              <div key={domain} style={{ padding: 16, background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>{domain}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div>FA: <span style={{ color: 'var(--accent-cyan)' }}>{(scores as any).factual_accuracy?.toFixed(1) ?? '-'}</span></div>
                  <div>CO: <span style={{ color: 'var(--accent-purple)' }}>{(scores as any).completeness?.toFixed(1) ?? '-'}</span></div>
                  <div>TP: <span style={{ color: 'var(--accent-gold)' }}>{(scores as any).technical_precision?.toFixed(1) ?? '-'}</span></div>
                  <div style={{ marginTop: 4, fontWeight: 600, color: 'var(--accent-blue)' }}>
                    Overall: {(scores as any).overall_score?.toFixed(1) ?? '-'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Past Loops */}
      {history.length > 0 && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
            Past Loops
          </h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                {['Loop ID', 'Status', 'Evolutions', 'Stage', 'Reason', 'Created'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.loop_id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: 12 }}>{h.loop_id}</td>
                  <td style={{ padding: '8px 12px', color: h.status === 'running' ? 'var(--status-running)' : 'var(--text-secondary)' }}>{h.status}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-primary)' }}>{h.current_evolution}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>{STAGE_LABELS[h.current_stage] ?? h.current_stage}</td>
                  <td style={{ padding: '8px 12px', color: h.stop_reason ? (STOP_LABELS[h.stop_reason]?.color ?? 'var(--text-secondary)') : 'var(--text-muted)' }}>
                    {h.stop_reason ? (STOP_LABELS[h.stop_reason]?.label ?? h.stop_reason) : '-'}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{h.created_at?.slice(0, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!status && !loading && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: 48, marginTop: 16 }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 16 }}>
            No evolution loop has been run yet. Start one to begin the autonomous training cycle.
          </p>
          <button onClick={() => start()} disabled={loading} style={btnStyle('primary')}>
            <Play size={16} /> Start First Evolution
          </button>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: color ?? 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  padding: 24,
}

const cellStyle: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'right',
  color: 'var(--text-secondary)',
}

function btnStyle(variant: 'primary' | 'secondary' | 'danger'): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    borderRadius: 'var(--radius-sm)',
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    transition: 'all 0.15s',
  }
  if (variant === 'primary') return { ...base, background: 'var(--accent-blue)', color: '#000' }
  if (variant === 'danger') return { ...base, background: 'rgba(255, 126, 179, 0.15)', color: 'var(--status-failed)', border: '1px solid var(--status-failed)' }
  return { ...base, background: 'rgba(126, 184, 255, 0.1)', color: 'var(--accent-blue)', border: '1px solid var(--border-subtle)' }
}
