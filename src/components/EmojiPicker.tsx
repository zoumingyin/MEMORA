import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Empty, Input, Segmented } from "antd";
import { LeftOutlined, RightOutlined, SearchOutlined } from "@ant-design/icons";
import {
  EMOJI_CATEGORIES,
  MAX_RECENT,
  loadRecentEmojis,
  pushRecentEmoji,
  searchEmojis,
  type EmojiItem,
} from "../utils/emojiData";

export interface EmojiAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface EmojiPickerProps {
  /** 锚点（触发元素视口坐标），null 时面板不渲染 */
  anchor: EmojiAnchor | null;
  onClose: () => void;
  onPick: (emoji: string) => void;
}

const PANEL_W = 344;
const PANEL_H = 372;
const GAP = 8;

/** 表情选择面板：antd(Input/Segmented/Empty) + unocss 布局，portal 到 body */
export default function EmojiPicker({ anchor, onClose, onPick }: EmojiPickerProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(() =>
    loadRecentEmojis().length > 0 ? "recent" : EMOJI_CATEGORIES[0].key
  );
  const [recent, setRecent] = useState<string[]>(() => loadRecentEmojis());

  /** 分类条滚动容器与左右箭头可用状态（10 个分类在 344px 内放不下，横向滚动 + 箭头切换） */
  const segRef = useRef<HTMLDivElement>(null);
  const [segArrows, setSegArrows] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  const updateSegArrows = (): void => {
    const el = segRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setSegArrows({
      left: el.scrollLeft > 2,
      right: el.scrollLeft < max - 2,
    });
  };

  /** 箭头点击：即时滚动一步并立刻同步箭头可用状态（部分环境程序化滚动不派发 scroll 事件，不能只依赖 onScroll） */
  const scrollSegBy = (dir: -1 | 1): void => {
    const el = segRef.current;
    if (!el) return;
    el.scrollBy({ left: 160 * dir });
    updateSegArrows();
  };

  // 打开时重置筛选
  useEffect(() => {
    if (anchor) {
      setQuery("");
      const recentList = loadRecentEmojis();
      setRecent(recentList);
      setCategory(recentList.length > 0 ? "recent" : EMOJI_CATEGORIES[0].key);
      const el = segRef.current;
      if (el) el.scrollLeft = 0;
      updateSegArrows();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  // 窗口尺寸变化时重算箭头可用状态
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("resize", updateSegArrows);
    return () => window.removeEventListener("resize", updateSegArrows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, recent.length]);

  // Esc 关闭
  useEffect(() => {
    if (!anchor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anchor, onClose]);

  const matched = useMemo(() => (query.trim() ? searchEmojis(query) : null), [query]);

  const options = useMemo(() => {
    const base = EMOJI_CATEGORIES.map((c) => ({ label: c.label, value: c.key }));
    if (recent.length > 0) {
      return [{ label: "最近使用", value: "recent" }, ...base];
    }
    return base;
  }, [recent]);

  const list = useMemo<EmojiItem[]>(() => {
    if (matched) return matched;
    if (category === "recent") {
      return recent.map((emoji, index) => ({ emoji, name: `最近使用 ${index + 1}`, keywords: [] }));
    }
    return EMOJI_CATEGORIES.find((c) => c.key === category)?.emojis ?? [];
  }, [matched, category, recent]);

  if (!anchor) return null;

  const rect = anchor;
  let left = rect.left;
  let top = rect.top + rect.height + GAP;
  if (top + PANEL_H > window.innerHeight - GAP) {
    top = Math.max(GAP, rect.top - PANEL_H - GAP);
  }
  if (left + PANEL_W > window.innerWidth - GAP) {
    left = Math.max(GAP, window.innerWidth - PANEL_W - GAP);
  }

  const handlePick = (item: EmojiItem): void => {
    pushRecentEmoji(item.emoji);
    onPick(item.emoji);
  };

  return createPortal(
    <>
      {/* 点击遮罩关闭 */}
      <div className="fixed inset-0 z-[1699]" onClick={onClose} />
      <div
        className="fixed z-[1700] flex   flex-col overflow-hidden rounded-xl border border-solid border-[var(--border)] bg-[rgba(var(--field-rgb),0.98)] shadow-[0_8px_28px_rgba(0,0,0,0.2)] backdrop-blur-xl"
        style={{ left, top, width: PANEL_W }}
      >
        {/* 搜索框 */}
        <div className="px-3 pt-3 pb-2">
          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined className="text-[var(--text-muted)]" />}
            placeholder="搜索表情（如：笑哭、heart）"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {/* 分类：10 个分类超出 344px 面板宽度，横向滚动 + 左右箭头切换 */}
        {!matched && (
          <div className="flex items-center gap-1 px-3 pb-2">
            <button
              type="button"
              disabled={!segArrows.left}
              aria-label="上一个分类"
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-fill)] active:scale-95 disabled:cursor-default disabled:opacity-25"
              onClick={() => scrollSegBy(-1)}
            >
              <LeftOutlined className="text-[10px]" />
            </button>
            <div
              ref={segRef}
              onScroll={updateSegArrows}
              className="emoji-cat-scroll min-w-0 flex-1 overflow-x-auto py-0.5"
            >
              <Segmented
                size="small"
                value={category}
                onChange={(value) => setCategory(String(value))}
                options={options}
              />
            </div>
            <button
              type="button"
              disabled={!segArrows.right}
              aria-label="下一个分类"
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-fill)] active:scale-95 disabled:cursor-default disabled:opacity-25"
              onClick={() => scrollSegBy(1)}
            >
              <RightOutlined className="text-[10px]" />
            </button>
          </div>
        )}

        {/* 表情网格 */}
        <div className="h-[260px] overflow-y-auto px-3 pb-3">
          {list.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的表情" />
            </div>
          ) : (
            <div className="grid grid-cols-8 gap-1">
              {list.map((item, index) => (
                <button
                  key={`${category}-${item.emoji}-${index}`}
                  type="button"
                  title={item.name}
                  className="flex h-9 items-center justify-center rounded-md text-[22px] leading-none transition-colors hover:bg-[var(--hover-fill)] active:scale-95"
                  onClick={() => handlePick(item)}
                >
                  {item.emoji}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 底部提示 */}
        <div className="border-t border-solid border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
          {matched
            ? `${list.length} 个结果`
            : category === "recent"
              ? `最近使用 · 最多 ${MAX_RECENT} 个，点击表情即可插入`
              : "点击表情插入到光标处"}
        </div>
      </div>
    </>,
    document.body
  );
}
