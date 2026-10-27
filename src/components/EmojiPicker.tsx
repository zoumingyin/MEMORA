import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Empty, Input, Segmented } from "antd";
import { SearchOutlined } from "@ant-design/icons";
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

  // 打开时重置筛选
  useEffect(() => {
    if (anchor) {
      setQuery("");
      const recentList = loadRecentEmojis();
      setRecent(recentList);
      setCategory(recentList.length > 0 ? "recent" : EMOJI_CATEGORIES[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

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
        style={{ left, top }}
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

        {/* 分类 */}
        {!matched && (
          <div className="px-3 pb-2">
            <Segmented
              size="small"
              block
              value={category}
              onChange={(value) => setCategory(String(value))}
              options={options}
            />
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
