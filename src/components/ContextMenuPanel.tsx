import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  CheckSquareOutlined,
  CopyOutlined,
  FontColorsOutlined,
  FontSizeOutlined,
  KeyOutlined,
  LeftOutlined,
  PictureOutlined,
  RightOutlined,
  ScissorOutlined,
  SmileOutlined,
  SnippetsOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { ColorPicker, Input } from "antd";
import { FONT_COLORS, FONT_SIZES, STANDARD_COLORS, DEFAULT_PICKER_COLOR } from "../utils/editorColors";
import {
  EMOJI_CATEGORIES,
  MAX_RECENT,
  loadRecentEmojis,
  pushRecentEmoji,
  searchEmojis,
  type EmojiItem,
} from "../utils/emojiData";

/** 右键菜单动作：面板只负责上报动作，由宿主（主窗口内嵌 / 独立菜单窗口）执行 */
export type CtxMenuAction =
  | { type: "copy" }
  | { type: "cut" }
  | { type: "paste" }
  | { type: "selectAll" }
  | { type: "bold" }
  | { type: "strike" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "color"; value: string }
  | { type: "colorClear" }
  | { type: "colorCommit"; value: string }
  | { type: "colorClearCommit" }
  | { type: "size"; value: string }
  | { type: "sizeDefault" }
  | { type: "insertImage" }
  | { type: "insertEmoji"; emoji: string }
  | { type: "info" };

/** 菜单项激活态（加粗/中划线/斜体/下划线） */
export interface ActiveFormats {
  bold: boolean;
  strike: boolean;
  italic: boolean;
  underline: boolean;
}

interface ContextMenuPanelProps {
  active: ActiveFormats;
  /** 打开菜单时读取的当前文字颜色（拾色器子菜单初始值） */
  colorValue?: string;
  /** 定位样式（页面内菜单传 top/left；独立窗口菜单不传，落在窗口左上角） */
  style?: CSSProperties;
  /**
   * 子菜单可展开的可见区域（CSS px，面板所在视口坐标系）。
   * 不传时默认整个窗口视口（页面内菜单即浏览器/应用视口；独立窗口即窗口自身 520×520）。
   * 独立窗口传「屏幕工作区 ∩ 窗口内部」的映射区域，使子菜单在靠近屏幕边缘时也能正确翻转。
   */
  viewArea?: { left: number; top: number; right: number; bottom: number } | null;
  onAction: (action: CtxMenuAction) => void;
}

/** 各子菜单的近似展开尺寸（CSS px），用于在展开前判断可用空间并决定方向 */
const SUBMENU_EST: Record<"color" | "size" | "emoji", { w: number; h: number }> = {
  color: { w: 180, h: 110 },
  size: { w: 180, h: 360 },
  emoji: { w: 244, h: 264 },
};

/**
 * Markdown 右键上下文菜单面板（VS Code 风格垂直列表）：
 * 复制/剪切/粘贴/全选、B/S/I/U、文字颜色/文字大小（子菜单）、插入图片/表情、快捷键介绍。
 * 面板只做展示与交互，所有动作通过 onAction 上报，供主窗口内嵌与独立 Tauri 菜单窗口复用，
 * 保证两处功能与样式完全一致。
 */
