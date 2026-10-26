import { useEffect, useState } from "react";
import { Input } from "antd";
import {
  Pin,
  Search,
  Settings,
  Timer,
  X,
  Zap,
} from "lucide-react";
import { useWindowStore } from "../store/useWindowStore";
import { useEntryStore } from "../store/useEntryStore";
import { closeWindow } from "../window/tauriWindow";
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
  const { alwaysOnTop } = useWindowStore();
  const { setAlwaysOnTop } = useWindowStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pomodoroOpen, setPomodoroOpen] = useState(false);
  const pomodoro = usePomodoro();
  const pomodoroLabel = pomodoro.getRemainingLabel();
  const search = useEntryStore((state) => state.search);
  const setSearch = useEntryStore((state) => state.setSearch);
  /** 搜索框展开状态：点击搜索图标展开，点击空白区域收起 */
  const [searchOpen, setSearchOpen] = useState(false);

  // 点击搜索框/图标以外的区域时收起搜索框
  useEffect(() => {
    if (!searchOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(".titlebar-search") ||
        target.closest(".search-toggle")
      ) {
        return;
      }
      setSearchOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [searchOpen]);

  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      <div className="titlebar-title text-12px">
        <span className="dot" />
        便签
      </div>

      <div
        className={`titlebar-search${searchOpen ? " open" : ""}`}
        data-tauri-drag-region="false"
      >
        <Input
          className="titlebar-search-input"
          allowClear
          size="small"
          autoFocus={searchOpen}
          placeholder="搜索标题或内容"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="titlebar-actions " data-tauri-drag-region="false">
        <button
          type="button"
          className={`titlebar-btn search-toggle ${searchOpen ? "active" : ""}`}
          title="搜索"
          onClick={() => setSearchOpen((open) => !open)}
        >
          <Search size={15} />
        </button>

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
