import { useState, useEffect, useRef } from 'react'
import { Search, Database, MessageSquare, RefreshCw, Trash2, BookOpen, Terminal, Square, SlidersHorizontal } from 'lucide-react'
import {
  getKBStatus, searchKB, chatKB, resetKB,
  KBStatus, KBSearchResult, KBChatResponse,
} from '../api/client'
import { useToastStore } from '../store/toastStore'
import { useKnowledgeStore } from '../store/knowledgeStore'

type Tab = 'search' | 'chat'

export default function KnowledgeBase() {
  const addToast = useToastStore(s => s.addToast)
  const { indexing, logs, startIndex, stopIndex, connectEvents, disconnect } = useKnowledgeStore()
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
  const [chatModel, setChatModel] = useState('gpt-oss:120b')
  const [chatTemp, setChatTemp] = useState(0.7)
  const [chatTopK, setChatTopK] = useState(40)
  const [chatMaxTokens, setChatMaxTokens] = useState(2048)
  const [chatChunks, setChatChunks] = useState(5)
  const [showChatSettings, setShowChatSettings] = useState(false)

  const terminalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadStatus()
    // Reconnect to SSE if indexing is already running (e.g. navigated back)
    if (indexing) {
      connectEvents()
    }
    return () => disconnect()
  }, [])

  // Refresh status when indexing finishes
  useEffect(() => {
    if (!indexing && logs.length > 2) {
      loadStatus()
    }
  }, [indexing])

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [logs])

  async function loadStatus() {
    try {
      const s = await getKBStatus()
      setStatus(s)
    } catch {
      // KB not initialized yet
    }
  }

  function handleIndex(force = false) {
    startIndex(force).then(() => {
      // Toast will show via logs when done
    })
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
      const res = await chatKB({
        query: chatQuery.trim(),
        model: chatModel,
        k: chatChunks,
        temperature: chatTemp,
        top_k: chatTopK,
        max_tokens: chatMaxTokens,
      })
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
      useKnowledgeStore.getState().clearLogs()
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
          {indexing ? (
            <button
              onClick={stopIndex}
              className="btn btn-danger"
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Square size={14} fill="currentColor" />
              Stop Indexing
            </button>
          ) : (
            <button
              onClick={() => handleIndex(false)}
              className="btn btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Database size={14} />
              Index Papers
            </button>
          )}
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
      {logs.length > 0 && (
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
            {!indexing && logs.length > 2 && <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 'auto' }}>DONE</span>}
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
          <form onSubmit={handleChat} style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <input
              value={chatQuery}
              onChange={e => setChatQuery(e.target.value)}
              placeholder="Ask a question about your papers..."
              className="input"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              onClick={() => setShowChatSettings(!showChatSettings)}
              className="btn"
              style={{ padding: '10px', color: showChatSettings ? 'var(--accent-primary)' : 'var(--text-muted)' }}
              title="Chat settings"
            >
              <SlidersHorizontal size={16} />
            </button>
            <button type="submit" disabled={chatting || !chatQuery.trim()} className="btn btn-primary">
              {chatting ? 'Thinking...' : 'Ask'}
            </button>
          </form>

          {/* Chat settings panel */}
          {showChatSettings && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: '12px',
              marginBottom: '20px',
              padding: '16px',
              background: 'rgba(15, 23, 42, 0.5)',
              backdropFilter: 'blur(16px)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '14px',
              fontSize: '12px',
            }}>
              <div>
                <label style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Model</label>
                <select value={chatModel} onChange={e => setChatModel(e.target.value)} style={{ fontSize: '12px', padding: '8px 10px' }}>
                  <option value="gpt-oss:120b">gpt-oss:120b</option>
                  <option value="nemotron-3-nano:latest">nemotron-3-nano</option>
                  <option value="qwen2.5:14b">qwen2.5:14b</option>
                  <option value="qwen2.5-coder:32b">qwen2.5-coder:32b</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Temperature</label>
                <input type="number" min={0} max={2} step={0.1} value={chatTemp} onChange={e => setChatTemp(parseFloat(e.target.value) || 0)} style={{ fontSize: '12px', padding: '8px 10px' }} />
              </div>
              <div>
                <label style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Top K</label>
                <input type="number" min={1} max={100} value={chatTopK} onChange={e => setChatTopK(parseInt(e.target.value) || 40)} style={{ fontSize: '12px', padding: '8px 10px' }} />
              </div>
              <div>
                <label style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Max Tokens</label>
                <input type="number" min={256} max={8192} step={256} value={chatMaxTokens} onChange={e => setChatMaxTokens(parseInt(e.target.value) || 2048)} style={{ fontSize: '12px', padding: '8px 10px' }} />
              </div>
              <div>
                <label style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Chunks (k)</label>
                <input type="number" min={1} max={20} value={chatChunks} onChange={e => setChatChunks(parseInt(e.target.value) || 5)} style={{ fontSize: '12px', padding: '8px 10px' }} />
              </div>
            </div>
          )}

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
