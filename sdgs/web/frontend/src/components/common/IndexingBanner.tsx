import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Database, Terminal, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { useKnowledgeStore } from '../../store/knowledgeStore'

export default function IndexingBanner() {
  const { indexing, logs } = useKnowledgeStore()
  const [expanded, setExpanded] = useState(false)
  const terminalRef = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const navigate = useNavigate()

  const onKnowledgePage = location.pathname === '/knowledge'

  // Check for running indexing on mount
  useEffect(() => {
    useKnowledgeStore.getState().checkRunning()
  }, [])

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [logs, expanded])

  // Don't show if not indexing or if on the knowledge page (it shows its own terminal)
  if (!indexing || onKnowledgePage) return null

  // Get the last meaningful log line for the collapsed view
  const lastLog = [...logs].reverse().find(l => l && !l.startsWith('$')) || 'Starting...'
  // Calculate progress from logs
  const progressMatch = lastLog.match(/\[(\d+)\/(\d+)\]/)
  const progress = progressMatch ? `${progressMatch[1]}/${progressMatch[2]}` : null

  return (
    <div style={{
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      width: expanded ? '480px' : '360px',
      background: 'rgba(8, 12, 28, 0.95)',
      backdropFilter: 'blur(16px)',
      border: '1px solid rgba(74, 222, 128, 0.2)',
      borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.4), 0 0 24px rgba(74, 222, 128, 0.06)',
      zIndex: 1000,
      overflow: 'hidden',
      transition: 'width 0.2s ease',
    }}>
      {/* Header bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 14px',
          cursor: 'pointer',
          borderBottom: expanded ? '1px solid rgba(255,255,255,0.06)' : 'none',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <Database size={14} style={{ color: 'var(--accent-primary)', animation: 'spin 2s linear infinite' }} />
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#fff', flex: 1 }}>
          Indexing Papers
          {progress && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '8px' }}>{progress}</span>}
        </span>
        <button
          onClick={e => { e.stopPropagation(); navigate('/knowledge') }}
          style={{
            fontSize: '10px',
            color: 'var(--accent-primary)',
            background: 'rgba(74, 222, 128, 0.1)',
            border: '1px solid rgba(74, 222, 128, 0.2)',
            borderRadius: '4px',
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          View
        </button>
        {expanded ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronUp size={14} style={{ color: 'var(--text-muted)' }} />}
      </div>

      {/* Collapsed: single line preview */}
      {!expanded && (
        <div style={{
          padding: '6px 14px 10px',
          fontSize: '11px',
          color: 'var(--text-muted)',
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {lastLog}
        </div>
      )}

      {/* Expanded: terminal output */}
      {expanded && (
        <div
          ref={terminalRef}
          style={{
            maxHeight: '250px',
            overflowY: 'auto',
            padding: '10px 14px',
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            fontSize: '11px',
            lineHeight: 1.6,
          }}
        >
          {logs.map((line, i) => {
            let color = 'var(--text-secondary)'
            if (line.startsWith('$')) color = 'var(--accent-purple)'
            else if (line.includes('OK   ')) color = 'var(--accent-primary)'
            else if (line.includes('SKIP ')) color = 'var(--accent-yellow)'
            else if (line.includes('Error')) color = 'var(--status-failed)'
            else if (line.startsWith('---') || line.startsWith('Done.') || line.startsWith('Found')) color = 'var(--accent-blue)'

            return (
              <div key={i} style={{ color, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {line || '\u00A0'}
              </div>
            )
          })}
          <div style={{ color: 'var(--accent-purple)' }}>
            <span style={{ animation: 'blink 1s step-end infinite' }}>_</span>
          </div>
        </div>
      )}
    </div>
  )
}
