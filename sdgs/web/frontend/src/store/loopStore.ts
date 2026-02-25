import { create } from 'zustand'
import {
  getLoopStatus,
  startLoop,
  stopLoop,
  listLoops,
  type LoopStatus,
  type LoopListEntry,
} from '../api/client'

interface LoopState {
  status: LoopStatus | null
  history: LoopListEntry[]
  loading: boolean
  error: string | null
  activeLoopId: string | null

  fetchStatus: () => Promise<void>
  fetchHistory: () => Promise<void>
  start: (params: { config_path?: string; dataset_id: number; model_config?: string }) => Promise<string | null>
  stop: () => Promise<void>
  setActiveLoopId: (id: string | null) => void
}

export const useLoopStore = create<LoopState>((set, get) => ({
  status: null,
  history: [],
  loading: false,
  error: null,
  activeLoopId: null,

  fetchStatus: async () => {
    try {
      const status = await getLoopStatus()
      set({ status, error: null })
    } catch (e: any) {
      set({ error: e.message })
    }
  },

  fetchHistory: async () => {
    try {
      const history = await listLoops(20)
      set({ history, error: null })
    } catch (e: any) {
      set({ error: e.message })
    }
  },

  start: async (params: { config_path?: string; dataset_id: number; model_config?: string }) => {
    set({ loading: true, error: null })
    try {
      const res = await startLoop(params)
      const loopId = res.loop_id
      set({ activeLoopId: loopId })
      await get().fetchStatus()
      return loopId
    } catch (e: any) {
      set({ error: e.message })
      return null
    } finally {
      set({ loading: false })
    }
  },

  stop: async () => {
    set({ loading: true, error: null })
    try {
      await stopLoop()
      await get().fetchStatus()
    } catch (e: any) {
      set({ error: e.message })
    } finally {
      set({ loading: false })
    }
  },

  setActiveLoopId: (id: string | null) => {
    set({ activeLoopId: id })
  },
}))
