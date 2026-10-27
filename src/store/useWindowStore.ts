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
  /** 当前被吸附/收纳的边缘，null 表示自由悬浮 */
  dockedEdge: DockEdge | null;
  /** 是否处于收纳窄条状态 */
  docked: boolean;
  /** 收纳前恢复用的窗口边界（物理坐标） */
  restoredBounds: Bounds | null;
  setAlwaysOnTop: (enabled: boolean) => Promise<void>;
  setOpacity: (value: number) => void;
  setEdgeDocking: (enabled: boolean) => void;
  setTheme: (theme: AppTheme) => void;
  setDock: (edge: DockEdge, restored: Bounds, docked: boolean) => void;
  clearDock: () => void;
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
  restoredBounds: null,

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

  clearDock: () =>
    set({ dockedEdge: null, docked: false, restoredBounds: null }),

  restoreBounds: () => get().restoredBounds,
}));
