import { useEffect, useCallback, useMemo } from 'react'
import { useGalaxyStore } from '../store/galaxyStore'
import GalaxyCanvas from '../components/galaxy/GalaxyCanvas'
import GalaxyControls from '../components/galaxy/GalaxyControls'
import PaperDetailPanel from '../components/galaxy/PaperDetail'
import DatasetDetailPanel from '../components/galaxy/DatasetDetail'

export default function Galaxy() {
  const {
    data, selectedNode, loading, error, searchQuery, activeFilter,
    fetchData, selectNode, clearSelection, setSearchQuery, setActiveFilter,
  } = useGalaxyStore()

  useEffect(() => {
    fetchData()
  }, [])

  // Process all nodes -- search highlighting, parent maps
  const { simNodes, simLinks, qaNodes, qaParentMap, qaParentIds } = useMemo(() => {
    if (!data) return { simNodes: [], simLinks: [], qaNodes: [], qaParentMap: new Map(), qaParentIds: new Set<string>() }

    const allNodes = [...data.nodes]
    const allLinks = [...data.links]

    // Search highlighting
    const processed = searchQuery
      ? allNodes.map(n => ({
          ...n,
          _match: n.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (n.type === 'qa' && n.instruction?.toLowerCase().includes(searchQuery.toLowerCase())),
        }))
      : allNodes

    const sNodes = processed.filter(n => n.type !== 'qa')
    const qNodes = processed.filter(n => n.type === 'qa')

    // Build parent map
    const parentMap = new Map<string, string>()
    const pIds = new Set<string>()
    for (const link of allLinks) {
      if (link.type === 'paper_qa' || link.type === 'dataset_qa') {
        const src = typeof link.source === 'string' ? link.source : (link.source as any).id
        const tgt = typeof link.target === 'string' ? link.target : (link.target as any).id
        parentMap.set(tgt, src)
        pIds.add(src)
      }
    }

    const sLinks = allLinks.filter(l => l.type !== 'paper_qa' && l.type !== 'dataset_qa')

    return { simNodes: sNodes, simLinks: sLinks, qaNodes: qNodes, qaParentMap: parentMap, qaParentIds: pIds }
  }, [data, searchQuery])

  const paperCount = useMemo(() => simNodes.filter(n => n.type === 'paper').length, [simNodes])
  const qaCount = qaNodes.length

  const datasetPapers = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'dataset') return []
    return simNodes.filter((n: any) => n.type === 'paper' && n.cluster === selectedNode.node.cluster)
  }, [selectedNode, simNodes])

  const handleNodeClick = useCallback((node: any) => selectNode(node), [selectNode])
  const handleDatasetPaperClick = useCallback((node: any) => selectNode(node), [selectNode])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}><div className="spinner" /></div>
  }

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--accent-red, #ff6b6b)' }}>
        <h3>Knowledge Graph Error</h3>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '13px', maxWidth: '600px', margin: '0 auto' }}>{error}</pre>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height: 'calc(100vh - 48px)' }}>
      {/* Controls */}
      <div style={{ position: 'absolute', top: '16px', left: '16px', zIndex: 10 }}>
        <GalaxyControls
          searchQuery={searchQuery}
          onSearch={setSearchQuery}
          paperCount={paperCount}
          qaCount={qaCount}
          activeFilter={activeFilter}
          onToggleFilter={setActiveFilter}
        />
      </div>

      {/* Stats overlay */}
      <div style={{
        position: 'absolute', bottom: '12px', left: '16px', zIndex: 10,
        fontSize: '11px', color: 'rgba(180, 190, 210, 0.5)', fontFamily: 'monospace',
      }}>
        {simNodes.length} papers / {qaCount} QA / {simLinks.length} links
      </div>

      {/* Graph */}
      <GalaxyCanvas
        nodes={simNodes}
        links={simLinks}
        qaNodes={qaNodes}
        qaParentMap={qaParentMap}
        qaParentIds={qaParentIds}
        activeFilter={activeFilter}
        searchQuery={searchQuery}
        onNodeClick={handleNodeClick}
      />

      {/* Paper detail panel */}
      {selectedNode?.type === 'paper' && selectedNode.detail && (
        <PaperDetailPanel paper={selectedNode.detail} onClose={clearSelection} />
      )}

      {/* Dataset detail panel */}
      {selectedNode?.type === 'dataset' && (
        <DatasetDetailPanel
          node={selectedNode.node}
          papers={datasetPapers}
          onPaperClick={handleDatasetPaperClick}
          onClose={clearSelection}
        />
      )}
    </div>
  )
}
