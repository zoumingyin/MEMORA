import { useEffect, useRef, useState } from "react";
import {
  beep,
  fmt,
  loadFocusStats,
  recordFocusRound,
  type FocusStats,
  type PomodoroControls,
  type PomodoroState,
} from "../utils/pomodoro";

const STORAGE_KEY = "bianqian.pomodoro.v1";

interface PomodoroSettings {
  workMinutes: number;
  breakMinutes: number;
  /** 绑定的待办条目 id：专注轮结束后据此提示勾选已完成子任务 */
  linkedEntryId: string | null;
}

function loadSettings(): PomodoroSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PomodoroSettings>;
      const work = [15, 25, 45].includes(parsed.workMinutes ?? -1)
        ? parsed.workMinutes!
        : 25;
      const brk = [5, 10, 15].includes(parsed.breakMinutes ?? -1)
        ? parsed.breakMinutes!
        : 5;
      return {
        workMinutes: work,
        breakMinutes: brk,
        linkedEntryId:
          typeof parsed.linkedEntryId === "string"
            ? parsed.linkedEntryId
            : null,
      };
    }
  } catch {
    // 损坏数据回退默认
  }
  return { workMinutes: 25, breakMinutes: 5, linkedEntryId: null };
}

function saveSettings(settings: PomodoroSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 存储不可用时静默跳过
  }
}

/**
 * 番茄钟计时逻辑：由 App 顶层常驻持有（收纳窄条态 App 不卸载，计时继续走），
 * 状态经 props 传给标题栏与弹窗；弹窗关闭后计时器继续走。
 * 工作轮结束自动切休息、休息轮结束自动切回工作并鸣响；设置持久化 localStorage。
 */
export function usePomodoro() {
  const [settings, setSettings] = useState<PomodoroSettings>(loadSettings);
  const [todayStats, setTodayStats] = useState<FocusStats>(loadFocusStats);
  const [state, setState] = useState<PomodoroState>(() => {
    const saved = loadSettings();
    return {
      mode: "work",
      remainingMs: saved.workMinutes * 60_000,
      running: false,
      rounds: 0,
    };
  });

  // 每完成一轮专注（rounds 递增）记入当天统计：跨天读取时自动归零
  const prevRoundsRef = useRef(state.rounds);
  useEffect(() => {
    if (state.rounds > prevRoundsRef.current) {
      setTodayStats(recordFocusRound(settings.workMinutes));
    }
    prevRoundsRef.current = state.rounds;
  }, [state.rounds, settings.workMinutes]);

  // 每秒 tick：剩余时间递减，归零自动切换模式
  useEffect(() => {
    if (!state.running) return;
    const timer = window.setInterval(() => {
      setState((prev) => {
        const next = prev.remainingMs - 1000;
        if (next > 0) {
          return { ...prev, remainingMs: next };
        }
        // 当前轮结束：切到另一模式并鸣响
        const mode = prev.mode === "work" ? "break" : "work";
        const ms =
          mode === "work"
            ? settings.workMinutes * 60_000
            : settings.breakMinutes * 60_000;
        beep();
        return {
          mode,
          remainingMs: ms,
          running: true,
          rounds: prev.mode === "work" ? prev.rounds + 1 : prev.rounds,
        };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state.running, settings.workMinutes, settings.breakMinutes]);

  const controls: PomodoroControls = {
    start: () => {
      setState((prev) =>
        prev.remainingMs <= 0
          ? {
              ...prev,
              remainingMs:
                (prev.mode === "work"
                  ? settings.workMinutes
                  : settings.breakMinutes) * 60_000,
              running: true,
            }
          : { ...prev, running: true },
      );
    },
    pause: () => setState((prev) => ({ ...prev, running: false })),
    reset: () =>
      setState((prev) => ({
        ...prev,
        remainingMs:
          (prev.mode === "work" ? settings.workMinutes : settings.breakMinutes) *
          60_000,
        running: false,
      })),
    setMode: (mode) =>
      setState((prev) => ({
        ...prev,
        mode,
        remainingMs:
          (mode === "work" ? settings.workMinutes : settings.breakMinutes) *
          60_000,
      })),
    setWorkMinutes: (minutes) => {
      setSettings((prev) => {
        const next = { ...prev, workMinutes: minutes };
        saveSettings(next);
        return next;
      });
      setState((prev) =>
        prev.mode === "work"
          ? { ...prev, remainingMs: minutes * 60_000 }
          : prev,
      );
    },
    setBreakMinutes: (minutes) => {
      setSettings((prev) => {
        const next = { ...prev, breakMinutes: minutes };
        saveSettings(next);
        return next;
      });
      setState((prev) =>
        prev.mode === "break"
          ? { ...prev, remainingMs: minutes * 60_000 }
          : prev,
      );
    },
    setLinkedEntry: (id) =>
      setSettings((prev) => {
        const next = { ...prev, linkedEntryId: id };
        saveSettings(next);
        return next;
      }),
  };

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const getRemainingLabel = () => {
    const s = stateRef.current;
    const ms =
      s.remainingMs <= 0
        ? (s.mode === "work" ? settings.workMinutes : settings.breakMinutes) * 60_000
        : s.remainingMs;
    return fmt(ms);
  };

  return {
    state,
    controls,
    workMinutes: settings.workMinutes,
    breakMinutes: settings.breakMinutes,
    linkedEntryId: settings.linkedEntryId,
    todayStats,
    getRemainingLabel,
  };
}

/** usePomodoro 的返回类型：App 顶层调用后经 props 下发，消费方（TitleBar 等）用此标注 */
export type PomodoroApi = ReturnType<typeof usePomodoro>;
