import { create } from 'zustand'
import {
  getClosedLoopStatus,
  getClosedLoopHistory,
  startClosedLoop,
  stopClosedLoop,
  cancelClosedLoop,
  type ClosedLoopCycle,
} from '../api/client'

interface GateBannerData {
  passed: boolean
  delta: number
  cycle: number
  consecutiveFailures: number
}

interface LoopState {
  loopId: string | null
  status: string
  currentCycle: number
  currentStage: string | null
  consecutiveGateFailures: number
  stopReason: string | null
  cycles: ClosedLoopCycle[]
  tallyResult: Record<string, any> | null
  gateBanner: GateBannerData | null
  loading: boolean
  error: string | null

  fetchStatus: () => Promise<void>
  fetchHistory: () => Promise<void>
  start: (configPath?: string, seedDatasetId?: number | null) => Promise<string | null>
  stop: () => Promise<void>
  cancel: () => Promise<void>
  setCurrentStage: (stage: string) => void
  setCurrentCycle: (cycle: number) => void
  setTallyResult: (data: Record<string, any>) => void
  showGateBanner: (data: GateBannerData) => void
  dismissGateBanner: () => void
  setStatus: (status: string) => void
  setStopReason: (reason: string | null) => void
}

export const useLoopStore = create<LoopState>((set, get) => ({
  loopId: null,
  status: 'idle',
  currentCycle: 0,
  currentStage: null,
  consecutiveGateFailures: 0,
  stopReason: null,
  cycles: [],
  tallyResult: null,
  gateBanner: null,
  loading: false,
  error: null,

  fetchStatus: async () => {
    try {
      const res = await getClosedLoopStatus()
      set({
        loopId: res.loop_id,
        status: res.status,
        currentCycle: res.current_cycle,
        currentStage: res.current_stage,
        consecutiveGateFailures: res.consecutive_gate_failures,
        stopReason: res.stop_reason,
        error: null,
      })
    } catch (e: any) {
      set({ error: e.message })
    }
  },

  fetchHistory: async () => {
    try {
      const res = await getClosedLoopHistory()
      set({ cycles: res.cycles, error: null })
    } catch (e: any) {
      set({ error: e.message })
    }
  },

  start: async (configPath?: string, seedDatasetId?: number | null) => {
    set({ loading: true, error: null })
    try {
      const res = await startClosedLoop(configPath, seedDatasetId)
      const loopId = res.loop_id
      set({ loopId, status: res.status })
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
      await stopClosedLoop()
      await get().fetchStatus()
    } catch (e: any) {
      set({ error: e.message })
    } finally {
      set({ loading: false })
    }
  },

  cancel: async () => {
    set({ loading: true, error: null })
    try {
      await cancelClosedLoop()
      set({ loopId: null, status: 'idle', currentCycle: 0, currentStage: null, stopReason: null })
    } catch (e: any) {
      set({ error: e.message })
    } finally {
      set({ loading: false })
    }
  },

  setCurrentStage: (stage: string) => {
    set({ currentStage: stage })
  },

  setCurrentCycle: (cycle: number) => {
    set({ currentCycle: cycle })
  },

  setTallyResult: (data: Record<string, any>) => {
    set({ tallyResult: data })
  },

  showGateBanner: (data: GateBannerData) => {
    set({ gateBanner: data })
  },

  dismissGateBanner: () => {
    set({ gateBanner: null })
  },

  setStatus: (status: string) => {
    set({ status })
  },

  setStopReason: (reason: string | null) => {
    set({ stopReason: reason })
  },
}))
