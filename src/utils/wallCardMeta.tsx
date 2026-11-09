import type { ReactNode } from "react";
import {
  BellOutlined,
  CheckSquareOutlined,
  EditOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { formatRelative, formatShort } from "../utils/format";
import type { AlarmMode, Entry } from "../types/entry";

/** 贴纸墙待办卡片内最多预览的子任务数（卡片高度固定，超出裁切） */
export const WALL_TODO_LIMIT = 4;

export const KIND_ICON: Record<Entry["kind"], ReactNode> = {
  note: <FileTextOutlined />,
  reminder: <BellOutlined />,
  todo: <CheckSquareOutlined />,
  draw: <EditOutlined />,
};

/** 闹钟模式简称（卡片内紧凑展示） */
export const ALARM_MODE_LABEL: Record<AlarmMode, string> = {
  once: "单次",
  loop: "循环",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
  lunar: "农历",
  workday: "工作日",
};

/** 月份/日期（贴纸墙页脚，参考图样式：10/29） */
export function formatMonthDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 待办完成判定：有子任务且全部勾选 */
export function todoAllDone(entry: Entry): boolean {
  return (
    entry.kind === "todo" &&
    entry.items.length > 0 &&
    entry.items.every((item) => item.done)
  );
}

/** 提醒状态：最近待提醒闹钟时间；全部已提醒视为处理完 */
export function reminderStatus(entry: Entry): {
  at: number;
  allNotified: boolean;
} {
  if (entry.kind !== "reminder") return { at: 0, allNotified: true };
  const alarms = entry.alarms;
  if (alarms.length === 0) {
    return { at: entry.remindAt, allNotified: entry.done || entry.notified };
  }
  const pending = alarms.filter((alarm) => !alarm.notified);
  if (pending.length === 0)
    return {
      at: Math.max(...alarms.map((alarm) => alarm.remindAt)),
      allNotified: true,
    };
  return {
    at: Math.min(...pending.map((alarm) => alarm.remindAt)),
    allNotified: false,
  };
}

/** 已完成判定：待办全部勾选，或提醒已全部处理（归入下方「已完成」分组） */
export function entryDone(entry: Entry): boolean {
  if (entry.kind === "todo") return todoAllDone(entry);
  if (entry.kind === "reminder") return reminderStatus(entry).allNotified;
  return false;
}

/** 卡片元信息行（列表行与卡片页脚共用）：待办 n/m、提醒相对时间/已到期 */
export function rowMeta(
  entry: Entry,
  now: number,
): { text: string; overdue?: boolean } {
  if (entry.kind === "note" || entry.kind === "draw") {
    return { text: `更新于 ${formatShort(entry.updatedAt)}` };
  }
  if (entry.kind === "todo") {
    const items = entry.items;
    if (items.length === 0) return { text: "无子任务" };
    const doneCount = items.filter((item) => item.done).length;
    return doneCount === items.length
      ? { text: `已完成 ${doneCount}/${items.length}` }
      : { text: `${doneCount}/${items.length} 项` };
  }
  const status = reminderStatus(entry);
  const overdue = !status.allNotified && status.at <= now;
  return {
    text: status.allNotified
      ? "已处理"
      : overdue
        ? "已到期"
        : formatRelative(status.at),
    overdue,
  };
}

/** 贴纸装饰：置顶卡片固定显示红色图钉，其余按 id 哈希分配左 / 右胶带，重排后不跳变 */
export function wallDecoration(id: string, pinned: boolean): string {
  if (pinned) return "wall-deco-pin";
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return ["wall-deco-tape-left", "wall-deco-tape-right"][Math.abs(hash) % 2];
}
