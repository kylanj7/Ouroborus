import { useEffect, useCallback, useMemo } from 'react'
import { useGalaxyStore } from '../store/galaxyStore'
import GalaxyCanvas from '../components/galaxy/GalaxyCanvas'
import GalaxyControls from '../components/galaxy/GalaxyControls'
import PaperDetailPanel from '../components/galaxy/PaperDetail'
import DatasetDetailPanel from '../components/galaxy/DatasetDetail'

export default function Galaxy() {
  const {
    data, selectedNode, loading, error, searchQuery, activeCluster,
    fetchData, selectNode, clearSelection, setSearchQuery, setActiveCluster,
  } = useGalaxyStore()

  useEffect(() => {
    fetchData()
  }, [])

  // Split nodes into simulation nodes (papers+datasets) and QA nodes (rendered separately)
  const { simNodes, simLinks, qaNodes, qaParentMap } = useMemo(() => {
    if (!data) return { simNodes: [], simLinks: [], qaNodes: [], qaParentMap: new Map() }

    let allNodes = [...data.nodes]
    let allLinks = [...data.links]

    // Filter by cluster
    if (activeCluster !== null) {
      const clusterNodeIds = new Set(
        allNodes.filter(n => n.cluster === activeCluster).map(n => n.id)
      )
      allNodes = allNodes.filter(n => clusterNodeIds.has(n.id))
      allLinks = allLinks.filter(l => {
        const src = typeof l.source === 'string' ? l.source : (l.source as any).id
        const tgt = typeof l.target === 'string' ? l.target : (l.target as any).id
        return clusterNodeIds.has(src) && clusterNodeIds.has(tgt)
      })
    }

    // Search highlighting
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      allNodes = allNodes.map(n => ({
        ...n,
        _match: n.label.toLowerCase().includes(q) ||
          (n.type === 'qa' && n.instruction?.toLowerCase().includes(q)),
      }))
    }

    // Separate QA nodes out of the force simulation
    const sNodes = allNodes.filter(n => n.type !== 'qa')
    const qNodes = allNodes.filter(n => n.type === 'qa')

    // Build parent map from QA links (paper_qa / dataset_qa)
    const parentMap = new Map<string, string>()
    for (const link of allLinks) {
      if (link.type === 'paper_qa' || link.type === 'dataset_qa') {
        const src = typeof link.source === 'string' ? link.source : (link.source as any).id
        const tgt = typeof link.target === 'string' ? link.target : (link.target as any).id
        parentMap.set(tgt, src)
      }
    }

    // Only pass non-QA links to the force simulation
    const sLinks = allLinks.filter(l => l.type !== 'paper_qa' && l.type !== 'dataset_qa')

    return { simNodes: sNodes, simLinks: sLinks, qaNodes: qNodes, qaParentMap: parentMap }
  }, [data, searchQuery, activeCluster])

  // Papers in the selected dataset's cluster (for dataset detail panel)
  const datasetPapers = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'dataset') return []
    return simNodes.filter(
      (n: any) => n.type === 'paper' && n.cluster === selectedNode.node.cluster,
    )
  }, [selectedNode, simNodes])

  const handleNodeClick = useCallback((node: any) => {
    selectNode(node)
  }, [selectNode])

  const handleDatasetPaperClick = useCallback((paperNode: any) => {
    selectNode(paperNode)
  }, [selectNode])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}><div className="spinner" /></div>
  }

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--accent-red, #ff6b6b)' }}>
        <h3>Galaxy Error</h3>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '13px', maxWidth: '600px', margin: '0 auto' }}>{error}</pre>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height: 'calc(100vh - 48px)' }}>
      {/* Controls overlay (search + cluster toggles) */}
      <div style={{
        position: 'absolute', top: '16px', left: '16px', zIndex: 10,
      }}>
        <GalaxyControls
          searchQuery={searchQuery}
          onSearch={setSearchQuery}
          clusters={data?.clusters || []}
          activeCluster={activeCluster}
          onToggleCluster={setActiveCluster}
        />
      </div>

      {/* Graph */}
      <GalaxyCanvas
        nodes={simNodes}
        links={simLinks}
        qaNodes={qaNodes}
        qaParentMap={qaParentMap}
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
