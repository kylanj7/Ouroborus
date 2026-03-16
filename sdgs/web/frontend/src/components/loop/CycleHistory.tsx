import { ClosedLoopCycle } from '../../api/client'

interface CycleHistoryProps {
  cycles: ClosedLoopCycle[]
}

function fmt1(value: number | null | undefined): string {
  if (value == null) return '--'
  return value.toFixed(1)
}

function deriveBaseVersion(cycles: ClosedLoopCycle[], upToIndex: number): string {
  if (upToIndex === 0) return 'v0'
  let passCount = 0
  for (let i = 0; i < upToIndex; i++) {
    if (cycles[i].gate_passed === true) passCount++
  }
  return `v${passCount}`
}

export default function CycleHistory({ cycles }: CycleHistoryProps) {
  if (cycles.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' }}>
        No cycle history yet.
      </p>
    )
  }

  const firstScores = cycles[0].benchmark_scores
  const benchmarkKeys = Object.keys(firstScores).filter((k) => k !== 'average')

  const headerCellStyle: React.CSSProperties = {
    padding: '8px 12px',
    textAlign: 'left',
    color: 'var(--text-muted)',
    fontWeight: 600,
    fontSize: 11,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    borderBottom: '1px solid var(--border-color)',
    background: 'var(--bg-card)',
    position: 'sticky' as const,
    top: 0,
    whiteSpace: 'nowrap' as const,
  }

  const cellStyle: React.CSSProperties = {
    padding: '8px 12px',
    fontSize: 12,
    color: 'var(--text-secondary)',
    borderBottom: '1px solid var(--border-color)',
    whiteSpace: 'nowrap' as const,
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={headerCellStyle}>Cycle</th>
            <th style={headerCellStyle}>Base</th>
            <th style={headerCellStyle}>Dataset</th>
            <th style={headerCellStyle}>Loss</th>
            {benchmarkKeys.map((k) => (
              <th key={k} style={headerCellStyle}>
                {k}
              </th>
            ))}
            <th style={headerCellStyle}>Average</th>
            <th style={headerCellStyle}>Gate</th>
            <th style={headerCellStyle}>Gaps</th>
          </tr>
        </thead>
        <tbody>
          {cycles.map((c, idx) => {
            const baseVersion = deriveBaseVersion(cycles, idx)
            const isEvenRow = idx % 2 === 0

            const rowBackground = isEvenRow
              ? 'transparent'
              : 'rgba(255, 255, 255, 0.02)'

            let gateBadge: React.ReactNode = '--'
            if (c.cycle > 0 && c.gate_passed !== null) {
              const deltaStr =
                c.gate_delta >= 0
                  ? `+${c.gate_delta.toFixed(1)}pp`
                  : `${c.gate_delta.toFixed(1)}pp`
              if (c.gate_passed) {
                gateBadge = (
                  <span
                    style={{
                      background: 'rgba(16, 185, 129, 0.15)',
                      color: '#10b981',
                      border: '1px solid rgba(16, 185, 129, 0.3)',
                      borderRadius: 12,
                      padding: '2px 8px',
                      fontWeight: 600,
                      fontSize: 11,
                    }}
                  >
                    PASS {deltaStr}
                  </span>
                )
              } else {
                gateBadge = (
                  <span
                    style={{
                      background: 'rgba(239, 68, 68, 0.15)',
                      color: '#ef4444',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      borderRadius: 12,
                      padding: '2px 8px',
                      fontWeight: 600,
                      fontSize: 11,
                    }}
                  >
                    FAIL {deltaStr}
                  </span>
                )
              }
            }

            const datasetLabel = c.dataset_path
              ? c.dataset_path.split('/').pop() ?? c.dataset_path
              : '--'

            const gapsCount =
              c.tally_metadata?.clusters?.length != null
                ? c.tally_metadata.clusters.length
                : '--'

            return (
              <tr key={c.cycle} style={{ background: rowBackground }}>
                <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {c.cycle}
                </td>
                <td style={{ ...cellStyle, fontFamily: 'monospace', fontSize: 11 }}>
                  {baseVersion}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    maxWidth: 160,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={c.dataset_path ?? undefined}
                >
                  {datasetLabel}
                </td>
                <td style={cellStyle}>{fmt1(c.training_loss)}</td>
                {benchmarkKeys.map((k) => (
                  <td key={k} style={cellStyle}>
                    {fmt1(c.benchmark_scores[k])}
                  </td>
                ))}
                <td
                  style={{
                    ...cellStyle,
                    fontWeight: 600,
                    color: 'var(--accent-blue)',
                  }}
                >
                  {fmt1(c.benchmark_scores['average'])}
                </td>
                <td style={{ ...cellStyle }}>{gateBadge}</td>
                <td style={cellStyle}>{gapsCount}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
