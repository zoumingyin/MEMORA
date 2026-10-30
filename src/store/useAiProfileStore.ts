import { create } from 'zustand'
import { activateAiProfile, getAiStatus } from '../services/aiClient'
import type { AiStatus } from '../types/ai'

interface AiProfilesState {
  /** 全部模型配置与当前选中项；null 表示尚未加载 */
  status: AiStatus | null
  loading: boolean
  /** force 为真时忽略缓存，重新向各免费网关拉取模型列表 */
  load: (force?: boolean) => Promise<void>
  activate: (id: string) => Promise<void>
  /** 设置页保存 / 删除后同步最新状态 */
  sync: (status: AiStatus) => void
}

export const useAiProfileStore = create<AiProfilesState>((set, get) => ({
  status: null,
  loading: false,

  load: async (force = false) => {
    // 强制刷新时允许排队执行（用户主动点了「重新获取」），普通加载则复用进行中的请求
    if (get().loading && !force) return
    set({ loading: true })
    try {
      set({ status: await getAiStatus(force) })
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
