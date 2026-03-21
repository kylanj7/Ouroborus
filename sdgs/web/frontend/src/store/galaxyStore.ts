import { create } from 'zustand'
import { getGalaxyData, getPaperDetail, GalaxyData, GalaxyNode, PaperDetail } from '../api/client'

interface SelectedNode {
  type: 'paper' | 'dataset' | 'qa'
  node: GalaxyNode
  detail?: PaperDetail | null
}

type ActiveFilter = 'paper' | 'qa' | null

interface GalaxyStore {
  data: GalaxyData | null
  selectedNode: SelectedNode | null
  loading: boolean
  error: string | null
  searchQuery: string
  activeFilter: ActiveFilter

  fetchData: () => Promise<void>
  selectNode: (node: GalaxyNode) => Promise<void>
  clearSelection: () => void
  setSearchQuery: (q: string) => void
  setActiveFilter: (f: ActiveFilter) => void
}

export const useGalaxyStore = create<GalaxyStore>((set, get) => ({
  data: null,
  selectedNode: null,
  loading: false,
  error: null,
  searchQuery: '',
  activeFilter: null,

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
      set({ selectedNode: null })
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
      set({ selectedNode: { type, node } })
    } else {
      set({ selectedNode: { type, node } })
    }
  },

  clearSelection: () => set({ selectedNode: null }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setActiveFilter: (f) => set({ activeFilter: f }),
}))
