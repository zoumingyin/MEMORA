import { useEffect, useMemo, useState } from "react";
import { Badge, Input } from "antd";
import dayjs from "dayjs";
import { CalendarDays, Pin, Search, Settings, Sparkles, Timer, X, Zap } from "lucide-react";
import { useWindowStore } from "../store/useWindowStore";
import { useEntryStore } from "../store/useEntryStore";
import { useAssistantStore } from "../store/useAssistantStore";
import { useUiStore } from "../store/useUiStore";
import { closeWindow } from "../window/tauriWindow";
import { toggleMaximize } from "../window/maximize";
import { SettingsDialog } from "./SettingsDialog";
import { BrandMark } from "./BrandLogo";
import { QuickCapture } from "./QuickCapture";
import { PomodoroDialog } from "./PomodoroDialog";
import type { PomodoroApi } from "../hooks/usePomodoro";

interface TitleBarProps {
  /** 快速记录弹窗（全局快捷键 / 标题栏闪电按钮共用） */
  quickOpen: boolean;
  setQuickOpen: (open: boolean) => void;
  /** 番茄钟状态由 App 顶层持有后下发：收纳窄条态 TitleBar 会被卸载，状态放这里会复位 */
  pomodoro: PomodoroApi;
}

export function TitleBar({ quickOpen, setQuickOpen, pomodoro }: TitleBarProps) {
  const { alwaysOnTop } = useWindowStore();
  const { setAlwaysOnTop } = useWindowStore();
  const [pomodoroOpen, setPomodoroOpen] = useState(false);
  // 设置弹窗状态提升到 UI store：AI 助手的「去设置」可定位到指定设置页
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const settingsSection = useUiStore((state) => state.settingsSection);
  const openSettings = useUiStore((state) => state.openSettings);
  const closeSettings = useUiStore((state) => state.closeSettings);
  const assistantOpen = useAssistantStore((state) => state.open);
  const toggleAssistant = useAssistantStore((state) => state.togglePanel);
  const pomodoroLabel = pomodoro.getRemainingLabel();
  const search = useEntryStore((state) => state.search);
  const setSearch = useEntryStore((state) => state.setSearch);
  const view = useEntryStore((state) => state.view);
  const setView = useEntryStore((state) => state.setView);
  const entries = useEntryStore((state) => state.entries);
  /** 今天范围内尚未触发的提醒闹钟数（含今天到期未触发的），日历按钮徽标用 */
  const todayAlarmCount = useMemo(() => {
    const start = dayjs().startOf("day").valueOf();
    const end = dayjs().endOf("day").valueOf();
    let count = 0;
    for (const entry of entries) {
      if (entry.kind !== "reminder" || entry.done) continue;
      for (const alarm of entry.alarms) {
        if (!alarm.notified && alarm.remindAt >= start && alarm.remindAt <= end) {
          count += 1;
        }
      }
    }
    return count;
  }, [entries]);
  /** 搜索框展开状态：点击搜索图标展开，点击空白区域收起 */
  const [searchOpen, setSearchOpen] = useState(false);
  /** 搜索过滤生效中（有关键字）：收起输入框后图标保持高亮提示，点击图标可回到搜索框 */
  const searchActive = searchOpen || search.trim().length > 0;

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

  // 双击标题栏空白拖拽区：最大化 / 还原。
  // 本应用 tauri.conf.json 配置 maximizable:false（透明窗口 OS 最大化态渲染空白），
  // Tauri 原生双击最大化因此静默无反应；这里在捕获阶段拦截双击，改走
  // 程序化撑满工作区的伪最大化（见 window/maximize.ts），观感一致且避开渲染 bug。
  // 只拦 detail===2 的双击：单击拖拽（detail===1）与按钮/输入框的单击交互不受影响。
  useEffect(() => {
    const onCaptureMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || event.detail !== 2) return;
      const target = event.target as HTMLElement | null;
      if (!target || typeof target.closest !== "function") return;
      if (!target.closest(".titlebar")) return;
      if (
        target.closest(
          'button, input, textarea, [data-tauri-drag-region="false"]'
        )
      ) {
        return;
      }
      // 收纳出场动画进行中不动窗口：缩窗流程已持锁并置 docked=true，
      // 此刻双击撑满会与缩窗互相抢矩形（窄条落地后又被撑满，状态错乱）
      const winState = useWindowStore.getState();
      if (winState.docked || winState.collapsing) return;
      // 双击最大/还原即退出贴边收纳：先结束收纳会话（dockedEdge/restoredBounds
      // 清空，此后移出窗口不再自动收回窄条），再切换伪最大化——顺序反过来，
      // 切换期间会留下 mouseleave 收回窄条的竞态窗口
      winState.clearDock();
      event.preventDefault();
      event.stopImmediatePropagation();
      void toggleMaximize();
    };
    window.addEventListener("mousedown", onCaptureMouseDown, true);
    return () =>
      window.removeEventListener("mousedown", onCaptureMouseDown, true);
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      <div className="titlebar-title" title="MEMORA — Think · Note · Do">
        <BrandMark size={19} />
      </div>

      <div className="titlebar-actions " data-tauri-drag-region="false">
        <div
          className={`titlebar-search${searchOpen ? " open" : ""}`}
          data-tauri-drag-region="false"
        >
          <Input
            className="titlebar-search-input w-32"
            allowClear
            size="small"
            autoFocus={searchOpen}
            placeholder="搜索标题或内容"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              // Enter：收起输入框，关键字继续生效（列表 / 日历同步过滤）
              if (event.key === "Enter") {
                event.preventDefault();
                setSearchOpen(false);
                return;
              }
              // Esc：一键取消搜索——清空关键字并收起输入框，图标同时取消高亮
              if (event.key === "Escape") {
                event.preventDefault();
                setSearch("");
                setSearchOpen(false);
              }
            }}
          />
        </div>
        <button
          type="button"
          className={`titlebar-btn search-toggle ${searchActive ? "active" : ""}`}
          title={searchActive ? "搜索（过滤生效中，点击继续编辑）" : "搜索"}
          aria-pressed={searchActive}
          onClick={() => setSearchOpen((open) => !open)}
        >
          <Search size={15} />
        </button>

        <Badge
          count={todayAlarmCount}
          size="small"
          offset={[-2, 3]}
          title={`今天还有 ${todayAlarmCount} 条提醒`}
        >
          <button
            type="button"
            className={`titlebar-btn ${view === "calendar" ? "active" : ""}`}
            title={view === "calendar" ? "退出日历视图" : "日历视图（月 / 周 / 日）"}
            aria-pressed={view === "calendar"}
            onClick={() => setView(view === "calendar" ? "list" : "calendar")}
          >
            <CalendarDays size={15} />
          </button>
        </Badge>

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
          className={`titlebar-btn ${assistantOpen ? "active" : ""}`}
          title="AI 助手"
          aria-label="AI 助手"
          onClick={toggleAssistant}
        >
          <Sparkles size={15} />
        </button>

        <button
          type="button"
          className={`titlebar-btn ${settingsOpen ? "active" : ""}`}
          title="设置"
          onClick={() => openSettings()}
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
        key={settingsOpen ? `open-${settingsSection ?? "default"}` : "closed"}
        open={settingsOpen}
        onClose={closeSettings}
        initialSection={settingsSection}
      />
      <QuickCapture open={quickOpen} onClose={() => setQuickOpen(false)} />
      <PomodoroDialog
        open={pomodoroOpen}
        onClose={() => setPomodoroOpen(false)}
        state={pomodoro.state}
        controls={pomodoro.controls}
        workMinutes={pomodoro.workMinutes}
        breakMinutes={pomodoro.breakMinutes}
        linkedEntryId={pomodoro.linkedEntryId}
        todayStats={pomodoro.todayStats}
      />
    </header>
  );
}
