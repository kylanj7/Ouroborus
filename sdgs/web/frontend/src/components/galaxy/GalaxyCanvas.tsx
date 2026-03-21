import { useCallback, useRef, useEffect, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'

const BLOOM_BG = '#0d0d1a'

interface Props {
  nodes: any[]
  links: any[]
  searchQuery: string
  onNodeClick: (node: any) => void
}

export default function GalaxyCanvas({ nodes, links, searchQuery, onNodeClick }: Props) {
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

  // Force tuning
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || nodes.length === 0) return
    const timer = setTimeout(() => {
      try {
        const charge = fg.d3Force('charge')
        if (charge) charge.strength((n: any) => n.type === 'dataset' ? -200 : -20)
        const link = fg.d3Force('link')
        if (link) link.distance((l: any) => l.type === 'dataset_paper' ? 50 : 30)
        fg.d3ReheatSimulation()
      } catch (_) {}
    }, 100)
    return () => clearTimeout(timer)
  }, [nodes.length > 0])

  // Node renderer -- clean, minimal, Neo4j Bloom style
  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const x = node.x || 0
    const y = node.y || 0
    const color = node.color || '#4ADE80'
    const isDataset = node.type === 'dataset'
    const baseSize = node.size || 3
    // Scale down at low zoom to prevent blob
    const size = isDataset ? baseSize : Math.min(baseSize, 2.5 + 1 / globalScale)

    const dimmed = searchQuery && !node._match
    const isHovered = hoveredNode?.id === node.id

    ctx.save()
    ctx.globalAlpha = dimmed ? 0.06 : 1

    // Subtle glow only on hover or datasets
    if ((isHovered || isDataset) && !dimmed) {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, size * 2)
      gradient.addColorStop(0, color + '30')
      gradient.addColorStop(1, color + '00')
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(x, y, size * 2, 0, Math.PI * 2)
      ctx.fill()
    }

    // Node body
    ctx.fillStyle = color
    ctx.beginPath()
    if (isDataset) {
      const s = size * 1.2
      ctx.moveTo(x, y - s)
      ctx.lineTo(x + s, y)
      ctx.lineTo(x, y + s)
      ctx.lineTo(x - s, y)
      ctx.closePath()
    } else {
      ctx.arc(x, y, size, 0, Math.PI * 2)
    }
    ctx.fill()

    // Label -- only on hover or for datasets, and only when not too zoomed out
    if (!dimmed && (isHovered || (isDataset && globalScale > 0.5))) {
      const label = node.label || ''
      const maxLen = isHovered ? 50 : 25
      const truncated = label.length > maxLen ? label.slice(0, maxLen - 3) + '...' : label
      ctx.font = isDataset ? 'bold 12px Inter, sans-serif' : '10px Inter, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = isHovered ? 'rgba(255,255,255,0.95)' : 'rgba(200,210,230,0.7)'
      ctx.fillText(truncated, x, y + size + 2)
    }

    ctx.restore()
  }, [searchQuery, hoveredNode])

  // Link renderer -- thin lines
  const linkCanvasObject = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const src = link.source
    const tgt = link.target
    if (!src || !tgt || src.x == null || tgt.x == null) return

    let alpha = 0.1
    let color = '#4a5568'
    let width = 0.3

    if (link.type === 'dataset_paper') {
      color = '#4ADE80'
      alpha = 0.15
      width = 0.6
    } else if (link.type === 'keyword') {
      color = '#F97316'
      alpha = 0.06
      width = 0.2
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
  }, [])

  const graphData = { nodes: [...nodes], links: [...links] }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', background: BLOOM_BG }}>
      {nodes.length === 0 ? (
        <div className="empty-state" style={{ paddingTop: '200px' }}>
          <h3>No data in Knowledge Graph</h3>
          <p>Generate a dataset to populate the graph</p>
        </div>
      ) : (
        <ForceGraph2D
          ref={fgRef}
          width={dimensions.width}
          height={dimensions.height}
          graphData={graphData}
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(node.x || 0, node.y || 0, (node.size || 3) + 3, 0, Math.PI * 2)
            ctx.fill()
          }}
          linkCanvasObject={linkCanvasObject}
          onNodeClick={onNodeClick}
          onNodeHover={(node: any) => setHoveredNode(node)}
          cooldownTicks={60}
          d3AlphaDecay={0.05}
          d3VelocityDecay={0.4}
          d3AlphaMin={0.02}
          backgroundColor={BLOOM_BG}
          enableNodeDrag={true}
        />
      )}
    </div>
  )
}
