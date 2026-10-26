import { Select } from "antd";
import { CalendarOutlined } from "@ant-design/icons";
import { useEntryStore } from "../store/useEntryStore";
import type { EntryKind } from "../types/entry";

type FilterValue = "all" | EntryKind | "calendar";

/** 左侧列表顶部的分类筛选：全部 / 备忘 / 提醒 / 待办 / 日历，各自显示计数（antd Select 下拉） */
export function CategoryTabs() {
  const filter = useEntryStore((state) => state.filter);
  const setFilter = useEntryStore((state) => state.setFilter);
  const setCurrentKind = useEntryStore((state) => state.setCurrentKind);
  const setView = useEntryStore((state) => state.setView);
  const view = useEntryStore((state) => state.view);
  const entries = useEntryStore((state) => state.entries);

  const countFor = (kind: EntryKind): number =>
    entries.filter((entry) => entry.kind === kind).length;

  const options: Array<{ value: FilterValue; label: React.ReactNode }> = [
    {
      value: "all",
      label: (
        <span className="filter-chip-label">
          全部 <em className="filter-chip-count">{entries.length}</em>
        </span>
      ),
    },
    {
      value: "note",
      label: (
        <span className="filter-chip-label">
          备忘 <em className="filter-chip-count">{countFor("note")}</em>
        </span>
      ),
    },
    {
      value: "reminder",
      label: (
        <span className="filter-chip-label">
          提醒 <em className="filter-chip-count">{countFor("reminder")}</em>
        </span>
      ),
    },
    {
      value: "todo",
      label: (
        <span className="filter-chip-label">
          待办 <em className="filter-chip-count">{countFor("todo")}</em>
        </span>
      ),
    },
    {
      value: "calendar",
      label: (
        <span className="filter-chip-label">
          <CalendarOutlined /> 日历
        </span>
      ),
    },
  ];

  return (
    <Select<FilterValue>
      className="kind-select"
      size="small"
      value={view === "calendar" ? "calendar" : filter}
      options={options}
      popupMatchSelectWidth={false}
      onChange={(value) => {
        if (value === "calendar") {
          setView("calendar");
          return;
        }
        setView("list");
        setFilter(value);
        if (value !== "all") setCurrentKind(value);
        // 切换筛选后自动选中结果列表的第一条
        const filtered = useEntryStore
          .getState()
          .entries.filter((entry) => value === "all" || entry.kind === value);
        useEntryStore.getState().setSelectedId(filtered[0]?.id ?? null);
      }}
    />
  );
}
