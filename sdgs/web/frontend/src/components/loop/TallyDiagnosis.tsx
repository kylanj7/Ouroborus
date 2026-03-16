interface TallyDiagnosisProps {
  tallyResult: Record<string, any> | null
  cycle: number
}

export default function TallyDiagnosis({ tallyResult, cycle }: TallyDiagnosisProps) {
  if (tallyResult === null) {
    return (
      <p style={{ color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' }}>
        Tally diagnosis will appear after the first evaluation.
      </p>
    )
  }

  const clusters: Record<string, any>[] = tallyResult.clusters ?? []
  const generationGuidance: string = tallyResult.generation_guidance ?? ''

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 16,
        }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          Tally Diagnosis -- Cycle {cycle}
        </h3>
        <span
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 12,
            padding: '2px 8px',
          }}
        >
          {clusters.length} cluster{clusters.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {clusters.map((cluster, idx) => {
          const priorityScore: number = cluster.priority_score ?? 0
          const queries: string[] = cluster.search_queries ?? []
          const affectedQuestions: string[] = cluster.affected_questions ?? []

          return (
            <div
              key={idx}
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                backdropFilter: 'blur(8px)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 13,
                  color: 'var(--text-primary)',
                  marginBottom: 4,
                }}
              >
                {cluster.gap_description}
              </div>

              {cluster.root_cause && (
                <div
                  style={{
                    fontStyle: 'italic',
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    marginBottom: 10,
                  }}
                >
                  {cluster.root_cause}
                </div>
              )}

              <div style={{ marginBottom: 10 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    marginBottom: 4,
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>Priority</span>
                  <span>{(priorityScore * 100).toFixed(0)}%</span>
                </div>
                <div
                  style={{
                    height: 6,
                    background: 'var(--bg-card)',
                    borderRadius: 3,
                    overflow: 'hidden',
                    border: '1px solid var(--border-color)',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${priorityScore * 100}%`,
                      background: 'linear-gradient(90deg, var(--accent-blue), #8b5cf6)',
                      borderRadius: 3,
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>

              {affectedQuestions.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                    Affected questions ({affectedQuestions.length})
                  </div>
                  <div
                    style={{
                      maxHeight: 150,
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                    }}
                  >
                    {affectedQuestions.map((q, qi) => (
                      <div
                        key={qi}
                        style={{
                          fontSize: 11,
                          color: 'var(--text-secondary)',
                          background: 'var(--bg-card)',
                          padding: '3px 8px',
                          borderRadius: 4,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={q}
                      >
                        {q.length > 100 ? q.slice(0, 100) + '...' : q}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {queries.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {queries.map((q, qi) => (
                    <span
                      key={qi}
                      style={{
                        fontSize: 11,
                        color: 'var(--accent-blue)',
                        background: 'rgba(59, 130, 246, 0.1)',
                        border: '1px solid rgba(59, 130, 246, 0.2)',
                        borderRadius: 12,
                        padding: '2px 8px',
                      }}
                    >
                      {q}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {generationGuidance && (
        <div
          style={{
            marginTop: 16,
            padding: '12px 14px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-muted)',
              marginBottom: 6,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Generation Guidance
          </div>
          {generationGuidance}
        </div>
      )}
    </div>
  )
}
