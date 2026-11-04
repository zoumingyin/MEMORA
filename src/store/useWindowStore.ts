import { create } from "zustand";
import { applyAlwaysOnTop, type Bounds } from "../window/tauriWindow";

const STORAGE_KEY = "bianqian.window.v1";

export type DockEdge = "left" | "right" | "top";
export type AppTheme = "light" | "dark";

interface PersistedSettings {
  alwaysOnTop: boolean;
  /** 面板背景不透明度 0 ~ 1；仅作用于背景，文字保持不透明 */
  opacity: number;
  edgeDocking: boolean;
  /** 界面主题：亮色 / 暗色（独立于透明度，透明度只调透明程度） */
  theme: AppTheme;
}

interface WindowState extends PersistedSettings {
  /** 收纳会话所在边缘；展开后仍保留（移出窗口据此收回窄条），null 表示无会话、自由悬浮 */
  dockedEdge: DockEdge | null;
  /** 是否处于收纳窄条状态 */
  docked: boolean;
  /** 收纳出场动画进行中：docked 已置 true（防缩窗事件写盘/重入），
   *  但主界面仍在播放滑向边缘的 dock-out-* 动画，播完才真正缩窗换窄条 */
  collapsing: boolean;
  /** 收纳前恢复用的窗口边界（物理坐标） */
  restoredBounds: Bounds | null;
  /** 主界面滑入动画的方向提示：托盘/快捷键展开会清掉收纳会话（dockedEdge 置 null），
   *  挂载时据此仍播放一次从该侧滑入的动画；动画结束后由调用方清回 null */
  slideFromEdge: DockEdge | null;
  setAlwaysOnTop: (enabled: boolean) => Promise<void>;
  setOpacity: (value: number) => void;
  setEdgeDocking: (enabled: boolean) => void;
  setTheme: (theme: AppTheme) => void;
  setDock: (edge: DockEdge, restored: Bounds, docked: boolean) => void;
  setCollapsing: (value: boolean) => void;
  clearDock: () => void;
  setSlideFrom: (edge: DockEdge | null) => void;
  restoreBounds: () => Bounds | null;
}

function loadPersisted(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      // 兼容旧版本数据：theme 缺省为亮色
      return {
        alwaysOnTop: parsed.alwaysOnTop ?? true,
        opacity: parsed.opacity ?? 1,
        edgeDocking: parsed.edgeDocking ?? true,
        theme: parsed.theme ?? "light",
      };
    }
  } catch {
    // 损坏时回落到默认值
  }
  return { alwaysOnTop: true, opacity: 1, edgeDocking: true, theme: "light" };
}

function persist(settings: PersistedSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

const initial = loadPersisted();

export const useWindowStore = create<WindowState>((set, get) => ({
  alwaysOnTop: initial.alwaysOnTop,
  opacity: initial.opacity,
  edgeDocking: initial.edgeDocking,
  theme: initial.theme,
  dockedEdge: null,
  docked: false,
  collapsing: false,
  restoredBounds: null,
  slideFromEdge: null,

  setAlwaysOnTop: async (enabled) => {
    await applyAlwaysOnTop(enabled);
    set({ alwaysOnTop: enabled });
    persist({
      alwaysOnTop: enabled,
      opacity: get().opacity,
      edgeDocking: get().edgeDocking,
      theme: get().theme,
    });
  },

  setOpacity: (value) => {
    const clamped = Math.min(1, Math.max(0, value));
    set({ opacity: clamped });
    persist({
      alwaysOnTop: get().alwaysOnTop,
      opacity: clamped,
      edgeDocking: get().edgeDocking,
      theme: get().theme,
    });
  },

  setEdgeDocking: (enabled) => {
    set({ edgeDocking: enabled });
    persist({
      alwaysOnTop: get().alwaysOnTop,
      opacity: get().opacity,
      edgeDocking: enabled,
      theme: get().theme,
    });
  },

  setTheme: (theme) => {
    set({ theme });
    persist({
      alwaysOnTop: get().alwaysOnTop,
      opacity: get().opacity,
      edgeDocking: get().edgeDocking,
      theme,
    });
  },

  setDock: (edge, restored, docked) =>
    set({ dockedEdge: edge, restoredBounds: restored, docked }),

  setCollapsing: (value) => set({ collapsing: value }),

  clearDock: () =>
    set({ dockedEdge: null, docked: false, restoredBounds: null }),

  setSlideFrom: (edge) => set({ slideFromEdge: edge }),

  restoreBounds: () => get().restoredBounds,
}));
