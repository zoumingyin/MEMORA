import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, once } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../repository";

/**
 * 常驻复用的 Markdown 右键菜单窗口。
 *
 * 早期实现每次右键都 new WebviewWindow：创建 WebView2 实例、加载 ctxmenu 入口
 * bundle、再串行做多次 IPC 定位，实测有几百毫秒延迟。改为应用启动后预热一个
 * 隐藏窗口，右键时只把快照（选中文本 / 格式 / 光标物理坐标）通过事件
 * 发过去，由菜单窗口自己定位并 show，延迟降到毫秒级。
 *
 * 窗口能力见 capabilities/md-ctx-menu.json（按 md-ctx-* 匹配）。
 */

/** 常驻菜单窗口标签 */
export const CTX_MENU_LABEL = "md-ctx-menu";

/** 主窗口 → 菜单窗口：打开一次菜单（payload 为快照） */
export const CTX_MENU_OPEN_EVENT = "md-ctx-open";
/** 菜单窗口 → 主窗口：页面已加载并注册好事件监听 */
export const CTX_MENU_READY_EVENT = "md-ctx-ready";
/** 主窗口 → 菜单窗口：就绪探测（主窗口刷新后重新握手用） */
export const CTX_MENU_PING_EVENT = "md-ctx-ping";
/** 菜单窗口 → 主窗口：菜单项命令 */
export const CTX_MENU_COMMAND_EVENT = "md-ctx-command";

/**
 * 菜单窗口尺寸（CSS px）：
 * 宽 780 = 面板（约 165）+ 面板内移 240（左侧给子菜单留空间）+ 右侧子菜单横向展开余量，
 * 使子菜单贴屏幕边缘时既能向左也能向右完整展开；高 520 容纳完整字号子菜单（360）。
 */
export const CTX_MENU_WIN_W = 780;
export const CTX_MENU_WIN_H = 520;

/**
 * 面板在窗口内的左移量（CSS px）：面板不贴窗口左缘，给子菜单左侧留出展开空间，
 * 使子菜单贴屏幕边缘时能向左完整展开（与 CTX_MENU_WIN_W 配套：
 * 240 + 触发项左缘(≈10) - 最宽子菜单(244) ≥ 0，且 240 + 触发项右缘(≈403) + 244 ≤ 780）。
 */
export const CTX_PANEL_OFFSET = 240;

/** 右键菜单窗口打开时主窗口快照的状态 */
export interface CtxMenuState {
  /** 发起右键的窗口标签：菜单命令定向回该窗口，避免多窗口同时开着编辑器时命令双份执行 */
  sourceLabel?: string;
  /** 当前编辑器选区纯文本（复制/剪切用，剪切/粘贴在菜单窗口内完成剪贴板读写） */
  selectedText: string;
  bold: boolean;
  strike: boolean;
  italic: boolean;
  underline: boolean;
  /** 当前文字颜色（拾色器子菜单初始值） */
  color?: string;
  /** 右键瞬间的鼠标位置（物理像素）：系统光标读取失败时为主窗口几何换算的兜底值 */
  cursorX: number;
  cursorY: number;
  /**
   * 点击所在显示器的工作区（物理像素）：主窗口就在该显示器上，
   * 作为菜单翻转/钳制的权威边界（多显示器场景下窗口自身所在显示器可能不同）。
   */
  workArea: { x: number; y: number; width: number; height: number } | null;
}

/** 菜单命令：菜单窗口点击后通过 Tauri 事件回传给主窗口执行 */
export type CtxCommand =
  | { cmd: "copy" | "cut" | "selectAll" | "bold" | "strike" | "italic" | "underline" | "insertImage" | "sizeDefault" | "info" }
  | { cmd: "paste"; value: string }
  | { cmd: "color" | "colorCommit"; value: string }
  | { cmd: "colorClear" | "colorClearCommit" }
  | { cmd: "size"; value: string }
  | { cmd: "insertEmoji"; value: string };

/** 等待菜单窗口回报就绪的超时时间；超时视为窗口失效并重建 */
const READY_TIMEOUT_MS = 4000;

/** 已创建的常驻窗口（销毁事件后置空，下次右键重新创建） */
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
    return await WebviewWindow.getByLabel(CTX_MENU_LABEL);
  } catch {
    return null;
  }
}

/** 取常驻菜单窗口；不存在时隐藏创建（不抢焦点），页面就绪后由 ready 事件确认 */
async function ensureWindow(): Promise<WebviewWindow | null> {
  if (windowRef) return windowRef;
  if (createInFlight) return createInFlight;
  createInFlight = (async () => {
    try {
      const existing = await findWindow();
      if (existing) return track(existing);
      const win = new WebviewWindow(CTX_MENU_LABEL, {
        url: "ctxmenu.html",
        width: CTX_MENU_WIN_W,
        height: CTX_MENU_WIN_H,
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
        title: "右键菜单",
      });
      win.once("tauri://error", (event) => {
        console.error("右键菜单窗口创建失败", event);
        if (windowRef === win) windowRef = null;
      });
      return track(win);
    } catch (error) {
      console.error("右键菜单窗口创建失败", error);
      return null;
    } finally {
      createInFlight = null;
    }
  })();
  return createInFlight;
}

/**
 * 等待菜单窗口回报就绪：先注册一次性监听再 ping，避免应答早于监听注册。
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
    void once(CTX_MENU_READY_EVENT, () => finish(true)).then(async (un) => {
      if (settled) {
        un();
        return;
      }
      unlisten = un;
      await emitTo(CTX_MENU_LABEL, CTX_MENU_PING_EVENT).catch(() => undefined);
    });
  });
}

/** 销毁失效窗口，下次打开时重新创建 */
async function destroyWindow(): Promise<void> {
  const win = windowRef;
  windowRef = null;
  try {
    await (win ?? (await findWindow()))?.destroy();
  } catch {
    // 已销毁 / 权限受限时忽略
  }
}

/** 应用启动后调用：提前把菜单窗口加载好，首次右键也无需等待 */
export function prewarmCtxMenuWindow(): void {
  if (!isTauriRuntime()) return;
  void ensureWindow();
}

/**
 * 打开右键菜单：向常驻窗口发送快照并返回是否成功。
 * 返回 false 时调用方回退为页面内菜单（窗口创建失败 / 就绪超时）。
 */
export async function openCtxMenu(snapshot: CtxMenuState): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const win = await ensureWindow();
    if (!win) return false;
    if (!(await requestReady())) {
      console.error("右键菜单窗口未就绪，重建后重试");
      await destroyWindow();
      continue;
    }
    try {
      await emitTo(CTX_MENU_LABEL, CTX_MENU_OPEN_EVENT, snapshot);
      return true;
    } catch (error) {
      console.error("打开右键菜单失败", error);
      await destroyWindow();
    }
  }
  return false;
}

/** 隐藏常驻菜单窗口（打开菜单的编辑器卸载时兜底调用） */
export async function hideCtxMenuWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const win = windowRef ?? (await findWindow());
    await win?.hide();
  } catch {
    // 窗口已销毁 / 未创建时忽略
  }
}
