import { App as AntdApp, Collapse, Empty } from "antd";
import {
  BellOutlined,
  CheckSquareOutlined,
  ClockCircleOutlined,
  EditOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useEntryStore } from "../store/useEntryStore";
import { useUiStore } from "../store/useUiStore";
import type { AlarmMode, Entry, EntryKind } from "../types/entry";
import { useNow } from "../hooks/useNow";
import { formatRelative, formatShort } from "../utils/format";
import { paperTintHex } from "../utils/paper";
import { markdownToHtml } from "../utils/markdown";
import { exportEntryImage } from "../utils/exportEntryImage";
import { EntryTags, EntryTools, TodoPreview } from "./EntryCardParts";

const KIND_ICON: Record<EntryKind, ReactNode> = {
  note: <FileTextOutlined />,
  reminder: <BellOutlined />,
  todo: <CheckSquareOutlined />,
  draw: <EditOutlined />,
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
/** 贴纸墙待办卡片内最多预览的子任务数（卡片高度固定，超出裁切） */
const WALL_TODO_LIMIT = 4;

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
  if (filter === "note" || filter === "draw") {
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
      // 涂鸦正文是 base64 图片，不参与关键词匹配，避免随机字符命中数据串
      const body = entry.kind === "draw" ? "" : entry.content;
      const haystack = `${entry.title}\n${body}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function rowMeta(
  entry: Entry,
  now: number
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

/** 复制用的完整时间：闹钟需要带年份，避免只看到月日 */
function formatCopyTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char,
  );
}

/** 纯文本兜底：保留 Markdown 结构，只把内嵌图片的 base64 换成占位，避免剪贴板塞入几 MB 数据 */
function clipboardTextFromMarkdown(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\(\s*data:[^)]*\)/gi, (_, alt: string) =>
      alt ? `[图片：${alt}]` : "[图片]",
    )
    .replace(/<img\b[^>]*>/gi, "[图片]")
    .trim();
}

interface ClipboardPayload {
  html: string;
  text: string;
}

/** 按分类拼出完整内容：备忘保留格式与图片，待办带勾选状态，提醒带全部闹钟，涂鸦带原图 */
function buildClipboardPayload(entry: Entry): ClipboardPayload {
  const title = entry.title.trim();
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  if (title) {
    htmlParts.push(`<h3>${escapeHtml(title)}</h3>`);
    textParts.push(title);
  }

  const appendContent = (content: string): void => {
    if (!content.trim()) return;
    htmlParts.push(markdownToHtml(content));
    textParts.push(clipboardTextFromMarkdown(content));
  };

  if (entry.kind === "note") {
    appendContent(entry.content);
  } else if (entry.kind === "todo") {
    if (entry.items.length > 0) {
      htmlParts.push(
        `<ul style="list-style:none;padding-left:0">${entry.items
          .map(
            (item) =>
              `<li>${item.done ? "☑" : "☐"} ${escapeHtml(item.text)}</li>`,
          )
          .join("")}</ul>`,
      );
      textParts.push(
        entry.items
          .map((item) => `- [${item.done ? "x" : " "}] ${item.text}`)
          .join("\n"),
      );
    }
    appendContent(entry.content);
  } else if (entry.kind === "reminder") {
    if (entry.alarms.length > 0) {
      const lines = entry.alarms.map(
        (alarm) =>
          `${formatCopyTime(alarm.remindAt)} · ${ALARM_MODE_LABEL[alarm.mode]}${
            alarm.notified ? " · 已提醒" : ""
          }`,
      );
      htmlParts.push(`<ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>`);
      textParts.push(lines.map((line) => `- ${line}`).join("\n"));
    }
    appendContent(entry.content);
  } else if (entry.content) {
    htmlParts.push(
      `<img src="${escapeHtml(entry.content)}" alt="${escapeHtml(title || "手写涂鸦")}">`,
    );
    textParts.push("[手写涂鸦图片]");
  }

  if (entry.tags.length > 0) {
    htmlParts.push(
      `<p>${entry.tags.map((tag) => `#${escapeHtml(tag)}`).join(" ")}</p>`,
    );
    textParts.push(entry.tags.map((tag) => `#${tag}`).join(" "));
  }

  return { html: htmlParts.join("\n"), text: textParts.join("\n\n") };
}