export function ContextMenuPanel({
  active,
  colorValue,
  style,
  viewArea,
  onAction,
}: ContextMenuPanelProps) {
  /** 展开的子菜单（color / size / emoji），null 表示收起 */
  const [ctxSubmenu, setCtxSubmenu] = useState<string | null>(null);
  /** 拾色器弹层打开状态（防止鼠标移入弹层时误关子菜单） */
  const [ctxColorPickerOpen, setCtxColorPickerOpen] = useState(false);
  /** 当前展开子菜单的方向（左右/上下自适应）与限高（空间不足时内部滚动） */
  const [submenuDir, setSubmenuDir] = useState<{
    x: "right" | "left";
    y: "down" | "up";
  }>({ x: "right", y: "down" });
  const [submenuMaxH, setSubmenuMaxH] = useState<number | undefined>(undefined);

  /** 打开子菜单：根据触发项位置与可见区域计算展开方向，空间不足时翻转并限高 */
  const openSubmenu = (
    kind: "color" | "size" | "emoji",
    trigger: HTMLElement
  ): void => {
    setCtxSubmenu(kind);
    const est = SUBMENU_EST[kind];
    const tr = trigger.getBoundingClientRect();
    const va = viewArea ?? {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
    // 横向：右方放不下且左方放得下 → 向左展开；否则向右
    const rightOk = tr.right + est.w <= va.right;
    const leftOk = tr.left - est.w >= va.left;
    const dirX = rightOk || !leftOk ? "right" : "left";
    // 纵向：下方放不下且上方放得下 → 向上展开；都放不下时选空间大的一侧并限高滚动
    const downOk = tr.top + est.h <= va.bottom;
    const upOk = tr.bottom - est.h >= va.top;
    let dirY: "down" | "up";
    let maxH: number | undefined;
    if (downOk || upOk) {
      dirY = downOk ? "down" : "up";
    } else {
      const downAvail = va.bottom - tr.top - 6;
      const upAvail = tr.bottom - va.top - 6;
      if (downAvail >= upAvail) {
        dirY = "down";
        maxH = Math.max(downAvail, 80);
      } else {
        dirY = "up";
        maxH = Math.max(upAvail, 80);
      }
    }
    setSubmenuDir({ x: dirX, y: dirY });
    setSubmenuMaxH(maxH);
  };

  /** 子菜单类名：方向自适应（左/右、上/下） */
  const submenuClass = `md-ctx-submenu${
    submenuDir.y === "up" ? " submenu-up" : ""
  }${submenuDir.x === "left" ? " submenu-left" : ""}`;

  // —— 表情子菜单（与 EmojiPicker 共用数据源：最近使用 + 分类 + 搜索）——
  const [emojiQuery, setEmojiQuery] = useState("");
  const [emojiCategory, setEmojiCategory] = useState<string>(() =>
    loadRecentEmojis().length > 0 ? "recent" : EMOJI_CATEGORIES[0].key
  );
  const [recentEmojis, setRecentEmojis] = useState<string[]>(() =>
    loadRecentEmojis()
  );

  /** 表情分类条：10 个分类超出子菜单宽度，左右箭头 + 横向滚动（与 EmojiPicker 一致） */
  const emojiTabsRef = useRef<HTMLDivElement>(null);
  const [emojiArrows, setEmojiArrows] = useState<{ left: boolean; right: boolean }>(
    { left: false, right: false }
  );

  const updateEmojiArrows = (): void => {
    const el = emojiTabsRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEmojiArrows({
      left: el.scrollLeft > 2,
      right: el.scrollLeft < max - 2,
    });
  };

  /** 分类箭头点击：即时滚动一步并立刻同步箭头可用状态（不依赖 scroll 事件） */
  const scrollEmojiTabs = (dir: -1 | 1): void => {
    const el = emojiTabsRef.current;
    if (!el) return;
    el.scrollBy({ left: 120 * dir });
    updateEmojiArrows();
  };

  const emojiMatched = useMemo(
    () => (emojiQuery.trim() ? searchEmojis(emojiQuery) : null),
    [emojiQuery]
  );

  const emojiOptions = useMemo(() => {
    const base = EMOJI_CATEGORIES.map((c) => ({ label: c.label, value: c.key }));
    if (recentEmojis.length > 0) {
      return [{ label: "最近使用", value: "recent" }, ...base];
    }
    return base;
  }, [recentEmojis]);

  // 表情子菜单打开（或分类增减）时刷新分类箭头可用状态
  useEffect(() => {
    if (ctxSubmenu === "emoji") updateEmojiArrows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxSubmenu, emojiOptions.length]);

  const emojiList = useMemo<EmojiItem[]>(() => {
    if (emojiMatched) return emojiMatched;
    if (emojiCategory === "recent") {
      return recentEmojis.map((emoji, index) => ({
        emoji,
        name: `最近使用 ${index + 1}`,
        keywords: [],
      }));
    }
    return EMOJI_CATEGORIES.find((c) => c.key === emojiCategory)?.emojis ?? [];
  }, [emojiMatched, emojiCategory, recentEmojis]);

  const handleEmojiPick = (item: EmojiItem): void => {
    pushRecentEmoji(item.emoji);
    setRecentEmojis(loadRecentEmojis());
    onAction({ type: "insertEmoji", emoji: item.emoji });
  };

  return (
    <div
      className="md-ctx-menu"
      style={style}
      onMouseLeave={() => {
        // 拾色器弹层打开时（弹层在菜单外部），不关闭子菜单，避免移入取色面板时菜单消失
        if (!ctxColorPickerOpen) setCtxSubmenu(null);
      }}
    >
      <div className="flex">
        {/* 复制 */}
        <div
          className="md-ctx-item"
          onClick={() => onAction({ type: "copy" })}
        >
          <span className="md-ctx-label grid">
            <CopyOutlined className="justify-center" />
            复制
          </span>
        </div>
        {/* 剪切 */}
        <div className="md-ctx-item" onClick={() => onAction({ type: "cut" })}>
          <span className="md-ctx-label grid">
            <ScissorOutlined className="justify-center" />
            剪切
          </span>
        </div>
        {/* 粘贴 */}
        <div
          className="md-ctx-item"
          onClick={() => onAction({ type: "paste" })}
        >
          <span className="md-ctx-label grid">
            <SnippetsOutlined className="justify-center" />
            粘贴
          </span>
        </div>
        {/* 全选 */}
        <div
          className="md-ctx-item"
          onClick={() => onAction({ type: "selectAll" })}
        >
          <span className="md-ctx-label grid">
            <CheckSquareOutlined className="justify-center" />
            全选
          </span>
        </div>
      </div>
      <div className="md-ctx-sep" />
      <div className="flex">
        {/* 加粗 */}
        <div
          className={`md-ctx-item${active.bold ? " active" : ""}`}
          onClick={() => onAction({ type: "bold" })}
        >
          <span className="md-ctx-label grid">
            <span className="md-ctx-b text-center">B</span>
            加粗
          </span>
        </div>
        {/* 中划线 */}
        <div
          className={`md-ctx-item${active.strike ? " active" : ""}`}
          onClick={() => onAction({ type: "strike" })}
        >
          <span className="md-ctx-label grid">
            <span className="md-ctx-s text-center">S</span>
            中划线
          </span>
        </div>
        {/* 倾斜 */}
        <div
          className={`md-ctx-item${active.italic ? " active" : ""}`}
          onClick={() => onAction({ type: "italic" })}
        >
          <span className="md-ctx-label grid">
            <span className="md-ctx-i text-center">I</span>
            倾斜
          </span>
        </div>
        {/* 下划线 */}
        <div
          className={`md-ctx-item${active.underline ? " active" : ""}`}
          onClick={() => onAction({ type: "underline" })}
        >
          <span className="md-ctx-label grid">
            <span className="md-ctx-u text-center">U</span>
            下划线
          </span>
        </div>
      </div>
      <div className="md-ctx-sep" />
      {/* 文字颜色 */}
      <div
        className="md-ctx-item"
        onMouseEnter={(e) => openSubmenu("color", e.currentTarget)}
      >
        <span className="md-ctx-label">
          <FontColorsOutlined style={{ color: "#e5484d" }} />
          文字颜色
        </span>
        <span className="md-ctx-arrow">›</span>
        {ctxSubmenu === "color" && (
          <div
            className={submenuClass}
            style={{ maxHeight: submenuMaxH }}
            onMouseEnter={() => {
              setCtxSubmenu("color");
              setCtxColorPickerOpen(false);
            }}
          >
            <button
              type="button"
              className="md-ctx-color-item"
              onClick={() => onAction({ type: "colorClearCommit" })}
            >
              <span
                style={{
                  display: "inline-block",
                  width: "16px",
                  height: "16px",
                  background: "#000000",
                  borderRadius: "3px",
                  marginRight: "8px",
                }}
              />
              默认字体颜色
            </button>
            <div className="md-ctx-sep" />
            <div style={{ padding: "4px" }}>
              <ColorPicker
                rootClassName="md-ctx-color-picker"
                // 无显式颜色时用不透明兜底色：cleared 颜色（alpha=0）会触发 disabledAlpha 警告
                defaultValue={colorValue ?? DEFAULT_PICKER_COLOR}
                format="hex"
                disabledAlpha
                allowClear
                presets={[
                  {
                    label: "常用色",
                    colors: FONT_COLORS.map((c) => c.value),
                  },
                  { label: "标准色", colors: STANDARD_COLORS },
                ]}
                onOpenChange={setCtxColorPickerOpen}
                onChange={(value) => {
                  if (value.cleared) {
                    onAction({ type: "colorClear" });
                    return;
                  }
                  onAction({ type: "color", value: value.toHexString() });
                }}
                onChangeComplete={(value) => {
                  if (value.cleared) {
                    onAction({ type: "colorClearCommit" });
                  } else {
                    onAction({
                      type: "colorCommit",
                      value: value.toHexString(),
                    });
                  }
                }}
                onClear={() => onAction({ type: "colorClearCommit" })}
              >
                <div className="md-ctx-color-trigger" title="打开 antd 拾色器">
                  自定义颜色
                </div>
              </ColorPicker>
            </div>
          </div>
        )}
      </div>
      {/* 文字大小 */}
      <div
        className="md-ctx-item"
        onMouseEnter={(e) => openSubmenu("size", e.currentTarget)}
      >
        <span className="md-ctx-label">
          <FontSizeOutlined />
          文字大小
        </span>
        <span className="md-ctx-arrow">›</span>
        {ctxSubmenu === "size" && (
          <div
            className={submenuClass}
            style={{ maxHeight: submenuMaxH }}
            onMouseEnter={() => setCtxSubmenu("size")}
          >
            {FONT_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className="md-ctx-color-item"
                onClick={() => onAction({ type: "size", value: `${size}px` })}
              >
                {size}
              </button>
            ))}
            <div className="md-ctx-sep" />
            <button
              type="button"
              className="md-ctx-color-item"
              onClick={() => onAction({ type: "sizeDefault" })}
            >
              默认 (13px)
            </button>
          </div>
        )}
      </div>
      <div className="md-ctx-sep" />
      {/* 插入图片 */}
      <div
        className="md-ctx-item"
        onClick={() => onAction({ type: "insertImage" })}
      >
        <span className="md-ctx-label">
          <PictureOutlined />
          插入图片
        </span>
      </div>
      {/* 插入表情（与文字颜色/大小一致：悬停展开子菜单） */}
      <div
        className="md-ctx-item"
        onMouseEnter={(e) => openSubmenu("emoji", e.currentTarget)}
      >
        <span className="md-ctx-label">
          <SmileOutlined />
          插入表情
        </span>
        <span className="md-ctx-arrow">›</span>
        {ctxSubmenu === "emoji" && (
          <div
            className={`${submenuClass} md-ctx-emoji-menu`}
            style={{ maxHeight: submenuMaxH }}
            onMouseEnter={() => setCtxSubmenu("emoji")}
          >
            <Input
              size="small"
              allowClear
              prefix={<SearchOutlined className="text-[var(--text-muted)]" />}
              placeholder="搜索表情（如：笑哭）"
              value={emojiQuery}
              onChange={(event) => setEmojiQuery(event.target.value)}
            />
            <div className="md-ctx-emoji-tabrow">
              <button
                type="button"
                disabled={!emojiArrows.left}
                aria-label="上一个分类"
                className="md-ctx-emoji-nav"
                onClick={() => scrollEmojiTabs(-1)}
              >
                <LeftOutlined className="text-[10px]" />
              </button>
              <div
                ref={emojiTabsRef}
                onScroll={updateEmojiArrows}
                className="md-ctx-emoji-tabs"
              >
                {emojiOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`md-ctx-emoji-tab${
                      emojiCategory === opt.value ? " active" : ""
                    }`}
                    onClick={() => setEmojiCategory(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={!emojiArrows.right}
                aria-label="下一个分类"
                className="md-ctx-emoji-nav"
                onClick={() => scrollEmojiTabs(1)}
              >
                <RightOutlined className="text-[10px]" />
              </button>
            </div>
            <div className="md-ctx-emoji-grid">
              {emojiList.map((item, index) => (
                <button
                  key={`${emojiCategory}-${item.emoji}-${index}`}
                  type="button"
                  title={item.name}
                  className="md-ctx-emoji-cell"
                  onClick={() => handleEmojiPick(item)}
                >
                  {item.emoji}
                </button>
              ))}
            </div>
            <div className="md-ctx-emoji-hint">
              {emojiMatched
                ? `${emojiList.length} 个结果`
                : emojiCategory === "recent"
                  ? `最近使用 · 最多 ${MAX_RECENT} 个，点击表情即可插入`
                  : "点击表情插入到光标处"}
            </div>
          </div>
        )}
      </div>
      <div className="md-ctx-sep" />
      {/* 快捷键介绍 */}
      <div
        className="md-ctx-item"
        title="快捷键：Ctrl+B 加粗 / Ctrl+I 斜体 / Ctrl+U 下划线 / Ctrl+Z 撤销"
      >
        <span className="md-ctx-label">
          <KeyOutlined />
          快捷键介绍
        </span>
      </div>
    </div>
  );
}
