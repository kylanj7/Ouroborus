import { useEffect, useRef, useState } from 'react'
import { Play, Square, XCircle, ChevronDown, ChevronUp, Settings } from 'lucide-react'
import { getDatasets, Dataset } from '../api/client'
import { useLoopStore } from '../store/loopStore'
import { useLoopSSE } from '../hooks/useLoopSSE'
import StagePipeline from '../components/loop/StagePipeline'
import BenchmarkChart from '../components/loop/BenchmarkChart'
import TallyDiagnosis from '../components/loop/TallyDiagnosis'
import GateBanner from '../components/loop/GateBanner'
import CycleHistory from '../components/loop/CycleHistory'

export default function Loop() {
  const store = useLoopStore()
  const { logs, done, clear } = useLoopSSE()
  const [showLogs, setShowLogs] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  // Config form state
  const [configPath, setConfigPath] = useState('configs/closed_loop.yaml')
  const [baseModel, setBaseModel] = useState('Qwen/Qwen3.5-9B')
  const [learningRate, setLearningRate] = useState('1e-5')
  const [numEpochs, setNumEpochs] = useState(3)
  const [batchSize, setBatchSize] = useState(4)
  const [gradAccumSteps, setGradAccumSteps] = useState(4)
  const [maxSeqLength, setMaxSeqLength] = useState(2048)
  const [loraRank, setLoraRank] = useState(64)
  const [loraAlpha, setLoraAlpha] = useState(128)
  const [targetScore, setTargetScore] = useState(85)
  const [maxCycles, setMaxCycles] = useState(50)
  const [gateThreshold, setGateThreshold] = useState(0.5)
  const [minPairs, setMinPairs] = useState(1000)
  const [tallyModel, setTallyModel] = useState('gpt-oss:120b')
  const [seedDatasetId, setSeedDatasetId] = useState<number | null>(null)
  const canStart = !isRunning && !store.loading && seedDatasetId !== null
  const [datasets, setDatasets] = useState<Dataset[]>([])

  useEffect(() => {
    store.fetchStatus()
    store.fetchHistory()
    getDatasets(1, 100).then((res) => {
      setDatasets(res.datasets.filter((d) => d.status === 'completed'))
    }).catch(() => {})
  }, [])

  // When SSE signals done, refresh REST data
  useEffect(() => {
    if (done) {
      store.fetchStatus()
      store.fetchHistory()
    }
  }, [done])

  // Auto-scroll logs to bottom when new lines arrive
  useEffect(() => {
    if (showLogs) {
      logEndRef.current?.scrollIntoView({ behavior: 'instant' })
    }
  }, [logs.length, showLogs])

  const isRunning = store.status === 'running'

  const baseVersion = store.cycles.filter(c => (c as any).gate_passed === true).length

  return (
    <div style={{ padding: '32px', maxWidth: 1200 }}>
      {/* Pulse animation for status badge */}
      <style>{`
        @keyframes statusPulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }
      `}</style>

      {/* GateBanner -- floating overlay */}
      <GateBanner data={store.gateBanner} onDismiss={store.dismissGateBanner} />

      {/* Header + Controls Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Evolution Loop
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
            {/* Status badge */}
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 10px',
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 600,
              background: isRunning ? 'rgba(59, 130, 246, 0.15)' : 'rgba(100, 116, 139, 0.15)',
              color: isRunning ? 'var(--accent-blue)' : 'var(--text-muted)',
              border: `1px solid ${isRunning ? 'var(--accent-blue)' : 'var(--border-subtle)'}`,
              animation: isRunning ? 'statusPulse 2s ease-in-out infinite' : undefined,
            }}>
              {store.status ?? 'idle'}
            </span>

            {/* Stop reason badges */}
            {store.stopReason === 'fail_cap' && (
              <span style={{
                padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                background: 'rgba(234, 179, 8, 0.15)', color: 'var(--accent-yellow)',
                border: '1px solid var(--accent-yellow)',
              }}>
                Fail Cap
              </span>
            )}
            {store.stopReason === 'target_reached' && (
              <span style={{
                padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                background: 'rgba(34, 197, 94, 0.15)', color: 'var(--accent-green)',
                border: '1px solid var(--accent-green)',
              }}>
                Target Reached
              </span>
            )}

            {/* Base model version */}
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Base v{baseVersion}
            </span>

            {/* Fail counter -- only shown when > 0 */}
            {store.consecutiveGateFailures > 0 && (
              <span style={{
                fontSize: 12, color: 'var(--status-failed)',
                padding: '3px 10px', borderRadius: 20,
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid var(--status-failed)',
              }}>
                Gate failures: {store.consecutiveGateFailures}/3
              </span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => { store.start(configPath, seedDatasetId); clear() }}
            disabled={!canStart}
            style={btnStyle('start', !canStart)}
          >
            <Play size={16} /> Start
          </button>

          {isRunning && (
            <button
              onClick={store.stop}
              disabled={store.loading}
              style={btnStyle('stop', store.loading)}
            >
              <Square size={16} /> Stop
            </button>
          )}

          <button
            onClick={store.cancel}
            disabled={store.loading}
            style={btnStyle('cancel', store.loading)}
            title="Force-cancel any stale or stuck loop run"
          >
            <XCircle size={16} /> Cancel
          </button>
        </div>
      </div>

      {/* Config Panel */}
      <div style={{ ...glassCard, marginBottom: 16 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
          <Settings size={16} />
          Training Configuration
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
              {/* Config Preset */}
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={labelStyle}>Config File</label>
                <select value={configPath} onChange={e => setConfigPath(e.target.value)} style={inputStyle}>
                  <option value="configs/closed_loop.yaml">closed_loop.yaml (production)</option>
                  <option value="configs/closed_loop_test.yaml">closed_loop_test.yaml (test)</option>
                </select>
              </div>

              {/* Model */}
              <div>
                <label style={labelStyle}>Base Model</label>
                <input value={baseModel} onChange={e => setBaseModel(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Context Length</label>
                <select value={maxSeqLength} onChange={e => setMaxSeqLength(Number(e.target.value))} style={inputStyle}>
                  <option value={512}>512</option>
                  <option value={1024}>1024</option>
                  <option value={2048}>2048</option>
                  <option value={4096}>4096</option>
                  <option value={8192}>8192</option>
                  <option value={16384}>16384</option>
                  <option value={32768}>32768</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>LoRA Rank</label>
                <input type="number" value={loraRank} onChange={e => setLoraRank(Number(e.target.value))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>LoRA Alpha</label>
                <input type="number" value={loraAlpha} onChange={e => setLoraAlpha(Number(e.target.value))} style={inputStyle} />
              </div>

              {/* Training */}
              <div>
                <label style={labelStyle}>Learning Rate</label>
                <input value={learningRate} onChange={e => setLearningRate(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Epochs</label>
                <input type="number" value={numEpochs} onChange={e => setNumEpochs(Number(e.target.value))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Batch Size</label>
                <input type="number" value={batchSize} onChange={e => setBatchSize(Number(e.target.value))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Grad Accumulation</label>
                <input type="number" value={gradAccumSteps} onChange={e => setGradAccumSteps(Number(e.target.value))} style={inputStyle} />
              </div>

              {/* Loop */}
              <div>
                <label style={labelStyle}>Target Score (%)</label>
                <input type="number" value={targetScore} onChange={e => setTargetScore(Number(e.target.value))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Max Cycles</label>
                <input type="number" value={maxCycles} onChange={e => setMaxCycles(Number(e.target.value))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Gate Threshold (pp)</label>
                <input type="number" step="0.1" value={gateThreshold} onChange={e => setGateThreshold(Number(e.target.value))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Min Pairs / Cycle</label>
                <input type="number" value={minPairs} onChange={e => setMinPairs(Number(e.target.value))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Tally Model</label>
                <input value={tallyModel} onChange={e => setTallyModel(e.target.value)} style={inputStyle} />
              </div>

              {/* Seed Dataset */}
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={labelStyle}>Seed Dataset</label>
                <select
                  value={seedDatasetId ?? ''}
                  onChange={e => setSeedDatasetId(e.target.value ? Number(e.target.value) : null)}
                  style={inputStyle}
                >
                  <option value="">Select a dataset...</option>
                  {datasets.map(d => (
                    <option key={d.id} value={d.id}>
                      {d.name || d.topic} ({d.actual_size} QA pairs)
                    </option>
                  ))}
                </select>
              </div>
            </div>
      </div>

      {/* Error display */}
      {store.error && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid var(--status-failed)',
          borderRadius: 12,
          marginBottom: 16,
          color: 'var(--status-failed)',
          fontSize: 13,
        }}>
          {store.error}
        </div>
      )}

      {/* StagePipeline */}
      <StagePipeline currentStage={store.currentStage} currentCycle={store.currentCycle} />

      {/* BenchmarkChart */}
      <div style={{ ...glassCard, marginTop: 16 }}>
        <BenchmarkChart cycles={store.cycles} targetScore={85} />
      </div>

      {/* TallyDiagnosis */}
      <div style={{ ...glassCard, marginTop: 16 }}>
        <TallyDiagnosis tallyResult={store.tallyResult} cycle={store.currentCycle} />
      </div>

      {/* CycleHistory */}
      <div style={{ ...glassCard, marginTop: 16 }}>
        <CycleHistory cycles={store.cycles} />
      </div>

      {/* Live Logs -- collapsible */}
      <div style={{ ...glassCard, marginTop: 16 }}>
        <button
          onClick={() => setShowLogs(v => !v)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
            fontSize: 13,
            fontWeight: 600,
            padding: 0,
          }}
        >
          {showLogs ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {showLogs ? 'Hide Logs' : 'Show Logs'}
        </button>

        {showLogs && (
          <div style={{
            marginTop: 12,
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: 1.6,
            background: 'rgba(0, 0, 0, 0.4)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '12px 16px',
            maxHeight: 400,
            overflowY: 'scroll',
            color: 'var(--text-secondary)',
          }}>
            {logs.length === 0 ? (
              <span style={{ color: 'var(--text-muted)' }}>No log output yet.</span>
            ) : (
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {logs.join('\n')}
              </pre>
            )}
            <div ref={logEndRef} />
          </div>
        )}
      </div>
    </div>
  )
}

const glassCard: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.03)',
  backdropFilter: 'blur(12px)',
  border: '1px solid var(--border-color)',
  borderRadius: 12,
  padding: 24,
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-muted)',
  marginBottom: 4,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--border-color)',
  background: 'rgba(0, 0, 0, 0.3)',
  color: 'var(--text-primary)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
}

function btnStyle(variant: 'start' | 'stop' | 'cancel', disabled: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 18px',
    borderRadius: 8,
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 13,
    fontWeight: 600,
    opacity: disabled ? 0.5 : 1,
    transition: 'all 0.15s',
  }
  if (variant === 'start') {
    return {
      ...base,
      background: disabled ? 'rgba(34, 197, 94, 0.15)' : 'rgba(34, 197, 94, 0.2)',
      color: 'var(--accent-green)',
      border: '1px solid var(--accent-green)',
    }
  }
  if (variant === 'cancel') {
    return {
      ...base,
      background: 'rgba(249, 115, 22, 0.15)',
      color: '#f97316',
      border: '1px solid #f97316',
    }
  }
  return {
    ...base,
    background: 'rgba(239, 68, 68, 0.15)',
    color: 'var(--status-failed)',
    border: '1px solid var(--status-failed)',
  }
}
