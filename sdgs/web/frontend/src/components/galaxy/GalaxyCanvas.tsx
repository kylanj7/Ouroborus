import { useCallback, useRef, useEffect, useState } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'

// ── Shared geometries ───────────────────────────────────────────────
const SHARED_GEO = {
  qa: new THREE.OctahedronGeometry(1, 0),
  paper: new THREE.SphereGeometry(1, 6, 4),
  dataset: new THREE.IcosahedronGeometry(1, 1),
  datasetWire: new THREE.IcosahedronGeometry(1.15, 1),
}

const PROXY_MAT = new THREE.MeshBasicMaterial({ visible: false })

const _matCache = new Map<string, THREE.Material>()
function getMaterial(
  kind: 'basic' | 'phong',
  color: string,
  opacity: number,
  extra: Record<string, any> = {},
): THREE.Material {
  const key = `${kind}|${color}|${opacity}|${JSON.stringify(extra)}`
  let mat = _matCache.get(key)
  if (!mat) {
    if (kind === 'basic') {
      mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, ...extra })
    } else {
      mat = new THREE.MeshPhongMaterial({
        color, transparent: true, opacity,
        emissive: color, emissiveIntensity: 0.3, ...extra,
      })
    }
    _matCache.set(key, mat)
  }
  return mat
}

const _dummy = new THREE.Object3D()
const _tmpColor = new THREE.Color()

// ── Component ───────────────────────────────────────────────────────

interface Props {
  nodes: any[]       // papers + datasets only (simulated by d3-force)
  links: any[]       // dataset_paper + keyword links only
  qaNodes: any[]     // QA nodes (NOT in force sim, positioned procedurally)
  qaParentMap: Map<string, string>  // qaNodeId -> parentNodeId
  searchQuery: string
  onNodeClick: (node: any) => void
}

interface InstanceRef {
  mesh: THREE.InstancedMesh
  nodeIds: string[]
}

