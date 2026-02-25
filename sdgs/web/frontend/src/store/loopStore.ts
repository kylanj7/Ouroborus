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
  pollInterval: ReturnType<typeof setInterval> | null

  fetchStatus: () => Promise<void>
  fetchHistory: () => Promise<void>
  start: (configPath?: string) => Promise<void>
  stop: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}

export const useLoopStore = create<LoopState>((set, get) => ({
  status: null,
  history: [],
  loading: false,
  error: null,
  pollInterval: null,

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

  start: async (configPath?: string) => {
    set({ loading: true, error: null })
    try {
      await startLoop(configPath)
      await get().fetchStatus()
      get().startPolling()
    } catch (e: any) {
      set({ error: e.message })
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

  startPolling: () => {
    const existing = get().pollInterval
    if (existing) clearInterval(existing)
    const interval = setInterval(() => {
      get().fetchStatus()
    }, 5000)
    set({ pollInterval: interval })
  },

  stopPolling: () => {
    const interval = get().pollInterval
    if (interval) clearInterval(interval)
    set({ pollInterval: null })
  },
}))
