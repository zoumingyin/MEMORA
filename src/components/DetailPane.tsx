import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Button, Checkbox, Input } from "antd";
import {
  ArrowLeftOutlined,
  BellOutlined,
  CheckOutlined,
  DeleteOutlined,
  FileTextOutlined,
  PlusOutlined,
  TagsOutlined,
} from "@ant-design/icons";
import { useEntryStore } from "../store/useEntryStore";
import type {
  AlarmItem,
  AlarmMethod,
  AlarmMode,
  Entry,
  PaperColor,
  PaperStyle,
  TodoItem,
} from "../types/entry";
import { useNow } from "../hooks/useNow";
import { formatRelative, formatShort } from "../utils/format";
import { ENTRY_KIND_LABEL } from "../utils/entryLabels";
import { alarmLoopIntervalMs } from "../reminder/scheduler";
import { paperTintHex, PAPER_COLORS, PAPER_STYLES } from "../utils/paper";
import { AlarmEditorDialog } from "./AlarmEditorDialog";
import { DoodleBoard } from "./DoodleBoard";
import { MarkdownEditor } from "./MarkdownEditor";

const TITLE_PLACEHOLDER: Record<Entry["kind"], string> = {
  note: "备忘标题",
  reminder: "提醒什么事？",
  todo: "要做什么？",
  draw: "涂鸦标题（可选）",
};

/** 闹钟模式短标签（列表行摘要） */
const ALARM_MODE_LABEL: Record<AlarmMode, string> = {
  once: "单次",
  loop: "循环",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年阳历",
  lunar: "每年农历",
  workday: "工作日",
};

/** 循环间隔摘要：优先 intervalMs（「X 时 Y 分」），旧数据换算后按 时/分/秒 展示 */
function loopIntervalSummary(alarm: AlarmItem): string {
  const ms = alarmLoopIntervalMs(alarm);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (hours > 0 && minutes > 0) return `每${hours}时${minutes}分`;
  if (hours > 0) return `每${hours}时`;
  if (minutes > 0) return `每${minutes}分`;
  return `每${seconds}秒`;
}

/** 闹钟方式短标签（列表行摘要） */
const ALARM_METHOD_LABEL: Record<AlarmMethod, string> = {
  dialog: "弹窗",
  notification: "系统通知",
  sound: "弹窗+声音",
};

/** 列表行时间摘要：YYYY-MM-DD HH:mm */
function formatAlarmTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const SAVE_DEBOUNCE_MS = 400;

/**
 * 编辑网关：注入后 DetailPane 可运行在独立小窗等无主窗口 store 的环境——
 * 存盘/读条目/标签池全部改走网关；不传时行为与原实现完全一致（直连 useEntryStore）。
 */
export interface DetailEditGateway {
  /** 当前条目最新已同步数据（flush 时对比 patch 用，替代主窗口 store 查询） */
  getEntry: (id: string) => Entry | null;
  updateEntry: (id: string, patch: Partial<Entry>) => void;
  toggleReminderDone: (id: string) => void;
  /** 全部已知标签（标签 chips 候选池，替代从主窗口 entries 派生） */
  knownTags: string[];
}

interface DetailPaneProps {
  entry: Entry | null;
  onRemove: (id: string) => void;
  /** 窄屏单栏模式下的返回回调；宽屏两栏时不传 */
  onBack?: () => void;
  /** 编辑网关：独立小窗等环境注入；缺省直连主窗口 store */
  gateway?: DetailEditGateway;
}

