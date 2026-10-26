import { Input, Select } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useMemo } from "react";
import { useEntryStore } from "../store/useEntryStore";

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

/** 列表搜索区：全局搜索（标题+内容）、时间范围、标签筛选、排序 */
export function SearchBar() {
  const search = useEntryStore((state) => state.search);
  const setSearch = useEntryStore((state) => state.setSearch);
  const tagFilter = useEntryStore((state) => state.tagFilter);
  const setTagFilter = useEntryStore((state) => state.setTagFilter);
  const timeRange = useEntryStore((state) => state.timeRange);
  const setTimeRange = useEntryStore((state) => state.setTimeRange);
  const sortBy = useEntryStore((state) => state.sortBy);
  const setSortBy = useEntryStore((state) => state.setSortBy);
  const tagOptions = useTagOptions();

  return (
    <div className="search-bar" data-tauri-drag-region="false">
      <Input
        className="search-input"
        allowClear
        size="small"
        prefix={<SearchOutlined style={{ fontSize: 12 }} />}
        placeholder="搜索标题或内容"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="search-filters">
        <Select
          className="search-select"
          size="small"
          value={timeRange}
          onChange={(value) => setTimeRange(value as 'all' | 'today' | '7d' | '30d')}
          options={[
            { value: "all", label: "全部时间" },
            { value: "today", label: "今天" },
            { value: "7d", label: "近 7 天" },
            { value: "30d", label: "近 30 天" },
          ]}
        />
        <Select
          className="search-select"
          size="small"
          value={sortBy}
          onChange={(value) => setSortBy(value as 'updated' | 'created')}
          options={[
            { value: "updated", label: "最近编辑" },
            { value: "created", label: "按创建时间" },
          ]}
        />
        <Select
          className="search-select"
          size="small"
          value={tagFilter ?? "all"}
          onChange={(value) => setTagFilter(value === "all" ? null : value)}
          options={[
            { value: "all", label: "全部标签" },
            ...tagOptions,
          ]}
        />
      </div>
    </div>
  );
}
