import { LeftOutlined, PlusOutlined, RightOutlined } from "@ant-design/icons";
import dayGridPlugin from "@fullcalendar/daygrid";
import type {
  EventClickArg,
  EventContentArg,
  EventInput,
} from "@fullcalendar/core";
import interactionPlugin, {
  type DateClickArg,
} from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import { App as AntdApp } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Lunar } from "lunar-javascript";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEntryStore } from "../store/useEntryStore";
import type { Entry, EntryKind, NewEntryInput } from "../types/entry";
import { ENTRY_KIND_COLOR, ENTRY_KIND_LABEL } from "../utils/entryLabels";
import { toMinuteStart } from "../utils/format";
import { CreateKindDialog } from "./CreateKindDialog";

/** 日历视图模式：月网格（FullCalendar）/ 周议程 / 日议程 */
type CalendarViewMode = "month" | "week" | "day";

const VIEW_STORAGE_KEY = "bianqian.calendarView.v1";
const VIEW_OPTIONS: { value: CalendarViewMode; label: string }[] = [
  { value: "month", label: "月" },
  { value: "week", label: "周" },
  { value: "day", label: "日" },
];
/** 星期表头（dayjs zh-cn / FullCalendar firstDay=1，周一为一周起点） */
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

/** FullCalendar 事件的扩展字段（eventContent / eventClick 用） */
interface FcEventProps {
  entryId: string;
  kind: EntryKind;
  done: boolean;
  ts: number;
}

function loadViewMode(): CalendarViewMode {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    return raw === "week" || raw === "day" ? raw : "month";
  } catch {
    return "month";
  }
}

function persistViewMode(view: CalendarViewMode): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // 存储不可用时静默跳过
  }
}

/** 日历事件：某条目在某天的展示点 */
interface CalendarEvent {
  entry: Entry;
  /** 该日期内的展示时间戳（同条目同天取最早一条，用于排序与 HH:mm 展示） */
  ts: number;
}

/** 条目的「发生日期」：提醒按闹钟时间（无闹钟兜底 remindAt），备忘/待办/涂鸦按最近更新时间 */
function entryTimes(entry: Entry): number[] {
  if (entry.kind === "reminder") {
    if (entry.alarms.length > 0) return entry.alarms.map((a) => a.remindAt);
    return [entry.remindAt];
  }
  return [entry.updatedAt];
}

/** 条目是否已完成（提醒 / 待办有完成态） */
function isEntryDone(entry: Entry): boolean {
  if (entry.kind === "todo" || entry.kind === "reminder") return entry.done;
  return false;
}

/** 月格下的农历小字：节气 > 节日（农历 / 公历） > 初一显月名 > 农历日 */
function lunarText(date: Dayjs): string {
  const lunar = Lunar.fromDate(date.toDate());
  const jieqi = lunar.getJieQi();
  if (jieqi) return jieqi;
  const lunarFest = lunar.getFestivals();
  if (lunarFest.length > 0) return lunarFest[0];
  const solarFest = lunar.getSolar().getFestivals();
  if (solarFest.length > 0) return solarFest[0];
  if (lunar.getDay() === 1) {
    return `${lunar.getMonth() < 0 ? "闰" : ""}${lunar.getMonthInChinese()}月`;
  }
  return lunar.getDayInChinese();
}

/** 单条日程事件（时间 + 分类色条 + 标题），点击进详情 */
function EventChip({
  event,
  onSelect,
  expanded,
}: {
  event: CalendarEvent;
  onSelect: (id: string) => void;
  expanded?: boolean;
}) {
  const { entry, ts } = event;
  const done = isEntryDone(entry);
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.id)}
      className={`flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-[var(--memora-radius-sm)] border border-[var(--border)] bg-transparent px-2 text-left transition-colors duration-150 hover:bg-[var(--hover-fill)] ${
        expanded ? "py-[7px]" : "py-[5px]"
      }`}
    >
      <span className="w-[36px] flex-none text-[11px] font-semibold text-[var(--text-muted)] tabular-nums">
        {dayjs(ts).format("HH:mm")}
      </span>
      <span
        aria-hidden
        className={expanded ? "h-[22px] w-[6px] flex-none rounded-[3px]" : "h-[20px] w-[5px] flex-none rounded-[3px]"}
        style={{ background: ENTRY_KIND_COLOR[entry.kind] }}
      />
      <span
        className={`min-w-0 flex-1 truncate font-semibold text-[var(--text)] ${
          expanded ? "text-[12.5px]" : "text-[12px]"
        }${done ? " opacity-60 line-through" : ""}`}
      >
        {entry.title.trim() || "（无标题）"}
      </span>
      <span className="flex-none text-[10px] text-[var(--text-muted)]">
        {ENTRY_KIND_LABEL[entry.kind]}
      </span>
    </button>
  );
}

