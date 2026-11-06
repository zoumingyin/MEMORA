import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, once } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../repository";
import { currentWorkArea, type WorkArea } from "./tauriWindow";
import type { Entry, EntryKind } from "../types/entry";
import { useEntryStore } from "../store/useEntryStore";

/**
 * 常驻复用的全局快捷搜索（Spotlight 式）窗口。
 *
 * 与右键菜单窗口同一套路：应用启动后预热一个隐藏窗口，Ctrl+Shift+F 唤起时
 * 主窗口把条目快照（标题/预览/标签/主题变量）+ 定位信息发给它，搜索窗口
 * 自己定位到主窗口所在显示器顶部居中并 show + 聚焦，回车跳回主窗口对应便签。
 *
 * 窗口能力见 capabilities/spotlight.json（按 spotlight 匹配）。
 */

/** 搜索窗口标签 */
export const SPOTLIGHT_LABEL = "spotlight";

/** 主窗口 → 搜索窗口：打开一次搜索（payload 为条目快照 + 主题 + 工作区） */
export const SPOTLIGHT_OPEN_EVENT = "spotlight:open";
/** 搜索窗口 → 主窗口：页面已加载并注册好事件监听 */
export const SPOTLIGHT_READY_EVENT = "spotlight:ready";
/** 主窗口 → 搜索窗口：就绪探测（主窗口刷新后重新握手用） */
export const SPOTLIGHT_PING_EVENT = "spotlight:ping";
/** 搜索窗口 → 主窗口：选中某条便签，主窗口跳转详情 */
export const SPOTLIGHT_JUMP_EVENT = "spotlight:jump";

/** 搜索窗口尺寸（CSS px）：顶部搜索框 + 下方结果列表的最大高度 */
export const SPOTLIGHT_WIN_W = 560;
export const SPOTLIGHT_WIN_H = 420;
/** 面板距所在显示器工作区顶部的间距（CSS px） */
export const SPOTLIGHT_TOP_OFFSET = 96;

/** 搜索窗口收到的单条便签快照：正文只留纯文本预览，避免 base64 图片撑爆事件 */
export interface SpotlightEntry {
  id: string;
  kind: EntryKind;
  title: string;
  preview: string;
  tags: string[];
  updatedAt: number;
}

/** 主窗口 → 搜索窗口的打开快照 */
export interface SpotlightSnapshot {
  entries: SpotlightEntry[];
  isDark: boolean;
  /** 主窗口当前主题的 CSS 变量快照，注入本窗口保持视觉一致 */
  cssVars: Record<string, string>;
  /** 主窗口所在显示器的工作区（物理像素）：搜索窗口定位到其顶部居中 */
  workArea: WorkArea | null;
}

/** 快照里给正文生成纯文本预览（与 TrashPane 的 previewText 同规则，截断 160 字） */
export function spotlightPreview(entry: Entry): string {
  if (entry.kind === "draw") return entry.content ? "手写涂鸦" : "";
  return (
    entry.content
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[#>*_~`-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || ""
  );
}

/** 从主窗口 store 构建条目快照（含废纸篓外的全部条目） */
export function buildSpotlightEntries(): SpotlightEntry[] {
  return useEntryStore.getState().entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    preview: spotlightPreview(entry),
    tags: entry.tags,
    updatedAt: entry.updatedAt,
  }));
}

/** 快照主窗口当前主题 CSS 变量（与右键菜单快照同一组 + --note 主色） */
export function buildSpotlightCssVars(): Record<string, string> {
  const cssVars: Record<string, string> = {};
  for (const key of [
    "--field-rgb",
    "--border",
    "--text",
    "--text-muted",
    "--hover-fill",
    "--kind-accent",
    "--note",
  ]) {
    cssVars[key] = getComputedStyle(document.documentElement)
      .getPropertyValue(key)
      .trim();
  }
  return cssVars;
}

/** 等待搜索窗口回报就绪的超时时间；超时视为窗口失效并重建 */
const READY_TIMEOUT_MS = 4000;

/** 已创建的常驻窗口（销毁事件后置空，下次唤起重新创建） */
let windowRef: WebviewWindow | null = null;
/** 进行中的创建过程：并发调用共享同一次创建，避免同标签重复创建 */
let createInFlight: Promise<WebviewWindow | null> | null = null;

