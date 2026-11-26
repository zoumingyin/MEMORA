import { useSyncExternalStore } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "@tauri-apps/api/window";
import { emitTo, once } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../repository";
import type { Entry } from "../types/entry";
import { useEntryStore } from "../store/useEntryStore";
import { useUiStore } from "../store/useUiStore";
import { currentWorkArea } from "./tauriWindow";

/**
 * 多窗口便签（拖出独立小窗）主窗口侧管理器。
 *
 * 每条便签可弹出一个独立 Tauri 窗口（label = `note-<entryId>`）。小窗展示态复用
 * 贴纸墙卡片渲染、编辑态复用 DetailPane 本体，经 DetailEditGateway 把存盘改走事件：
 * 小窗编辑 → note-window:patch → 主窗口 updateEntry → entries 变化广播
 * note-window:sync 回各小窗；便签被移入废纸篓时由主窗口直接销毁对应小窗。
 *
 * 打开状态持久化到 localStorage，主窗口启动数据加载完成后自动重开。
 * 窗口能力见 capabilities/note-window.json（按 note-* 匹配）。
 */

/** 小窗窗口标签前缀（完整 label = 前缀 + 条目 id，UUID 含 `-` 为合法字符） */
export const NOTE_WINDOW_PREFIX = "note-";
/** 小窗 → 主窗口：页面已加载（payload 携带条目 id） */
export const NOTE_WINDOW_READY_EVENT = "note-window:ready";
/** 主窗口 → 小窗：就绪探测 */
export const NOTE_WINDOW_PING_EVENT = "note-window:ping";
/** 主窗口 → 小窗：下发完整条目快照（打开时一次性） */
export const NOTE_WINDOW_OPEN_EVENT = "note-window:open";
/** 主窗口 → 小窗：条目已更新，同步最新数据（编辑回显 / 其他入口修改） */
export const NOTE_WINDOW_SYNC_EVENT = "note-window:sync";
/** 小窗 → 主窗口：小窗内编辑，请求应用 patch（DetailPane 网关回传，任意字段） */
export const NOTE_WINDOW_PATCH_EVENT = "note-window:patch";
/** 主窗口 → 小窗：patch 应用结果（按 requestId 匹配，携带最新条目或错误） */
export const NOTE_WINDOW_PATCH_RESULT_EVENT = "note-window:patch-result";
/** 小窗 → 主窗口：小窗内删除便签（移入废纸篓），主窗口执行后联动关闭小窗 */
export const NOTE_WINDOW_REMOVE_EVENT = "note-window:remove";

/** 便签小窗点击正文 [[引用]]：把引用（id 或标题）转发主窗口解析跳转（小窗没有全量条目清单） */
export const NOTE_WINDOW_OPEN_REF_EVENT = "note-window:open-ref";

/** 主窗口 → 小窗的打开快照（主题由全局 ThemeProvider 解析，不再随快照下发） */
export interface NoteWindowSnapshot {
  entry: Entry;
  /** 全部已知标签（DetailPane 编辑网关的标签候选池） */
  knownTags: string[];
  /** 全部备忘便签清单（小窗解析 [[引用]] 胶囊用） */
  noteRefs: Array<{ id: string; title: string }>;
  /** 主窗口侧是否置顶（小窗按同款哈希生成胶带/图钉装饰） */
  pinned: boolean;
}