/** 单日议程段：日期头（今日标记 + 新建按钮） + 当日事件列表 */
function AgendaDay({
  date,
  events,
  todayKey,
  onSelect,
  onCreate,
  expanded,
}: {
  date: Dayjs;
  events: CalendarEvent[];
  todayKey: string;
  onSelect: (id: string) => void;
  onCreate: (date: Dayjs) => void;
  /** 日视图主区块：更大的留白与新建按钮 */
  expanded?: boolean;
}) {
  const isToday = date.format("YYYY-MM-DD") === todayKey;
  return (
    <section className={expanded ? "flex min-h-0 flex-1 flex-col" : "flex flex-col"}>
      <div
        className={`flex items-center gap-2 px-1 ${expanded ? "pt-1.5 pb-2" : "pt-1.5 pb-1"}`}
      >
        <span
          className={`flex items-center justify-center rounded-full font-bold ${
            isToday
              ? "bg-[var(--note)] text-white"
              : "text-[var(--text)]"
          } ${expanded ? "h-[26px] px-2.5 text-[13px]" : "h-[20px] w-[20px] text-[11px]"}`}
        >
          {isToday ? "今" : date.date()}
        </span>
        <span
          className={`font-semibold text-[var(--text)] ${expanded ? "text-[13px]" : "text-[11px] text-[var(--text-muted)]"}`}
        >
          {date.format(expanded ? "M月D日 dddd" : "dddd")}
        </span>
        <span className="h-px flex-1 bg-[var(--border)]" />
        {expanded ? (
          <button
            type="button"
            title="在这天新建便签"
            onClick={() => onCreate(date)}
            className="flex h-6 cursor-pointer items-center gap-1 rounded-full border border-[var(--border)] bg-transparent px-2 text-[11px] font-semibold text-[var(--text)] transition-colors duration-150 hover:bg-[var(--hover-fill)]"
          >
            <PlusOutlined />
            <span>新建事项</span>
          </button>
        ) : (
          <button
            type="button"
            title={`在 ${date.format("M月D日")} 新建便签`}
            aria-label={`在 ${date.format("M月D日")} 新建便签`}
            onClick={() => onCreate(date)}
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-[var(--border)] bg-transparent text-[11px] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--hover-fill)] hover:text-[var(--text)]"
          >
            <PlusOutlined />
          </button>
        )}
      </div>
      <div
        className={`flex min-h-0 flex-col gap-1 px-1 ${
          expanded ? "flex-1 overflow-y-auto pb-2" : ""
        }`}
      >
        {events.length === 0 ? (
          <div className="py-2.5 text-center text-[11px] text-[var(--text-muted)]">
            这天没有日程，点「+」新建便签
          </div>
        ) : (
          events.map((event) => (
            <EventChip
              key={`${event.entry.id}-${event.ts}`}
              event={event}
              onSelect={onSelect}
              expanded={expanded}
            />
          ))
        )}
      </div>
    </section>
  );
}

/**
 * 日历视图：月网格（FullCalendar dayGrid + 农历/节气/节日小字）/ 周议程 / 日议程三种模式切换（选择持久化）。
 * - 顶部分类筛选（全部 / 备忘 / 提醒 / 待办 / 涂鸦）同样生效，只展示所选分类的日程；
 * - 提醒按闹钟时间、其余条目按最近更新时间归入日期，事件条均按分类色区分；
 * - 今日高亮标记；前后导航按当前视图步进（月 / 周 / 日），selectedDate 为唯一时间锚点，
 *   月视图通过 calendarRef.gotoDate 让 FullCalendar 网格跟随；
 * - 点击日期在下方（或日视图主体）查看当日日程，点「+」弹出类型选择，
 *   在该日新建备忘 / 提醒（落 09:00）/ 待办 / 涂鸦；点击事件条目进入详情编辑。
 */