/** 右侧详情面板：未选中时显示提示，选中后进入可自动保存的编辑表单 */
export function DetailPane({
  entry,
  onRemove,
  onBack,
  gateway,
}: DetailPaneProps) {
  return (
    <div className="detail-pane" data-tauri-drag-region="false">
      {onBack && (
        <button type="button" className="detail-back" onClick={onBack}>
          <ArrowLeftOutlined />
          <span>返回列表</span>
        </button>
      )}
      {entry ? (
        <DetailForm
          key={entry.id}
          entry={entry}
          onRemove={onRemove}
          gateway={gateway}
        />
      ) : (
        <div className="detail-empty flex-center flex-col gap-1">
          <FileTextOutlined />
          <span>从左侧选择一条笔记</span>
          <span className="sub">点击条目后可在右侧直接修改</span>
        </div>
      )}
    </div>
  );
}

interface DetailFormProps {
  entry: Entry;
  onRemove: (id: string) => void;
  gateway?: DetailEditGateway;
}

function DetailForm({ entry, onRemove, gateway }: DetailFormProps) {
  const storeUpdateEntry = useEntryStore((state) => state.updateEntry);
  const storeToggleReminderDone = useEntryStore(
    (state) => state.toggleReminderDone
  );
  const storeEntries = useEntryStore((state) => state.entries);
  // 网关注入时走网关，否则与原实现一致直连 store（Hook 无条件调用，仅选择取值来源）
  const updateEntry = gateway ? gateway.updateEntry : storeUpdateEntry;
  const toggleReminderDone = gateway
    ? gateway.toggleReminderDone
    : storeToggleReminderDone;
  const entries = gateway ? [] : storeEntries;
  const now = useNow();

  // 本地编辑态：随 entry.id 重挂载重新初始化，不与 store 双向同步，避免打断输入
  const [title, setTitle] = useState(entry.title);
  const [content, setContent] = useState(entry.content);
  const [tags, setTags] = useState<string[]>(entry.tags);
  const [draftTag, setDraftTag] = useState("");
  const [items, setItems] = useState<TodoItem[]>(() =>
    entry.kind === "todo" ? entry.items : []
  );
  const [draftItem, setDraftItem] = useState("");
  const [alarms, setAlarms] = useState<AlarmItem[]>(() =>
    entry.kind === "reminder" ? entry.alarms : []
  );
  // 纸张外观：底色 + 纹理（随条目重挂载初始化，由防抖统一落盘）
  const [color, setColor] = useState<PaperColor>(entry.color ?? "plain");
  const [paper, setPaper] = useState<PaperStyle>(entry.paper ?? "plain");

  // 标签选择：全部已知标签（网关模式用注入的标签池，主窗口模式从 entries 派生），
  // 数据变化（任意条目标签增删）时自动刷新
  const tagPool = gateway ? gateway.knownTags : entries;
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const item of tagPool) {
      for (const tag of item.tags ?? []) set.add(tag);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [tagPool]);
  // 与当前条目 tags 求并集：新建的自定义标签在落盘前也能立即出现在 chips 里
  const chipTags = useMemo(() => {
    const set = new Set<string>(allTags);
    for (const tag of tags) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [allTags, tags]);

  // 点击标签：选中（挂到条目）/ 取消（从条目移除），多选；由防抖统一落盘
  const toggleTag = (tag: string): void => {
    setTags((prev) =>
      prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]
    );
  };

  // 「+ 自定义」行内输入：回车/失焦确认，Esc 取消
  const [customOpen, setCustomOpen] = useState(false);
  const confirmCustomTag = (): void => {
    const tag = draftTag.trim();
    if (tag && !tags.includes(tag)) setTags((prev) => [...prev, tag]);
    setDraftTag("");
    setCustomOpen(false);
  };

  // flushRef 保存最新保存函数：每次渲染后由 effect 刷新，供防抖定时器与卸载兜底共用
  const flushRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    flushRef.current = () => {
      // 网关模式读最近一次同步进来的条目数据，主窗口模式读 store
      const current = gateway
        ? gateway.getEntry(entry.id)
        : useEntryStore.getState().entries.find((e) => e.id === entry.id);
      if (!current) return;
      const patch: Record<string, unknown> = {};
      // 未填标题时用分类名兜底：新建后直接离开也显示「待办 / 备忘 / 提醒 / 涂鸦」
      const nextTitle = title.trim() || ENTRY_KIND_LABEL[entry.kind];
      if (current.title !== nextTitle) patch.title = nextTitle;
      // 待办与提醒的正文分别是子任务清单 / 闹钟清单，不再有备注文本框；备忘与涂鸦保留正文
      if (
        (current.kind === "note" || current.kind === "draw") &&
        current.content !== content
      )
        patch.content = content;
      if (current.tags?.join("\u0000") !== tags.join("\u0000"))
        patch.tags = tags;
      if (current.color !== color) patch.color = color;
      if (current.paper !== paper) patch.paper = paper;
      if (entry.kind === "todo" && current.kind === "todo") {
        const prev = JSON.stringify(current.items ?? []);
        if (prev !== JSON.stringify(items)) {
          patch.items = items;
          const allDone = items.length > 0 && items.every((item) => item.done);
          if (current.done !== allDone) patch.done = allDone;
        }
      }
      if (entry.kind === "reminder" && current.kind === "reminder") {
        const prev = JSON.stringify(current.alarms ?? []);
        if (prev !== JSON.stringify(alarms)) {
          patch.alarms = alarms;
        }
      }
      if (Object.keys(patch).length > 0) {
        void updateEntry(entry.id, patch as Partial<Entry>);
      }
    };
  });

  // 输入停止 SAVE_DEBOUNCE_MS 后自动保存
  useEffect(() => {
    const timer = window.setTimeout(() => flushRef.current(), SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [title, content, tags, items, alarms, color, paper]);

  // 卸载（切换条目 / 关闭）时兜底保存未落盘的改动
  useEffect(() => () => flushRef.current(), []);

  // 待办完成度
  const doneCount = items.filter((item) => item.done).length;
  const allDone = items.length > 0 && doneCount === items.length;

  // 提醒：最近一个未通知闹钟决定到期显示
  const pendingAlarms = alarms.filter((alarm) => !alarm.notified);
  const nextAlarmAt = pendingAlarms.length
    ? Math.min(...pendingAlarms.map((alarm) => alarm.remindAt))
    : alarms.length
      ? Math.min(...alarms.map((alarm) => alarm.remindAt))
      : entry.kind === "reminder"
        ? entry.remindAt
        : 0;
  const overdue =
    entry.kind === "reminder" && pendingAlarms.length > 0 && nextAlarmAt <= now;

  // 子任务清单操作：仅改本地态，由防抖统一落盘
  const addItem = (): void => {
    const text = draftItem.trim();
    if (!text) return;
    setItems((prev) => [
      ...prev,
      { id: crypto.randomUUID(), text, done: false },
    ]);
    setDraftItem("");
  };

  const toggleItem = (id: string): void => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, done: !item.done } : item
      )
    );
  };

  const editItem = (id: string, text: string): void => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, text } : item))
    );
  };

  const removeItem = (id: string): void => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  // 闹钟清单操作：仅改本地态，由防抖统一落盘
  // 正在编辑的闹钟：{ id, isNew }；isNew 表示「添加」创建、取消时需从列表移除
  const [editingAlarm, setEditingAlarm] = useState<{
    id: string;
    isNew: boolean;
  } | null>(null);

  const addAlarm = useCallback((): void => {
    const alarm: AlarmItem = {
      id: crypto.randomUUID(),
      remindAt: Date.now() + 3600_000,
      mode: "once",
      method: "dialog",
      notified: false,
    };
    setAlarms((prev) => [...prev, alarm]);
    setEditingAlarm({ id: alarm.id, isNew: true });
  }, []);

  const saveAlarm = (updated: AlarmItem): void => {
    setAlarms((prev) =>
      prev.map((alarm) => (alarm.id === updated.id ? updated : alarm))
    );
    setEditingAlarm(null);
  };

  const closeAlarmEditor = (): void => {
    if (editingAlarm?.isNew) removeAlarm(editingAlarm.id);
    setEditingAlarm(null);
  };

  const removeAlarm = (id: string): void => {
    setAlarms((prev) => prev.filter((alarm) => alarm.id !== id));
  };

  // 右键菜单：新建闹钟；右键在闹钟行上时追加 编辑 / 删除
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    alarmId: string | null;
  } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [ctxMenu]);

  // 双击空白处（不在闹钟行/删除按钮上）新建闹钟
  const onAlarmListDoubleClick = (event: ReactMouseEvent): void => {
    const target = event.target as HTMLElement;
    if (target.closest(".alarm-item") || target.closest(".alarm-del")) return;
    addAlarm();
  };

  const onAlarmListContextMenu = (event: ReactMouseEvent): void => {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".alarm-item");
    setCtxMenu({
      x: event.clientX,
      y: event.clientY,
      alarmId: row?.dataset.alarmId ?? null,
    });
  };

  const onCtxAction = (action: "add" | "edit" | "delete"): void => {
    const alarmId = ctxMenu?.alarmId ?? null;
    setCtxMenu(null);
    if (action === "add") {
      addAlarm();
    } else if (action === "edit" && alarmId) {
      setEditingAlarm({ id: alarmId, isNew: false });
    } else if (action === "delete" && alarmId) {
      removeAlarm(alarmId);
    }
  };

  const editing = editingAlarm
    ? (alarms.find((alarm) => alarm.id === editingAlarm.id) ?? null)
    : null;

  // 纸张外观激活判定：有底色或任一纹理时，面板挂 data-paper 供 CSS 加纹理、编辑器退为透明
  const paperActive = color !== "plain" || paper !== "plain";
  const tintHex = paperTintHex(color);

  return (
    <div
      className="detail-pane"
      data-paper={paperActive ? paper : undefined}
      style={
        tintHex
          ? {
              backgroundColor: `color-mix(in srgb, ${tintHex} var(--paper-tint-alpha), transparent)`,
            }
          : undefined
      }
    >
      <Input
        variant="borderless"
        className="detail-title"
        value={title}
        placeholder={TITLE_PLACEHOLDER[entry.kind]}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          if (!title.trim()) setTitle(ENTRY_KIND_LABEL[entry.kind]);
        }}
      />
      {/* 标签选择：展示全部已知标签，点击选中/取消（选中即挂到当前条目，多选）；
          「+ 自定义」展开行内输入新建标签。chips 随条目标签数据变化自动刷新 */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 px-1">
        <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)]">
          <TagsOutlined className="text-[11px]" />
          标签:
        </span>
        {chipTags.map((tag) => {
          const active = tags.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              title={active ? "点击取消该标签" : "点击添加该标签"}
              onClick={() => toggleTag(tag)}
              className={`h-[24px] rounded-[8px] px-2.5 text-[11.5px] leading-none transition ${
                active
                  ? "bg-[var(--text)] font-medium text-[var(--field)]"
                  : "border border-solid border-[var(--control-border)] bg-[var(--field)] text-[var(--text-muted)] hover:border-[var(--border)] hover:text-[var(--text)]"
              }`}
            >
              #{tag}
            </button>
          );
        })}
        {customOpen ? (
          <input
            autoFocus
            value={draftTag}
            placeholder="标签名，回车确认"
            onChange={(event) => setDraftTag(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") confirmCustomTag();
              else if (event.key === "Escape") {
                setDraftTag("");
                setCustomOpen(false);
              }
            }}
            onBlur={confirmCustomTag}
            className="h-[24px] w-[92px] rounded-[8px] border border-solid border-[var(--control-border)] bg-[var(--field)] px-2 text-[11.5px] text-[var(--text)] outline-none"
          />
        ) : (
          <button
            type="button"
            title="新建自定义标签"
            onClick={() => setCustomOpen(true)}
            className="h-[24px] rounded-[8px] border border-dashed border-[var(--control-border)] bg-[var(--field)] px-2.5 text-[11.5px] leading-none text-[var(--text-muted)] transition hover:border-[var(--border)] hover:text-[var(--text)]"
          >
            <PlusOutlined className="text-[10px]" /> 自定义
          </button>
        )}
      </div>
      {entry.kind === "todo" && (
        <div className="todo-items flex-1">
          <div className="todo-items-head ">
            <span>子任务</span>
            <span className="todo-progress">
              {items.length === 0
                ? "还没有子任务"
                : allDone
                  ? "全部完成"
                  : `${doneCount}/${items.length} 项`}
            </span>
          </div>
          <ul className="todo-item-list">
            {items.map((item) => (
              <li
                key={item.id}
                className={`todo-item ${item.done ? "done" : ""}`}
              >
                <Checkbox
                  className="todo-check"
                  checked={item.done}
                  title={item.done ? "标记未完成" : "标记完成"}
                  onChange={() => toggleItem(item.id)}
                />
                <Input
                  variant="borderless"
                  className="todo-item-text"
                  value={item.text}
                  placeholder="子任务内容"
                  onChange={(event) => editItem(item.id, event.target.value)}
                />
                <Button
                  type="text"
                  size="small"
                  className="icon-btn todo-item-del"
                  title="删除子任务"
                  icon={<DeleteOutlined />}
                  onClick={() => removeItem(item.id)}
                />
              </li>
            ))}
          </ul>
          <div className="todo-add">
            <Input
              size="small"
              value={draftItem}
              placeholder="添加子任务，回车确认"
              onChange={(event) => setDraftItem(event.target.value)}
              onPressEnter={() => addItem()}
            />
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              className="todo-add-btn"
              onClick={addItem}
            >
              添加
            </Button>
          </div>
        </div>
      )}
      {entry.kind === "reminder" && (
        <div
          className="alarm-list flex-1"
          data-tauri-drag-region="false"
          onDoubleClick={onAlarmListDoubleClick}
          onContextMenu={onAlarmListContextMenu}
        >
          <div className="alarm-list-head">
            <span>闹钟</span>
            <span className="alarm-hint">
              双击行编辑 · 双击空白或右键新建
            </span>
          </div>
          {alarms.map((alarm) => (
            <div
              key={alarm.id}
              className={`alarm-item ${alarm.notified ? "notified" : ""}`}
              data-alarm-id={alarm.id}
              data-tauri-drag-region="false"
              title="双击编辑闹钟"
              onDoubleClick={() =>
                setEditingAlarm({ id: alarm.id, isNew: false })
              }
            >
              <span className="alarm-brief">
                <span className="alarm-brief-mode">
                  {ALARM_MODE_LABEL[alarm.mode]}
                  {alarm.mode === "loop"
                    ? `·${loopIntervalSummary(alarm)}`
                    : ""}
                </span>
                <span className="alarm-brief-time">
                  {formatAlarmTime(alarm.remindAt)}
                </span>
                <span className="alarm-brief-method">
                  {ALARM_METHOD_LABEL[alarm.method]}
                </span>
                {alarm.notified && (
                  <span className="alarm-brief-done">已提醒</span>
                )}
              </span>
              <Button
                type="text"
                size="small"
                className="icon-btn alarm-del"
                title="删除闹钟"
                icon={<DeleteOutlined />}
                onClick={() => removeAlarm(alarm.id)}
              />
            </div>
          ))}
          {alarms.length === 0 && (
            <p className="alarm-empty">还没有闹钟，双击空白处或右键新建</p>
          )}
          {ctxMenu && (
            <div
              className="alarm-ctx"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="alarm-ctx-item"
                onClick={() => onCtxAction("add")}
              >
                <PlusOutlined /> 新建闹钟
              </button>
              {ctxMenu.alarmId && (
                <>
                  <button
                    type="button"
                    className="alarm-ctx-item"
                    onClick={() => onCtxAction("edit")}
                  >
                    <BellOutlined /> 编辑闹钟
                  </button>
                  <button
                    type="button"
                    className="alarm-ctx-item danger"
                    onClick={() => onCtxAction("delete")}
                  >
                    <DeleteOutlined /> 删除闹钟
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {editing && (
        <AlarmEditorDialog
          alarm={editing}
          onSave={saveAlarm}
          onClose={closeAlarmEditor}
        />
      )}
      {entry.kind === "note" && (
        <MarkdownEditor
          value={content}
          placeholder="支持 Markdown：**加粗**、# 标题、- 列表、> 引用、```代码```"
          onChange={setContent}
        />
      )}
      {entry.kind === "draw" && (
        <DoodleBoard value={content} onChange={setContent} />
      )}

      {/* 颜色 / 纸张：便签纸张外观设置（底色圆点选中加圈；纹理选中加框） */}
      <div className="flex flex-col gap-1.5 px-1 pb-1.5">
        <div className="flex items-center gap-2">
          <span className="w-[36px] shrink-0 text-[11px] text-[var(--text-muted)]">
            颜色:
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {PAPER_COLORS.map((item) => (
              <button
                key={item.key}
                type="button"
                title={item.label}
                onClick={() => setColor(item.key)}
                className={`h-[20px] w-[20px] rounded-full border border-solid transition ${
                  color === item.key
                    ? "border-[2px] border-[var(--text)]"
                    : "border-[var(--control-border)] hover:border-[var(--border)]"
                }`}
                style={{ backgroundColor: item.hex || "var(--field)" }}
              />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-[36px] shrink-0 text-[11px] text-[var(--text-muted)]">
            纸张:
          </span>
          <div className="flex items-center gap-1">
            {PAPER_STYLES.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setPaper(item.key)}
                className={`h-[22px] rounded-[6px] px-2 text-[11.5px] leading-none transition ${
                  paper === item.key
                    ? "border border-solid border-[var(--text)] bg-[var(--field)] font-medium text-[var(--text)]"
                    : "border border-transparent bg-[var(--field)] text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="detail-actions">
        <span className="detail-meta bg-[var(--field)]! rounded-[8px] px-2 py-1">
          {(entry.kind === "note" || entry.kind === "draw") &&
            `更新于 ${formatShort(entry.updatedAt)}`}
          {entry.kind === "todo" &&
            (allDone
              ? `完成于 ${entry.completedAt ? formatShort(entry.completedAt) : formatShort(entry.updatedAt)}`
              : `${doneCount}/${items.length} 项进行中`)}
          {entry.kind === "reminder" && (
            <div className="grid">
              <div className={`reminder-time ${overdue ? "overdue" : ""}`}>
                <BellOutlined />
                {alarms.length === 0
                  ? "暂无闹钟"
                  : pendingAlarms.length === 0
                    ? "全部已提醒"
                    : overdue
                      ? "已到期"
                      : formatRelative(nextAlarmAt)}
              </div>
              <div>
                {pendingAlarms.length === 0
                  ? `${alarms.length} 个闹钟`
                  : `共 ${alarms.length} 个闹钟，${pendingAlarms.length} 个待提醒`}
              </div>
            </div>
          )}
        </span>

        <div className="detail-action-btns">
          {entry.kind === "reminder" && (
            <Button
              type={pendingAlarms.length === 0 ? "primary" : "default"}
              size="small"
              icon={<CheckOutlined />}
              className="detail-toggle"
              onClick={() => void toggleReminderDone(entry.id)}
            >
              {pendingAlarms.length === 0 ? "已处理" : "标记已处理"}
            </Button>
          )}
          <Button
            type="text"
            danger
            size="small"
            className="icon-btn danger"
            title="移入废纸篓"
            icon={<DeleteOutlined />}
            onClick={() => onRemove(entry.id)}
          />
        </div>
      </div>
    </div>
  );
}
