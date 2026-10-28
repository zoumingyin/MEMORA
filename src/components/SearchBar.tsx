import { Dropdown } from "antd";
import type { MenuProps } from "antd";
import { DownOutlined } from "@ant-design/icons";
import { useMemo } from "react";
import { useEntryStore } from "../store/useEntryStore";

type SortBy = "updated" | "created";
type TimeRange = "all" | "today" | "7d" | "30d";

/** 排序文案：默认「最近编辑」（与参考图一致） */
const SORT_LABEL: Record<SortBy, string> = {
  updated: "最近编辑",
  created: "按创建时间",
};

const TIME_OPTIONS: Array<{ value: TimeRange; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

/** 标签下拉选项：收集全部条目标签，按使用次数排序 */
function useTagOptions() {
  const entries = useEntryStore((state) => state.entries);
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      for (const tag of entry.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
      .map(([tag, count]) => ({ value: tag, label: `${tag}（${count}）` }));
  }, [entries]);
}

/**
 * 列表右上角的排序/筛选控件（对齐参考图）：纯文字 + 箭头，无边框。
 * 下拉内分三组：排序 / 时间范围 / 标签——原有筛选能力全部保留。
 */
export function SearchBar() {
  const sortBy = useEntryStore((state) => state.sortBy);
  const setSortBy = useEntryStore((state) => state.setSortBy);
  const timeRange = useEntryStore((state) => state.timeRange);
  const setTimeRange = useEntryStore((state) => state.setTimeRange);
  const tagFilter = useEntryStore((state) => state.tagFilter);
  const setTagFilter = useEntryStore((state) => state.setTagFilter);
  const tagOptions = useTagOptions();

  const items: MenuProps["items"] = [
    {
      key: "group-sort",
      type: "group",
      label: "排序",
      children: [
        { key: "sort:updated", label: "最近编辑" },
        { key: "sort:created", label: "按创建时间" },
      ],
    },
    { type: "divider" },
    {
      key: "group-time",
      type: "group",
      label: "时间范围",
      children: TIME_OPTIONS.map((option) => ({
        key: `time:${option.value}`,
        label: option.label,
      })),
    },
    { type: "divider" },
    {
      key: "group-tag",
      type: "group",
      label: "标签",
      children: [
        { key: "tag:all", label: "全部标签" },
        ...tagOptions.map((option) => ({
          key: `tag:${option.value}`,
          label: option.label,
        })),
      ],
    },
  ];

  const selectedKeys = [
    `sort:${sortBy}`,
    `time:${timeRange}`,
    `tag:${tagFilter ?? "all"}`,
  ];

  const handleClick: MenuProps["onClick"] = ({ key }) => {
    const splitAt = key.indexOf(":");
    const namespace = key.slice(0, splitAt);
    const value = key.slice(splitAt + 1);
    if (namespace === "sort") setSortBy(value as SortBy);
    else if (namespace === "time") setTimeRange(value as TimeRange);
    else if (namespace === "tag") setTagFilter(value === "all" ? null : value);
  };

  // 时间 / 标签非默认时，用一个蓝点提示「还有额外筛选生效」
  const hasExtraFilter = timeRange !== "all" || tagFilter !== null;

  return (
    <Dropdown
      menu={{ items, selectedKeys, onClick: handleClick }}
      trigger={["click"]}
      placement="bottomRight"
      getPopupContainer={() => document.body}
    >
      <button
        type="button"
        data-tauri-drag-region="false"
        title="排序与筛选"
        className="ml-auto mr-[10px] flex shrink-0 items-center gap-1 border-0 bg-transparent p-0 text-[12px] text-[var(--text-muted)] cursor-pointer select-none transition-colors duration-150 hover:text-[var(--text)]"
      >
        <span>{SORT_LABEL[sortBy]}</span>
        {hasExtraFilter && (
          <span className="h-[5px] w-[5px] rounded-full bg-[var(--note)]" />
        )}
        <DownOutlined className="text-[9px]" />
      </button>
    </Dropdown>
  );
}
