import { useEffect, useRef, useState } from 'react'
import { useLoopStore } from '../store/loopStore'
import { useLoopSSE, LoopMetrics } from '../hooks/useLoopSSE'
import {
  listLoopConfigs, getDatasets, getConfigs, importFromHuggingFace,
  type LoopConfigEntry, type EvolutionSummary, type Dataset, type ConfigInfo,
} from '../api/client'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import { Play, Square, RefreshCw, CheckCircle, AlertTriangle, XCircle, Clock, ChevronDown, ChevronUp } from 'lucide-react'

const STAGES_DEFAULT = [
  { key: 'generating', label: 'Generate' },
  { key: 'formatting', label: 'Format' },
  { key: 'transferring', label: 'Transfer' },
  { key: 'training', label: 'Train' },
  { key: 'converting', label: 'Convert' },
  { key: 'evaluating', label: 'Evaluate' },
  { key: 'analyzing', label: 'Analyze' },
]

const STAGES_EVO1_DATASET = [
  { key: 'generating', label: 'Dataset' },
  { key: 'formatting', label: 'Format' },
  { key: 'transferring', label: 'Transfer' },
  { key: 'training', label: 'Train' },
  { key: 'converting', label: 'Convert' },
  { key: 'evaluating', label: 'Evaluate' },
  { key: 'analyzing', label: 'Analyze' },
]

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
  const { status, history, loading, error, fetchStatus, fetchHistory, start, stop, activeLoopId, setActiveLoopId } = useLoopStore()
  const sse = useLoopSSE(activeLoopId)
  const [configs, setConfigs] = useState<LoopConfigEntry[]>([])
  const [selectedConfig, setSelectedConfig] = useState<string>('')
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null)
  const [modelConfigs, setModelConfigs] = useState<ConfigInfo[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [showParams, setShowParams] = useState(false)
  const [loraRank, setLoraRank] = useState(64)
  const [loraAlpha, setLoraAlpha] = useState(128)
  const [learningRate, setLearningRate] = useState(0.00001)
  const [numEpochs, setNumEpochs] = useState(3)
  const [batchSize, setBatchSize] = useState(32)
  const [gradAccumSteps, setGradAccumSteps] = useState(4)
  const [maxSteps, setMaxSteps] = useState(-1)
  const [hfImportMode, setHfImportMode] = useState(false)
  const [hfRepoId, setHfRepoId] = useState('')
  const [hfImporting, setHfImporting] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  // Load configs + initial data
  useEffect(() => {
    fetchStatus()
    fetchHistory()
    listLoopConfigs().then(c => {
      setConfigs(c)
      if (c.length > 0) setSelectedConfig(c[0].path)
    }).catch(() => {})
    getDatasets(1).then(r => {
      const completed = r.datasets.filter(d => d.status === 'completed')
      setDatasets(completed)
    }).catch(() => {})
    getConfigs('models').then(r => {
      setModelConfigs(r.configs)
    }).catch(() => {})
  }, [])

  // If there's already a running loop on page load, connect SSE
  useEffect(() => {
    if (status?.status === 'running' && status.loop_id && !activeLoopId) {
      setActiveLoopId(status.loop_id)
    }
  }, [status])

  // On SSE done, refresh REST data
  useEffect(() => {
    if (sse.done) {
      fetchStatus()
      fetchHistory()
    }
  }, [sse.done])

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sse.logs.length])

  const isRunning = status?.status === 'running' || (sse.status === 'running' && !sse.done)

  // Use SSE metrics when streaming, otherwise fall back to REST evolutions
  const sseMetrics = sse.metrics
  const restEvolutions: EvolutionSummary[] = status?.evolutions ?? []

  // Build chart data -- prefer SSE if we have it
  const chartSource = sseMetrics.length > 0 ? sseMetrics : restEvolutions
  const chartData = chartSource.map((e: LoopMetrics | EvolutionSummary) => ({
    evo: `Evo ${e.evolution}`,
    'Overall Score': +e.overall_score.toFixed(1),
    'Factual Accuracy': +e.factual_accuracy.toFixed(1),
    'Completeness': +e.completeness.toFixed(1),
    'Technical Precision': +e.technical_precision.toFixed(1),
    'Best Score': +e.best_score_so_far.toFixed(1),
  }))

  const targetAccuracy = (status?.config_snapshot?.evolution as any)?.target_accuracy ?? 70
  const latestMetrics = sseMetrics.length > 0 ? sseMetrics[sseMetrics.length - 1] : null
  const latestEvo = restEvolutions.length > 0 ? restEvolutions[restEvolutions.length - 1] : null
  const currentScore = latestMetrics?.overall_score ?? latestEvo?.overall_score
  const bestScore = latestMetrics?.best_score_so_far ?? latestEvo?.best_score_so_far
  const maxEvos = (status?.config_snapshot?.evolution as any)?.max_evolutions ?? '?'
  const currentEvo = sse.evolution || status?.current_evolution || 0
  const currentStage = sse.stage || status?.current_stage || 'idle'

  // Determine stage labels: evo 1 with selected dataset shows "Dataset" instead of "Generate"
  const hasSelectedDataset = !!(status?.config_snapshot?.selected_dataset as any)?.id
  const STAGES = (currentEvo <= 1 && hasSelectedDataset) ? STAGES_EVO1_DATASET : STAGES_DEFAULT

  // Merge evolution data for table: SSE metrics + REST for completeness
  const allEvolutions: EvolutionSummary[] = restEvolutions
  const displayStopReason = sse.stopReason || status?.stop_reason

  const handleStart = async () => {
    if (!selectedDatasetId) return
    await start({
      config_path: selectedConfig || undefined,
      dataset_id: selectedDatasetId,
      model_config: selectedModel || undefined,
      learning_rate: learningRate,
      num_epochs: numEpochs,
      batch_size: batchSize,
      gradient_accumulation_steps: gradAccumSteps,
      max_steps: maxSteps,
      lora_rank: loraRank,
      lora_alpha: loraAlpha,
    })
  }

  const handleHfImport = async () => {
    if (!hfRepoId.trim()) return
    setHfImporting(true)
    try {
      const ds = await importFromHuggingFace({ repo_id: hfRepoId.trim() })
      // Refresh datasets and auto-select the new one
      const r = await getDatasets(1)
      const completed = r.datasets.filter(d => d.status === 'completed')
      setDatasets(completed)
      setSelectedDatasetId(ds.id)
      setHfImportMode(false)
      setHfRepoId('')
    } catch (e: any) {
      alert(`Import failed: ${e.message}`)
    } finally {
      setHfImporting(false)
    }
  }

  return (
    <div style={{ padding: '32px', maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)' }}>Evolution Loop</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
            Autonomous closed-loop: generate &rarr; train &rarr; evaluate &rarr; feedback
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!isRunning && (
            <>
              <select
                value={selectedDatasetId ?? ''}
                onChange={e => {
                  if (e.target.value === '__hf_import__') {
                    setHfImportMode(true)
                    e.target.value = ''
                  } else {
                    setSelectedDatasetId(e.target.value ? Number(e.target.value) : null)
                  }
                }}
                style={selectStyle}
              >
                <option value="">Select dataset...</option>
                {datasets.map(d => (
                  <option key={d.id} value={d.id}>{d.topic} ({d.actual_size} samples)</option>
                ))}
                <option value="__hf_import__">Import from HuggingFace...</option>
              </select>
              <select
                value={selectedModel}
                onChange={e => setSelectedModel(e.target.value)}
                style={selectStyle}
              >
                <option value="">Default model</option>
                {modelConfigs.map(m => (
                  <option key={m.name} value={m.name}>{m.display_name}</option>
                ))}
              </select>
              <select
                value={selectedConfig}
                onChange={e => setSelectedConfig(e.target.value)}
                style={selectStyle}
              >
                {configs.map(c => (
                  <option key={c.path} value={c.path}>{c.display_name}</option>
                ))}
              </select>
            </>
          )}
          <button onClick={() => { fetchStatus(); fetchHistory() }} style={btnStyle('secondary')} title="Refresh">
            <RefreshCw size={16} />
          </button>
          {isRunning ? (
            <button onClick={stop} disabled={loading} style={btnStyle('danger')}>
              <Square size={16} /> Stop
            </button>
          ) : (
            <button onClick={handleStart} disabled={loading || !selectedConfig || !selectedDatasetId} style={btnStyle('primary')}>
              <Play size={16} /> Start Evolution
            </button>
          )}
        </div>
      </div>

      {/* HuggingFace Import */}
      {hfImportMode && !isRunning && (
        <div style={{ ...cardStyle, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            Import from HuggingFace
          </div>
          <input
            value={hfRepoId}
            onChange={e => setHfRepoId(e.target.value)}
            placeholder="e.g. username/dataset-name"
            onKeyDown={e => e.key === 'Enter' && handleHfImport()}
            autoFocus
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-input)', color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)', fontSize: 14,
            }}
          />
          <button onClick={handleHfImport} disabled={hfImporting || !hfRepoId.trim()} style={btnStyle('primary')}>
            {hfImporting ? 'Importing...' : 'Import'}
          </button>
          <button onClick={() => { setHfImportMode(false); setHfRepoId('') }} style={btnStyle('secondary')}>
            Cancel
          </button>
        </div>
      )}

      {/* Training Parameters (collapsible) */}
      {!isRunning && (
        <div style={{ ...cardStyle, marginBottom: 12 }}>
          <div
            onClick={() => setShowParams(!showParams)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}
          >
            {showParams ? <ChevronUp size={16} color="var(--text-muted)" /> : <ChevronDown size={16} color="var(--text-muted)" />}
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Training Parameters</span>
          </div>
          {showParams && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
              <NumberField label="LoRA Rank" value={loraRank} onChange={setLoraRank} step={1} min={1} />
              <NumberField label="LoRA Alpha" value={loraAlpha} onChange={setLoraAlpha} step={1} min={1} />
              <NumberField label="Learning Rate" value={learningRate} onChange={setLearningRate} step={0.00001} />
              <NumberField label="Epochs" value={numEpochs} onChange={setNumEpochs} step={1} min={1} />
              <NumberField label="Batch Size" value={batchSize} onChange={setBatchSize} step={1} min={1} />
              <NumberField label="Gradient Accumulation Steps" value={gradAccumSteps} onChange={setGradAccumSteps} step={1} min={1} />
              <NumberField label="Max Steps (-1 for unlimited)" value={maxSteps} onChange={setMaxSteps} step={1} />
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ padding: '12px 16px', background: 'rgba(255, 126, 179, 0.1)', border: '1px solid var(--status-failed)', borderRadius: 'var(--radius-sm)', marginBottom: 16, color: 'var(--status-failed)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Stage Pipeline */}
      {(isRunning || status) && (
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, fontWeight: 500 }}>
            Stage Pipeline {currentEvo > 0 && <span style={{ color: 'var(--accent-blue)' }}>-- Evolution {currentEvo}</span>}
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            {STAGES.map((s, i) => {
              const stageIdx = STAGES.findIndex(x => x.key === currentStage)
              const isActive = s.key === currentStage && isRunning
              const isPast = stageIdx >= 0 && i < stageIdx && isRunning
              const isDone = !isRunning && displayStopReason

              let bg = 'var(--bg-input)'
              let color = 'var(--text-muted)'
              let border = '1px solid var(--border-subtle)'

              if (isActive) {
                bg = 'var(--accent-blue)'
                color = '#000'
                border = '1px solid var(--accent-blue)'
              } else if (isPast) {
                bg = 'rgba(0, 255, 150, 0.15)'
                color = 'var(--accent-green)'
                border = '1px solid var(--accent-green)'
              } else if (isDone) {
                bg = 'rgba(0, 255, 150, 0.08)'
                color = 'var(--accent-green)'
                border = '1px solid rgba(0, 255, 150, 0.3)'
              }

              return (
                <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                    background: bg, color, border,
                    animation: isActive ? 'pulse 2s ease-in-out infinite' : undefined,
                  }}>
                    {s.label}
                  </div>
                  {i < STAGES.length - 1 && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>&gt;</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Status Row */}
      {(status || isRunning) && (
        <div style={{ ...cardStyle, marginTop: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16 }}>
            <Stat label="Status" value={isRunning ? 'Running' : (status?.status ?? 'idle')} color={isRunning ? 'var(--status-running)' : 'var(--text-secondary)'} />
            <Stat label="Evolution" value={`${currentEvo} / ${maxEvos}`} />
            <Stat label="Stage" value={STAGE_LABELS[currentStage] ?? currentStage} color={isRunning ? 'var(--accent-cyan)' : undefined} />
            {(status?.config_snapshot?.training as any)?.model_config && (
              <Stat label="Model" value={(status?.config_snapshot?.training as any).model_config} />
            )}
            {(status?.config_snapshot?.selected_dataset as any)?.name && (
              <Stat label="Dataset" value={(status?.config_snapshot?.selected_dataset as any).name} />
            )}
            {status?.config_snapshot?.parameter_overrides && (() => {
              const ov = status.config_snapshot.parameter_overrides as Record<string, number>
              const labels: Record<string, string> = {
                learning_rate: 'LR', num_train_epochs: 'Epochs', per_device_train_batch_size: 'Batch',
                gradient_accumulation_steps: 'GradAccum', max_steps: 'MaxSteps', lora_rank: 'LoRA r', lora_alpha: 'LoRA a',
              }
              const parts = Object.entries(ov).map(([k, v]) => `${labels[k] ?? k}: ${v}`)
              return parts.length > 0 ? <Stat label="Overrides" value={parts.join(', ')} /> : null
            })()}
            {currentScore != null && (
              <Stat label="Current Score" value={`${currentScore.toFixed(1)}%`} color={currentScore >= targetAccuracy ? 'var(--accent-green)' : 'var(--accent-blue)'} />
            )}
            {bestScore != null && (
              <Stat label="Best Score" value={`${bestScore.toFixed(1)}%`} color="var(--accent-gold)" />
            )}
            <Stat label="Target" value={`${targetAccuracy}%`} />
            {displayStopReason && (() => {
              const info = STOP_LABELS[displayStopReason]
              if (!info) return <Stat label="Stop Reason" value={displayStopReason} />
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

      {/* Live Logs + Convergence Chart */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        {/* Live Logs */}
        <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', minHeight: 340, maxHeight: 400 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Live Logs</h2>
            {isRunning && (
              <span style={{ fontSize: 11, color: 'var(--accent-green)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-green)', animation: 'pulse 2s ease-in-out infinite' }} />
                Streaming
              </span>
            )}
          </div>
          <div style={{
            flex: 1, overflow: 'auto', background: 'var(--bg-main)', borderRadius: 'var(--radius-sm)',
            padding: '8px 12px', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6,
            color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)',
          }}>
            {sse.logs.length === 0 && !isRunning && (
              <span style={{ color: 'var(--text-muted)' }}>No logs yet. Start a loop to see live output.</span>
            )}
            {sse.logs.map((line, i) => (
              <div key={i} style={{ color: line.startsWith('ERROR') ? 'var(--status-failed)' : undefined }}>
                {line}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>

        {/* Convergence Chart */}
        <div style={{ ...cardStyle, minHeight: 340, maxHeight: 400 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
            Convergence Chart
          </h2>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis dataKey="evo" stroke="var(--text-muted)" fontSize={11} />
                <YAxis domain={[0, 100]} stroke="var(--text-muted)" fontSize={11} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={targetAccuracy} stroke="var(--accent-green)" strokeDasharray="6 3" label={{ value: `Target ${targetAccuracy}%`, fill: 'var(--accent-green)', fontSize: 10 }} />
                <Line type="monotone" dataKey="Overall Score" stroke="var(--accent-blue)" strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="Factual Accuracy" stroke="var(--accent-cyan)" strokeWidth={1} strokeDasharray="4 2" dot={false} />
                <Line type="monotone" dataKey="Completeness" stroke="var(--accent-purple)" strokeWidth={1} strokeDasharray="4 2" dot={false} />
                <Line type="monotone" dataKey="Technical Precision" stroke="var(--accent-gold)" strokeWidth={1} strokeDasharray="4 2" dot={false} />
                <Line type="monotone" dataKey="Best Score" stroke="var(--accent-green)" strokeWidth={1} strokeDasharray="2 2" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 280, color: 'var(--text-muted)', fontSize: 13 }}>
              Chart will appear after the first evolution completes.
            </div>
          )}
        </div>
      </div>

      {/* Evolution History Table */}
      {allEvolutions.length > 0 && (
        <div style={{ ...cardStyle, marginTop: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
            Evolution History
          </h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  {['Evo', 'Score', 'Best', 'Delta', 'FA', 'CO', 'TP', 'Regr.', 'Plat.', 'Target'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allEvolutions.map(e => (
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
                    <td style={cellStyle}>{e.target_reached ? <CheckCircle size={13} color="var(--accent-green)" /> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Domain Breakdown */}
      {(() => {
        const domainSource = latestMetrics?.domain_scores ?? (latestEvo?.domain_scores)
        if (!domainSource || Object.keys(domainSource).length === 0) return null
        return (
          <div style={{ ...cardStyle, marginTop: 12 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
              Domain Scores (Latest)
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }}>
              {Object.entries(domainSource).map(([domain, scores]) => (
                <div key={domain} style={{ padding: 14, background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{domain}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div>FA: <span style={{ color: 'var(--accent-cyan)' }}>{(scores as any).factual_accuracy?.toFixed(1) ?? '-'}</span></div>
                    <div>CO: <span style={{ color: 'var(--accent-purple)' }}>{(scores as any).completeness?.toFixed(1) ?? '-'}</span></div>
                    <div>TP: <span style={{ color: 'var(--accent-gold)' }}>{(scores as any).technical_precision?.toFixed(1) ?? '-'}</span></div>
                    <div style={{ marginTop: 3, fontWeight: 600, color: 'var(--accent-blue)' }}>
                      Overall: {(scores as any).overall_score?.toFixed(1) ?? '-'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Past Loops */}
      {history.length > 0 && (
        <div style={{ ...cardStyle, marginTop: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
            Past Loops
          </h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                {['Loop ID', 'Status', 'Evolutions', 'Stage', 'Reason', 'Created'].map(h => (
                  <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr
                  key={h.loop_id}
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                    background: activeLoopId === h.loop_id ? 'rgba(126, 184, 255, 0.05)' : undefined,
                  }}
                  onClick={() => setActiveLoopId(h.loop_id)}
                >
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: 11 }}>{h.loop_id}</td>
                  <td style={{ padding: '6px 10px', color: h.status === 'running' ? 'var(--status-running)' : 'var(--text-secondary)' }}>{h.status}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-primary)' }}>{h.current_evolution}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{STAGE_LABELS[h.current_stage] ?? h.current_stage}</td>
                  <td style={{ padding: '6px 10px', color: h.stop_reason ? (STOP_LABELS[h.stop_reason]?.color ?? 'var(--text-secondary)') : 'var(--text-muted)' }}>
                    {h.stop_reason ? (STOP_LABELS[h.stop_reason]?.label ?? h.stop_reason) : '-'}
                  </td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-muted)' }}>{h.created_at?.slice(0, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!status && !loading && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: 48, marginTop: 16 }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 16 }}>
            No evolution loop has been run yet. Start one to begin the autonomous training cycle.
          </p>
          <button onClick={handleStart} disabled={loading || !selectedConfig || !selectedDatasetId} style={btnStyle('primary')}>
            <Play size={16} /> Start First Evolution
          </button>
        </div>
      )}

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </div>
  )
}

function NumberField({ label, value, onChange, step = 1, min }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; min?: number
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <input
        type="number"
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        step={step}
        min={min}
        style={{
          width: '100%', padding: '8px 12px', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-input)', color: 'var(--text-primary)',
          border: '1px solid var(--border-subtle)', fontSize: 13,
        }}
      />
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: color ?? 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  padding: 20,
}

const selectStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
  fontSize: 13,
  maxWidth: 200,
}

const cellStyle: React.CSSProperties = {
  padding: '6px 10px',
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
