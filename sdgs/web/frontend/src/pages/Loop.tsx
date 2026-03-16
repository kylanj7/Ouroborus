import { useEffect, useRef, useState } from 'react'
import { Play, Square, ChevronDown, ChevronUp } from 'lucide-react'
import { useLoopStore } from '../store/loopStore'
import { useLoopSSE } from '../hooks/useLoopSSE'
import { StagePipeline } from '../components/loop/StagePipeline'
import { BenchmarkChart } from '../components/loop/BenchmarkChart'
import { TallyDiagnosis } from '../components/loop/TallyDiagnosis'
import { GateBanner } from '../components/loop/GateBanner'
import { CycleHistory } from '../components/loop/CycleHistory'

export default function Loop() {
  const store = useLoopStore()
  const { logs, done, clear } = useLoopSSE()
  const [showLogs, setShowLogs] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    store.fetchStatus()
    store.fetchHistory()
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
            onClick={() => { store.start(); clear() }}
            disabled={isRunning || store.loading}
            style={btnStyle('start', isRunning || store.loading)}
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

function btnStyle(variant: 'start' | 'stop', disabled: boolean): React.CSSProperties {
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
  return {
    ...base,
    background: 'rgba(239, 68, 68, 0.15)',
    color: 'var(--status-failed)',
    border: '1px solid var(--status-failed)',
  }
}
