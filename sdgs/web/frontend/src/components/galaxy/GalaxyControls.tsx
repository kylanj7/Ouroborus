import { Search } from 'lucide-react'
import { ClusterInfo } from '../../api/client'

interface Props {
  searchQuery: string
  onSearch: (q: string) => void
  clusters: ClusterInfo[]
  activeCluster: number | null
  onToggleCluster: (id: number | null) => void
}

export default function GalaxyControls({
  searchQuery, onSearch, clusters, activeCluster, onToggleCluster,
}: Props) {
  return (
    <div className="card" style={{ padding: '12px', width: '280px' }}>
      {/* Search */}
      <div style={{ position: 'relative', marginBottom: clusters.length > 0 ? '12px' : 0 }}>
        <input
          value={searchQuery}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search nodes..."
          style={{ paddingLeft: '32px', fontSize: '13px' }}
        />
        <Search size={14} style={{
          position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)',
          color: 'var(--text-muted)',
        }} />
      </div>

      {/* Cluster toggles */}
      {clusters.length > 0 && (
        <>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            Clusters
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            <button
              className="btn"
              onClick={() => onToggleCluster(null)}
              style={{
                fontSize: '12px', padding: '4px 10px',
                background: activeCluster === null ? 'rgba(126, 184, 255, 0.15)' : undefined,
              }}
            >
              All
            </button>
            {clusters.map(c => (
              <button
                key={c.id}
                className="btn"
                onClick={() => onToggleCluster(activeCluster === c.id ? null : c.id)}
                style={{
                  fontSize: '12px', padding: '4px 10px',
                  background: activeCluster === c.id ? `${c.color}22` : undefined,
                  borderColor: activeCluster === c.id ? `${c.color}66` : undefined,
                }}
              >
                <span style={{
                  display: 'inline-block', width: '8px', height: '8px',
                  borderRadius: '50%', background: c.color, marginRight: '4px',
                }} />
                {c.label} ({c.paper_count})
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
