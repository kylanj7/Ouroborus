import { create } from 'zustand'
import { startKBIndex, stopKBIndex, getKBIndexStatus, indexKBEvents, KBIndexEvent } from '../api/client'

interface KnowledgeState {
  indexing: boolean
  logs: string[]
  lastEventId: number
  cancelFn: (() => void) | null
  connected: boolean

  startIndex: (force?: boolean) => Promise<void>
  stopIndex: () => Promise<void>
  connectEvents: () => void
  disconnect: () => void
  clearLogs: () => void
  checkRunning: () => Promise<void>
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  indexing: false,
  logs: [],
  lastEventId: 0,
  cancelFn: null,
  connected: false,

  startIndex: async (force = false) => {
    const { indexing } = get()
    if (indexing) return

    set({ indexing: true, logs: ['$ ouroboros index-papers' + (force ? ' --force' : ''), ''], lastEventId: 0, connected: false })

    try {
      await startKBIndex(force)
      get().connectEvents()
    } catch (e) {
      set({ indexing: false })
      set(s => ({ logs: [...s.logs, `Error: ${e instanceof Error ? e.message : 'Failed to start indexing'}`] }))
    }
  },

  stopIndex: async () => {
    try {
      await stopKBIndex()
    } catch {
      // ignore
    }
  },

  connectEvents: () => {
    const { cancelFn, lastEventId, connected } = get()
    // Prevent duplicate connections
    if (connected) return
    if (cancelFn) cancelFn()

    set({ connected: true })

    const cancel = indexKBEvents(
      (event: KBIndexEvent) => {
        if (event.message) {
          set(s => ({
            logs: [...s.logs, event.message!],
            lastEventId: s.lastEventId + 1,
          }))
        }
        if (event.type === 'done') {
          set({ indexing: false, cancelFn: null, connected: false })
        }
      },
      () => {
        set({ indexing: false, cancelFn: null, connected: false })
      },
      lastEventId,
    )

    set({ cancelFn: cancel })
  },

  disconnect: () => {
    const { cancelFn } = get()
    if (cancelFn) cancelFn()
    set({ cancelFn: null, connected: false })
  },

  clearLogs: () => {
    set({ logs: [], lastEventId: 0 })
  },

  checkRunning: async () => {
    const { indexing, connected } = get()
    if (indexing && connected) return
    try {
      const status = await getKBIndexStatus()
      if (status.running && !get().connected) {
        set({ indexing: true })
        get().connectEvents()
      }
    } catch {
      // backend not reachable
    }
  },
}))
