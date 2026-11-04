import type { EntryKind } from "../types/entry";

/** 分类中文名：新建条目未填标题时的默认标题 */
export const ENTRY_KIND_LABEL: Record<EntryKind, string> = {
  note: "备忘",
  reminder: "提醒",
  todo: "待办",
  draw: "涂鸦",
};

/** 分类主题色：antd 主色 / --kind-accent / 收纳窄条胶囊点缀共用（备忘蓝/提醒珊瑚红/待办绿/涂鸦紫） */
export const ENTRY_KIND_COLOR: Record<EntryKind, string> = {
  note: "#2563eb",
  reminder: "#d9686b",
  todo: "#57a878",
  draw: "#8b5cf6",
};
