import { BellOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import { renderNoteMarkdown } from "../utils/noteLinks";
import { formatRelative, formatShort } from "../utils/format";
import { TodoPreview } from "./EntryCardParts";
import {
  ALARM_MODE_LABEL,
  WALL_TODO_LIMIT,
  reminderStatus,
} from "../utils/wallCardMeta";
import type { Entry } from "../types/entry";

interface EntryCardBodyProps {
  entry: Entry;
  now: number;
  /** 便签 [[引用]] 解析器：标题 → 目标 id；缺省（无全量清单的窗口）渲染为不可点的未解析胶囊 */
  resolveNoteRef?: (title: string) => { id: string } | null;
}

/**
 * 贴纸墙卡片正文（备忘 Markdown / 涂鸦图 / 待办进度+子任务 / 提醒状态）。
 * 从 EntryList 的 renderWallCard 抽出共享：贴纸墙与便签独立小窗展示态共用，
 * 保证两处展示像素级一致。
 */
export function EntryCardBody({
  entry,
  now,
  resolveNoteRef,
}: EntryCardBodyProps): ReactNode {
  if (entry.kind === "note") {
    // 无解析器（小窗未收到清单）时按未解析胶囊渲染，点击仍可转发主窗口跳转
    const noteHtml = renderNoteMarkdown(
      entry.content || "",
      resolveNoteRef ?? (() => null)
    );
    return noteHtml ? (
      <div
        className="note-md wall-note-md"
        dangerouslySetInnerHTML={{ __html: noteHtml }}
      />
    ) : (
      <span className="wall-note-empty">（空白便签）</span>
    );
  }
  if (entry.kind === "draw") {
    return entry.content ? (
      <img
        src={entry.content}
        alt=""
        draggable={false}
        className="wall-draw-img"
      />
    ) : (
      <span className="wall-note-empty">（空白涂鸦）</span>
    );
  }
  if (entry.kind === "todo") {
    const todoTotal = entry.items.length;
    const todoDoneCount = entry.items.filter((item) => item.done).length;
    const todoPct = todoTotal
      ? Math.round((todoDoneCount / todoTotal) * 100)
      : 0;
    return (
      <div className="flex flex-col gap-2">
        <div className="wall-progress">
          <span className="wall-progress-track">
            <span
              className="wall-progress-fill"
              style={{ width: `${todoPct}%` }}
            />
          </span>
          <span className="wall-progress-count">
            {todoDoneCount}/{todoTotal}
          </span>
        </div>
        {todoTotal === 0 ? (
          <span className="wall-note-empty">暂无子任务</span>
        ) : (
          <TodoPreview items={entry.items} limit={WALL_TODO_LIMIT} />
        )}
      </div>
    );
  }
  const reminder = reminderStatus(entry);
  const nextAlarm = entry.alarms.find((alarm) => !alarm.notified) ?? entry.alarms[0];
  const overdue = !reminder.allNotified && reminder.at <= now;
  return (
    <div className="flex flex-col gap-1.5">
      <span className={`wall-reminder-main ${overdue ? "overdue" : ""}`}>
        <BellOutlined />
        {reminder.allNotified
          ? "全部已提醒"
          : overdue
            ? "已到期"
            : formatRelative(reminder.at)}
      </span>
      <span className="wall-reminder-sub flex min-w-0 items-center gap-1">
        {nextAlarm ? (
          <>
            {nextAlarm.name && (
              <span className="max-w-[45%] shrink-0 truncate font-600">
                {nextAlarm.name}
              </span>
            )}
            <span className="min-w-0 truncate">
              {formatShort(nextAlarm.remindAt)} ·{" "}
              {ALARM_MODE_LABEL[nextAlarm.mode]}
            </span>
          </>
        ) : (
          "暂无闹钟"
        )}
        {entry.alarms.length > 0 && (
          <span className="shrink-0">　共 {entry.alarms.length} 个</span>
        )}
      </span>
    </div>
  );
}
