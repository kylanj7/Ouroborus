import { create } from 'zustand'
import { getGalaxyData, getPaperDetail, GalaxyData, GalaxyNode, PaperDetail } from '../api/client'

interface SelectedNode {
  type: 'paper' | 'dataset' | 'qa'
  node: GalaxyNode
  detail?: PaperDetail | null
}

interface GalaxyStore {
  data: GalaxyData | null
  selectedNode: SelectedNode | null
  loading: boolean
  error: string | null
  searchQuery: string
  activeCluster: number | null

  fetchData: () => Promise<void>
  selectNode: (node: GalaxyNode) => Promise<void>
  clearSelection: () => void
  setSearchQuery: (q: string) => void
  setActiveCluster: (id: number | null) => void
}

export const useGalaxyStore = create<GalaxyStore>((set, get) => ({
  data: null,
  selectedNode: null,
  loading: false,
  error: null,
  searchQuery: '',
  activeCluster: null,

  fetchData: async () => {
    set({ loading: true, error: null })
    try {
      const data = await getGalaxyData()
      set({ data, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  selectNode: async (node: GalaxyNode) => {
    const type = node.type as 'paper' | 'dataset' | 'qa'

    // Click same node again -> deselect
    if (get().selectedNode?.node.id === node.id) {
      set({ selectedNode: null, activeCluster: null })
      return
    }

    if (type === 'paper') {
      const paperId = parseInt(node.id.replace('paper-', ''))
      set({ selectedNode: { type, node, detail: null } })
      try {
        const detail = await getPaperDetail(paperId)
        set({ selectedNode: { type, node, detail } })
      } catch (e) {
        set({ error: String(e) })
      }
    } else if (type === 'dataset') {
      set({ selectedNode: { type, node }, activeCluster: node.cluster })
    } else {
      set({ selectedNode: { type, node } })
    }
  },

  clearSelection: () => set({ selectedNode: null, activeCluster: null }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setActiveCluster: (id) => set({ activeCluster: id }),
}))
