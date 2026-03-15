import { create } from 'zustand'
import { startKBIndex, stopKBIndex, getKBIndexStatus, indexKBEvents, KBIndexEvent, KBChatResponse } from '../api/client'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: string[]
  chunks_used?: number
  model?: string
}

export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
}

const STORAGE_KEY = 'ouroboros_chat_sessions'

function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveSessions(sessions: ChatSession[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find(m => m.role === 'user')
  if (!first) return 'New Chat'
  return first.content.length > 50 ? first.content.slice(0, 50) + '...' : first.content
}

interface KnowledgeState {
  indexing: boolean
  logs: string[]
  lastEventId: number
  cancelFn: (() => void) | null
  connected: boolean

  // Chat
  sessions: ChatSession[]
  activeSessionId: string | null
  chatHistory: ChatMessage[]
  chatting: boolean

  startIndex: (force?: boolean) => Promise<void>
  stopIndex: () => Promise<void>
  connectEvents: () => void
  disconnect: () => void
  clearLogs: () => void
  checkRunning: () => Promise<void>

  addUserMessage: (content: string) => void
  addAssistantMessage: (response: KBChatResponse) => void
  setChatting: (v: boolean) => void
  newChat: () => void
  switchSession: (id: string) => void
  deleteSession: (id: string) => void
  clearChat: () => void
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => {
  const saved = loadSessions()

  return {
    indexing: false,
    logs: [],
    lastEventId: 0,
    cancelFn: null,
    connected: false,

    sessions: saved,
    activeSessionId: null,
    chatHistory: [],
    chatting: false,

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

    addUserMessage: (content: string) => {
      const { activeSessionId, sessions, chatHistory } = get()
      const msg: ChatMessage = { role: 'user', content }
      const newHistory = [...chatHistory, msg]

      if (!activeSessionId) {
        // Create a new session
        const session: ChatSession = {
          id: generateId(),
          title: content.length > 50 ? content.slice(0, 50) + '...' : content,
          messages: newHistory,
          createdAt: Date.now(),
        }
        const newSessions = [session, ...sessions]
        saveSessions(newSessions)
        set({ activeSessionId: session.id, chatHistory: newHistory, sessions: newSessions })
      } else {
        // Update existing session
        const newSessions = sessions.map(s =>
          s.id === activeSessionId ? { ...s, messages: newHistory, title: deriveTitle(newHistory) } : s
        )
        saveSessions(newSessions)
        set({ chatHistory: newHistory, sessions: newSessions })
      }
    },

    addAssistantMessage: (response: KBChatResponse) => {
      const { activeSessionId, sessions, chatHistory } = get()
      const msg: ChatMessage = {
        role: 'assistant',
        content: response.answer,
        sources: response.sources,
        chunks_used: response.chunks_used,
        model: response.model,
      }
      const newHistory = [...chatHistory, msg]

      if (activeSessionId) {
        const newSessions = sessions.map(s =>
          s.id === activeSessionId ? { ...s, messages: newHistory } : s
        )
        saveSessions(newSessions)
        set({ chatHistory: newHistory, sessions: newSessions })
      } else {
        set({ chatHistory: newHistory })
      }
    },

    setChatting: (v: boolean) => set({ chatting: v }),

    newChat: () => {
      set({ activeSessionId: null, chatHistory: [] })
    },

    switchSession: (id: string) => {
      const { sessions } = get()
      const session = sessions.find(s => s.id === id)
      if (session) {
        set({ activeSessionId: id, chatHistory: session.messages })
      }
    },

    deleteSession: (id: string) => {
      const { sessions, activeSessionId } = get()
      const newSessions = sessions.filter(s => s.id !== id)
      saveSessions(newSessions)
      if (activeSessionId === id) {
        set({ sessions: newSessions, activeSessionId: null, chatHistory: [] })
      } else {
        set({ sessions: newSessions })
      }
    },

    clearChat: () => {
      set({ activeSessionId: null, chatHistory: [] })
    },
  }
})