function track(win: WebviewWindow): WebviewWindow {
  windowRef = win;
  win.once("tauri://destroyed", () => {
    if (windowRef === win) windowRef = null;
  });
  return win;
}

async function findWindow(): Promise<WebviewWindow | null> {
  try {
    return await WebviewWindow.getByLabel(SPOTLIGHT_LABEL);
  } catch {
    return null;
  }
}

/** 取常驻搜索窗口；不存在时隐藏创建（不抢焦点），页面就绪后由 ready 事件确认 */
async function ensureWindow(): Promise<WebviewWindow | null> {
  if (windowRef) return windowRef;
  if (createInFlight) return createInFlight;
  createInFlight = (async () => {
    try {
      const existing = await findWindow();
      if (existing) return track(existing);
      const win = new WebviewWindow(SPOTLIGHT_LABEL, {
        url: "spotlight.html",
        width: SPOTLIGHT_WIN_W,
        height: SPOTLIGHT_WIN_H,
        center: false,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        skipTaskbar: true,
        focus: false,
        visible: false,
        shadow: false,
        title: "快捷搜索",
      });
      win.once("tauri://error", (event) => {
        console.error("快捷搜索窗口创建失败", event);
        if (windowRef === win) windowRef = null;
      });
      return track(win);
    } catch (error) {
      console.error("快捷搜索窗口创建失败", error);
      return null;
    } finally {
      createInFlight = null;
    }
  })();
  return createInFlight;
}

/**
 * 等待搜索窗口回报就绪：先注册一次性监听再 ping，避免应答早于监听注册。
 * 窗口首次创建时 ping 无人应答，由页面加载完成后的 ready 广播补齐。
 */
function requestReady(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unlisten: (() => void) | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unlisten?.();
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), READY_TIMEOUT_MS);
    void once(SPOTLIGHT_READY_EVENT, () => finish(true)).then(async (un) => {
      if (settled) {
        un();
        return;
      }
      unlisten = un;
      await emitTo(SPOTLIGHT_LABEL, SPOTLIGHT_PING_EVENT).catch(() => undefined);
    });
  });
}

/** 销毁失效窗口，下次唤起时重新创建 */
async function destroyWindow(): Promise<void> {
  const win = windowRef;
  windowRef = null;
  try {
    await (win ?? (await findWindow()))?.destroy();
  } catch {
    // 已销毁 / 权限受限时忽略
  }
}

/** 应用启动后调用：提前把搜索窗口加载好，首次快捷键也无需等待 */
export function prewarmSpotlightWindow(): void {
  if (!isTauriRuntime()) return;
  void ensureWindow();
}

/** 隐藏搜索窗口（主窗口跳转 / 搜索窗口自身关闭后由主窗口兜底调用） */
export async function hideSpotlightWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const win = windowRef ?? (await findWindow());
    await win?.hide();
  } catch {
    // 窗口已销毁 / 未创建时忽略
  }
}

/**
 * 快捷键唤起 / 再按一次关闭搜索窗口（toggle）：
 * 已可见 → 直接隐藏；否则确保窗口存在、握手就绪后发送快照，由搜索窗口自行定位显示。
 */
export async function toggleSpotlightWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const existing = await findWindow();
  if (existing && (await existing.isVisible().catch(() => false))) {
    await hideSpotlightWindow();
    return;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const win = await ensureWindow();
    if (!win) return;
    if (!(await requestReady())) {
      console.error("快捷搜索窗口未就绪，重建后重试");
      await destroyWindow();
      continue;
    }
    try {
      const snapshot: SpotlightSnapshot = {
        entries: buildSpotlightEntries(),
        isDark: document.documentElement.classList.contains("dark-glass"),
        cssVars: buildSpotlightCssVars(),
        workArea: await currentWorkArea().catch(() => null),
      };
      await emitTo(SPOTLIGHT_LABEL, SPOTLIGHT_OPEN_EVENT, snapshot);
      return;
    } catch (error) {
      console.error("唤起快捷搜索失败", error);
      await destroyWindow();
    }
  }
}
