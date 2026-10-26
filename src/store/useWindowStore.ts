import { create } from "zustand";
import { applyAlwaysOnTop, type Bounds } from "../window/tauriWindow";

const STORAGE_KEY = "bianqian.window.v1";

export type DockEdge = "left" | "right" | "top";

interface PersistedSettings {
  alwaysOnTop: boolean;
  /** 面板背景不透明度 0.25 ~ 1；仅作用于背景，文字保持不透明 */
  opacity: number;
  edgeDocking: boolean;
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
  setDock: (edge: DockEdge, restored: Bounds, docked: boolean) => void;
  clearDock: () => void;
  restoreBounds: () => Bounds | null;
}

function loadPersisted(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PersistedSettings;
  } catch {
    // 损坏时回落到默认值
  }
  return { alwaysOnTop: true, opacity: 1, edgeDocking: true };
}

function persist(settings: PersistedSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

const initial = loadPersisted();

export const useWindowStore = create<WindowState>((set, get) => ({
  alwaysOnTop: initial.alwaysOnTop,
  opacity: initial.opacity,
  edgeDocking: initial.edgeDocking,
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
    });
  },

  setOpacity: (value) => {
    const clamped = Math.min(1, Math.max(0, value));
    set({ opacity: clamped });
    persist({
      alwaysOnTop: get().alwaysOnTop,
      opacity: clamped,
      edgeDocking: get().edgeDocking,
    });
  },

  setEdgeDocking: (enabled) => {
    set({ edgeDocking: enabled });
    persist({
      alwaysOnTop: get().alwaysOnTop,
      opacity: get().opacity,
      edgeDocking: enabled,
    });
  },

  setDock: (edge, restored, docked) =>
    set({ dockedEdge: edge, restoredBounds: restored, docked }),

  clearDock: () =>
    set({ dockedEdge: null, docked: false, restoredBounds: null }),

  restoreBounds: () => get().restoredBounds,
}));
