import { useCallback, useRef, useEffect, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'

// Neo4j Bloom dark mode palette
const BLOOM = {
  bg: '#0d0d1a',
  nodeGlow: 0.4,
  linkAlpha: 0.15,
  labelColor: 'rgba(220, 225, 240, 0.85)',
  labelFont: '11px Inter, sans-serif',
  clusterLabelFont: 'bold 13px Inter, sans-serif',
}

type ActiveFilter = 'paper' | 'qa' | null

interface Props {
  nodes: any[]
  links: any[]
  qaNodes: any[]
  qaParentMap: Map<string, string>
  qaParentIds: Set<string>
  activeFilter: ActiveFilter
  searchQuery: string
  onNodeClick: (node: any) => void
}

export default function GalaxyCanvas({ nodes, links, qaNodes, qaParentMap, qaParentIds, activeFilter, searchQuery, onNodeClick }: Props) {
  const fgRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const [hoveredNode, setHoveredNode] = useState<any>(null)

  // Resize
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        })
      }
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [])

  // Force tuning -- converge fast, then freeze
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || nodes.length === 0) return
    const timer = setTimeout(() => {
      try {
        const charge = fg.d3Force('charge')
        if (charge) {
          charge.strength((node: any) =>
            node.type === 'dataset' ? -200 : -30
          )
        }
        const link = fg.d3Force('link')
        if (link) {
          link.distance((l: any) =>
            l.type === 'dataset_paper' ? 60 : 40
          )
        }
        fg.d3ReheatSimulation()
      } catch (_) { /* not ready */ }
    }, 100)
    return () => clearTimeout(timer)
  }, [nodes.length > 0])

  // Check node visibility based on active filter
  const isVisible = useCallback((node: any) => {
    if (activeFilter === null) return true
    if (activeFilter === 'paper') return node.type === 'paper' || node.type === 'dataset'
    if (activeFilter === 'qa') return node.type === 'qa' || node.type === 'dataset' || qaParentIds.has(node.id)
    return true
  }, [activeFilter, qaParentIds])

  // Custom node renderer -- Neo4j Bloom style
  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    if (!isVisible(node)) return

    const size = node.size || 4
    const x = node.x || 0
    const y = node.y || 0
    const color = node.color || '#4ADE80'
    const dimmed = (searchQuery && !node._match) || (activeFilter === 'qa' && node.type === 'paper' && !qaParentIds.has(node.id))
    const alpha = dimmed ? 0.08 : 1

    ctx.save()
    ctx.globalAlpha = alpha

    // Outer glow (Bloom effect)
    if (!dimmed && size > 3) {
      const gradient = ctx.createRadialGradient(x, y, size * 0.5, x, y, size * 2.5)
      gradient.addColorStop(0, color + '40')
      gradient.addColorStop(1, color + '00')
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(x, y, size * 2.5, 0, Math.PI * 2)
      ctx.fill()
    }

    // Node body
    ctx.fillStyle = color
    ctx.beginPath()

    if (node.type === 'dataset') {
      // Diamond shape for datasets
      const s = size * 1.2
      ctx.moveTo(x, y - s)
      ctx.lineTo(x + s, y)
      ctx.lineTo(x, y + s)
      ctx.lineTo(x - s, y)
      ctx.closePath()
    } else if (node.type === 'qa') {
      // Small square for QA
      const s = size * 0.6
      ctx.rect(x - s, y - s, s * 2, s * 2)
    } else {
      // Circle for papers
      ctx.arc(x, y, size, 0, Math.PI * 2)
    }
    ctx.fill()

    // Border ring
    if (node.type === 'dataset') {
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Label -- show on hover or for datasets always
    const showLabel = node.type === 'dataset' || hoveredNode?.id === node.id || globalScale > 2.5
    if (showLabel && !dimmed) {
      const label = node.label || ''
      const truncated = label.length > 30 ? label.slice(0, 27) + '...' : label
      ctx.font = node.type === 'dataset' ? BLOOM.clusterLabelFont : BLOOM.labelFont
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = BLOOM.labelColor
      ctx.fillText(truncated, x, y + size + 3)
    }

    ctx.restore()
  }, [searchQuery, activeFilter, qaParentIds, hoveredNode, isVisible])

  // Link renderer
  const linkCanvasObject = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const src = link.source
    const tgt = link.target
    if (!src || !tgt || src.x == null || tgt.x == null) return

    // Hide links based on filter
    if (activeFilter === 'paper' && (link.type === 'paper_qa' || link.type === 'dataset_qa')) return
    if (activeFilter === 'qa' && link.type === 'keyword') return

    let alpha = BLOOM.linkAlpha
    let color = '#4a5568'
    let width = 0.5

    if (link.type === 'dataset_paper') {
      color = '#4ADE80'
      alpha = 0.2
      width = 0.8
    } else if (link.type === 'keyword') {
      color = '#F97316'
      alpha = 0.08
      width = 0.3
    } else if (link.type === 'paper_qa' || link.type === 'dataset_qa') {
      color = '#8B5CF6'
      alpha = 0.12
      width = 0.4
    }

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = color
    ctx.lineWidth = width / globalScale
    ctx.beginPath()
    ctx.moveTo(src.x, src.y)
    ctx.lineTo(tgt.x, tgt.y)
    ctx.stroke()
    ctx.restore()
  }, [activeFilter])

  // Build combined graph data (papers + datasets + visible QA nodes)
  const graphData = useCallback(() => {
    // Always include all sim nodes (visibility handled in render)
    const allNodes = [...nodes]

    // Add QA nodes
    for (const qa of qaNodes) {
      const parentId = qaParentMap.get(qa.id)
      const parent = parentId ? nodes.find((n: any) => n.id === parentId) : null
      if (parent) {
        // Position QA near parent with jitter
        const angle = Math.random() * Math.PI * 2
        const r = 8 + Math.random() * 5
        allNodes.push({
          ...qa,
          fx: (parent.x || 0) + Math.cos(angle) * r,
          fy: (parent.y || 0) + Math.sin(angle) * r,
        })
      }
    }

    // All links
    const allLinks = [...links]

    return { nodes: allNodes, links: allLinks }
  }, [nodes, qaNodes, qaParentMap, links])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', background: BLOOM.bg }}>
      {nodes.length === 0 && qaNodes.length === 0 ? (
        <div className="empty-state" style={{ paddingTop: '200px' }}>
          <h3>No data in Galaxy</h3>
          <p>Generate a dataset to populate the Knowledge Graph</p>
        </div>
      ) : (
        <ForceGraph2D
          ref={fgRef}
          width={dimensions.width}
          height={dimensions.height}
          graphData={graphData()}
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
            const size = node.size || 4
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(node.x || 0, node.y || 0, size + 2, 0, Math.PI * 2)
            ctx.fill()
          }}
          linkCanvasObject={linkCanvasObject}
          onNodeClick={onNodeClick}
          onNodeHover={(node: any) => setHoveredNode(node)}
          cooldownTicks={80}
          d3AlphaDecay={0.04}
          d3VelocityDecay={0.4}
          d3AlphaMin={0.01}
          backgroundColor={BLOOM.bg}
          enableNodeDrag={true}
        />
      )}
    </div>
  )
}
