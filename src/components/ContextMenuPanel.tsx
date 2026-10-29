import { useState, type CSSProperties } from "react";
import {
  CheckSquareOutlined,
  CopyOutlined,
  FontColorsOutlined,
  FontSizeOutlined,
  KeyOutlined,
  PictureOutlined,
  ScissorOutlined,
  SmileOutlined,
  SnippetsOutlined,
} from "@ant-design/icons";
import { ColorPicker } from "antd";
import type { EmojiAnchor } from "./EmojiPicker";
import { FONT_COLORS, FONT_SIZES, STANDARD_COLORS } from "../utils/editorColors";

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
  | { type: "insertEmoji"; anchor: EmojiAnchor }
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
  onAction: (action: CtxMenuAction) => void;
}

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
  onAction,
}: ContextMenuPanelProps) {
  /** 展开的子菜单（color / size），null 表示收起 */
  const [ctxSubmenu, setCtxSubmenu] = useState<string | null>(null);
  /** 拾色器弹层打开状态（防止鼠标移入弹层时误关子菜单） */
  const [ctxColorPickerOpen, setCtxColorPickerOpen] = useState(false);

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
        onMouseEnter={() => setCtxSubmenu("color")}
      >
        <span className="md-ctx-label">
          <FontColorsOutlined style={{ color: "#e5484d" }} />
          文字颜色
        </span>
        <span className="md-ctx-arrow">›</span>
        {ctxSubmenu === "color" && (
          <div
            className="md-ctx-submenu submenu-up"
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
                defaultValue={colorValue}
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
        onMouseEnter={() => setCtxSubmenu("size")}
      >
        <span className="md-ctx-label">
          <FontSizeOutlined />
          文字大小
        </span>
        <span className="md-ctx-arrow">›</span>
        {ctxSubmenu === "size" && (
          <div
            className="md-ctx-submenu submenu-up"
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
      {/* 插入表情 */}
      <div
        className="md-ctx-item"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onAction({
            type: "insertEmoji",
            anchor: {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            },
          });
        }}
      >
        <span className="md-ctx-label">
          <SmileOutlined />
          插入表情
        </span>
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
