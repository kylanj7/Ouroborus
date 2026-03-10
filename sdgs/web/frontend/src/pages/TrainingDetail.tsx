import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { StopCircle, FlaskConical, SlidersHorizontal, ChevronDown, ChevronRight } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useTrainingStore } from '../store/trainingStore'
import { useTrainingSSE, MetricPoint } from '../hooks/useTrainingSSE'
import { cancelTraining, getTrainingRun, updateKnobs } from '../api/client'
import { useToastStore } from '../store/toastStore'

const statusClass: Record<string, string> = {
  pending: 'badge-pending',
  running: 'badge-running',
  completed: 'badge-completed',
  failed: 'badge-failed',
  cancelled: 'badge-cancelled',
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function KnobsPanel({ runId }: { runId: number }) {
  const [open, setOpen] = useState(false)
  const [lr, setLr] = useState('')
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const handleApply = async () => {
    if (!lr.trim()) return
    setApplying(true)
    setResult(null)
    try {
      const res = await updateKnobs(runId, { learning_rate: parseFloat(lr) })
      setResult(`Applied. Current knobs: ${JSON.stringify(res.knobs)}`)
    } catch (e) {
      setResult(e instanceof Error ? e.message : 'Failed to update knobs')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: '16px' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '14px',
          fontWeight: 500,
          padding: 0,
        }}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <SlidersHorizontal size={16} />
        Adjust Training Knobs
      </button>

      {open && (
        <div style={{ marginTop: '12px', display: 'flex', alignItems: 'flex-end', gap: '12px' }}>
          <div style={{ flex: 1 }}>
            <label>Learning Rate</label>
            <input
              type="number"
              value={lr}
              onChange={(e) => setLr(e.target.value)}
              placeholder="e.g. 0.00001"
              step={0.000001}
              disabled={applying}
              style={{ fontSize: '13px' }}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={handleApply}
            disabled={applying || !lr.trim()}
            style={{ padding: '8px 16px', fontSize: '13px', flexShrink: 0 }}
          >
            {applying ? <span className="spinner" /> : 'Apply'}
          </button>
        </div>
      )}

      {open && result && (
        <div style={{
          marginTop: '8px',
          fontSize: '12px',
          color: 'var(--text-secondary)',
          background: 'var(--bg-tertiary)',
          padding: '6px 10px',
          borderRadius: 'var(--radius-sm)',
        }}>
          {result}
        </div>
      )}
    </div>
  )
}

