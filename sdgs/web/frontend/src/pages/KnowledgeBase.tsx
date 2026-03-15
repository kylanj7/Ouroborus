import { useState, useEffect, useRef } from 'react'
import { Search, Database, MessageSquare, RefreshCw, Trash2, BookOpen, Terminal } from 'lucide-react'
import {
  getKBStatus, indexKBStream, searchKB, chatKB, resetKB,
  KBStatus, KBSearchResult, KBChatResponse, KBIndexEvent,
} from '../api/client'
import { useToastStore } from '../store/toastStore'

type Tab = 'search' | 'chat'

export default function KnowledgeBase() {
  const addToast = useToastStore(s => s.addToast)
  const [tab, setTab] = useState<Tab>('search')
  const [status, setStatus] = useState<KBStatus | null>(null)
  const [loading, setLoading] = useState(false)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KBSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  // Chat state
  const [chatQuery, setChatQuery] = useState('')
  const [chatResponse, setChatResponse] = useState<KBChatResponse | null>(null)
  const [chatting, setChatting] = useState(false)

  // Index state
  const [indexing, setIndexing] = useState(false)
  const [indexLogs, setIndexLogs] = useState<string[]>([])
  const terminalRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    loadStatus()
  }, [])

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [indexLogs])

  async function loadStatus() {
    try {
      const s = await getKBStatus()
      setStatus(s)
    } catch {
      // KB not initialized yet
    }
  }

  function handleIndex(force = false) {
    setIndexing(true)
    setIndexLogs(['$ ouroboros index-papers' + (force ? ' --force' : ''), ''])

    const cancel = indexKBStream(
      (event: KBIndexEvent) => {
        if (event.message) {
          setIndexLogs(prev => [...prev, event.message!])
        }
        if (event.type === 'done') {
          addToast('success', `Indexed ${event.indexed} PDFs (${event.chunks_added} chunks, ${event.skipped} skipped)`)
        }
      },
      () => {
        setIndexing(false)
        loadStatus()
      },
      force,
    )

    cancelRef.current = cancel
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!searchQuery.trim()) return
    setSearching(true)
    setSearchResults([])
    try {
      const res = await searchKB(searchQuery.trim())
      setSearchResults(res.results)
      if (res.count === 0) addToast('info', 'No results found')
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  async function handleChat(e: React.FormEvent) {
    e.preventDefault()
    if (!chatQuery.trim()) return
    setChatting(true)
    setChatResponse(null)
    try {
      const res = await chatKB(chatQuery.trim())
      setChatResponse(res)
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Chat failed')
    } finally {
      setChatting(false)
    }
  }

  async function handleReset() {
    if (!confirm('Delete the entire knowledge base? This cannot be undone.')) return
    setLoading(true)
    try {
      await resetKB()
      setSearchResults([])
      setChatResponse(null)
      setIndexLogs([])
      addToast('success', 'Knowledge base reset')
      await loadStatus()
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)' }}>Knowledge Base</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            Semantic search and RAG chat over your indexed papers
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => handleIndex(false)}
            disabled={indexing}
            className="btn btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            {indexing ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Database size={14} />}
            {indexing ? 'Indexing...' : 'Index Papers'}
          </button>
          <button
            onClick={handleReset}
            disabled={loading || indexing}
            className="btn"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)' }}
            title="Reset knowledge base"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Status bar */}
      {status && (
        <div style={{
          display: 'flex', gap: '24px', padding: '12px 16px',
          background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)',
          marginBottom: '20px', fontSize: '13px', color: 'var(--text-secondary)',
        }}>
          <span><strong>{status.collection_count}</strong> chunks indexed</span>
          <span><strong>{status.indexed_file_count}</strong> / {status.total_pdfs} PDFs indexed</span>
          {status.indexed_files.length > 0 && (
            <span title={status.indexed_files.join(', ')}>
              Latest: {status.indexed_files[status.indexed_files.length - 1]}
            </span>
          )}
        </div>
      )}

      {/* Terminal output */}
      {indexLogs.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '8px 12px',
            background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
            borderBottom: '1px solid var(--border-subtle)',
          }}>
            <Terminal size={12} style={{ color: 'var(--text-muted)' }} />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>Index Output</span>
            {indexing && <span style={{ fontSize: '10px', color: 'var(--accent-primary)', marginLeft: 'auto' }}>RUNNING</span>}
            {!indexing && indexLogs.length > 2 && <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 'auto' }}>DONE</span>}
          </div>
          <div
            ref={terminalRef}
            style={{
              background: 'var(--bg-primary)',
              borderRadius: '0 0 var(--radius-sm) var(--radius-sm)',
              padding: '12px 16px',
              maxHeight: '300px',
              overflowY: 'auto',
              fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
              fontSize: '12px',
              lineHeight: 1.7,
            }}
          >
            {indexLogs.map((line, i) => {
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
            {indexing && (
              <div style={{ color: 'var(--accent-purple)' }}>
                <span style={{ animation: 'blink 1s step-end infinite' }}>_</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '20px', borderBottom: '1px solid var(--border-subtle)' }}>
        {[
          { key: 'search' as Tab, label: 'Semantic Search', icon: Search },
          { key: 'chat' as Tab, label: 'RAG Chat', icon: MessageSquare },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: '10px 20px', fontSize: '13px', fontWeight: tab === key ? 600 : 400,
              color: tab === key ? 'var(--accent-primary)' : 'var(--text-secondary)',
              borderBottom: tab === key ? '2px solid var(--accent-primary)' : '2px solid transparent',
              background: 'none', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '6px',
            }}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {/* Search tab */}
      {tab === 'search' && (
        <div>
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search your paper library..."
              className="input"
              style={{ flex: 1 }}
            />
            <button type="submit" disabled={searching || !searchQuery.trim()} className="btn btn-primary">
              {searching ? 'Searching...' : 'Search'}
            </button>
          </form>

          {searchResults.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {searchResults.map((r, i) => (
                <div key={i} style={{
                  padding: '16px', background: 'var(--bg-secondary)',
                  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                    <BookOpen size={12} style={{ color: 'var(--accent-primary)' }} />
                    <span style={{ fontSize: '11px', color: 'var(--accent-primary)', fontWeight: 500 }}>
                      {r.source_file}
                    </span>
                  </div>
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                    {r.content}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Chat tab */}
      {tab === 'chat' && (
        <div>
          <form onSubmit={handleChat} style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
            <input
              value={chatQuery}
              onChange={e => setChatQuery(e.target.value)}
              placeholder="Ask a question about your papers..."
              className="input"
              style={{ flex: 1 }}
            />
            <button type="submit" disabled={chatting || !chatQuery.trim()} className="btn btn-primary">
              {chatting ? 'Thinking...' : 'Ask'}
            </button>
          </form>

          {chatting && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite', marginBottom: '8px' }} />
              <p>Retrieving context and generating answer...</p>
            </div>
          )}

          {chatResponse && (
            <div style={{
              padding: '20px', background: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)',
            }}>
              <p style={{ fontSize: '14px', color: 'var(--text-primary)', lineHeight: 1.7, whiteSpace: 'pre-wrap', marginBottom: '16px' }}>
                {chatResponse.answer}
              </p>
              {chatResponse.sources.length > 0 && (
                <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>
                    Sources ({chatResponse.chunks_used} chunks):
                  </span>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                    {chatResponse.sources.map((s, i) => (
                      <span key={i} style={{
                        fontSize: '11px', padding: '2px 8px',
                        background: 'var(--bg-tertiary)', borderRadius: '4px',
                        color: 'var(--text-secondary)',
                      }}>
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
