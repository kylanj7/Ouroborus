import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Search, ExternalLink, Download, ChevronLeft, ChevronRight, HardDrive, Sparkles, Plus, Trash2 } from 'lucide-react'
import { getPapers, getPaperTopics, downloadPaperPdf, scrapePapers, scrapePapersStream, bulkDeletePapers, PaperInfo, ScrapeProgressEvent } from '../api/client'
import { useToastStore } from '../store/toastStore'

export default function Papers() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const [papers, setPapers] = useState<PaperInfo[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState(searchParams.get('search') || '')
  const [loading, setLoading] = useState(true)
  const [topics, setTopics] = useState<string[]>([])
  const [selectedTopic, setSelectedTopic] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [showScrape, setShowScrape] = useState(false)
  const [scrapeTopic, setScrapeTopic] = useState('')
  const [scrapeCount, setScrapeCount] = useState(20)
  const [scrapeYearMin, setScrapeYearMin] = useState<string>('')
  const [scrapeYearMax, setScrapeYearMax] = useState<string>('')
  const [scrapeSources, setScrapeSources] = useState<Set<string>>(new Set(['arxiv', 'semantic_scholar', 'openalex', 'core']))
  const [scraping, setScraping] = useState(false)
  const [scrapeMsg, setScrapeMsg] = useState('')
  const [scrapeLogs, setScrapeLogs] = useState<ScrapeProgressEvent[]>([])
  const cancelScrapeRef = useRef<(() => void) | null>(null)

  const datasetId = searchParams.get('dataset_id')
    ? Number(searchParams.get('dataset_id'))
    : undefined

  useEffect(() => {
    getPaperTopics().then(setTopics).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    getPapers(page, search || undefined, datasetId, selectedTopic || undefined)
      .then((res) => {
        setPapers(res.papers)
        setTotal(res.total)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [page, search, datasetId, selectedTopic])

  const totalPages = Math.ceil(total / 50)

  const handleSearch = (val: string) => {
    setSearch(val)
    setPage(1)
    setSelectedIds(new Set())
    const params = new URLSearchParams(searchParams)
    if (val) params.set('search', val)
    else params.delete('search')
    setSearchParams(params, { replace: true })
  }

  const handleTopicChange = (val: string) => {
    setSelectedTopic(val)
    setPage(1)
    setSelectedIds(new Set())
  }

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    const currentPageIds = papers.map((p) => p.id)
    const allSelected = currentPageIds.every((id) => selectedIds.has(id))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        currentPageIds.forEach((id) => next.delete(id))
      } else {
        currentPageIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  const addToast = useToastStore((s) => s.addToast)

  const handleGenerateFromSelected = () => {
    const ids = Array.from(selectedIds).join(',')
    navigate(`/create?from_papers=${ids}`)
  }

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selectedIds.size} selected paper(s)?`)) return
    try {
      const res = await bulkDeletePapers(Array.from(selectedIds))
      addToast('success', `Deleted ${res.deleted} paper(s)`)
      setSelectedIds(new Set())
      setPage(1)
      setLoading(true)
      getPapers(1, search || undefined, datasetId, selectedTopic || undefined)
        .then((r) => { setPapers(r.papers); setTotal(r.total) })
        .catch(() => {})
        .finally(() => setLoading(false))
      getPaperTopics().then(setTopics).catch(() => {})
    } catch {
      addToast('error', 'Failed to delete papers')
    }
  }

  const toggleSource = (src: string) => {
    setScrapeSources((prev) => {
      const next = new Set(prev)
      if (next.has(src)) {
        if (next.size > 1) next.delete(src)
      } else {
        next.add(src)
      }
      return next
    })
  }

  const handleScrape = () => {
    if (!scrapeTopic.trim()) return
    setScraping(true)
    setScrapeMsg('')
    setScrapeLogs([])

    const yearMin = scrapeYearMin ? parseInt(scrapeYearMin) : null
    const yearMax = scrapeYearMax ? parseInt(scrapeYearMax) : null
    const sources = scrapeSources.size < 4 ? Array.from(scrapeSources) : null

    const cancel = scrapePapersStream(
      scrapeTopic.trim(),
      scrapeCount,
      yearMin,
      yearMax,
      sources,
      (event) => {
        setScrapeLogs((prev) => [...prev, event])
      },
      (event) => {
        setScrapeLogs((prev) => [...prev, event])
        setScraping(false)
        addToast('success', event.message)
        setScrapeMsg(event.message)
        setShowScrape(false)
        setScrapeTopic('')
        setScrapeCount(20)
        setScrapeYearMin('')
        setScrapeYearMax('')
        setScrapeSources(new Set(['arxiv', 'semantic_scholar', 'openalex', 'core']))
        setPage(1)
        getPaperTopics().then(setTopics).catch(() => {})
        setLoading(true)
        getPapers(1, search || undefined, datasetId, selectedTopic || undefined)
          .then((r) => { setPapers(r.papers); setTotal(r.total) })
          .catch(() => {})
          .finally(() => setLoading(false))
      },
    )
    cancelScrapeRef.current = cancel
  }

  const allOnPageSelected = papers.length > 0 && papers.every((p) => selectedIds.has(p.id))

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>PDF Database <span style={{ fontSize: '14px', fontWeight: 400, color: 'var(--text-muted)' }}>({total} papers)</span></h1>
          <p>All scholarly papers used in dataset generation</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {selectedIds.size > 0 && (
            <>
              <button className="btn btn-primary" onClick={handleGenerateFromSelected}>
                <Sparkles size={16} />
                Generate from {selectedIds.size} Selected
              </button>
              <button className="btn btn-danger" onClick={handleBulkDelete}>
                <Trash2 size={16} />
                Delete {selectedIds.size}
              </button>
            </>
          )}
          <button className="btn btn-primary" onClick={() => setShowScrape(!showScrape)}>
            <Plus size={16} />
            Scrape Papers
          </button>
        </div>
      </div>

      {/* Scrape Form */}
      {showScrape && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Topic</label>
              <input
                type="text"
                placeholder="e.g. quantum computing, superconductors..."
                value={scrapeTopic}
                onChange={(e) => setScrapeTopic(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleScrape()}
                autoFocus
                style={{ width: '100%', fontSize: '14px' }}
              />
            </div>
            <div style={{ width: '100px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Max papers</label>
              <input
                type="number"
                min={1}
                max={200}
                value={scrapeCount}
                onChange={(e) => setScrapeCount(Math.max(1, parseInt(e.target.value) || 1))}
                style={{ width: '100%', fontSize: '14px' }}
              />
            </div>
            <div style={{ width: '90px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Year from</label>
              <input
                type="number"
                min={1900}
                max={2030}
                placeholder="e.g. 1999"
                value={scrapeYearMin}
                onChange={(e) => setScrapeYearMin(e.target.value)}
                style={{ width: '100%', fontSize: '14px' }}
              />
            </div>
            <div style={{ width: '90px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Year to</label>
              <input
                type="number"
                min={1900}
                max={2030}
                placeholder="e.g. 2017"
                value={scrapeYearMax}
                onChange={(e) => setScrapeYearMax(e.target.value)}
                style={{ width: '100%', fontSize: '14px' }}
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={handleScrape}
              disabled={scraping || !scrapeTopic.trim()}
              style={{ whiteSpace: 'nowrap' }}
            >
              {scraping ? <span className="spinner" style={{ width: '14px', height: '14px' }} /> : 'Search'}
            </button>
            <button className="btn" onClick={() => { if (!scraping) setShowScrape(false) }} disabled={scraping}>
              Cancel
            </button>
          </div>
          {/* Source filter */}
          <div style={{ display: 'flex', gap: '10px', marginTop: '10px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sources:</span>
            {([
              ['arxiv', 'arXiv'],
              ['semantic_scholar', 'Semantic Scholar'],
              ['openalex', 'OpenAlex'],
              ['core', 'CORE'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => toggleSource(key)}
                style={{
                  fontSize: '12px',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  border: `1px solid ${scrapeSources.has(key) ? 'var(--accent-blue)' : 'var(--border-primary)'}`,
                  background: scrapeSources.has(key) ? 'rgba(68, 147, 248, 0.15)' : 'transparent',
                  color: scrapeSources.has(key) ? 'var(--accent-blue)' : 'var(--text-muted)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {!scraping && scrapeLogs.length === 0 && (
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px', marginBottom: 0 }}>
              Searches arXiv, Semantic Scholar, OpenAlex, and CORE for scholarly papers.
            </p>
          )}

          {/* Live feed */}
          {(scraping || scrapeLogs.length > 0) && (
            <div style={{
              marginTop: '12px',
              background: 'rgba(2, 6, 18, 0.6)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '12px',
              padding: '14px 18px',
              fontFamily: '"JetBrains Mono", "Fira Code", monospace',
              fontSize: '12px',
              lineHeight: 1.8,
              maxHeight: '200px',
              overflowY: 'auto',
            }}>
              {scrapeLogs.map((log, i) => {
                let color = 'var(--text-secondary)'
                if (log.stage === 'source_done') color = 'var(--accent-primary)'
                else if (log.stage === 'source_error') color = 'var(--status-failed)'
                else if (log.stage === 'searching') color = 'var(--accent-purple)'
                else if (log.stage === 'done') color = 'var(--accent-primary)'
                else if (log.stage === 'saving' || log.stage === 'dedup') color = 'var(--accent-blue)'

                return (
                  <div key={i} style={{ color, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {log.stage === 'searching' && <span className="spinner" style={{ width: 10, height: 10 }} />}
                    {log.stage === 'source_done' && <span style={{ color: 'var(--accent-primary)' }}>+</span>}
                    {log.stage === 'done' && <span>+</span>}
                    <span>{log.message}</span>
                  </div>
                )
              })}
              {scraping && scrapeLogs.length > 0 && scrapeLogs[scrapeLogs.length - 1].stage === 'searching' && null}
              {scraping && (
                <div style={{ color: 'var(--accent-purple)' }}>
                  <span style={{ animation: 'blink 1s step-end infinite' }}>_</span>
                </div>
              )}
              {/* Progress bar */}
              {scraping && scrapeLogs.length > 0 && (() => {
                const last = scrapeLogs[scrapeLogs.length - 1]
                if (last.sources_total && last.sources_done !== undefined) {
                  const pct = (last.sources_done / last.sources_total) * 100
                  return (
                    <div style={{ marginTop: '8px', background: 'rgba(255,255,255,0.04)', borderRadius: '4px', height: '3px', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--gradient-green)', transition: 'width 0.5s ease', borderRadius: '4px' }} />
                    </div>
                  )
                }
                return null
              })()}
            </div>
          )}
        </div>
      )}

      {scrapeMsg && (
        <div style={{
          background: 'rgba(34, 197, 94, 0.1)',
          border: '1px solid rgba(34, 197, 94, 0.3)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
          color: 'var(--accent-green)',
          fontSize: '13px',
          marginBottom: '16px',
        }}>
          {scrapeMsg}
        </div>
      )}

      {/* Search + Topic Filter */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search
            size={16}
            style={{
              position: 'absolute',
              left: '12px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
            }}
          />
          <input
            type="text"
            placeholder="Search papers by title..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            style={{ paddingLeft: '36px', fontSize: '14px', width: '100%' }}
          />
        </div>
        {topics.length > 0 && (
          <select
            value={selectedTopic}
            onChange={(e) => handleTopicChange(e.target.value)}
            style={{ width: '220px', fontSize: '14px' }}
          >
            <option value="">All Topics</option>
            {topics.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        )}
      </div>

      {datasetId && (
        <div style={{
          marginBottom: '16px',
          padding: '8px 12px',
          background: 'rgba(59, 130, 246, 0.1)',
          border: '1px solid rgba(59, 130, 246, 0.2)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '13px',
          color: 'var(--text-secondary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>Showing papers for dataset #{datasetId}</span>
          <button
            onClick={() => {
              const params = new URLSearchParams(searchParams)
              params.delete('dataset_id')
              setSearchParams(params, { replace: true })
            }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent-blue)',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Show all
          </button>
        </div>
      )}

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <th style={{ ...thStyle, width: '40px', textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={toggleSelectAll}
                  style={{ cursor: 'pointer' }}
                />
              </th>
              <th style={thStyle}>Title</th>
              <th style={{ ...thStyle, width: '180px' }}>Authors</th>
              <th style={{ ...thStyle, width: '60px', textAlign: 'center' }}>Year</th>
              <th style={{ ...thStyle, width: '70px', textAlign: 'center' }}>Source</th>
              <th style={{ ...thStyle, width: '80px', textAlign: 'right' }}>Citations</th>
              <th style={{ ...thStyle, width: '60px', textAlign: 'right' }}>QA</th>
              <th style={{ ...thStyle, width: '40px' }}></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  <span className="spinner" />
                </td>
              </tr>
            ) : papers.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  {search ? 'No papers match your search' : 'No papers yet. Generate a dataset to see papers here.'}
                </td>
              </tr>
            ) : (
              papers.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                      style={{ cursor: 'pointer' }}
                    />
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1.4, display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {(p.pdf_path || p.pdf_url) ? (
                        <a
                          href="#"
                          onClick={async (e) => {
                            e.preventDefault()
                            try {
                              const res = await fetch(`/api/papers/${p.id}/pdf`, {
                                headers: { Authorization: `Bearer ${localStorage.getItem('access_token') || ''}` },
                              })
                              if (!res.ok) return
                              const blob = await res.blob()
                              const url = URL.createObjectURL(blob)
                              window.open(url, '_blank')
                            } catch { /* ignore */ }
                          }}
                          style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}
                          title="View PDF"
                        >
                          {p.title}
                        </a>
                      ) : (
                        p.title
                      )}
                      {p.pdf_path && (
                        <span title="PDF saved locally" style={{ display: 'flex', flexShrink: 0 }}>
                          <HardDrive size={12} style={{ color: 'var(--accent-green)' }} />
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>
                    {p.authors.length > 0
                      ? p.authors.length <= 2
                        ? p.authors.join(', ')
                        : `${p.authors[0]} et al.`
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                    }
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center', color: 'var(--text-secondary)' }}>
                    {p.year || '—'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    {p.source ? (
                      <span style={{
                        fontSize: '11px',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        background: p.source === 'arxiv' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(34, 197, 94, 0.12)',
                        color: p.source === 'arxiv' ? 'var(--accent-blue)' : 'var(--accent-green)',
                      }}>
                        {p.source === 'semantic_scholar' ? 'S2' : p.source}
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-secondary)' }}>
                    {p.citation_count > 0 ? p.citation_count.toLocaleString() : '—'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-secondary)' }}>
                    {p.qa_pair_count > 0 ? p.qa_pair_count : '—'}
                  </td>
                  <td style={tdStyle}>
                    {(p.pdf_path || p.pdf_url) ? (
                      <button
                        onClick={() => downloadPaperPdf(p.id, p.title)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--accent-blue)',
                          display: 'flex',
                          cursor: 'pointer',
                          padding: 0,
                        }}
                        title="Download PDF"
                      >
                        <Download size={14} />
                      </button>
                    ) : p.url ? (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--text-muted)', display: 'flex' }}
                        title="Open paper"
                      >
                        <ExternalLink size={14} />
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '12px',
          marginTop: '16px',
          fontSize: '13px',
          color: 'var(--text-secondary)',
        }}>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={paginationBtnStyle}
          >
            <ChevronLeft size={16} />
          </button>
          <span>Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            style={paginationBtnStyle}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding: '10px 12px',
  textAlign: 'left',
  fontWeight: 500,
  color: 'var(--text-muted)',
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
}

const tdStyle: React.CSSProperties = {
  padding: '10px 12px',
  verticalAlign: 'top',
}

const paginationBtnStyle: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border-primary)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  padding: '4px 8px',
  display: 'flex',
  alignItems: 'center',
}
