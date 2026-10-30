import { useEffect, useState } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { emit } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../repository";
import { currentWorkArea } from "../window/tauriWindow";

/**
 * 菜单面板在窗口内的左移量（CSS px）：面板不贴窗口左缘，给子菜单左侧留出展开空间，
 * 使子菜单贴屏幕边缘时能向左完整展开（与 MarkdownEditor 的 CTX_MENU_WIN_W=780 配套：
 * 240 + 触发项左缘(≈10) - 最宽子菜单(244) ≥ 0，且 240 + 触发项右缘(≈403) + 244 ≤ 780）。
 */
const CTX_PANEL_OFFSET = 240;
import {
  ContextMenuPanel,
  type CtxMenuAction,
} from "./ContextMenuPanel";

/** 右键菜单窗口打开时主窗口快照的状态 */
interface CtxMenuState {
  /** 当前编辑器选区纯文本（复制/剪切用，剪切/粘贴在菜单窗口内完成剪贴板读写） */
  selectedText: string;
  bold: boolean;
  strike: boolean;
  italic: boolean;
  underline: boolean;
  /** 当前文字颜色（拾色器子菜单初始值） */
  color?: string;
  isDark: boolean;
  /** 主窗口当前主题的 CSS 变量快照，注入本窗口让菜单视觉与主窗口一致 */
  cssVars: Record<string, string>;
  /** 右键瞬间的系统光标位置（物理像素），用于把本窗口精确定位到鼠标点击处 */
  cursorX: number;
  cursorY: number;
  /** cursorPosition 是否读取成功（失败时保持创建选项位置） */
  cursorCaptured: boolean;
  /** 菜单窗口期望的 CSS 像素尺寸（主窗口按此换算物理尺寸校正） */
  winW: number;
  winH: number;
  /**
   * 点击所在显示器的工作区（物理像素）：主窗口就在该显示器上，
   * 作为菜单翻转/钳制的权威边界（多显示器场景下窗口初始位置所在显示器可能不同）。
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

/** 从弹窗窗口 URL 参数读取 storageKey，再从 localStorage 取菜单状态（只读取一次） */
function readParams(): CtxMenuState | null {
  const query = new URLSearchParams(location.search);
  const key = query.get("key") ?? "";
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw) as CtxMenuState;
    localStorage.removeItem(key);
    return data;
  } catch {
    return null;
  }
}

async function writeClipboard(text: string): Promise<void> {
  try {
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (write && text) await write(text);
  } catch {
    // 剪贴板不可用时静默忽略（与主窗口原行为一致）
  }
}

async function readClipboard(): Promise<string> {
  try {
    const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
    if (!read) return "";
    return await read();
  } catch {
    return "";
  }
}

/**
 * Markdown 右键菜单独立窗口（参考图片预览窗口实现）：
 * 读取主窗口右键时快照的状态，渲染与页面内完全一致的菜单面板；
 * 点击菜单项后通过 Tauri 事件把命令回传给主窗口执行，随后关闭本窗口。
 * 复制/剪切/粘贴在菜单窗口内完成剪贴板读写（此时本窗口持有焦点与用户手势）。
 */
