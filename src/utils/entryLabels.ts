import type { EntryKind } from "../types/entry";

/** 分类中文名：新建条目未填标题时的默认标题 */
export const ENTRY_KIND_LABEL: Record<EntryKind, string> = {
  note: "备忘",
  reminder: "提醒",
  todo: "待办",
  draw: "涂鸦",
};

/** 分类强调色：--kind-accent / 收纳窄条胶囊点缀共用，取自 MEMORA 品牌语义色
 *  （备忘=主色蓝 / 提醒=危险珊瑚 / 待办=成功绿 / 涂鸦=AI 紫）；
 *  引用 CSS 变量而非固定 hex，深色下自动换成更亮的主色档；
 *  antd 主色不再跟随分类，统一为品牌主色，见 theme/antdTheme.ts */
export const ENTRY_KIND_COLOR: Record<EntryKind, string> = {
  note: "var(--note)",
  reminder: "var(--reminder)",
  todo: "var(--todo)",
  draw: "var(--draw)",
};
