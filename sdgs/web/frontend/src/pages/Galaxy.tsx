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

  // Inline graph filtering (replaces useGalaxyGraph hook)
  const graphData = useMemo(() => {
    if (!data) return { nodes: [], links: [] }

    let nodes = [...data.nodes]
    let links = [...data.links]

    // Filter by cluster
    if (activeCluster !== null) {
      const clusterNodeIds = new Set(
        nodes.filter(n => n.cluster === activeCluster).map(n => n.id)
      )
      nodes = nodes.filter(n => clusterNodeIds.has(n.id))
      links = links.filter(l => {
        const src = typeof l.source === 'string' ? l.source : (l.source as any).id
        const tgt = typeof l.target === 'string' ? l.target : (l.target as any).id
        return clusterNodeIds.has(src) && clusterNodeIds.has(tgt)
      })
    }

    // Search highlighting
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      nodes = nodes.map(n => ({
        ...n,
        _match: n.label.toLowerCase().includes(q) ||
          (n.type === 'qa' && n.instruction?.toLowerCase().includes(q)),
      }))
    }

    return { nodes, links }
  }, [data, searchQuery, activeCluster])

  // Papers in the selected dataset's cluster (for dataset detail panel)
  const datasetPapers = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'dataset') return []
    return graphData.nodes.filter(
      (n: any) => n.type === 'paper' && n.cluster === selectedNode.node.cluster,
    )
  }, [selectedNode, graphData.nodes])

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
        nodes={graphData.nodes}
        links={graphData.links}
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
