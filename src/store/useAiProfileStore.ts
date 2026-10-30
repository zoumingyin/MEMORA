import { create } from 'zustand'
import { activateAiProfile, getAiStatus } from '../services/aiClient'
import type { AiStatus } from '../types/ai'

interface AiProfilesState {
  /** 全部模型配置与当前选中项；null 表示尚未加载 */
  status: AiStatus | null
  loading: boolean
  load: () => Promise<void>
  activate: (id: string) => Promise<void>
  /** 设置页保存 / 删除后同步最新状态 */
  sync: (status: AiStatus) => void
}

export const useAiProfileStore = create<AiProfilesState>((set, get) => ({
  status: null,
  loading: false,

  load: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      set({ status: await getAiStatus() })
    } finally {
      set({ loading: false })
    }
  },

  activate: async (id) => {
    if (get().status?.activeId === id) return
    set({ status: await activateAiProfile(id) })
  },

  sync: (status) => set({ status }),
}))
