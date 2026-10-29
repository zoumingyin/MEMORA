import { useEffect, useState } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../repository";
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

  // 窗口以隐藏方式创建（visible:false）：首帧渲染完成后再显示并聚焦，消除白屏
  useEffect(() => {
    if (!state) return;
    if (isTauriRuntime()) {
      const win = getCurrentWindow();
      void win.show();
      void win.setFocus();
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
          onAction={(action) => void handleAction(action)}
        />
      </div>
    </ConfigProvider>
  );
}
