import { useState } from "react";
import {
  Magnet,
  Minus,
  PanelRightClose,
  Pin,
  Settings,
  Timer,
  X,
  Zap,
} from "lucide-react";
import { useWindowStore } from "../store/useWindowStore";
import {
  closeWindow,
  currentWorkArea,
  getBounds,
  minimizeWindow,
} from "../window/tauriWindow";
import { collapseToStrip, detectDockEdge } from "../window/edgeDock";
import { SettingsDialog } from "./SettingsDialog";
import { QuickCapture } from "./QuickCapture";
import { PomodoroDialog } from "./PomodoroDialog";
import { usePomodoro } from "../hooks/usePomodoro";

interface TitleBarProps {
  /** 快速记录弹窗（全局快捷键 / 标题栏闪电按钮共用） */
  quickOpen: boolean;
  setQuickOpen: (open: boolean) => void;
}

export function TitleBar({ quickOpen, setQuickOpen }: TitleBarProps) {
  const { alwaysOnTop, edgeDocking, docked } = useWindowStore();
  const { setAlwaysOnTop, setEdgeDocking, setDock } = useWindowStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pomodoroOpen, setPomodoroOpen] = useState(false);
  const pomodoro = usePomodoro();
  const pomodoroLabel = pomodoro.getRemainingLabel();

  /** 收纳到当前贴近边缘；未贴近边缘时默认右侧 */
  const handleCollapse = async () => {
    const bounds = await getBounds();
    if (!bounds) return;
    const workArea = await currentWorkArea();
    if (!workArea) return;
    let edge = useWindowStore.getState().dockedEdge;
    if (!edge) edge = detectDockEdge(bounds, workArea) ?? "right";
    setDock(edge, bounds, true);
    await collapseToStrip(edge, bounds, workArea);
  };

  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      <div className="titlebar-title">
        <span className="dot" />
        便签
      </div>

      <div className="titlebar-actions" data-tauri-drag-region="false">
        <button
          type="button"
          className={`titlebar-btn ${alwaysOnTop ? "active" : ""}`}
          title={alwaysOnTop ? "取消置顶" : "置顶到桌面最上层"}
          onClick={() => void setAlwaysOnTop(!alwaysOnTop)}
        >
          <Pin size={15} />
        </button>

        <button
          type="button"
          className={`titlebar-btn ${edgeDocking ? "active" : ""}`}
          title={edgeDocking ? "关闭边缘吸附" : "开启边缘吸附"}
          onClick={() => setEdgeDocking(!edgeDocking)}
        >
          <Magnet size={15} />
        </button>

        <button
          type="button"
          className={`titlebar-btn pomodoro-btn ${pomodoroOpen ? "active" : ""}`}
          title="番茄钟"
          onClick={() => setPomodoroOpen(true)}
        >
          <Timer size={15} />
          {pomodoro.state.running && (
            <span className="pomodoro-label">{pomodoroLabel}</span>
          )}
        </button>

        <button
          type="button"
          className={`titlebar-btn ${settingsOpen ? "active" : ""}`}
          title="设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={15} />
        </button>

        <button
          type="button"
          className={`titlebar-btn ${quickOpen ? "active" : ""}`}
          title="快速记录（Ctrl+Shift+N）"
          onClick={() => setQuickOpen(true)}
        >
          <Zap size={15} />
        </button>

        <button
          type="button"
          className={`titlebar-btn ${docked ? "active" : ""}`}
          title={docked ? "展开便签" : "收纳到屏幕边缘"}
          disabled={docked}
          onClick={() => void handleCollapse()}
        >
          <PanelRightClose size={15} />
        </button>

        <button
          type="button"
          className="titlebar-btn"
          title="最小化"
          onClick={() => void minimizeWindow()}
        >
          <Minus size={15} />
        </button>

        <button
          type="button"
          className="titlebar-btn close"
          title="关闭"
          onClick={() => void closeWindow()}
        >
          <X size={15} />
        </button>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <QuickCapture open={quickOpen} onClose={() => setQuickOpen(false)} />
      <PomodoroDialog
        open={pomodoroOpen}
        onClose={() => setPomodoroOpen(false)}
        state={pomodoro.state}
        controls={pomodoro.controls}
        workMinutes={pomodoro.workMinutes}
        breakMinutes={pomodoro.breakMinutes}
      />
    </header>
  );
}