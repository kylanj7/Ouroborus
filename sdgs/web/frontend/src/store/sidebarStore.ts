import { create } from 'zustand'

interface SidebarStore {
  collapsed: boolean
  toggle: () => void
}

export const useSidebarStore = create<SidebarStore>((set) => ({
  collapsed: false,
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
}))
