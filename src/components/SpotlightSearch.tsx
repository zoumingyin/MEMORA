import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { emitTo, listen } from "@tauri-apps/api/event";
import { SearchOutlined } from "@ant-design/icons";
import {
  SPOTLIGHT_JUMP_EVENT,
  SPOTLIGHT_OPEN_EVENT,
  SPOTLIGHT_PING_EVENT,
  SPOTLIGHT_READY_EVENT,
  SPOTLIGHT_TOP_OFFSET,
  SPOTLIGHT_WIN_W,
  type SpotlightEntry,
  type SpotlightSnapshot,
} from "../window/spotlightWindow";
import { ENTRY_KIND_COLOR, ENTRY_KIND_LABEL } from "../utils/entryLabels";
import { formatShort } from "../utils/format";

/** 空查询时兜底展示的最近条数 */
const RECENT_LIMIT = 8;
/** 有关键词时最多展示的结果数 */
const RESULT_LIMIT = 12;
/** 无快照时的空条目兜底（模块级常量，保持引用稳定） */
const EMPTY_ENTRIES: SpotlightEntry[] = [];

/** 空查询兜底：按更新时间取最近的若干条（快速跳转最近便签） */
function pickRecent(entries: SpotlightEntry[]): SpotlightEntry[] {
  return [...entries]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_LIMIT);
}

/** 关键词匹配：标题 / 正文预览 / 标签，大小写不敏感 */
function matchEntry(entry: SpotlightEntry, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return true;
  return (
    entry.title.toLowerCase().includes(kw) ||
    entry.preview.toLowerCase().includes(kw) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(kw))
  );
}

/**
 * Spotlight 式快捷搜索窗口（独立轻量入口 spotlight.html）：
 * 输入即搜（标题/正文预览/标签），↑↓ 选择、回车跳回主窗口对应便签，Esc 关闭。
 * 数据由主窗口在唤起时通过 spotlight:open 事件下发快照，本窗口不做任何存储读写。
 */
