import { Database, Clock, Zap, ChevronRight } from 'lucide-react'
import type { Dataset } from '../../api/client'

interface Props {
  dataset: Dataset
  onClick: () => void
}

const statusClass: Record<string, string> = {
  pending: 'badge-pending',
  running: 'badge-running',
  completed: 'badge-completed',
  failed: 'badge-failed',
  cancelled: 'badge-cancelled',
}

const statusAccent: Record<string, string> = {
  completed: 'rgba(34, 197, 94, 0.08)',
  running: 'rgba(59, 130, 246, 0.06)',
  failed: 'rgba(239, 68, 68, 0.06)',
  pending: 'transparent',
  cancelled: 'rgba(217, 119, 6, 0.04)',
}

export default function DatasetCard({ dataset, onClick }: Props) {
  const date = dataset.created_at ? new Date(dataset.created_at).toLocaleDateString() : ''

  return (
    <div
      onClick={onClick}
      style={{
        background: statusAccent[dataset.status] || 'transparent',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        borderRadius: '14px',
        padding: '18px 22px',
        cursor: 'pointer',
        transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
        e.currentTarget.style.transform = 'translateY(-1px)'
        e.currentTarget.style.boxShadow = '0 8px 32px rgba(0,0,0,0.25)'
        e.currentTarget.style.background = 'rgba(20, 30, 55, 0.5)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
        e.currentTarget.style.background = statusAccent[dataset.status] || 'transparent'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flex: 1, minWidth: 0 }}>
          <div style={{
            width: '40px',
            height: '40px',
            borderRadius: '12px',
            background: 'rgba(59, 130, 246, 0.1)',
            border: '1px solid rgba(59, 130, 246, 0.12)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Database size={18} style={{ color: '#60A5FA' }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontWeight: 600,
              fontSize: '14px',
              marginBottom: '4px',
              color: '#fff',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {dataset.topic}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span>{dataset.provider || 'default'}{dataset.model ? ` / ${dataset.model}` : ''}</span>
              <span style={{ opacity: 0.3 }}>|</span>
              <span>{date}</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: '18px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {dataset.actual_size > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Database size={13} style={{ opacity: 0.4 }} />
                <span style={{ fontFeatureSettings: '"tnum"' }}>{dataset.actual_size}</span>
              </div>
            )}
            {dataset.total_tokens > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Zap size={13} style={{ opacity: 0.4 }} />
                <span style={{ fontFeatureSettings: '"tnum"' }}>{dataset.total_tokens.toLocaleString()}</span>
              </div>
            )}
            {dataset.duration_seconds > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Clock size={13} style={{ opacity: 0.4 }} />
                <span style={{ fontFeatureSettings: '"tnum"' }}>{Math.round(dataset.duration_seconds)}s</span>
              </div>
            )}
          </div>

          <span className={`badge ${statusClass[dataset.status] || 'badge-pending'}`}>
            {dataset.status}
          </span>

          <ChevronRight size={16} style={{ color: 'var(--text-muted)', opacity: 0.3 }} />
        </div>
      </div>
    </div>
  )
}
