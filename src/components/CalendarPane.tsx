import { Calendar, Empty } from "antd";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useMemo, useState, type ReactNode } from "react";
import { useEntryStore } from "../store/useEntryStore";
import type { Entry } from "../types/entry";
import { ENTRY_KIND_COLOR, ENTRY_KIND_LABEL } from "../utils/entryLabels";
import { formatShort } from "../utils/format";

/** 某条目的「发生日期」：提醒按最近闹钟时间，备忘/待办/涂鸦按最近更新时间 */
function entryDates(entry: Entry): number[] {
  if (entry.kind === "reminder") {
    return entry.alarms.map((alarm) => alarm.remindAt);
  }
  return [entry.updatedAt];
}

/**
 * 日历视图：月历打点（提醒按闹钟日期、备忘/待办按更新时间），
 * 点击日期在下方列出当天条目，点击条目进详情编辑。
 */
export function CalendarPane({ onSelect }: { onSelect: (id: string) => void }) {
  const entries = useEntryStore((state) => state.entries);
  const [selectedDate, setSelectedDate] = useState<Dayjs>(() => dayjs());

  // 日期 → 条目映射（所有分类），用于月历打点与当日列表
  const byDate = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const entry of entries) {
      const seen = new Set<string>();
      for (const ts of entryDates(entry)) {
        const key = dayjs(ts).format("YYYY-MM-DD");
        if (seen.has(key)) continue;
        seen.add(key);
        const list = map.get(key) ?? [];
        list.push(entry);
        map.set(key, list);
      }
    }
    return map;
  }, [entries]);

  const dayKey = selectedDate.format("YYYY-MM-DD");
  const dayEntries = useMemo(() => {
    const list = byDate.get(dayKey) ?? [];
    return [...list].sort((a, b) => {
      if (a.kind === "reminder" && b.kind === "reminder") {
        return a.remindAt - b.remindAt;
      }
      return b.updatedAt - a.updatedAt;
    });
  }, [byDate, dayKey]);

  const cellRender = (
    date: Dayjs,
    info: { originNode: ReactNode; type: string },
  ) => {
    // 注意：不能原样返回 info.originNode —— antd v6 会把 cellRender 的返回值渲染进
    // content 区，而 originNode 本身已包含单元格数字（日期/月份/年份），返回它会导致
    // 每个格子数字渲染两遍。这里只渲染打点（date 类型），数字由 antd 正常绘制。
    if (info.type !== "date") return null;
    const list = byDate.get(date.format("YYYY-MM-DD"));
    if (!list || list.length === 0) return null;
    // 打点按分类去重，最多显示 3 个
    const kinds = [...new Set(list.map((entry) => entry.kind))].slice(0, 3);
    return (
      <span className="calendar-dots">
        {kinds.map((kind) => (
          <i
            key={kind}
            className="calendar-dot"
            style={{ background: ENTRY_KIND_COLOR[kind] }}
          />
        ))}
      </span>
    );
  };

  return (
    <div className="calendar-pane">
      <Calendar
        fullscreen={false}
        value={selectedDate}
        onSelect={(date) => setSelectedDate(date)}
        cellRender={cellRender}
      />
      <div className="calendar-day-head">
        <span>{selectedDate.format("M 月 D 日 dddd")}</span>
        <em className="calendar-day-count">
          {dayEntries.length === 0 ? "没有条目" : `${dayEntries.length} 条`}
        </em>
      </div>
      <div className="calendar-day-list">
        {dayEntries.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这天没有条目" />
        ) : (
          dayEntries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="calendar-day-item"
              onClick={() => onSelect(entry.id)}
            >
              <i
                className="calendar-day-kind"
                style={{ background: ENTRY_KIND_COLOR[entry.kind] }}
              />
              <span className="calendar-day-title">
                {entry.title.trim() || "（无标题）"}
              </span>
              <span className="calendar-day-meta">
                {ENTRY_KIND_LABEL[entry.kind]}
                {entry.kind === "reminder"
                  ? ` · ${formatShort(entry.remindAt)}`
                  : ` · ${formatShort(entry.updatedAt)}`}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