export function SpotlightSearch() {
  const [snapshot, setSnapshot] = useState<SpotlightSnapshot | null>(null);
  const [keyword, setKeyword] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 主题变量注入：与主窗口保持一致（ctxmenu 同款做法）
  useEffect(() => {
    if (!snapshot) return;
    for (const [key, value] of Object.entries(snapshot.cssVars)) {
      document.documentElement.style.setProperty(key, value);
    }
    document.documentElement.classList.toggle("dark-glass", snapshot.isDark);
  }, [snapshot]);

  // 事件注册：ready 握手 + 接收打开快照 + 失焦自动隐藏
  useEffect(() => {
    let disposed = false;
    let detachOpen: (() => void) | null = null;
    let detachPing: (() => void) | null = null;
    let detachFocus: (() => void) | null = null;

    void (async () => {
      const current = getCurrentWindow();
      const [unOpen, unPing, unFocus] = await Promise.all([
        listen<SpotlightSnapshot>(SPOTLIGHT_OPEN_EVENT, (event) => {
          setSnapshot(event.payload);
          setKeyword("");
          setActiveIndex(0);
          // 定位到主窗口所在显示器工作区顶部居中，再显示并聚焦
          void (async () => {
            try {
              const scale = await current.scaleFactor();
              const area = event.payload.workArea;
              if (area) {
                const x = area.x + Math.max(
                  0,
                  Math.round((area.width - SPOTLIGHT_WIN_W * scale) / 2),
                );
                const y = area.y + Math.round(SPOTLIGHT_TOP_OFFSET * scale);
                await current.setPosition(new PhysicalPosition(x, y));
              }
            } catch {
              // 定位失败保持原位显示
            }
            await current.show();
            await current.setFocus();
            requestAnimationFrame(() => inputRef.current?.select());
          })();
        }),
        listen(SPOTLIGHT_PING_EVENT, () => {
          void emitTo("main", SPOTLIGHT_READY_EVENT);
        }),
        current.onFocusChanged(({ payload: focused }) => {
          // 失焦即隐藏（Spotlight 惯例：点击别处自动收起）；hide 幂等，可重复调用
          if (focused || disposed) return;
          void current
            .isVisible()
            .then((visible) => {
              if (visible) return current.hide();
              return undefined;
            })
            .catch(() => undefined);
        }),
      ]);
      if (disposed) {
        unOpen();
        unPing();
        unFocus();
        return;
      }
      detachOpen = unOpen;
      detachPing = unPing;
      detachFocus = unFocus;
      await emitTo("main", SPOTLIGHT_READY_EVENT);
    })();

    return () => {
      disposed = true;
      detachOpen?.();
      detachPing?.();
      detachFocus?.();
    };
  }, []);

  const entries = snapshot?.entries ?? EMPTY_ENTRIES;
  const results = useMemo(() => {
    const kw = keyword.trim();
    const matched = kw
      ? entries.filter((entry) => matchEntry(entry, kw)).slice(0, RESULT_LIMIT)
      : pickRecent(entries);
    return matched;
  }, [entries, keyword]);

  // 选中索引渲染期钳制：结果集缩小（继续输入）时避免越界，无需 effect 回写 state
  const safeIndex =
    results.length === 0 ? 0 : Math.min(activeIndex, results.length - 1);

  // 选中项滚动进可视区
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-result-index="${safeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [safeIndex]);

  const hideSelf = (): void => {
    void getCurrentWindow().hide();
  };

  const jump = (entryId: string): void => {
    void emitTo("main", SPOTLIGHT_JUMP_EVENT, { entryId });
    hideSelf();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideSelf();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length > 0) {
        setActiveIndex((prev) => (prev + 1) % results.length);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length > 0) {
        setActiveIndex(
          (prev) => (prev - 1 + results.length) % results.length,
        );
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = results[safeIndex];
      if (target) jump(target.id);
    }
  };

  const hasKeyword = keyword.trim() !== "";

  return (
    <div
      className="flex h-full w-full flex-col items-center overflow-hidden p-[8px]"
      data-tauri-drag-region="false"
    >
      <div
        className="flex max-h-full w-full flex-col overflow-hidden rounded-[14px] border border-solid border-[var(--border)] shadow-[0_18px_48px_rgba(16,24,40,0.22)]"
        style={{ background: "rgba(var(--field-rgb), 0.97)" }}
      >
        {/* 搜索输入行 */}
        <div className="flex shrink-0 items-center gap-2 border-0 border-b border-b-solid border-[var(--border)] px-3 py-2.5">
          <SearchOutlined
            className="shrink-0 text-[14px] text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            autoFocus
            value={keyword}
            placeholder="搜索便签：标题、正文、标签"
            className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="shrink-0 rounded-[6px] bg-[var(--hover-fill)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
            Esc 关闭
          </span>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="flex h-full min-h-[80px] items-center justify-center text-[12.5px] text-[var(--text-muted)]">
              {hasKeyword ? "没有匹配的便签" : "还没有便签"}
            </div>
          ) : (
            results.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                data-result-index={index}
                className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-[10px] border-0 px-2.5 py-2 text-left transition-colors duration-150 ${
                  index === safeIndex
                    ? "bg-[var(--hover-fill)]"
                    : "bg-transparent hover:bg-[var(--hover-fill)]"
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => jump(entry.id)}
              >
                <span className="flex w-full items-center gap-2">
                  <span
                    className="h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ background: ENTRY_KIND_COLOR[entry.kind] }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text)]">
                    {entry.title || "无标题"}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                    {ENTRY_KIND_LABEL[entry.kind]} ·{" "}
                    {formatShort(entry.updatedAt)}
                  </span>
                </span>
                {entry.preview && (
                  <span className="min-w-0 truncate pl-[15px] text-[11.5px] text-[var(--text-muted)]">
                    {entry.preview}
                  </span>
                )}
                {entry.tags.length > 0 && (
                  <span className="flex min-w-0 gap-1 pl-[15px]">
                    {entry.tags.slice(0, 4).map((tag) => (
                      <span
                        key={tag}
                        className="max-w-[120px] truncate rounded-full bg-[var(--hover-fill)] px-1.5 text-[10px] leading-[16px] text-[var(--text-muted)]"
                      >
                        {tag}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        {/* 底部提示行 */}
        <div className="flex shrink-0 items-center justify-between border-0 border-t border-t-solid border-[var(--border)] px-3 py-1.5 text-[10.5px] text-[var(--text-muted)]">
          <span>↑↓ 选择 · Enter 打开</span>
          <span>{hasKeyword ? `${results.length} 条结果` : "最近便签"}</span>
        </div>
      </div>
    </div>
  );
}
