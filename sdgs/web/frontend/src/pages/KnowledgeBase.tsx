import { useState, useEffect, useRef } from 'react'
import { Search, Database, MessageSquare, RefreshCw, Trash2, BookOpen, Terminal, Square } from 'lucide-react'
import {
  getKBStatus, searchKB, chatKB, resetKB,
  KBStatus, KBSearchResult,
} from '../api/client'
import { HelpCircle } from 'lucide-react'
import { useToastStore } from '../store/toastStore'
import { useKnowledgeStore } from '../store/knowledgeStore'
import MarkdownRenderer from '../components/common/MarkdownRenderer'

type Tab = 'search' | 'chat'

function SettingLabel({ label, tooltip }: { label: string; tooltip: string }) {
  const [show, setShow] = useState(false)
  return (
    <label style={{
      fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px',
      display: 'flex', alignItems: 'center', gap: '4px',
      textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600,
      position: 'relative',
    }}>
      {label}
      <span
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        style={{ cursor: 'help', display: 'inline-flex', position: 'relative' }}
      >
        <HelpCircle size={10} style={{ opacity: show ? 0.9 : 0.4, transition: 'opacity 0.15s' }} />
        {show && (
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: '8px',
            width: '220px',
            padding: '10px 12px',
            background: 'rgba(8, 12, 28, 0.95)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(74, 222, 128, 0.15)',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            fontSize: '11px',
            fontWeight: 400,
            lineHeight: 1.5,
            color: 'var(--text-secondary)',
            textTransform: 'none',
            letterSpacing: 'normal',
            whiteSpace: 'normal',
            zIndex: 50,
            pointerEvents: 'none',
          }}>
            {tooltip}
            <div style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              width: 0, height: 0,
              borderLeft: '6px solid transparent',
              borderRight: '6px solid transparent',
              borderTop: '6px solid rgba(74, 222, 128, 0.15)',
            }} />
          </div>
        )}
      </span>
    </label>
  )
}

