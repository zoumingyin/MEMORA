import { useEffect, useState } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../repository";
import { readClipboardText, writeClipboardText } from "../utils/clipboard";
import { currentWorkArea } from "../window/tauriWindow";
import {
  CTX_MENU_COMMAND_EVENT,
  CTX_MENU_OPEN_EVENT,
  CTX_MENU_PING_EVENT,
  CTX_MENU_READY_EVENT,
  CTX_MENU_WIN_H,
  CTX_MENU_WIN_W,
  CTX_PANEL_OFFSET,
  type CtxCommand,
  type CtxMenuState,
} from "../window/ctxMenuWindow";
import {
  ContextMenuPanel,
  type CtxMenuAction,
} from "./ContextMenuPanel";

/**
 * Markdown 右键菜单独立窗口（应用启动后预热、常驻复用）：
 * 监听主窗口发来的快照（选中文本 / 格式 / 光标物理坐标 / 主题变量），
 * 渲染与页面内完全一致的菜单面板；
 * 点击菜单项后通过 Tauri 事件把命令回传给主窗口执行，随后隐藏本窗口（不销毁，下次复用）。
 * 复制/剪切/粘贴在菜单窗口内完成剪贴板读写（此时本窗口持有焦点与用户手势）。
 */
export function CtxMenuDialog() {
  const [state, setState] = useState<CtxMenuState | null>(null);
  /** 每次打开递增：让面板重挂载，清空上次的子菜单/表情搜索等瞬时状态 */
  const [openSeq, setOpenSeq] = useState(0);

  // 常驻窗口：订阅打开指令与就绪探测；监听就绪后广播 ready，主窗口据此握手
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const subs: UnlistenFn[] = [];
    let disposed = false;
    void (async () => {
      try {
        const [unOpen, unPing] = await Promise.all([
          listen<CtxMenuState>(CTX_MENU_OPEN_EVENT, (event) => {
            setState(event.payload);
            setOpenSeq((seq) => seq + 1);
          }),
          listen(CTX_MENU_PING_EVENT, () => {
            void emit(CTX_MENU_READY_EVENT);
          }),
        ]);
        if (disposed) {
          unOpen();
          unPing();
          return;
        }
        subs.push(unOpen, unPing);
        await emit(CTX_MENU_READY_EVENT);
      } catch (e) {
        console.error("右键菜单窗口事件订阅失败", e);
      }
    })();
    return () => {
      disposed = true;
      for (const un of subs) un();
    };
  }, []);

  const close = async (): Promise<void> => {
    if (!isTauriRuntime()) return;
    try {
      // 常驻窗口只隐藏不销毁：下次右键直接复用，避免重建 WebView2 的延迟
      await getCurrentWindow().hide();
    } catch (e) {
      console.error("隐藏右键菜单窗口失败", e);
    }
  };

  const send = async (payload: CtxCommand): Promise<void> => {
    if (!isTauriRuntime()) return;
    try {
      // 定向回发起右键的窗口：主窗口详情页与便签小窗可同时挂载编辑器，
      // 全局广播会让两份编辑器都执行命令（复制两次 / 格式误改）。
      // 旧快照无 sourceLabel 时保持原来的全局广播兼容。
      if (state?.sourceLabel) {
        await emitTo(state.sourceLabel, CTX_MENU_COMMAND_EVENT, payload);
      } else {
        await emit(CTX_MENU_COMMAND_EVENT, payload);
      }
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
          // ① 先移动到光标处（物理坐标）：常驻窗口可能停在别的显示器上，
          //    先移过去，之后 scaleFactor 查询才以点击所在显示器为准
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
            : CTX_MENU_WIN_W;
          const panelH = panel
            ? (panel as HTMLElement).getBoundingClientRect().height
            : CTX_MENU_WIN_H;
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
                  CTX_MENU_WIN_W,
                  Math.round((area.x + area.width - winX) / scale)
                ),
                bottom: Math.min(
                  CTX_MENU_WIN_H,
                  Math.round((area.y + area.height - winY) / scale)
                ),
              }
            : {
                left: 0,
                top: 0,
                right: CTX_MENU_WIN_W,
                bottom: CTX_MENU_WIN_H,
              };
          setViewArea(va);
          await win.setSize(
            new PhysicalSize(
              Math.round(CTX_MENU_WIN_W * scale),
              Math.round(CTX_MENU_WIN_H * scale)
            )
          );
        } catch (e) {
          // 权限未生效 / 单位换算失败时，保持窗口现有位置与尺寸
          console.error("右键菜单窗口定位/校正失败", e);
        }
        await win.show();
        await win.setFocus();
        // Windows 上透明窗口 hide→show 后 WebView2 可能不重绘：强制刷新一次合成层
        requestAnimationFrame(() => {
          const root = document.documentElement;
          root.style.transform = "translateZ(0)";
          requestAnimationFrame(() => {
            root.style.transform = "";
          });
        });
      })();
    }
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
        await writeClipboardText(state?.selectedText ?? "");
        await close();
        break;
      case "cut": {
        // 先确认剪贴板写入成功再通知主窗口删除选区，避免写入失败时误删内容
        const ok = await writeClipboardText(state?.selectedText ?? "");
        if (ok) await send({ cmd: "cut" });
        await close();
        break;
      }
      case "paste": {
        const text = await readClipboardText();
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
          key={openSeq}
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
