import type { EntryKind } from "../types/entry";

/** 分类中文名：新建条目未填标题时的默认标题 */
export const ENTRY_KIND_LABEL: Record<EntryKind, string> = {
  note: "备忘",
  reminder: "提醒",
  todo: "待办",
  draw: "涂鸦",
};
