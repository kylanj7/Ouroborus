import { useEffect, useCallback, useMemo } from 'react'
import { useGalaxyStore } from '../store/galaxyStore'
import GalaxyCanvas from '../components/galaxy/GalaxyCanvas'
import PaperDetailPanel from '../components/galaxy/PaperDetail'
import DatasetDetailPanel from '../components/galaxy/DatasetDetail'
import { Search } from 'lucide-react'

export default function Galaxy() {
  const {
    data, selectedNode, loading, error, searchQuery,
    fetchData, selectNode, clearSelection, setSearchQuery,
  } = useGalaxyStore()

  useEffect(() => { fetchData() }, [])

  // Papers + datasets only -- no QA nodes in the graph
  const { graphNodes, graphLinks } = useMemo(() => {
    if (!data) return { graphNodes: [], graphLinks: [] }

    const nodes = data.nodes.filter(n => n.type !== 'qa')
    const links = data.links.filter(l => l.type !== 'paper_qa' && l.type !== 'dataset_qa')

    // Search highlighting
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      return {
        graphNodes: nodes.map(n => ({ ...n, _match: n.label.toLowerCase().includes(q) })),
        graphLinks: links,
      }
    }
    return { graphNodes: nodes, graphLinks: links }
  }, [data, searchQuery])

  const datasetPapers = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'dataset') return []
    return graphNodes.filter((n: any) => n.type === 'paper' && n.cluster === selectedNode.node.cluster)
  }, [selectedNode, graphNodes])

  const handleNodeClick = useCallback((node: any) => selectNode(node), [selectNode])
  const handleDatasetPaperClick = useCallback((node: any) => selectNode(node), [selectNode])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}><div className="spinner" /></div>
  }

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: '#ff6b6b' }}>
        <h3>Knowledge Graph Error</h3>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '13px', maxWidth: '600px', margin: '0 auto' }}>{error}</pre>
      </div>
    )
  }

  const paperCount = graphNodes.filter(n => n.type === 'paper').length
  const datasetCount = graphNodes.filter(n => n.type === 'dataset').length

  return (
    <div style={{ position: 'relative', height: 'calc(100vh - 48px)' }}>
      {/* Search + stats overlay */}
      <div style={{ position: 'absolute', top: '16px', left: '16px', zIndex: 10, width: '220px' }}>
        <div className="card" style={{ padding: '12px' }}>
          <div style={{ position: 'relative', marginBottom: '8px' }}>
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search papers..."
              style={{ paddingLeft: '32px', fontSize: '13px' }}
            />
            <Search size={14} style={{
              position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
            }} />
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '12px' }}>
            <span>{paperCount} papers</span>
            <span>{datasetCount} datasets</span>
            <span>{graphLinks.length} links</span>
          </div>
        </div>
      </div>

      {/* Graph */}
      <GalaxyCanvas
        nodes={graphNodes}
        links={graphLinks}
        searchQuery={searchQuery}
        onNodeClick={handleNodeClick}
      />

      {/* Paper detail -- shows QA pairs when you click a paper */}
      {selectedNode?.type === 'paper' && selectedNode.detail && (
        <PaperDetailPanel paper={selectedNode.detail} onClose={clearSelection} />
      )}

      {/* Dataset detail */}
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
