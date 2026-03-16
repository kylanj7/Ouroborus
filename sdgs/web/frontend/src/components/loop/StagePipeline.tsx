interface StagePipelineProps {
  currentStage: string | null
  currentCycle: number
}

const CYCLE_STAGES = [
  { key: 'tallying', label: 'TALLY' },
  { key: 'retrieving', label: 'RETRIEVE' },
  { key: 'curating', label: 'CURATE' },
  { key: 'training', label: 'TRAIN' },
  { key: 'merging', label: 'MERGE' },
  { key: 'evaluating', label: 'EVALUATE' },
  { key: 'gating', label: 'GATE' },
]

const BASELINE_STAGE = [{ key: 'baseline', label: 'BASELINE' }]

export default function StagePipeline({ currentStage, currentCycle }: StagePipelineProps) {
  const stages = currentCycle === 0 ? BASELINE_STAGE : CYCLE_STAGES
  const activeIdx = stages.findIndex((s) => s.key === currentStage)

  return (
    <div>
      <style>{`
        @keyframes stagePulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); }
          50% { opacity: 0.85; box-shadow: 0 0 0 6px rgba(59, 130, 246, 0); }
        }
      `}</style>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 500 }}>
        Cycle {currentCycle}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {stages.map((s, i) => {
          const isActive = s.key === currentStage
          const isCompleted = activeIdx >= 0 && i < activeIdx

          let background: string
          let color: string
          let border: string
          let animation: string | undefined

          if (isActive) {
            background = 'var(--accent-blue)'
            color = '#ffffff'
            border = '1px solid var(--accent-blue)'
            animation = 'stagePulse 2s ease-in-out infinite'
          } else if (isCompleted) {
            background = 'var(--status-success)'
            color = '#ffffff'
            border = '1px solid var(--status-success)'
            animation = undefined
          } else {
            background = 'var(--bg-card)'
            color = 'var(--text-muted)'
            border = '1px solid var(--border-color)'
            animation = undefined
          }

          return (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div
                style={{
                  padding: '8px 16px',
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  background,
                  color,
                  border,
                  animation,
                }}
              >
                {s.label}
              </div>
              {i < stages.length - 1 && (
                <span style={{ color: 'var(--text-muted)', fontSize: 12, userSelect: 'none' }}>
                  &gt;
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