export function CtxMenuDialog() {
  const [state] = useState(() => readParams());

  const close = async (): Promise<void> => {
    if (isTauriRuntime()) {
      try {
        await getCurrentWindow().close();
      } catch (e) {
        console.error("关闭右键菜单窗口失败", e);
      }
    }
  };

  const send = async (payload: CtxCommand): Promise<void> => {
    if (!isTauriRuntime()) return;
    try {
      await emit("md-ctx-command", payload);
    } catch (e) {
      console.error("右键菜单命令发送失败", e);
    }
  };

  // 注入主窗口主题 CSS 变量，使菜单视觉（底色/边框/文字/悬停/主题色）与主窗口一致
  useEffect(() => {
    if (!state) return;
    const rootStyle = document.documentElement.style;
    for (const [key, value] of Object.entries(state.cssVars)) {
      if (value) rootStyle.setProperty(key, value);
    }
  }, [state]);

  // 窗口以隐藏方式创建（visible:false）：先移动到光标处，使窗口落在点击所在显示器，
  // 再取该显示器的缩放与工作区，按四方向碰撞规则（右/下放不下则向左/上翻转，
  // 左/上兜底钳制）计算落点，用物理坐标精确定位；同时把「屏幕工作区 ∩ 窗口内部」
  // 映射为可见区域，供子菜单展开方向自适应。全部完成后才显示聚焦。
  // 多显示器关键：翻转/钳制必须用「点击所在显示器」的工作区（主窗口传入优先），
  // 而不是窗口创建时所在显示器的，否则右/下边缘判断会失效。
  const [viewArea, setViewArea] = useState<{
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null>(null);
  useEffect(() => {
    if (!state) return;
    if (isTauriRuntime()) {
      const win = getCurrentWindow();
      void (async () => {
        try {
          if (state.cursorCaptured) {
            // ① 先移动到光标处（物理坐标）：窗口落在点击所在显示器，
            //    之后 scaleFactor/工作区查询都以该显示器为准
            await win.setPosition(
              new PhysicalPosition(state.cursorX, state.cursorY)
            );
            const scale = await win.scaleFactor();
            // ② 边界：优先用主窗口传入的「点击所在显示器」工作区；
            //    缺失时回退为移动后当前显示器的工作区
            const area = state.workArea ?? (await currentWorkArea());
            // ③ 面板实际尺寸（CSS px，面板落在窗口左上角）
            const panel = document.querySelector(".md-ctx-menu");
            const panelW = panel
              ? (panel as HTMLElement).getBoundingClientRect().width
              : state.winW;
            const panelH = panel
              ? (panel as HTMLElement).getBoundingClientRect().height
              : state.winH;
            // 期望落点：面板左上角对齐光标（右下展开）
            let wx = state.cursorX;
            let wy = state.cursorY;
            const pWP = Math.round(panelW * scale);
            const pHP = Math.round(panelH * scale);
            if (area) {
              // 右边界放不下 → 向左翻转（面板右缘贴近鼠标）
              if (wx + pWP > area.x + area.width) wx = state.cursorX - pWP;
              // 下边界放不下 → 向上翻转（面板底缘贴近鼠标）
              if (wy + pHP > area.y + area.height) wy = state.cursorY - pHP;
              // 左/上边界兜底钳制：面板比工作区还大时贴住边缘
              wx = Math.min(
                Math.max(wx, area.x),
                area.x + Math.max(0, area.width - pWP)
              );
              wy = Math.min(
                Math.max(wy, area.y),
                area.y + Math.max(0, area.height - pHP)
              );
            }
            await win.setPosition(
              new PhysicalPosition(
                wx - Math.round(CTX_PANEL_OFFSET * scale),
                wy
              )
            );
            // ④ 可见区域：点击所在显示器工作区映射进窗口坐标系后与窗口内部取交集（CSS px）。
            //    窗口左缘 = 面板锚点 - 面板内移量（物理像素），子菜单方向以窗口内的实际位置计算
            const winX = wx - Math.round(CTX_PANEL_OFFSET * scale);
            const winY = wy;
            const va = area
              ? {
                  left: Math.max(0, Math.round((area.x - winX) / scale)),
                  top: Math.max(0, Math.round((area.y - winY) / scale)),
                  right: Math.min(
                    state.winW,
                    Math.round((area.x + area.width - winX) / scale)
                  ),
                  bottom: Math.min(
                    state.winH,
                    Math.round((area.y + area.height - winY) / scale)
                  ),
                }
              : {
                  left: 0,
                  top: 0,
                  right: state.winW,
                  bottom: state.winH,
                };
            setViewArea(va);
            await win.setSize(
              new PhysicalSize(
                Math.round(state.winW * scale),
                Math.round(state.winH * scale)
              )
            );
          }
        } catch (e) {
          // 权限未生效 / 单位换算失败时，保持创建选项的位置与尺寸
          console.error("右键菜单窗口定位/校正失败", e);
        }
        await win.show();
        await win.setFocus();
      })();
    }
  }, [state]);

  // 状态缺失（key 失效等）：直接关闭窗口
  useEffect(() => {
    if (state) return;
    if (isTauriRuntime()) void getCurrentWindow().close();
  }, [state]);

  // Esc 关闭 / 失焦关闭（点击主窗口等外部区域时菜单自动消失）
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") void close();
    };
    const onBlur = (): void => {
      void close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [state]);

  const handleAction = async (action: CtxMenuAction): Promise<void> => {
    switch (action.type) {
      case "copy":
        await writeClipboard(state?.selectedText ?? "");
        await close();
        break;
      case "cut":
        await writeClipboard(state?.selectedText ?? "");
        await send({ cmd: "cut" });
        await close();
        break;
      case "paste": {
        const text = await readClipboard();
        if (text) await send({ cmd: "paste", value: text });
        await close();
        break;
      }
      case "selectAll":
        await send({ cmd: "selectAll" });
        await close();
        break;
      case "bold":
        await send({ cmd: "bold" });
        await close();
        break;
      case "strike":
        await send({ cmd: "strike" });
        await close();
        break;
      case "italic":
        await send({ cmd: "italic" });
        await close();
        break;
      case "underline":
        await send({ cmd: "underline" });
        await close();
        break;
      case "color":
        // 实时取色：仅通知主窗口应用，不关闭菜单
        await send({ cmd: "color", value: action.value });
        break;
      case "colorClear":
        // 实时清色：仅通知主窗口，不关闭菜单
        await send({ cmd: "colorClear" });
        break;
      case "colorCommit":
        await send({ cmd: "colorCommit", value: action.value });
        await close();
        break;
      case "colorClearCommit":
        await send({ cmd: "colorClearCommit" });
        await close();
        break;
      case "size":
        await send({ cmd: "size", value: action.value });
        await close();
        break;
      case "sizeDefault":
        await send({ cmd: "sizeDefault" });
        await close();
        break;
      case "insertImage":
        await send({ cmd: "insertImage" });
        await close();
        break;
      case "insertEmoji":
        await send({ cmd: "insertEmoji", value: action.emoji });
        await close();
        break;
      case "info":
        // 快捷键介绍：仅展示
        break;
    }
  };

  if (!state) {
    return <div className="md-ctx-window" />;
  }

  return (
    <ConfigProvider
      theme={state.isDark ? { algorithm: antdTheme.darkAlgorithm } : undefined}
    >
      <div
        className="md-ctx-window"
        onContextMenu={(e) => {
          e.preventDefault();
          void close();
        }}
      >
        {/* 点击/右键窗口空白处关闭（透明区域也由遮罩接管，行为与页面内菜单遮罩一致） */}
        <div
          className="md-ctx-window-mask"
          onClick={() => void close()}
          onContextMenu={(e) => {
            e.preventDefault();
            void close();
          }}
        />
        <ContextMenuPanel
          active={{
            bold: state.bold,
            strike: state.strike,
            italic: state.italic,
            underline: state.underline,
          }}
          colorValue={state.color}
          style={{ left: CTX_PANEL_OFFSET }}
          viewArea={viewArea}
          onAction={(action) => void handleAction(action)}
        />
      </div>
    </ConfigProvider>
  );
}
