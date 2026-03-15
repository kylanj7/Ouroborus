import { useCallback, useRef, useEffect, useState } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'

// ── Shared geometries (created once, reused for all nodes) ──────────
const SHARED_GEO = {
  qa: new THREE.OctahedronGeometry(1, 0),
  paper: new THREE.SphereGeometry(1, 8, 6),
  dataset: new THREE.IcosahedronGeometry(1, 1),
  datasetWire: new THREE.IcosahedronGeometry(1.15, 1),
}

// Invisible material for QA raycast proxies.
// material.visible=false means zero draw cost but geometry still
// intersects the Three.js Raycaster so clicks keep working.
const QA_PROXY_MAT = new THREE.MeshBasicMaterial({ visible: false })

// ── Material cache (paper/dataset only) ─────────────────────────────
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

// ── Temp objects for InstancedMesh updates (allocated once) ─────────
const _dummy = new THREE.Object3D()
const _tmpColor = new THREE.Color()

// ── Component ───────────────────────────────────────────────────────

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
  const starfieldRef = useRef<THREE.Points | null>(null)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  const qaInstanceRef = useRef<{
    mesh: THREE.InstancedMesh
    nodeIds: string[]
  } | null>(null)

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

  // ── Renderer pixel ratio ──────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const renderer = fg.renderer()
    if (renderer) {
      // Cap at 2x to avoid excessive GPU fill on 3x+ displays
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

  // ── Force tuning (keep QA nodes near parents) ─────────────────────
  const forcesApplied = useRef(false)
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || nodes.length === 0) return

    // Only configure once -- d3 forces persist across data updates.
    // Defer to next frame so ForceGraph3D finishes its own init first.
    if (forcesApplied.current) return
    const timer = setTimeout(() => {
      try {
        const charge = fg.d3Force('charge')
        if (charge) {
          charge.strength((node: any) => {
            if (node.type === 'qa') return -2
            if (node.type === 'dataset') return -80
            return -30
          })
        }

        const link = fg.d3Force('link')
        if (link) {
          link.distance((l: any) => {
            if (l.type === 'paper_qa' || l.type === 'dataset_qa') return 8
            if (l.type === 'dataset_paper') return 30
            return 50
          })
          link.strength((l: any) => {
            if (l.type === 'paper_qa' || l.type === 'dataset_qa') return 0.8
            if (l.type === 'dataset_paper') return 0.3
            return 0.1
          })
        }

        forcesApplied.current = true
        fg.d3ReheatSimulation()
      } catch (_) { /* force graph not ready yet */ }
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

    const count = 2500
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
      color: '#c8d4ff',
      size: 1.2,
      transparent: true,
      opacity: 0.5,
      sizeAttenuation: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
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

  // ── QA InstancedMesh (GPU-batched: 1 draw call for ALL QA nodes) ──
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const scene = fg.scene()

    // Clean up previous
    if (qaInstanceRef.current) {
      scene.remove(qaInstanceRef.current.mesh)
      ;(qaInstanceRef.current.mesh.material as THREE.Material).dispose()
      qaInstanceRef.current.mesh.dispose()
      qaInstanceRef.current = null
    }

    const qaNodes = nodes.filter((n: any) => n.type === 'qa')
    if (qaNodes.length === 0) return

    const count = qaNodes.length
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 })
    const mesh = new THREE.InstancedMesh(SHARED_GEO.qa, mat, count)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

    // Per-instance colors (with search dimming)
    for (let i = 0; i < count; i++) {
      _tmpColor.set(qaNodes[i].color || '#22c55e')
      if (searchQuery && !qaNodes[i]._match) {
        _tmpColor.multiplyScalar(0.15)
      }
      mesh.setColorAt(i, _tmpColor)
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

    // Initial transforms (may be 0,0,0 before force sim runs)
    for (let i = 0; i < count; i++) {
      _dummy.position.set(qaNodes[i].x || 0, qaNodes[i].y || 0, qaNodes[i].z || 0)
      _dummy.scale.setScalar(qaNodes[i].size || 2.5)
      _dummy.updateMatrix()
      mesh.setMatrixAt(i, _dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true

    scene.add(mesh)
    qaInstanceRef.current = { mesh, nodeIds: qaNodes.map((n: any) => n.id) }

    return () => {
      scene.remove(mesh)
      ;(mesh.material as THREE.Material).dispose()
      mesh.dispose()
      qaInstanceRef.current = null
    }
  }, [nodes, searchQuery])

  // ── Sync QA instance positions from force simulation each tick ────
  const syncQAPositions = useCallback(() => {
    const inst = qaInstanceRef.current
    if (!inst) return

    const { mesh, nodeIds } = inst
    const currentNodes = nodesRef.current
    const nodeMap = new Map<string, any>()
    for (const n of currentNodes) nodeMap.set(n.id, n)

    for (let i = 0; i < nodeIds.length; i++) {
      const node = nodeMap.get(nodeIds[i])
      if (!node) continue
      _dummy.position.set(node.x || 0, node.y || 0, node.z || 0)
      _dummy.scale.setScalar(node.size || 2.5)
      _dummy.updateMatrix()
      mesh.setMatrixAt(i, _dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  }, [])

  // ── Node renderer ─────────────────────────────────────────────────
  const nodeThreeObject = useCallback((node: any) => {
    const color = node.color || '#3b82f6'
    const size = node.size || 4
    const dimmed = searchQuery && !node._match
    const opacity = dimmed ? 0.15 : 1

    if (node.type === 'qa') {
      // Invisible proxy: zero draw cost, still clickable via raycaster
      // (actual QA rendering done by InstancedMesh above)
      const mesh = new THREE.Mesh(SHARED_GEO.qa, QA_PROXY_MAT)
      mesh.scale.setScalar(size)
      return mesh
    }

    if (node.type === 'dataset') {
      const mat = getMaterial('phong', color, opacity, { shininess: 100 })
      const mesh = new THREE.Mesh(SHARED_GEO.dataset, mat)
      mesh.scale.setScalar(size)
      const wireMat = getMaterial('basic', '#ffffff', opacity * 0.25, { wireframe: true })
      const wire = new THREE.Mesh(SHARED_GEO.datasetWire, wireMat)
      mesh.add(wire)
      return mesh
    }

    // Paper: MeshPhongMaterial
    const mat = getMaterial('phong', color, opacity)
    const mesh = new THREE.Mesh(SHARED_GEO.paper, mat)
    mesh.scale.setScalar(size)
    return mesh
  }, [searchQuery])

  // ── Tooltip ───────────────────────────────────────────────────────
  const getNodeLabel = useCallback((node: any) => {
    if (node.type === 'dataset') {
      return `<div style="background:rgba(10,10,30,0.9);padding:8px 12px;border-radius:6px;border:1px solid rgba(59,130,246,0.3);max-width:300px">
        <div style="color:#3b82f6;font-weight:600;margin-bottom:4px">Dataset</div>
        <div style="color:#e8e8f0">${node.label}</div>
        <div style="color:#888;font-size:12px;margin-top:4px">${node.abstract || ''}</div>
      </div>`
    }
    if (node.type === 'qa') {
      const instruction = node.instruction || node.label || ''
      const answer = node.answer_text || ''
      return `<div style="background:rgba(10,10,30,0.95);padding:10px 14px;border-radius:6px;border:1px solid rgba(34,197,94,0.3);max-width:350px">
        <div style="color:#ffd666;font-weight:600;font-size:11px;margin-bottom:6px">Q&A</div>
        <div style="color:#e8e8f0;font-size:13px;margin-bottom:8px">${instruction.length > 200 ? instruction.slice(0, 200) + '...' : instruction}</div>
        ${answer ? `<div style="color:#a8a8b8;font-size:12px;border-top:1px solid rgba(255,255,255,0.1);padding-top:6px">${answer.length > 150 ? answer.slice(0, 150) + '...' : answer}</div>` : ''}
        ${node.is_valid ? '<div style="margin-top:4px"><span style="background:rgba(34,197,94,0.15);color:#22c55e;font-size:10px;padding:2px 6px;border-radius:3px">valid</span></div>' : ''}
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
      {nodes.length === 0 ? (
        <div className="empty-state" style={{ paddingTop: '200px' }}>
          <h3>No data in Galaxy</h3>
          <p>Generate a dataset to populate the Galaxy viewer</p>
        </div>
      ) : (
        <ForceGraph3D
          ref={fgRef}
          rendererConfig={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
          width={dimensions.width}
          height={dimensions.height}
          graphData={{ nodes, links }}
          nodeThreeObject={nodeThreeObject}
          nodeThreeObjectExtend={false}
          linkColor={(link: any) => {
            if (link.type === 'dataset_paper') return 'rgba(59, 130, 246, 0.25)'
            if (link.type === 'paper_qa' || link.type === 'dataset_qa') return 'rgba(34, 197, 94, 0.2)'
            if (link.type === 'keyword') return 'rgba(255, 214, 102, 0.15)'
            return 'rgba(59, 130, 246, 0.1)'
          }}
          linkWidth={(link: any) =>
            link.type === 'paper_qa' || link.type === 'dataset_qa' ? 0.8 : link.weight * 2
          }
          linkOpacity={0.7}
          onNodeClick={onNodeClick}
          nodeLabel={getNodeLabel}
          onEngineTick={syncQAPositions}
          cooldownTicks={200}
          d3AlphaDecay={0.015}
          d3VelocityDecay={0.3}
          d3AlphaMin={0.001}
          backgroundColor="#020617"
          showNavInfo={false}
        />
      )}
    </div>
  )
}