/** 收集全部已知标签（DetailPane 标签 chips 候选池，与详情页同排序） */
export function collectKnownTags(): string[] {
  const set = new Set<string>();
  for (const item of useEntryStore.getState().entries) {
    for (const tag of item.tags ?? []) set.add(tag);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/** 收集全部备忘便签清单（小窗解析 [[引用]] 与点击跳转用） */
export function collectNoteRefs(): Array<{ id: string; title: string }> {
  return useEntryStore
    .getState()
    .entries.filter((item) => item.kind === "note")
    .map((item) => ({ id: item.id, title: item.title }));
}
/** 小窗尺寸（CSS px）＝贴纸墙卡片 264×228 + 内边距（顶部 14 / 其余 8），可调大小 */
export const NOTE_WIN_W = 280;
export const NOTE_WIN_H = 250;
/** 编辑态展开尺寸（CSS px）：DetailPane 的完整表单需要足够宽高，避免挤压 / 工具栏换行 */
export const NOTE_EDIT_W = 350;
export const NOTE_EDIT_H = 550;

/** 打开状态持久化键 */
const NOTE_WINDOWS_KEY = "bianqian.noteWindows.v1";

function loadPersistedIds(): string[] {
  try {
    const raw = localStorage.getItem(NOTE_WINDOWS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function persistIds(ids: string[]): void {
  try {
    localStorage.setItem(NOTE_WINDOWS_KEY, JSON.stringify(ids));
  } catch {
    // 存储不可用时静默跳过
  }
}

/** 当前打开的小窗条目 id 集合（订阅源，供 useNoteWindowOpen 反映按钮态） */
const openIds = new Set<string>(loadPersistedIds());
const openWindows = new Map<string, WebviewWindow>();
const listeners = new Set<() => void>();
/** 进行中的就绪握手：id → Promise，避免同窗口重复握手 */
const readyInFlight = new Map<string, Promise<boolean>>();

function emitChange(): void {
  persistIds([...openIds]);
  for (const listener of listeners) listener();
}

/** 供 useSyncExternalStore 订阅打开集合变化 */
export function subscribeNoteWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前打开的全部小窗条目 id（顺序为打开先后，供同步/重开遍历） */
export function getOpenNoteIds(): string[] {
  return [...openIds];
}

/** 钩子：该便签是否已弹出独立小窗（卡片工具条按钮激活态） */
export function useNoteWindowOpen(id: string): boolean {
  return useSyncExternalStore(
    subscribeNoteWindows,
    () => openIds.has(id),
    () => false
  );
}

function labelFor(id: string): string {
  return `${NOTE_WINDOW_PREFIX}${id}`;
}

async function findWindow(id: string): Promise<WebviewWindow | null> {
  try {
    return await WebviewWindow.getByLabel(labelFor(id));
  } catch {
    return null;
  }
}

/** 等待指定小窗回报就绪（超时视为窗口失效） */
function requestReady(id: string): Promise<boolean> {
  const existing = readyInFlight.get(id);
  if (existing) return existing;
  const promise = new Promise<boolean>((resolve) => {
    let settled = false;
    let unlisten: (() => void) | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unlisten?.();
      readyInFlight.delete(id);
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), 4000);
    void once(NOTE_WINDOW_READY_EVENT, (event) => {
      const payload = event.payload as { id?: string };
      finish(payload?.id === id);
    }).then(async (un) => {
      if (settled) {
        un();
        return;
      }
      unlisten = un;
      await emitTo(labelFor(id), NOTE_WINDOW_PING_EVENT, { id }).catch(
        () => undefined
      );
    });
  });
  readyInFlight.set(id, promise);
  return promise;
}

/** 销毁小窗并清理状态 */
export async function closeNoteWindow(id: string): Promise<void> {
  if (!openIds.delete(id)) return;
  const win = openWindows.get(id) ?? (await findWindow(id));
  openWindows.delete(id);
  emitChange();
  try {
    await win?.destroy();
  } catch {
    // 已销毁 / 权限受限时忽略
  }
}

/** 新小窗级联偏移：第 n 个窗口向右下错开，避免完全重叠（物理像素） */
function cascadeOffset(index: number): { dx: number; dy: number } {
  const slot = index % 6;
  return { dx: 60 + slot * 32, dy: 60 + slot * 28 };
}

/**
 * 打开（或聚焦已打开的）便签独立小窗：
 * 创建隐藏窗口 → 就绪握手 → 下发条目快照（含主题变量）→ show + 聚焦。
 * 条目必须存在于主窗口 store（小窗不直接读写存储，数据全部经主窗口中转）。
 */
export async function openNoteWindow(id: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const entry = useEntryStore.getState().entries.find((item) => item.id === id);
  if (!entry) return false;

  let win = openWindows.get(id) ?? (await findWindow(id));
  if (win && !openWindows.has(id)) {
    openWindows.set(id, win);
    win.once("tauri://destroyed", () => {
      if (openWindows.get(id) === win) {
        openWindows.delete(id);
        if (openIds.delete(id)) emitChange();
      }
    });
  }
  if (!win) {
    try {
      win = new WebviewWindow(labelFor(id), {
        url: "note.html",
        width: NOTE_WIN_W,
        height: NOTE_WIN_H,
        minWidth: 200,
        minHeight: 160,
        center: false,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: true,
        maximizable: false,
        minimizable: true,
        skipTaskbar: true,
        focus: false,
        visible: false,
        shadow: false,
        title: entry.title || "便签",
      });
      win.once("tauri://error", (event) => {
        console.error("便签小窗创建失败", event);
        if (openWindows.get(id) === win) {
          openWindows.delete(id);
          if (openIds.delete(id)) emitChange();
        }
      });
      win.once("tauri://destroyed", () => {
        if (openWindows.get(id) === win) {
          openWindows.delete(id);
          if (openIds.delete(id)) emitChange();
        }
      });
      openWindows.set(id, win);
      if (!openIds.has(id)) {
        openIds.add(id);
        emitChange();
      }
    } catch (error) {
      console.error("便签小窗创建失败", error);
      return false;
    }
  }

  // 已可见：视为再次点击，仅聚焦
  if (await win.isVisible().catch(() => false)) {
    await win.setFocus().catch(() => undefined);
    return true;
  }

  if (!(await requestReady(id))) {
    console.error("便签小窗未就绪，销毁待重建");
    openWindows.delete(id);
    if (openIds.delete(id)) emitChange();
    try {
      await win.destroy();
    } catch {
      // 忽略
    }
    return false;
  }

  try {
    await emitTo(labelFor(id), NOTE_WINDOW_OPEN_EVENT, {
      id,
      entry,
      knownTags: collectKnownTags(),
      noteRefs: collectNoteRefs(),
      pinned: useUiStore.getState().pinnedIds.includes(id),
    });
    // 级联定位：主窗口所在工作区左上区域依次错开
    const area = await currentWorkArea().catch(() => null);
    if (area) {
      const { dx, dy } = cascadeOffset(openWindows.size - 1);
      await win.setPosition(new PhysicalPosition(area.x + dx, area.y + dy));
    }
    await win.show();
    await win.setFocus();
    return true;
  } catch (error) {
    console.error("唤起便签小窗失败", error);
    return false;
  }
}

/** 切换小窗：已打开则销毁，未打开则弹出 */
export async function toggleNoteWindow(id: string): Promise<void> {
  if (openIds.has(id)) await closeNoteWindow(id);
  else await openNoteWindow(id);
}

/** 把条目最新数据同步给已打开的小窗（entries 变化时由 App 逐条调用） */
export async function syncNoteWindow(entry: Entry): Promise<void> {
  if (!openIds.has(entry.id)) return;
  try {
    await emitTo(labelFor(entry.id), NOTE_WINDOW_SYNC_EVENT, {
      id: entry.id,
      entry,
      knownTags: collectKnownTags(),
      noteRefs: collectNoteRefs(),
    });
  } catch {
    // 窗口可能正在关闭，忽略
  }
}

/** 主窗口启动数据加载完成后调用：重开上次会话遗留的小窗（条目已删除的跳过并清理） */
export async function restoreNoteWindows(): Promise<void> {
  if (!isTauriRuntime()) return;
  for (const id of [...openIds]) {
    const exists = useEntryStore
      .getState()
      .entries.some((item) => item.id === id);
    if (!exists) {
      openIds.delete(id);
      continue;
    }
    await openNoteWindow(id);
  }
  emitChange();
}