export default function KnowledgeBase() {
  const addToast = useToastStore(s => s.addToast)
  const {
    indexing, logs, startIndex, stopIndex, connectEvents, disconnect,
    chatHistory, chatting, addUserMessage, addAssistantMessage, setChatting,
    sessions, activeSessionId, newChat, switchSession, deleteSession, clearChat,
  } = useKnowledgeStore()
  const [tab, setTab] = useState<Tab>('search')
  const [status, setStatus] = useState<KBStatus | null>(null)
  const [loading, setLoading] = useState(false)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KBSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  // Chat input state (only the input field is local)
  const [chatQuery, setChatQuery] = useState('')
  const [chatModel, setChatModel] = useState('gpt-oss:120b')
  const [chatTemp, setChatTemp] = useState(0.7)
  const [chatTopK, setChatTopK] = useState(5)
  const [chatMaxTokens, setChatMaxTokens] = useState(4096)
  const [chatChunks, setChatChunks] = useState(5)

  const terminalRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

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

  // Auto-scroll chat
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatHistory, chatting])

  async function handleChat(e: React.FormEvent) {
    e.preventDefault()
    if (!chatQuery.trim()) return
    const query = chatQuery.trim()
    addUserMessage(query)
    setChatQuery('')
    setChatting(true)
    try {
      const res = await chatKB({
        query,
        model: chatModel,
        k: chatChunks,
        temperature: chatTemp,
        top_k: chatTopK,
        max_tokens: chatMaxTokens,
      })
      addAssistantMessage(res)
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
      clearChat()
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
        <div style={{ display: 'flex', gap: '16px', height: 'calc(100vh - 380px)', minHeight: '300px' }}>
          {/* Session sidebar */}
          <div style={{
            width: '220px',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-subtle)',
            overflow: 'hidden',
          }}>
            <button
              onClick={newChat}
              className="btn btn-primary"
              style={{
                margin: '10px',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                fontSize: '12px', padding: '8px',
              }}
            >
              <MessageSquare size={12} />
              New Chat
            </button>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 6px 6px' }}>
              {sessions.map(s => (
                <div
                  key={s.id}
                  onClick={() => switchSession(s.id)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    marginBottom: '2px',
                    background: s.id === activeSessionId
                      ? 'rgba(74, 222, 128, 0.1)'
                      : 'transparent',
                    border: s.id === activeSessionId
                      ? '1px solid rgba(74, 222, 128, 0.15)'
                      : '1px solid transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => {
                    if (s.id !== activeSessionId) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                  }}
                  onMouseLeave={e => {
                    if (s.id !== activeSessionId) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{
                      fontSize: '12px',
                      color: s.id === activeSessionId ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontWeight: s.id === activeSessionId ? 500 : 400,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {s.title}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {s.messages.length} messages
                    </div>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); deleteSession(s.id) }}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-muted)', padding: '2px', flexShrink: 0,
                      opacity: 0.5, fontSize: '12px',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = '#F87171' }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.color = 'var(--text-muted)' }}
                    title="Delete chat"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {sessions.length === 0 && (
                <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px' }}>
                  No saved chats
                </div>
              )}
            </div>
          </div>

          {/* Chat main area */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

          {/* Chat history */}
          <div style={{
            flex: 1, overflowY: 'auto', marginBottom: '12px',
            display: 'flex', flexDirection: 'column', gap: '12px',
          }}>
            {chatHistory.length === 0 && !chatting && (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                Ask a question about your indexed papers
              </div>
            )}

            {chatHistory.map((msg, i) => (
              <div key={i} style={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}>
                <div style={{
                  maxWidth: msg.role === 'user' ? '70%' : '85%',
                  padding: '12px 16px',
                  borderRadius: '12px',
                  background: msg.role === 'user'
                    ? 'linear-gradient(135deg, rgba(74, 222, 128, 0.15), rgba(6, 182, 212, 0.1))'
                    : 'var(--bg-secondary)',
                  border: msg.role === 'user'
                    ? '1px solid rgba(74, 222, 128, 0.2)'
                    : '1px solid var(--border-subtle)',
                }}>
                  {msg.role === 'assistant' ? (
                    <MarkdownRenderer content={msg.content} />
                  ) : (
                    <p style={{
                      fontSize: '13px',
                      color: 'var(--text-primary)',
                      lineHeight: 1.7,
                      margin: 0,
                    }}>
                      {msg.content}
                    </p>
                  )}
                  {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '8px', marginTop: '10px' }}>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 500 }}>
                        Sources ({msg.chunks_used} chunks):
                      </span>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                        {msg.sources.map((s, j) => (
                          <span key={j} style={{
                            fontSize: '10px', padding: '1px 6px',
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
              </div>
            ))}

            {chatting && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{
                  padding: '12px 16px',
                  borderRadius: '12px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex', alignItems: 'center', gap: '8px',
                  color: 'var(--text-muted)', fontSize: '13px',
                }}>
                  <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  Retrieving context and generating answer...
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Chat input */}
          <form onSubmit={handleChat} style={{ display: 'flex', gap: '8px' }}>
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

          {/* Chat settings panel */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: '12px',
              marginTop: '8px',
              padding: '12px 16px',
              background: 'rgba(15, 23, 42, 0.5)',
              backdropFilter: 'blur(16px)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '12px',
              fontSize: '12px',
            }}>
              <div>
                <SettingLabel label="Model" tooltip="The local LLM that generates your answer. Larger models (120B) reason better over complex papers but respond slower. Smaller models (nano) are fast for quick lookups." />
                <select value={chatModel} onChange={e => setChatModel(e.target.value)} style={{ fontSize: '12px', padding: '8px 10px' }}>
                  <option value="gpt-oss:120b">gpt-oss:120b</option>
                  <option value="nemotron-3-nano:latest">nemotron-3-nano</option>
                  <option value="qwen2.5:14b">qwen2.5:14b</option>
                  <option value="qwen2.5-coder:32b">qwen2.5-coder:32b</option>
                </select>
              </div>
              <div>
                <SettingLabel label="Temperature" tooltip="Controls output randomness during generation. At 0 the model always picks the most likely token -- great for factual recall. Above 1.0 it gets creative and exploratory. 0.7 balances accuracy with natural phrasing." />
                <input type="number" min={0} max={2} step={0.1} value={chatTemp} onChange={e => setChatTemp(parseFloat(e.target.value) || 0)} style={{ fontSize: '12px', padding: '8px 10px' }} />
              </div>
              <div>
                <SettingLabel label="Top K" tooltip="Limits token selection to the K most probable next words at each generation step. Low values (5) keep responses focused and precise. High values (40+) allow more varied vocabulary but may introduce noise. This affects how the model writes -- not what documents it reads." />
                <input type="number" min={1} max={100} value={chatTopK} onChange={e => setChatTopK(parseInt(e.target.value) || 5)} style={{ fontSize: '12px', padding: '8px 10px' }} />
              </div>
              <div>
                <SettingLabel label="Max Tokens" tooltip="Caps the response length. One token is roughly 3/4 of a word. 4096 tokens is about 3000 words -- enough for detailed explanations. Reduce for quick, concise answers. The model stops early if it finishes naturally." />
                <input type="number" min={256} max={8192} step={256} value={chatMaxTokens} onChange={e => setChatMaxTokens(parseInt(e.target.value) || 2048)} style={{ fontSize: '12px', padding: '8px 10px' }} />
              </div>
              <div>
                <SettingLabel label="Chunks" tooltip="Number of text passages retrieved from ChromaDB as context before generating. More chunks give the model broader source material but can dilute focus. 5 is a good default -- increase for broad survey questions, decrease for precise lookups." />
                <input type="number" min={1} max={20} value={chatChunks} onChange={e => setChatChunks(parseInt(e.target.value) || 5)} style={{ fontSize: '12px', padding: '8px 10px' }} />
              </div>
            </div>
          </div>{/* end chat main area */}
        </div>
      )}
    </div>
  )
}
