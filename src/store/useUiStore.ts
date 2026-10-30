import { create } from 'zustand'

/** 跨组件界面状态：设置弹窗由标题栏渲染，AI 面板等入口可请求定位到指定设置页 */
interface UiState {
  settingsOpen: boolean
  /** 打开设置时定位的叶子节点 key（如 'ai-config'） */
  settingsSection: string | null
  openSettings: (section?: string) => void
  closeSettings: () => void
}

export const useUiStore = create<UiState>((set) => ({
  settingsOpen: false,
  settingsSection: null,
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section ?? null }),
  closeSettings: () => set({ settingsOpen: false, settingsSection: null }),
}))