/** 优先写 HTML（保留加粗、列表、颜色与图片），环境不支持时退化为纯文本 */
async function writeClipboard(payload: ClipboardPayload): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error("当前环境不支持剪贴板");
  if (clipboard.write && typeof ClipboardItem !== "undefined") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([payload.html], { type: "text/html" }),
          "text/plain": new Blob([payload.text], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      // 部分 WebView 只允许写纯文本，回退到 writeText
    }
  }
  await clipboard.writeText(payload.text);
}

/** 列表模式的一行摘要：待办取未完成子任务，提醒取最近闹钟，其余取正文纯文本 */
function listSummary(entry: Entry): string {
  if (entry.kind === "draw") {
    return entry.content ? "手写涂鸦" : "（空白涂鸦）";
  }
  if (entry.kind === "todo") {
    const pending = entry.items.find((item) => !item.done) ?? entry.items[0];
    return pending ? pending.text : toPlainText(entry.content || "");
  }
  if (entry.kind === "reminder") {
    const pending =
      entry.alarms.find((alarm) => !alarm.notified) ?? entry.alarms[0];
    if (pending) {
      return `${formatShort(pending.remindAt)} · ${ALARM_MODE_LABEL[pending.mode]}`;
    }
  }
  return toPlainText(entry.content || "");
}

/** 月份/日期（贴纸墙页脚，参考图样式：10/29） */
function formatMonthDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 贴纸墙卡片尺寸与间距（与 index.css 的 --wall-card-w/h 保持一致） */
const WALL_CARD_W = 264;
const WALL_CARD_H = 228;
const WALL_GAP = 20;
/** 画布底部预留空间：留出继续向下摆放的余地 */
const WALL_BOTTOM_ROOM = 200;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 贴纸装饰：置顶卡片固定显示红色图钉，其余按 id 哈希分配左 / 右胶带，重排后不跳变 */
function wallDecoration(id: string, pinned: boolean): string {
  if (pinned) return "wall-deco-pin";
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return ["wall-deco-tape-left", "wall-deco-tape-right"][
    Math.abs(hash) % 2
  ];
}

/** 自由拖拽时临时覆盖的坐标 */
interface DragState {
  id: string;
  x: number;
  y: number;
}

/** 三种展示模式：贴纸墙（宽屏固定）/ 网格 / 列表（窄屏可切换） */
export type EntryListView = "wall" | "grid" | "list";

interface EntryListProps {
  onSelect: (id: string) => void;
  /** 当前展示模式，由外层按视口宽度决定 */
  mode: EntryListView;
}

