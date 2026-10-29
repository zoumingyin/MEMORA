import type { PaperColor, PaperStyle } from "../types/entry";

/** 纸张底色色板：key 存库，hex 用于色板圆点与面板/卡片着色（plain = 跟随主题不加色） */
export const PAPER_COLORS: { key: PaperColor; label: string; hex: string }[] = [
  { key: "plain", label: "默认", hex: "" },
  { key: "yellow", label: "黄", hex: "#f3eda0" },
  { key: "mint", label: "薄荷", hex: "#c9e8d5" },
  { key: "blue", label: "天蓝", hex: "#cfe0f2" },
  { key: "lavender", label: "淡紫", hex: "#e3ddf6" },
  { key: "cream", label: "米杏", hex: "#f3ead4" },
  { key: "pink", label: "樱粉", hex: "#f5dce6" },
  { key: "peach", label: "蜜桃", hex: "#f6ddc6" },
];

/** 纸张纹理选项：key 对应 index.css 的 [data-paper] 纹理规则 */
export const PAPER_STYLES: { key: PaperStyle; label: string }[] = [
  { key: "plain", label: "素白" },
  { key: "ruled", label: "横线" },
  { key: "grid", label: "方格" },
  { key: "dots", label: "点阵" },
];

/** 按 key 取纸张色值；plain 或未知 key 返回 undefined（不加色） */
export function paperTintHex(
  color: PaperColor | string | undefined | null
): string | undefined {
  return PAPER_COLORS.find((item) => item.key === color)?.hex || undefined;
}
