import { useEntryStore } from "../store/useEntryStore";
import type { EntryKind } from "../types/entry";

type FilterValue = "all" | EntryKind;
const FILTERS: Array<{ value: FilterValue; label: string }> = [
  { value: "all", label: "全部" },
  { value: "note", label: "备忘" },
  { value: "reminder", label: "提醒" },
  { value: "todo", label: "待办" },
];

/** 左侧列表顶部的分类筛选胶囊：全部 / 备忘 / 提醒 / 待办，选中态蓝色实心 + 计数（与参考图一致：仅选中项显示计数，保持一行紧凑） */
export function CategoryTabs() {
  const filter = useEntryStore((state) => state.filter);
  const setFilter = useEntryStore((state) => state.setFilter);
  const setCurrentKind = useEntryStore((state) => state.setCurrentKind);
  const setView = useEntryStore((state) => state.setView);
  const entries = useEntryStore((state) => state.entries);

  const countFor = (value: FilterValue): number =>
    value === "all"
      ? entries.length
      : entries.filter((entry) => entry.kind === value).length;

  return (
    <div className="filter-chips">
      {FILTERS.map((f) => {
        const active = filter === f.value;
        return (
          <button
            key={f.value}
            type="button"
            className={`filter-chip ${active ? "active" : ""}`}
            onClick={() => {
              setView("list");
              setFilter(f.value);
              if (f.value !== "all") setCurrentKind(f.value);
              const filtered = entries.filter(
                (entry) => f.value === "all" || entry.kind === f.value,
              );
              useEntryStore.getState().setSelectedId(filtered[0]?.id ?? null);
            }}
          >
            <span>{f.label}</span>
            {active && <em className="filter-chip-count">{countFor(f.value)}</em>}
          </button>
        );
      })}
    </div>
  );
}
