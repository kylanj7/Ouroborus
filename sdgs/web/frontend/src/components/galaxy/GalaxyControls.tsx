import { Search, FileText, MessageSquare } from 'lucide-react'

type ActiveFilter = 'paper' | 'qa' | null

interface Props {
  searchQuery: string
  onSearch: (q: string) => void
  paperCount: number
  qaCount: number
  activeFilter: ActiveFilter
  onToggleFilter: (f: ActiveFilter) => void
}

export default function GalaxyControls({
  searchQuery, onSearch, paperCount, qaCount, activeFilter, onToggleFilter,
}: Props) {
  const categories: { key: 'paper' | 'qa'; label: string; count: number; color: string; icon: typeof FileText }[] = [
    { key: 'paper', label: 'Papers', count: paperCount, color: '#7eb8ff', icon: FileText },
    { key: 'qa', label: 'QA Pairs', count: qaCount, color: '#6ee7d8', icon: MessageSquare },
  ]

  return (
    <div className="card" style={{ padding: '12px', width: '220px' }}>
      {/* Search */}
      <div style={{ position: 'relative', marginBottom: '12px' }}>
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

      {/* Category filters */}
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
        Categories
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <button
          className="btn"
          onClick={() => onToggleFilter(null)}
          style={{
            fontSize: '12px', padding: '6px 10px',
            background: activeFilter === null ? 'rgba(59, 130, 246, 0.15)' : undefined,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <span>All</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{paperCount + qaCount}</span>
        </button>
        {categories.map(c => {
          const Icon = c.icon
          return (
            <button
              key={c.key}
              className="btn"
              onClick={() => onToggleFilter(activeFilter === c.key ? null : c.key)}
              style={{
                fontSize: '12px', padding: '6px 10px',
                background: activeFilter === c.key ? `${c.color}22` : undefined,
                borderColor: activeFilter === c.key ? `${c.color}66` : undefined,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Icon size={13} style={{ color: c.color }} />
                {c.label}
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{c.count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