export default function TrainingDetail() {
  const { id } = useParams<{ id: string }>()
  const runId = parseInt(id || '0')
  const navigate = useNavigate()
  const { currentRun, loading, fetchTrainingRun, updateTrainingRun } = useTrainingStore()
  const logViewerRef = useRef<HTMLDivElement>(null)

  const isRunning = currentRun?.status === 'pending' || currentRun?.status === 'running'
  const { logs, metrics, status: sseStatus, done } = useTrainingSSE(isRunning ? runId : null)

  useEffect(() => {
    fetchTrainingRun(runId)
  }, [runId])

  const addToast = useToastStore((s) => s.addToast)

  useEffect(() => {
    if (done) {
      getTrainingRun(runId).then((run) => {
        updateTrainingRun(run)
        if (run.status === 'completed') {
          addToast('success', `Training "${run.run_name}" completed`)
        } else if (run.status === 'failed') {
          addToast('error', `Training "${run.run_name}" failed`)
        }
      }).catch(() => {})
    }
  }, [done, runId])

  useEffect(() => {
    if (logViewerRef.current) {
      logViewerRef.current.scrollTop = logViewerRef.current.scrollHeight
    }
  }, [logs])

  if (loading && !currentRun) {
    return <div style={{ textAlign: 'center', padding: '40px' }}><div className="spinner" /></div>
  }

  if (!currentRun) {
    return <div className="empty-state"><h3>Training run not found</h3></div>
  }

  const stats = [
    { label: 'Base Model', value: currentRun.base_model },
    { label: 'LoRA Rank', value: String(currentRun.lora_rank) },
    { label: 'Learning Rate', value: String(currentRun.learning_rate) },
    { label: 'Epochs', value: String(currentRun.num_epochs) },
    { label: 'Batch Size', value: String(currentRun.batch_size) },
    { label: 'Final Loss', value: currentRun.final_loss != null ? currentRun.final_loss.toFixed(4) : '—' },
    { label: 'Total Steps', value: currentRun.total_steps != null ? String(currentRun.total_steps) : '—' },
    { label: 'Runtime', value: currentRun.duration_seconds > 0 ? formatDuration(currentRun.duration_seconds) : '—' },
  ]

  return (
    <div>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h1>{currentRun.run_name}</h1>
            <span className={`badge ${statusClass[currentRun.status] || 'badge-pending'}`}>
              {currentRun.status}
            </span>
          </div>
          <p>
            {currentRun.base_model}
            {currentRun.created_at && ` — ${new Date(currentRun.created_at).toLocaleString()}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {isRunning && (
            <button
              className="btn btn-danger"
              onClick={async () => {
                try {
                  await cancelTraining(runId)
                  fetchTrainingRun(runId)
                } catch { /* ignore */ }
              }}
            >
              <StopCircle size={16} />
              Cancel
            </button>
          )}
          {currentRun.status === 'completed' && (
            <button
              className="btn btn-primary"
              onClick={() => navigate(`/evaluations?training_run_id=${runId}`)}
            >
              <FlaskConical size={16} />
              Run Evaluation
            </button>
          )}
        </div>
      </div>

      {/* Stats cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '12px',
        marginBottom: '16px',
      }}>
        {stats.map((s) => (
          <div key={s.label} className="card" style={{ padding: '12px 16px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>{s.label}</div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Dataset info */}
      {currentRun.dataset_path && (
        <div className="card" style={{ marginBottom: '16px', padding: '12px 16px' }}>
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Dataset: {currentRun.dataset_path}
            {currentRun.train_samples > 0 && (
              <> — {currentRun.train_samples} train / {currentRun.val_samples} val / {currentRun.test_samples} test</>
            )}
          </span>
        </div>
      )}

      {/* Error */}
      {currentRun.error_message && (
        <div className="card" style={{
          marginBottom: '16px',
          background: 'rgba(255, 126, 179, 0.05)',
          borderColor: 'rgba(255, 126, 179, 0.2)',
        }}>
          <h3 style={{ fontSize: '14px', fontWeight: 500, color: 'var(--accent-pink)', marginBottom: '8px' }}>Error</h3>
          <pre style={{ fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
            {currentRun.error_message}
          </pre>
        </div>
      )}

      {/* Live knobs */}
      {currentRun.status === 'running' && <KnobsPanel runId={runId} />}

      {/* Training metrics charts */}
      {metrics.length > 1 && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 500, marginBottom: '12px' }}>Training Metrics</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            {/* Loss chart */}
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Loss</div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={metrics.filter((m) => m.loss != null)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis dataKey="step" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', fontSize: '12px' }}
                    labelStyle={{ color: 'var(--text-secondary)' }}
                  />
                  <Line type="monotone" dataKey="loss" stroke="var(--accent-primary)" dot={false} strokeWidth={1.5} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {/* Learning rate chart */}
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Learning Rate</div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={metrics.filter((m) => m.learning_rate != null)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis dataKey="step" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickFormatter={(v) => v.toExponential(1)} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', fontSize: '12px' }}
                    labelStyle={{ color: 'var(--text-secondary)' }}
                    formatter={(v: number) => v.toExponential(3)}
                  />
                  <Line type="monotone" dataKey="learning_rate" stroke="var(--accent-blue)" dot={false} strokeWidth={1.5} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Live SSE log */}
      {isRunning && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 500 }}>Live Progress</h3>
            {sseStatus && <span className={`badge badge-${sseStatus}`}>{sseStatus}</span>}
          </div>
          <div className="log-viewer" ref={logViewerRef} style={{ maxHeight: '400px' }}>
            {logs.map((line, i) => (
              <div key={i} className="log-line">{line}</div>
            ))}
            {logs.length === 0 && (
              <div style={{ color: 'var(--text-muted)' }}>Waiting for training to start...</div>
            )}
          </div>
        </div>
      )}

      {/* Adapter path */}
      {currentRun.adapter_path && (
        <div className="card" style={{ padding: '12px 16px' }}>
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Adapter saved to: <code style={{ color: 'var(--accent-blue)' }}>{currentRun.adapter_path}</code>
          </span>
        </div>
      )}
    </div>
  )
}
