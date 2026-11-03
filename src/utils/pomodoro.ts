/** 番茄钟共享类型与纯函数：PomodoroDialog 与 usePomodoro 均从此导入，避免组件文件导出非组件 */

export type PomodoroMode = "work" | "break";

export interface PomodoroState {
  mode: PomodoroMode;
  /** 剩余毫秒 */
  remainingMs: number;
  running: boolean;
  /** 已完成的工作轮次 */
  rounds: number;
}

export interface PomodoroControls {
  start: () => void;
  pause: () => void;
  reset: () => void;
  setMode: (mode: PomodoroMode) => void;
  setWorkMinutes: (minutes: number) => void;
  setBreakMinutes: (minutes: number) => void;
  /** 绑定/解绑番茄钟关联的待办（null = 不绑定） */
  setLinkedEntry: (id: string | null) => void;
}

export const WORK_PRESETS = [15, 25, 45];
export const BREAK_PRESETS = [5, 10, 15];

export const MODE_LABEL: Record<PomodoroMode, string> = {
  work: "专注",
  break: "休息",
};

/** 毫秒 → mm:ss（向上取整，剩余 0 显示 00:00） */
export function fmt(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 每日专注统计（date 为本地日期键，跨天自动归零） */
export interface FocusStats {
  date: string;
  /** 完成的工作轮数 */
  rounds: number;
  /** 累计专注分钟数 */
  minutes: number;
}

const FOCUS_STATS_KEY = "bianqian.pomodoro.stats.v1";

/** 本地日期键 YYYY-MM-DD（按用户时区，而非 UTC） */
export function localDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 读取今天的专注统计（存的是别的日期则视为零） */
export function loadFocusStats(): FocusStats {
  const today = localDateKey();
  try {
    const raw = localStorage.getItem(FOCUS_STATS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FocusStats>;
      if (parsed.date === today) {
        return {
          date: today,
          rounds: Math.max(0, Math.floor(parsed.rounds ?? 0)),
          minutes: Math.max(0, Math.floor(parsed.minutes ?? 0)),
        };
      }
    }
  } catch {
    // 损坏数据回退为零
  }
  return { date: today, rounds: 0, minutes: 0 };
}

/** 记录一轮完成的专注并写回今天统计 */
export function recordFocusRound(workMinutes: number): FocusStats {
  const prev = loadFocusStats();
  const next: FocusStats = {
    date: prev.date,
    rounds: prev.rounds + 1,
    minutes: prev.minutes + workMinutes,
  };
  try {
    localStorage.setItem(FOCUS_STATS_KEY, JSON.stringify(next));
  } catch {
    // 存储不可用时仅内存生效
  }
  return next;
}

/** 完成提示音：Web Audio 短促双音（无需权限文件） */
export function beep(): void {
  try {
    const ctx = new AudioContext();
    for (const [offset, freq] of [
      [0, 880],
      [0.18, 660],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.25, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        ctx.currentTime + offset + 0.35,
      );
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.4);
    }
    window.setTimeout(() => void ctx.close(), 1200);
  } catch {
    // 环境不支持音频时静默跳过
  }
}
