import { Collapse, Empty } from "antd";
import {
  BellOutlined,
  CheckSquareOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { useState, type ReactNode } from "react";
import { useEntryStore } from "../store/useEntryStore";
import type { AlarmMode, Entry, EntryKind } from "../types/entry";
import { useNow } from "../hooks/useNow";
import { formatRelative, formatShort } from "../utils/format";

const KIND_ICON: Record<EntryKind, ReactNode> = {
  note: <FileTextOutlined />,
  reminder: <BellOutlined />,
  todo: <CheckSquareOutlined />,
};

/** 闹钟模式简称（卡片内紧凑展示） */
const ALARM_MODE_LABEL: Record<AlarmMode, string> = {
  once: "单次",
  loop: "循环",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
  lunar: "农历",
  workday: "工作日",
};

/** 卡片内最多预览的条目数（子任务 / 闹钟），超出的折叠为 +N */
const PREVIEW_LIMIT = 3;

/** 待办完成判定：有子任务且全部勾选 */
function todoAllDone(entry: Entry): boolean {
  return (
    entry.kind === "todo" &&
    entry.items.length > 0 &&
    entry.items.every((item) => item.done)
  );
}

/** 已完成判定：待办全部勾选，或提醒已全部处理（归入下方「已完成」分组） */
function entryDone(entry: Entry): boolean {
  if (entry.kind === "todo") return todoAllDone(entry);
  if (entry.kind === "reminder") return reminderStatus(entry).allNotified;
  return false;
}

/** 提醒状态：最近待提醒闹钟时间；全部已提醒视为处理完 */
function reminderStatus(entry: Entry): { at: number; allNotified: boolean } {
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

/** 分类排序：备忘按更新时间倒序，提醒按最近待提醒时间升序（未提醒在前），待办未完成在前 */
function sortEntries(
  filter: "all" | EntryKind,
  entries: Entry[],
  sortBy: "updated" | "created" = "updated"
): Entry[] {
  const byTime = (a: Entry, b: Entry) =>
    sortBy === "created"
      ? b.createdAt - a.createdAt
      : b.updatedAt - a.updatedAt;
  if (filter === "all") {
    return [...entries].sort(byTime);
  }
  const list = entries.filter((entry) => entry.kind === filter);
  if (filter === "note") {
    return list.sort(byTime);
  }
  if (filter === "todo") {
    return list.sort((a, b) => {
      if (a.kind === "todo" && b.kind === "todo") {
        const aDone = todoAllDone(a);
        const bDone = todoAllDone(b);
        if (aDone !== bDone) return aDone ? 1 : -1;
        return byTime(a, b);
      }
      return 0;
    });
  }
  return list.sort((a, b) => {
    const aStatus = reminderStatus(a);
    const bStatus = reminderStatus(b);
    if (aStatus.allNotified !== bStatus.allNotified)
      return aStatus.allNotified ? 1 : -1;
    return aStatus.at - bStatus.at;
  });
}

/** 搜索/标签/时间范围过滤：query 匹配标题与正文，tag 精确匹配，range 按更新时间 */
function filterEntries(
  entries: Entry[],
  search: string,
  tagFilter: string | null,
  timeRange: "all" | "today" | "7d" | "30d"
): Entry[] {
  const query = search.trim().toLowerCase();
  const now = Date.now();
  const start =
    timeRange === "today"
      ? (() => {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          return d.getTime();
        })()
      : timeRange === "7d"
        ? now - 7 * 24 * 3600_000
        : timeRange === "30d"
          ? now - 30 * 24 * 3600_000
          : 0;
  return entries.filter((entry) => {
    if (tagFilter && !entry.tags.includes(tagFilter)) return false;
    if (start && entry.updatedAt < start) return false;
    if (query) {
      const haystack = `${entry.title}\n${entry.content}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function rowMeta(
  entry: Entry,
  now: number
): { text: string; overdue?: boolean } {
  if (entry.kind === "note") {
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

/** 从 markdown/HTML 正文提取首张图片（base64 data URL），列表卡片用作缩略图 */
function firstImageSrc(md: string): string | null {
  const mdImg = md.match(/!\[[^\]]*\]\((data:image\/[^)\s]+)\)/i);
  if (mdImg) return mdImg[1];
  const htmlImg = md.match(/<img[^>]+src=["'](data:image\/[^"']+)["']/i);
  return htmlImg ? htmlImg[1] : null;
}

/** 正文转纯文本摘要：剔除图片标记与 HTML 标签，避免 base64 数据串作为乱码显示在列表 */
function toPlainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<img[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_~`-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface EntryListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** 左侧主从列表：全部条目按行展示，点击选中后在右侧详情编辑；待办分类下已完成条目自动归入下方「已完成」分组 */
export function EntryList({ selectedId, onSelect }: EntryListProps) {
  const filter = useEntryStore((state) => state.filter);
  const entries = useEntryStore((state) => state.entries);
  const search = useEntryStore((state) => state.search);
  const tagFilter = useEntryStore((state) => state.tagFilter);
  const timeRange = useEntryStore((state) => state.timeRange);
  const sortBy = useEntryStore((state) => state.sortBy);
  const now = useNow();

  const filtered = filterEntries(entries, search, tagFilter, timeRange);
  const list = sortEntries(filter, filtered, sortBy);

  // 分组视图：待办/提醒拆「进行中/其他」与「已完成」两组，
  // 待办勾选完成、提醒标记已处理后自动归入下方「已完成」区
  const activeRows = list.filter((entry) => !entryDone(entry));
  const doneRows = list.filter((entry) => entryDone(entry));
  // 已完成区默认折叠：点「已完成项 (n)」标题展开查看已完成的卡片
  const [doneExpanded, setDoneExpanded] = useState(false);

  const renderRow = (entry: Entry) => {
    const icon = KIND_ICON[entry.kind];
    const meta = rowMeta(entry, now);
    const doneClass = entryDone(entry) ? "done" : "";
    const thumb = firstImageSrc(entry.content || "");
    const excerpt = toPlainText(entry.content || "");
    return (
      <button
        key={entry.id}
        type="button"
        className={`note-row kind-${entry.kind} ${selectedId === entry.id ? "note-card-active" : "note-card"} ${meta.overdue ? "overdue" : ""} ${doneClass}`}
        onClick={() => onSelect(entry.id)}
      >
        <span className="row-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="row-title ">{entry.title || "无标题"}</span>
        {thumb && (
          <span className="row-thumb flex-1 min-h-0">
            <img
              src={thumb}
              alt=""
              loading="lazy"
              draggable={false}
              className="h-full! w-full object-cover"
            />
          </span>
        )}
        {/* 待办卡片预览部分子任务；闹钟卡片预览部分闹钟；其余沿用正文摘要 */}
        {entry.kind === "todo" && entry.items.length > 0 ? (
          <span className="flex w-full min-h-0 flex-col gap-1 overflow-hidden">
            {entry.items.slice(0, PREVIEW_LIMIT).map((item) => (
              <span
                key={item.id}
                className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]"
              >
                <span
                  className={`h-[9px] w-[9px] shrink-0 rounded-[3px] ${item.done ? "bg-[var(--todo)]" : "border border-solid border-[var(--control-border)]"}`}
                />
                <span
                  className={`min-w-0 truncate ${item.done ? "opacity-60 line-through" : ""}`}
                >
                  {item.text}
                </span>
              </span>
            ))}
            {entry.items.length > PREVIEW_LIMIT && (
              <span className="text-[10.5px] text-[var(--text-muted)] opacity-70">
                +{entry.items.length - PREVIEW_LIMIT} 项
              </span>
            )}
          </span>
        ) : entry.kind === "reminder" && entry.alarms.length > 0 ? (
          <span className="flex w-full min-h-0 flex-col gap-1 overflow-hidden">
            {entry.alarms.slice(0, PREVIEW_LIMIT).map((alarm) => (
              <span
                key={alarm.id}
                className={`flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)] ${alarm.notified ? "opacity-55" : ""}`}
              >
                <ClockCircleOutlined className="shrink-0 text-[10px]" />
                <span className="min-w-0 truncate">
                  {formatShort(alarm.remindAt)}
                </span>
                <span className="shrink-0 opacity-70">
                  {ALARM_MODE_LABEL[alarm.mode]}
                </span>
              </span>
            ))}
            {entry.alarms.length > PREVIEW_LIMIT && (
              <span className="text-[10.5px] text-[var(--text-muted)] opacity-70">
                +{entry.alarms.length - PREVIEW_LIMIT} 个
              </span>
            )}
          </span>
        ) : (
          excerpt && (
            <span className={`row-desc ${thumb ? "line-clamp-2" : "line-clamp-5"}`}>
              {excerpt}
            </span>
          )
        )}
        <span className="mt-auto w-full flex flex-col gap-1.5">
          <span className="card-divider" />
          <span className={`row-meta ${meta.overdue ? "overdue" : ""}`}>
            {meta.text}
          </span>
        </span>
      </button>
    );
  };

  if (list.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 p-[6px_10px_12px] flex-1 min-h-0 overflow-y-auto"
        data-tauri-drag-region="false"
      >
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有内容" />
        <span className="text-xs color-muted">点右上角 + 新建一条</span>
      </div>
    );
  }

  return (
    <div
      className="entry-list grid grid-cols-2 gap-3 p-[6px_10px_12px] flex-1 min-h-0 overflow-y-auto content-start"
      data-tauri-drag-region="false"
    >
      {activeRows.map(renderRow)}
      {doneRows.length > 0 && (
        <Collapse
          ghost
          key="done-collapse"
          activeKey={doneExpanded ? ["done"] : []}
          onChange={(keys) =>
            setDoneExpanded(
              Array.isArray(keys) ? keys.includes("done") : keys === "done"
            )
          }
          items={[
            {
              key: "done",
              label: (
                <span className="text-[12px] font-medium tracking-[0.6px]">
                  已完成项 ({doneRows.length})
                </span>
              ),
              children: (
                <div className="grid grid-cols-2 gap-3 pt-[4px]">
                  {doneRows.map(renderRow)}
                </div>
              ),
            },
          ]}
          className="col-span-full done-collapse"
          styles={{
            header: {
              color: "var(--text)",
              background: "rgb(var(--field-rgb))",
              borderRadius: "8px",
              padding: "12px 10px",
            },
            body: { padding: "0" },
          }}
        />
      )}
    </div>
  );
}