/** 左侧主从列表：按贴纸墙 / 网格 / 列表展示，点击选中后在右侧详情编辑；已完成条目自动归入下方「已完成」分组 */
export function EntryList({ onSelect, mode }: EntryListProps) {
  const { message } = AntdApp.useApp();
  const filter = useEntryStore((state) => state.filter);
  const entries = useEntryStore((state) => state.entries);
  const search = useEntryStore((state) => state.search);
  const tagFilter = useEntryStore((state) => state.tagFilter);
  const timeRange = useEntryStore((state) => state.timeRange);
  const sortBy = useEntryStore((state) => state.sortBy);
  const selectedId = useEntryStore((state) => state.selectedId);
  const moveToTrash = useEntryStore((state) => state.moveToTrash);
  const wallPositions = useUiStore((state) => state.wallPositions);
  const setWallPosition = useUiStore((state) => state.setWallPosition);
  const clearWallPosition = useUiStore((state) => state.clearWallPosition);
  const pinnedIds = useUiStore((state) => state.pinnedIds);
  const togglePinned = useUiStore((state) => state.togglePinned);
  const now = useNow();

  const filtered = filterEntries(entries, search, tagFilter, timeRange);
  const list = sortEntries(filter, filtered, sortBy);

  // 搜索框键盘导航：↑/↓ 在可见条目间移动高亮，Enter 打开当前项（窄屏只高亮、Enter 才进详情）。
  // 用 ref 保存最新列表，监听器只注册一次，避免列表每次渲染都重新绑定。
  const listRef = useRef(list);
  const selectedIdRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    onSelectRef.current = onSelect;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Enter"
      ) {
        return;
      }
      const targetEl = event.target as HTMLElement | null;
      if (
        !targetEl ||
        targetEl.tagName !== "INPUT" ||
        !targetEl.closest(".titlebar-search")
      ) {
        return;
      }
      const rows = listRef.current;
      if (rows.length === 0) return;
      event.preventDefault();
      if (event.key === "Enter") {
        const current = rows.find((entry) => entry.id === selectedIdRef.current);
        const next = current ?? rows[0];
        if (next) onSelectRef.current(next.id);
        return;
      }
      const currentIndex = rows.findIndex(
        (entry) => entry.id === selectedIdRef.current,
      );
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        currentIndex < 0
          ? delta > 0
            ? 0
            : rows.length - 1
          : (currentIndex + delta + rows.length) % rows.length;
      const next = rows[nextIndex];
      if (!next) return;
      useEntryStore.getState().setSelectedId(next.id);
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-entry-id="${next.id}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 分组视图：待办/提醒拆「进行中/其他」与「已完成」两组，
  // 待办勾选完成、提醒标记已处理后自动归入下方「已完成」区
  const activeRows = list.filter((entry) => !entryDone(entry));
  const doneRows = list.filter((entry) => entryDone(entry));
  // 置顶标记：贴纸墙红图钉即置顶；卡片模式把置顶项排在最前（稳定排序，其余保持原顺序）
  const pinnedSet = new Set(pinnedIds);
  const cardRows =
    mode === "list"
      ? activeRows
      : [...activeRows].sort(
          (a, b) =>
            Number(pinnedSet.has(b.id)) - Number(pinnedSet.has(a.id))
        );
  // 搜索框 ↑/↓ 只遍历实际展示的条目（已完成分组默认折叠，跳进去会看不到高亮）
  useEffect(() => {
    listRef.current = cardRows;
  }, [cardRows]);

  // 已完成区默认折叠：点「已完成项 (n)」标题展开查看已完成的卡片
  const [doneExpanded, setDoneExpanded] = useState(false);

  // 自由摆放：测量画布宽度以计算默认网格列数与拖拽边界
  const boardRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  const [dragPos, setDragPos] = useState<DragState | null>(null);
  // 拖拽结束时浏览器仍会补发 click，用标记吞掉这一次，避免误打开详情
  const suppressClickRef = useRef(false);
  const hasBoard = mode === "wall" && cardRows.length > 0;

  useEffect(() => {
    if (!hasBoard) return;
    const el = boardRef.current;
    if (!el) return;
    const measure = (): void => setBoardWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasBoard]);

  // 卡片坐标：有保存的自由坐标优先，否则按默认网格铺开；窗口变窄时把超出画布的卡片收回
  const wallWidth = boardWidth || 900;
  const wallCols = Math.max(
    1,
    Math.floor((wallWidth + WALL_GAP) / (WALL_CARD_W + WALL_GAP))
  );
  const wallLayout = new Map<string, { x: number; y: number }>();
  cardRows.forEach((entry, index) => {
    const fallbackX = (index % wallCols) * (WALL_CARD_W + WALL_GAP);
    const fallbackY = Math.floor(index / wallCols) * (WALL_CARD_H + WALL_GAP);
    const saved = wallPositions[entry.id];
    wallLayout.set(
      entry.id,
      saved
        ? {
            x: clamp(saved.x, 0, Math.max(0, wallWidth - WALL_CARD_W)),
            y: Math.max(saved.y, 0),
          }
        : { x: fallbackX, y: fallbackY }
    );
  });

  let wallBottom = 0;
  wallLayout.forEach((pos) => {
    wallBottom = Math.max(wallBottom, pos.y + WALL_CARD_H);
  });
  const wallBoardHeight = Math.max(wallBottom + WALL_BOTTOM_ROOM, 320);

  /** 按住卡片自由拖拽：超过 3px 才视为拖动，松手后保存坐标 */
  const startWallDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    entry: Entry
  ): void => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".wall-note-tool")) return;
    const board = boardRef.current;
    if (!board) return;
    suppressClickRef.current = false;
    const boardRect = board.getBoundingClientRect();
    const cardRect = event.currentTarget.getBoundingClientRect();
    const origin = wallLayout.get(entry.id) ?? {
      x: cardRect.left - boardRect.left,
      y: cardRect.top - boardRect.top,
    };
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    let next = origin;
    const onMove = (moveEvent: PointerEvent): void => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 3) moved = true;
      if (!moved) return;
      next = {
        x: clamp(origin.x + dx, 0, Math.max(0, board.clientWidth - WALL_CARD_W)),
        y: clamp(origin.y + dy, 0, Math.max(0, board.clientHeight - WALL_CARD_H)),
      };
      setDragPos({ id: entry.id, ...next });
    };
    const finish = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setDragPos(null);
      if (moved) {
        suppressClickRef.current = true;
        setWallPosition(entry.id, next);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const openEntry = (entry: Entry): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSelect(entry.id);
  };

  const copyEntry = (entry: Entry): void => {
    void writeClipboard(buildClipboardPayload(entry))
      .then(() => message.success("已复制"))
      .catch(() => message.error("复制失败"));
  };

  /** 置顶 / 取消置顶：新置顶的卡片清掉自由坐标，回到墙面前排默认铺位 */
  const toggleWallPin = (entry: Entry): void => {
    if (!pinnedSet.has(entry.id)) clearWallPosition(entry.id);
    togglePinned(entry.id);
  };

  const removeEntry = (entry: Entry): void => {
    void moveToTrash(entry.id).then(() => message.success("已移入废纸篓"));
  };

  const exportEntry = (entry: Entry): void => {
    void exportEntryImage(entry)
      .then((result) => {
        if (result === "saved") message.success("已导出图片");
      })
      .catch((error) => {
        console.error("导出图片失败", error);
        message.error("导出图片失败");
      });
  };

  /** 卡片工具条渲染入口：贴纸墙与网格卡片共用同一组件 */
  const renderEntryTools = (entry: Entry) => (
    <EntryTools
      entry={entry}
      pinned={pinnedSet.has(entry.id)}
      onEdit={(target) => onSelect(target.id)}
      onTogglePin={toggleWallPin}
      onCopy={copyEntry}
      onExport={exportEntry}
      onRemove={removeEntry}
    />
  );

  /** 网格模式：固定高度卡片（窄屏两列） */
  const renderCard = (entry: Entry) => {
    const icon = KIND_ICON[entry.kind];
    const meta = rowMeta(entry, now);
    const doneClass = entryDone(entry) ? "done" : "";
    // 备忘类：正文按 Markdown 富文本渲染（含图片内联），不再单独抽缩略图以免与正文图片重复
    const isNote = entry.kind === "note";
    const isDraw = entry.kind === "draw";
    // 涂鸦正文本身就是 PNG data URL，直接作为缩略图
    const thumb = isNote
      ? null
      : isDraw
        ? entry.content || null
        : firstImageSrc(entry.content || "");
    const excerpt = isDraw ? "" : toPlainText(entry.content || "");
    const noteHtml = isNote ? markdownToHtml(entry.content || "") : "";
    // 纸张外观：底色淡染（--card-tint）+ 纹理（data-paper），纹理规则见 index.css 的 note-row[data-paper]
    const tintHex = paperTintHex(entry.color);
    const paperActive = (entry.paper ?? "plain") !== "plain";
    const previewLimit = PREVIEW_LIMIT;
    return (
      <div
        key={entry.id}
        data-entry-id={entry.id}
        className={`note-row kind-${entry.kind} note-card ${meta.overdue ? "overdue" : ""} ${doneClass}`}
        data-paper={paperActive ? entry.paper : undefined}
        style={
          tintHex ? ({ "--card-tint": tintHex } as CSSProperties) : undefined
        }
        onClick={() => onSelect(entry.id)}
      >
        <div className="flex w-full items-center justify-between gap-1">
          <span className="row-icon" aria-hidden="true">
            {icon}
          </span>
          {renderEntryTools(entry)}
        </div>
        <span className="row-title">{entry.title || "无标题"}</span>
        {thumb && (
          <span className="row-thumb flex-1 min-h-0">
            <img
              src={thumb}
              alt=""
              loading="lazy"
              draggable={false}
              className={`h-full! w-full ${isDraw ? "object-contain" : "object-cover"}`}
            />
          </span>
        )}
        {/* 备忘卡片：正文按 Markdown 富文本渲染（标题/加粗/列表/换行/图片等）；
            待办预览子任务；闹钟预览闹钟；其余沿用正文纯文本摘要 */}
        {isNote ? (
          noteHtml && (
            <span
              className="note-md w-full min-h-0 flex-1 overflow-y-auto"
              dangerouslySetInnerHTML={{ __html: noteHtml }}
            />
          )
        ) : entry.kind === "draw" ? (
          !thumb && <span className="row-desc line-clamp-5">（空白涂鸦）</span>
        ) : entry.kind === "todo" && entry.items.length > 0 ? (
          <TodoPreview items={entry.items} limit={previewLimit} />
        ) : entry.kind === "reminder" && entry.alarms.length > 0 ? (
          <span className="flex w-full min-h-0 flex-col gap-1 overflow-hidden">
            {entry.alarms.slice(0, previewLimit).map((alarm) => (
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
            {entry.alarms.length > previewLimit && (
              <span className="text-[10.5px] text-[var(--text-muted)] opacity-70">
                +{entry.alarms.length - previewLimit} 个
              </span>
            )}
          </span>
        ) : (
          excerpt && (
            <span
              className={`row-desc ${thumb ? "line-clamp-2" : "line-clamp-5"}`}
            >
              {excerpt}
            </span>
          )
        )}
        <span className="mt-auto w-full flex flex-col gap-1.5">
          {entry.tags.length > 0 && <EntryTags tags={entry.tags} />}
          <span className="card-divider" />
          <span className={`row-meta ${meta.overdue ? "overdue" : ""}`}>
            {meta.text}
          </span>
        </span>
      </div>
    );
  };

  /** 贴纸墙模式（宽屏）：统一尺寸纸张卡片 + 胶带/图钉 + 自由拖拽；点击打开右侧详情抽屉 */
  const renderWallCard = (entry: Entry, positioned: boolean) => {
    const isDone = entryDone(entry);
    const meta = rowMeta(entry, now);
    const isNote = entry.kind === "note";
    const noteHtml = isNote ? markdownToHtml(entry.content || "") : "";
    const tintHex = paperTintHex(entry.color);
    const paperActive = (entry.paper ?? "plain") !== "plain";
    const todoTotal = entry.kind === "todo" ? entry.items.length : 0;
    const todoDoneCount =
      entry.kind === "todo"
        ? entry.items.filter((item) => item.done).length
        : 0;
    const todoPct = todoTotal
      ? Math.round((todoDoneCount / todoTotal) * 100)
      : 0;
    const reminder = entry.kind === "reminder" ? reminderStatus(entry) : null;
    const nextAlarm =
      entry.kind === "reminder"
        ? entry.alarms.find((alarm) => !alarm.notified) ?? entry.alarms[0]
        : undefined;

    const isDragging = dragPos?.id === entry.id;
    const pos = positioned ? (isDragging ? dragPos : wallLayout.get(entry.id)) : undefined;
    const isPinned = pinnedSet.has(entry.id);

    return (
      <div
        key={entry.id}
        data-entry-id={entry.id}
        className={`note-row wall-note ${positioned ? "" : "wall-note-flow"} ${wallDecoration(entry.id, isPinned)} kind-${entry.kind} ${isDone ? "is-done" : ""} ${meta.overdue ? "overdue" : ""} ${selectedId === entry.id ? "is-selected" : ""} ${isDragging ? "is-dragging" : ""}`}
        data-paper={paperActive ? entry.paper : undefined}
        style={
          {
            ...(tintHex ? { "--card-tint": tintHex } : null),
            ...(pos ? { left: pos.x, top: pos.y } : null),
          } as CSSProperties
        }
        onPointerDown={
          positioned && !isDone
            ? (event) => startWallDrag(event, entry)
            : undefined
        }
        onClick={() => openEntry(entry)}
      >
        <div className="wall-note-head">
          <span className="wall-note-kind" aria-hidden="true">
            {KIND_ICON[entry.kind]}
          </span>
          <span className="wall-note-title">{entry.title || "便签"}</span>
          {renderEntryTools(entry)}
        </div>

        <div className="wall-note-body">
          {isNote ? (
            noteHtml ? (
              <div
                className="note-md wall-note-md"
                dangerouslySetInnerHTML={{ __html: noteHtml }}
              />
            ) : (
              <span className="wall-note-empty">（空白便签）</span>
            )
          ) : entry.kind === "draw" ? (
            entry.content ? (
              <img
                src={entry.content}
                alt=""
                draggable={false}
                className="wall-draw-img"
              />
            ) : (
              <span className="wall-note-empty">（空白涂鸦）</span>
            )
          ) : entry.kind === "todo" ? (
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
          ) : (
            <div className="flex flex-col gap-1.5">
              <span
                className={`wall-reminder-main ${meta.overdue ? "overdue" : ""}`}
              >
                <BellOutlined />
                {reminder?.allNotified
                  ? "全部已提醒"
                  : meta.overdue
                    ? "已到期"
                    : formatRelative(reminder?.at ?? now)}
              </span>
              <span className="wall-reminder-sub">
                {nextAlarm
                  ? `${formatShort(nextAlarm.remindAt)} · ${ALARM_MODE_LABEL[nextAlarm.mode]}`
                  : "暂无闹钟"}
                {entry.alarms.length > 0 && `　共 ${entry.alarms.length} 个`}
              </span>
            </div>
          )}
        </div>

        <div className="wall-note-foot">
          <span className="wall-note-tags">
            <EntryTags tags={entry.tags} />
          </span>
          <span className="wall-note-date">{formatMonthDay(entry.updatedAt)}</span>
        </div>
      </div>
    );
  };

  /** 列表模式：单行紧凑条目（标题 + 摘要 + 时间） */
  const renderListRow = (entry: Entry) => {
    const icon = KIND_ICON[entry.kind];
    const meta = rowMeta(entry, now);
    const doneClass = entryDone(entry) ? "done" : "";
    const summary = listSummary(entry);
    const tintHex = paperTintHex(entry.color);
    return (
      <button
        key={entry.id}
        type="button"
        className={`note-row note-list-row kind-${entry.kind} flex w-full items-center gap-2.5 rounded-xl border border-solid border-[var(--border)] bg-[var(--card-bg)] p-[9px_12px] text-left text-[var(--text)] transition hover:border-[var(--card-border-hover)] hover:shadow-[var(--card-hover-shadow)] ${meta.overdue ? "overdue" : ""} ${doneClass}`}
        style={
          tintHex ? ({ "--card-tint": tintHex } as CSSProperties) : undefined
        }
        onClick={() => onSelect(entry.id)}
      >
        <span
          className={`row-icon row-list-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-[13px] ${doneClass ? "opacity-60" : ""}`}
          aria-hidden="true"
          style={{
            color: "var(--kind-accent)",
            background:
              "color-mix(in srgb, var(--kind-accent) 12%, transparent)",
          }}
        >
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="row-title truncate text-[12.5px] font-medium">
            {entry.title || "无标题"}
          </span>
          {summary && (
            <span className="truncate text-[11.5px] text-[var(--text-muted)]">
              {summary}
            </span>
          )}
        </span>
        <span className={`row-meta shrink-0 max-w-[45%] text-right ${meta.overdue ? "overdue" : ""}`}>
          {meta.text}
        </span>
      </button>
    );
  };

  const renderDoneChildren = () => {
    if (mode === "list") {
      return (
        <div className="flex flex-col gap-2 pt-1">
          {doneRows.map(renderListRow)}
        </div>
      );
    }
    if (mode === "wall") {
      return (
        <div className="wall-done-grid pt-1">
          {doneRows.map((entry) => renderWallCard(entry, false))}
        </div>
      );
    }
    return (
      <div className="grid grid-cols-2 gap-3 pt-1">
        {doneRows.map(renderCard)}
      </div>
    );
  };

  const renderDoneCollapse = () => (
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
          children: renderDoneChildren(),
        },
      ]}
      className={
        mode === "wall"
          ? "done-collapse wall-done-collapse"
          : "done-collapse col-span-full break-inside-avoid"
      }
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
  );

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

  if (mode === "wall") {
    return (
      <div
        key={mode}
        className="entry-list entry-view-enter wall-canvas"
        data-tauri-drag-region="false"
      >
        {cardRows.length > 0 && (
          <div
            ref={boardRef}
            className="wall-board"
            style={{ height: wallBoardHeight }}
          >
            {cardRows.map((entry) => renderWallCard(entry, true))}
          </div>
        )}
        {doneRows.length > 0 && renderDoneCollapse()}
      </div>
    );
  }

  const containerClass =
    mode === "list"
      ? "entry-view flex flex-col gap-2 p-[6px_10px_12px] flex-1 min-h-0 overflow-y-auto"
      : "entry-view grid grid-cols-2 gap-3 p-[6px_10px_12px] flex-1 min-h-0 overflow-y-auto content-start";

  return (
    <div
      key={mode}
      className={`entry-list entry-view-enter ${containerClass}`}
      data-tauri-drag-region="false"
    >
      {mode === "list"
        ? activeRows.map(renderListRow)
        : cardRows.map(renderCard)}
      {doneRows.length > 0 && renderDoneCollapse()}
    </div>
  );
}
