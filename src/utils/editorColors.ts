/** Markdown 编辑器与右键菜单共享的排版常量 */

/**
 * 拾色器兜底初始色：本项目文字颜色不支持透明，而「无颜色」在 antd ColorPicker
 * 内部表现为 alpha=0 的 cleared 颜色，配合 disabledAlpha 会触发 dev 警告
 * （disabledAlpha will make the alpha to be 100%）。无显式颜色时用它兜底，
 * 调用方通常会优先传入当前渲染的文字颜色。
 */
export const DEFAULT_PICKER_COLOR = "#000000";

/** 文字颜色板：红 / 橙 / 绿 / 蓝 / 紫 / 亮白（暗色下文字用） */
export const FONT_COLORS = [
  { label: "红", value: "#e5484d" },
  { label: "橙", value: "#f2994a" },
  { label: "绿", value: "#30a46c" },
  { label: "蓝", value: "#3b82f6" },
  { label: "紫", value: "#8e4ec6" },
  { label: "白", value: "#f4f1ea" },
];

/** 标准色（拾色器 presets 用） */
export const STANDARD_COLORS = [
  "#e5484d",
  "#f2994a",
  "#f5d90a",
  "#30a46c",
  "#3b82f6",
  "#8e4ec6",
  "#e5489d",
  "#000000",
];

/** 完整字号列表 */
export const FONT_SIZES = [8, 9, 10, 12, 14, 16, 18, 20, 24, 36, 48];