export default function GalaxyCanvas({ nodes, links, qaNodes, qaParentMap, searchQuery, onNodeClick }: Props) {
  const fgRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const starfieldRef = useRef<THREE.Points | null>(null)

  const paperInstanceRef = useRef<InstanceRef | null>(null)
  const qaInstanceRef = useRef<InstanceRef | null>(null)

  // Stable refs for tick callback
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const qaNodesRef = useRef(qaNodes)
  qaNodesRef.current = qaNodes
  const qaParentMapRef = useRef(qaParentMap)
  qaParentMapRef.current = qaParentMap

  // Pre-build node lookup (rebuilt on nodes change, not per tick)
  const nodeMapRef = useRef<Map<string, any>>(new Map())
  useEffect(() => {
    const map = new Map<string, any>()
    for (const n of nodes) map.set(n.id, n)
    nodeMapRef.current = map
  }, [nodes])

  // Throttle counter for tick sync
  const tickCountRef = useRef(0)

  // ── Resize ────────────────────────────────────────────────────────
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

  // ── Renderer setup ──────────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const renderer = fg.renderer()
    if (renderer) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    }
  }, [])

  // ── Auto-rotate ───────────────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const controls = fg.controls()
    if (controls) {
      controls.autoRotate = true
      controls.autoRotateSpeed = 0.5
    }
  }, [nodes])

  // ── Force tuning ──────────────────────────────────────────────────
  const forcesApplied = useRef(false)
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || nodes.length === 0) return
    if (forcesApplied.current) return
    const timer = setTimeout(() => {
      try {
        const charge = fg.d3Force('charge')
        if (charge) {
          charge.strength((node: any) =>
            node.type === 'dataset' ? -80 : -30
          )
        }
        const link = fg.d3Force('link')
        if (link) {
          link.distance((l: any) =>
            l.type === 'dataset_paper' ? 30 : 50
          )
          link.strength((l: any) =>
            l.type === 'dataset_paper' ? 0.3 : 0.1
          )
        }
        forcesApplied.current = true
        fg.d3ReheatSimulation()
      } catch (_) { /* not ready */ }
    }, 100)
    return () => clearTimeout(timer)
  }, [nodes])

  // ── Starfield ─────────────────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || nodes.length === 0) return
    const scene = fg.scene()

    if (starfieldRef.current) {
      scene.remove(starfieldRef.current)
      starfieldRef.current.geometry.dispose()
      ;(starfieldRef.current.material as THREE.Material).dispose()
    }

    const count = 1500
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = 500 + Math.random() * 1000
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      positions[i * 3 + 2] = r * Math.cos(phi)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color: '#c8d4ff', size: 1.2, transparent: true, opacity: 0.5,
      sizeAttenuation: false, blending: THREE.AdditiveBlending, depthWrite: false,
    })
    const stars = new THREE.Points(geo, mat)
    stars.onBeforeRender = () => {
      const t = performance.now() * 0.001
      stars.rotation.y = t * 0.008
      stars.rotation.x = Math.sin(t * 0.004) * 0.08
    }
    scene.add(stars)
    starfieldRef.current = stars

    return () => {
      scene.remove(stars)
      geo.dispose()
      mat.dispose()
      starfieldRef.current = null
    }
  }, [nodes.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Helper: build InstancedMesh ───────────────────────────────────
  function buildInstance(
    scene: THREE.Scene,
    filtered: any[],
    geometry: THREE.BufferGeometry,
    ref: React.MutableRefObject<InstanceRef | null>,
  ) {
    if (ref.current) {
      scene.remove(ref.current.mesh)
      ;(ref.current.mesh.material as THREE.Material).dispose()
      ref.current.mesh.dispose()
      ref.current = null
    }
    if (filtered.length === 0) return

    const count = filtered.length
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 })
    const mesh = new THREE.InstancedMesh(geometry, mat, count)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

    for (let i = 0; i < count; i++) {
      _tmpColor.set(filtered[i].color || '#22c55e')
      if (searchQuery && !filtered[i]._match) _tmpColor.multiplyScalar(0.15)
      mesh.setColorAt(i, _tmpColor)
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

    for (let i = 0; i < count; i++) {
      _dummy.position.set(filtered[i].x || 0, filtered[i].y || 0, filtered[i].z || 0)
      _dummy.scale.setScalar(filtered[i].size || 2.5)
      _dummy.updateMatrix()
      mesh.setMatrixAt(i, _dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true

    scene.add(mesh)
    ref.current = { mesh, nodeIds: filtered.map((n: any) => n.id) }
  }

  // ── Paper InstancedMesh ───────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const scene = fg.scene()
    const paperNodes = nodes.filter((n: any) => n.type === 'paper')
    buildInstance(scene, paperNodes, SHARED_GEO.paper, paperInstanceRef)
    return () => {
      if (paperInstanceRef.current) {
        fg.scene().remove(paperInstanceRef.current.mesh)
        ;(paperInstanceRef.current.mesh.material as THREE.Material).dispose()
        paperInstanceRef.current.mesh.dispose()
        paperInstanceRef.current = null
      }
    }
  }, [nodes, searchQuery])

  // ── QA InstancedMesh (positioned procedurally, not in force sim) ──
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const scene = fg.scene()
    buildInstance(scene, qaNodes, SHARED_GEO.qa, qaInstanceRef)
    return () => {
      if (qaInstanceRef.current) {
        fg.scene().remove(qaInstanceRef.current.mesh)
        ;(qaInstanceRef.current.mesh.material as THREE.Material).dispose()
        qaInstanceRef.current.mesh.dispose()
        qaInstanceRef.current = null
      }
    }
  }, [qaNodes, searchQuery])

  // ── Sync positions from force sim each tick (throttled) ───────────
  const syncPositions = useCallback(() => {
    // Throttle: update every 2nd tick
    tickCountRef.current++
    if (tickCountRef.current % 2 !== 0) return

    const nodeMap = nodeMapRef.current

    // Sync paper instances
    const paperInst = paperInstanceRef.current
    if (paperInst) {
      const { mesh, nodeIds } = paperInst
      for (let i = 0; i < nodeIds.length; i++) {
        const node = nodeMap.get(nodeIds[i])
        if (!node) continue
        _dummy.position.set(node.x || 0, node.y || 0, node.z || 0)
        _dummy.scale.setScalar(node.size || 4)
        _dummy.updateMatrix()
        mesh.setMatrixAt(i, _dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
    }

    // Sync QA instances: position around their parent node
    const qaInst = qaInstanceRef.current
    if (qaInst) {
      const { mesh, nodeIds } = qaInst
      const currentQA = qaNodesRef.current
      const parentMap = qaParentMapRef.current

      // Pre-compute per-parent offsets using golden angle distribution
      const parentChildCount = new Map<string, number>()
      const parentChildIndex = new Map<string, number>()

      for (let i = 0; i < nodeIds.length; i++) {
        const parentId = parentMap.get(nodeIds[i])
        if (!parentId) continue
        const count = (parentChildCount.get(parentId) || 0)
        parentChildCount.set(parentId, count + 1)
      }

      for (let i = 0; i < nodeIds.length; i++) {
        const qaNode = currentQA[i]
        if (!qaNode) continue
        const parentId = parentMap.get(nodeIds[i])
        const parent = parentId ? nodeMap.get(parentId) : null

        if (parent && parentId) {
          // Golden angle spherical distribution around parent
          const idx = parentChildIndex.get(parentId) || 0
          parentChildIndex.set(parentId, idx + 1)
          const total = parentChildCount.get(parentId) || 1
          const radius = 5 + total * 0.3
          const golden = 2.399963 // golden angle in radians
          const theta = golden * idx
          const phi = Math.acos(1 - 2 * (idx + 0.5) / Math.max(total, 1))

          _dummy.position.set(
            (parent.x || 0) + radius * Math.sin(phi) * Math.cos(theta),
            (parent.y || 0) + radius * Math.sin(phi) * Math.sin(theta),
            (parent.z || 0) + radius * Math.cos(phi),
          )
        } else {
          _dummy.position.set(qaNode.x || 0, qaNode.y || 0, qaNode.z || 0)
        }
        _dummy.scale.setScalar(qaNode.size || 2.5)
        _dummy.updateMatrix()
        mesh.setMatrixAt(i, _dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
    }
  }, [])

  // ── Node renderer (papers use invisible proxy, datasets render directly) ──
  const nodeThreeObject = useCallback((node: any) => {
    const size = node.size || 4

    if (node.type === 'paper') {
      const mesh = new THREE.Mesh(SHARED_GEO.paper, PROXY_MAT)
      mesh.scale.setScalar(size)
      return mesh
    }

    // Dataset: only ~4 of these
    const color = node.color || '#3b82f6'
    const dimmed = searchQuery && !node._match
    const opacity = dimmed ? 0.15 : 1
    const mat = getMaterial('phong', color, opacity, { shininess: 100 })
    const mesh = new THREE.Mesh(SHARED_GEO.dataset, mat)
    mesh.scale.setScalar(size)
    const wireMat = getMaterial('basic', '#ffffff', opacity * 0.25, { wireframe: true })
    const wire = new THREE.Mesh(SHARED_GEO.datasetWire, wireMat)
    mesh.add(wire)
    return mesh
  }, [searchQuery])

  // ── Memoized link styling ─────────────────────────────────────────
  const linkColorFn = useCallback((link: any) => {
    if (link.type === 'dataset_paper') return 'rgba(59, 130, 246, 0.25)'
    if (link.type === 'keyword') return 'rgba(255, 214, 102, 0.15)'
    return 'rgba(59, 130, 246, 0.1)'
  }, [])

  const linkWidthFn = useCallback((link: any) =>
    link.type === 'dataset_paper' ? 1.2 : (link.weight || 0.3) * 2
  , [])

  // ── Tooltip ───────────────────────────────────────────────────────
  const getNodeLabel = useCallback((node: any) => {
    if (node.type === 'dataset') {
      return `<div style="background:rgba(10,10,30,0.9);padding:8px 12px;border-radius:6px;border:1px solid rgba(59,130,246,0.3);max-width:300px">
        <div style="color:#3b82f6;font-weight:600;margin-bottom:4px">Dataset</div>
        <div style="color:#e8e8f0">${node.label}</div>
        <div style="color:#888;font-size:12px;margin-top:4px">${node.abstract || ''}</div>
      </div>`
    }
    const qaCount = node.qa_pair_count != null ? node.qa_pair_count : 0
    return `<div style="background:rgba(10,10,30,0.9);padding:8px 12px;border-radius:6px;border:1px solid rgba(59,130,246,0.3);max-width:300px">
      <div style="color:#22c55e;font-weight:600;margin-bottom:4px">Paper</div>
      <div style="color:#e8e8f0">${node.label}</div>
      <div style="color:#888;font-size:12px;margin-top:4px">Year: ${node.year || 'N/A'} | Citations: ${node.citation_count || 0} | Q&A pairs: ${qaCount}</div>
    </div>`
  }, [])

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', background: '#020617' }}>
      {nodes.length === 0 && qaNodes.length === 0 ? (
        <div className="empty-state" style={{ paddingTop: '200px' }}>
          <h3>No data in Galaxy</h3>
          <p>Generate a dataset to populate the Galaxy viewer</p>
        </div>
      ) : (
        <ForceGraph3D
          ref={fgRef}
          rendererConfig={{ antialias: false, alpha: true, powerPreference: 'high-performance' }}
          width={dimensions.width}
          height={dimensions.height}
          graphData={{ nodes, links }}
          nodeThreeObject={nodeThreeObject}
          nodeThreeObjectExtend={false}
          linkColor={linkColorFn}
          linkWidth={linkWidthFn}
          linkOpacity={0.7}
          onNodeClick={onNodeClick}
          nodeLabel={getNodeLabel}
          onEngineTick={syncPositions}
          cooldownTicks={100}
          d3AlphaDecay={0.03}
          d3VelocityDecay={0.4}
          d3AlphaMin={0.008}
          backgroundColor="#020617"
          showNavInfo={false}
          warmupTicks={40}
          enableNodeDrag={false}
        />
      )}
    </div>
  )
}