export function CalendarPane({ onSelect }: { onSelect: (id: string) => void }) {
  const { message } = AntdApp.useApp();
  const entries = useEntryStore((state) => state.entries);
  // 分类筛选（全部 / 备忘 / 提醒 / 待办 / 涂鸦）在日历视图同样生效
  const filter = useEntryStore((state) => state.filter);
  const [viewMode, setViewMode] = useState<CalendarViewMode>(loadViewMode);
  const [selectedDate, setSelectedDate] = useState<Dayjs>(() => dayjs());
  /** 新建弹窗锚定日期：非 null 时弹出类型选择，创建的条目落在该日期 */
  const [createFor, setCreateFor] = useState<Dayjs | null>(null);

  const todayKey = dayjs().format("YYYY-MM-DD");
  const selectedKey = selectedDate.format("YYYY-MM-DD");

  const visibleEntries = useMemo(
    () =>
      filter === "all" ? entries : entries.filter((entry) => entry.kind === filter),
    [entries, filter],
  );

  // 日期 → 事件映射（同一条目同一天只留最早一条），列表按时间升序
  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const entry of visibleEntries) {
      const seen = new Set<string>();
      for (const ts of entryTimes(entry)) {
        const key = dayjs(ts).format("YYYY-MM-DD");
        if (seen.has(key)) continue;
        seen.add(key);
        const list = map.get(key) ?? [];
        list.push({ entry, ts });
        map.set(key, list);
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.ts - b.ts);
    return map;
  }, [visibleEntries]);

  // 月视图 FullCalendar 的事件源（同条目同一天去重，时间用于排序 / 「更多」弹层）
  const fcEvents = useMemo<EventInput[]>(() => {
    const out: EventInput[] = [];
    for (const entry of visibleEntries) {
      const seen = new Set<string>();
      for (const ts of entryTimes(entry)) {
        const key = dayjs(ts).format("YYYY-MM-DD");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: `${entry.id}-${key}`,
          groupId: entry.id,
          title: entry.title.trim() || ENTRY_KIND_LABEL[entry.kind],
          start: dayjs(ts).toDate(),
          extendedProps: {
            entryId: entry.id,
            kind: entry.kind,
            done: isEntryDone(entry),
            ts,
          } satisfies FcEventProps,
        });
      }
    }
    return out;
  }, [visibleEntries]);

  // 周视图的 7 天（周一 → 周日）
  const weekDays = useMemo(() => {
    const start = selectedDate.startOf("week");
    return Array.from({ length: 7 }, (_, i) => start.add(i, "day"));
  }, [selectedDate]);

  const dayEvents = useMemo(
    () => byDate.get(selectedKey) ?? [],
    [byDate, selectedKey],
  );

  /** 在某天新建所选类型的便签并进入详情编辑：提醒落该日 09:00，其余按分类默认 */
  const handleCreateAt = (date: Dayjs): void => {
    setCreateFor(date);
  };

  const handleCreateWithKind = (kind: EntryKind): void => {
    const date = createFor;
    setCreateFor(null);
    if (!date) return;
    void (async () => {
      try {
        const input: NewEntryInput = { title: "", content: "" };
        if (kind === "reminder") {
          input.remindAt = toMinuteStart(
            date.hour(9).minute(0).second(0).millisecond(0).valueOf(),
          );
        }
        const entry = await useEntryStore.getState().addEntry(input, kind);
        if (entry) onSelect(entry.id);
      } catch (error) {
        message.error(
          error instanceof Error ? error.message : "新建便签失败，请重试",
        );
      }
    })();
  };

  const switchView = (view: CalendarViewMode): void => {
    setViewMode(view);
    persistViewMode(view);
  };

  // 月视图 FullCalendar 实例：selectedDate 变化（导航 / 点击 / 今天）时让网格跟随跳月
  const calendarRef = useRef<FullCalendar | null>(null);
  useEffect(() => {
    if (viewMode !== "month") return;
    calendarRef.current?.getApi().gotoDate(selectedDate.toDate());
  }, [selectedDate, viewMode]);

  // 前后导航按视图步进：月视图 ±1 月、周视图 ±1 周、日视图 ±1 天
  const stepUnit =
    viewMode === "month" ? "month" : viewMode === "week" ? "week" : "day";

  const periodLabel = useMemo(() => {
    if (viewMode === "month") return selectedDate.format("YYYY年M月");
    if (viewMode === "day") return selectedDate.format("YYYY年M月D日 dddd");
    const start = selectedDate.startOf("week");
    const end = start.add(6, "day");
    return start.month() === end.month()
      ? `${start.format("M月D日")} – ${end.format("D日")}`
      : `${start.format("M月D日")} – ${end.format("M月D日")}`;
  }, [viewMode, selectedDate]);

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-1 pb-2">
      {/* 顶部工具条：前后导航 + 周期标题 */}
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          aria-label="上一"
          onClick={() => setSelectedDate((d) => d.subtract(1, stepUnit))}
          className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-[var(--memora-radius-sm)] border-0 bg-transparent text-[12px] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--hover-fill)] hover:text-[var(--text)]"
        >
          <LeftOutlined />
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-[13px] font-bold text-[var(--text)]">
          {periodLabel}
        </span>
        <button
          type="button"
          aria-label="下一"
          onClick={() => setSelectedDate((d) => d.add(1, stepUnit))}
          className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-[var(--memora-radius-sm)] border-0 bg-transparent text-[12px] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--hover-fill)] hover:text-[var(--text)]"
        >
          <RightOutlined />
        </button>
      </div>

      {/* 第二行：回到今天 + 视图切换 */}
      <div className="mt-1.5 flex items-center justify-between px-1">
        <button
          type="button"
          onClick={() => setSelectedDate(dayjs())}
          className={`h-6 cursor-pointer rounded-[var(--memora-radius-sm)] border-0 px-2 text-[12px] font-semibold transition-colors duration-150 ${
            selectedKey === todayKey
              ? "bg-[var(--note)] text-white"
              : "bg-[var(--hover-fill)] text-[var(--text-muted)] hover:text-[var(--text)]"
          }`}
        >
          今天
        </button>
        <div
          className="flex items-center gap-0.5 rounded-[var(--memora-radius)] bg-[var(--hover-fill)] p-0.5"
          role="group"
          aria-label="切换日历视图"
        >
          {VIEW_OPTIONS.map((option) => {
            const active = viewMode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => switchView(option.value)}
                className={`h-6 cursor-pointer rounded-[var(--memora-radius-sm)] border-0 px-2.5 text-[12px] font-semibold transition-colors duration-150 ${
                  active
                    ? "bg-[var(--card-bg)] text-[var(--text)] shadow-[var(--memora-shadow)]"
                    : "bg-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 月视图：FullCalendar dayGrid（农历 / 节气小字 + 事件条） + 当日议程 */}
      {viewMode === "month" ? (
        <>
          <div className="fc-calendar-mini px-0.5 pt-2">
            <FullCalendar
              ref={calendarRef}
              plugins={[dayGridPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              initialDate={selectedDate.toDate()}
              locale={zhCnLocale}
              headerToolbar={false}
              footerToolbar={false}
              height="auto"
              firstDay={1}
              fixedWeekCount
              dayMaxEvents={2}
              moreLinkText="条"
              events={fcEvents}
              dayHeaderContent={(arg) => (
                <span className="fc-head-dow">
                  {WEEKDAY_LABELS[(arg.date.getDay() + 6) % 7]}
                </span>
              )}
              dayCellContent={(arg) => {
                const d = dayjs(arg.date);
                const isToday = d.format("YYYY-MM-DD") === todayKey;
                return (
                  <div className="fc-lunar-cell">
                    <span
                      className={`fc-lunar-num${isToday ? " today" : ""}`}
                    >
                      {d.date()}
                    </span>
                    <span
                      className={`fc-lunar-sub${isToday ? " today" : ""}`}
                      title={lunarText(d)}
                    >
                      {lunarText(d)}
                    </span>
                  </div>
                );
              }}
              dayCellClassNames={(arg) =>
                dayjs(arg.date).format("YYYY-MM-DD") === selectedKey
                  ? ["sel-day"]
                  : []
              }
              dateClick={(arg: DateClickArg) =>
                setSelectedDate(dayjs(arg.date))
              }
              eventClick={(arg: EventClickArg) => {
                arg.jsEvent.preventDefault();
                const props = arg.event.extendedProps as FcEventProps;
                onSelect(props.entryId);
              }}
              eventContent={(arg: EventContentArg) => {
                const props = arg.event.extendedProps as FcEventProps;
                return (
                  <div className={`fc-chip${props.done ? " done" : ""}`}>
                    <i
                      aria-hidden
                      style={{ background: ENTRY_KIND_COLOR[props.kind] }}
                    />
                    <span>{arg.event.title}</span>
                  </div>
                );
              }}
            />
          </div>
          <AgendaDay
            date={selectedDate}
            events={dayEvents}
            todayKey={todayKey}
            onSelect={onSelect}
            onCreate={handleCreateAt}
          />
        </>
      ) : viewMode === "week" ? (
        /* 周视图：7 天议程分组 */
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1 pt-2">
          {weekDays.map((day) => (
            <AgendaDay
              key={day.format("YYYY-MM-DD")}
              date={day}
              events={byDate.get(day.format("YYYY-MM-DD")) ?? []}
              todayKey={todayKey}
              onSelect={onSelect}
              onCreate={handleCreateAt}
            />
          ))}
        </div>
      ) : (
        /* 日视图：单日议程（主体） */
        <AgendaDay
          date={selectedDate}
          events={dayEvents}
          todayKey={todayKey}
          onSelect={onSelect}
          onCreate={handleCreateAt}
          expanded
        />
      )}

      {/* 新建类型选择（备忘 / 提醒 / 待办 / 涂鸦），创建的条目落在锚定日期 */}
      <CreateKindDialog
        open={createFor !== null}
        onClose={() => setCreateFor(null)}
        onCreate={handleCreateWithKind}
      />
    </div>
  );
}
