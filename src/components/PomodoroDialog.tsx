import { Button, Modal, Progress, Select } from "antd";
import {
  CheckOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  RedoOutlined,
} from "@ant-design/icons";
import { useMemo } from "react";
import {
  BREAK_PRESETS,
  fmt,
  localDateKey,
  MODE_LABEL,
  WORK_PRESETS,
  type FocusStats,
  type PomodoroControls,
  type PomodoroState,
} from "../utils/pomodoro";
import { useEntryStore } from "../store/useEntryStore";
import type { TodoEntry } from "../types/entry";

interface PomodoroDialogProps {
  open: boolean;
  onClose: () => void;
  state: PomodoroState;
  controls: PomodoroControls;
  workMinutes: number;
  breakMinutes: number;
  /** 当前绑定的待办 id（null = 不绑定） */
  linkedEntryId: string | null;
  todayStats: FocusStats;
}

/** 番茄钟弹窗：专注/休息倒计时 + 轮次计数，计时器由 App 顶层常驻持有（关闭弹窗 / 收纳窗口都继续走） */
export function PomodoroDialog({
  open,
  onClose,
  state,
  controls,
  workMinutes,
  breakMinutes,
  linkedEntryId,
  todayStats,
}: PomodoroDialogProps) {
  const { mode, remainingMs, running, rounds } = state;
  const totalMs = (mode === "work" ? workMinutes : breakMinutes) * 60_000;
  const percent = Math.min(100, Math.max(0, 100 - (remainingMs / totalMs) * 100));

  const entries = useEntryStore((state) => state.entries);
  const linkedEntry = linkedEntryId
    ? entries.find((entry) => entry.id === linkedEntryId)
    : undefined;
  const linkedTodo = linkedEntry?.kind === "todo" ? linkedEntry : null;

  // 可绑定待办：还有未完成子任务的待办；已绑定但全部完成的也保留在选项里，避免值显示成 id
  const todoOptions = useMemo(() => {
    const pendingOptions = entries
      .filter(
        (entry): entry is TodoEntry =>
          entry.kind === "todo" && entry.items.some((item) => !item.done)
      )
      .map((entry) => ({
        value: entry.id,
        label: `剩 ${entry.items.filter((item) => !item.done).length} 项 · ${entry.title}`,
      }));
    if (linkedTodo && !pendingOptions.some((item) => item.value === linkedTodo.id)) {
      pendingOptions.push({
        value: linkedTodo.id,
        label: `${linkedTodo.title}（已完成）`,
      });
    }
    return pendingOptions;
  }, [entries, linkedTodo]);

  // 跨天但尚未完成新一轮时，本地统计还停在昨天：展示层按今天归零
  const stats =
    todayStats.date === localDateKey()
      ? todayStats
      : { date: todayStats.date, rounds: 0, minutes: 0 };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="番茄钟"
      centered
      footer={null}
      width={330}
    >
      <div className="pomodoro-body">
        <div className="pomodoro-ring">
          <Progress
            type="circle"
            percent={Math.round(percent)}
            size={168}
            strokeColor={mode === "work" ? "#e56875" : "#16a78a"}
            trailColor="rgba(128,128,128,0.18)"
            format={() => <span className="pomodoro-time">{fmt(remainingMs)}</span>}
          />
        </div>
        <div className="pomodoro-meta">
          <span className={`pomodoro-mode ${mode}`}>
            {MODE_LABEL[mode]}
          </span>
          <span className="pomodoro-rounds">第 {rounds + 1} 轮</span>
        </div>

        <div className="flex w-full flex-col gap-1.5">
          <div className="flex w-full items-center justify-between text-[11.5px] text-[var(--text-muted)]">
            <span>今日专注</span>
            <span className="font-semibold text-[var(--text)]">
              {stats.rounds} 轮 · {stats.minutes} 分钟
            </span>
          </div>
          <div className="flex w-full items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <span className="shrink-0">绑定待办</span>
            <Select
              size="small"
              className="min-w-0 flex-1"
              allowClear
              placeholder="不绑定"
              value={linkedTodo ? linkedTodo.id : undefined}
              onChange={(value) => controls.setLinkedEntry(value ?? null)}
              options={todoOptions}
              popupMatchSelectWidth={false}
              notFoundContent="暂无未完成待办"
            />
          </div>
        </div>

        <div className="pomodoro-controls">
          {running ? (
            <Button
              icon={<PauseOutlined />}
              onClick={controls.pause}
            >
              暂停
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={controls.start}
            >
              {remainingMs <= 0 ? "开始" : "继续"}
            </Button>
          )}
          <Button icon={<RedoOutlined />} onClick={controls.reset}>
            重置
          </Button>
          {remainingMs <= 0 && !running && (
            <Button
              icon={<CheckOutlined />}
              onClick={() => {
                controls.reset();
                controls.start();
              }}
            >
              再来一轮
            </Button>
          )}
        </div>

        <div className="pomodoro-settings">
          <div className="pomodoro-setting">
            <span>专注</span>
            <Select
              size="small"
              value={workMinutes}
              onChange={(value) => controls.setWorkMinutes(value)}
              options={WORK_PRESETS.map((minutes) => ({
                value: minutes,
                label: `${minutes} 分钟`,
              }))}
            />
          </div>
          <div className="pomodoro-setting">
            <span>休息</span>
            <Select
              size="small"
              value={breakMinutes}
              onChange={(value) => controls.setBreakMinutes(value)}
              options={BREAK_PRESETS.map((minutes) => ({
                value: minutes,
                label: `${minutes} 分钟`,
              }))}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
