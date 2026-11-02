import { Button, Empty, Popconfirm, message } from "antd";
import {
  ArrowLeftOutlined,
  BellOutlined,
  CheckSquareOutlined,
  DeleteOutlined,
  FileTextOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";
import { useEntryStore } from "../store/useEntryStore";
import { useUiStore } from "../store/useUiStore";
import { useViewport } from "../hooks/useViewport";
import type { Entry } from "../types/entry";
import { formatShort } from "../utils/format";

const KIND_LABEL: Record<Entry["kind"], string> = {
  note: "备忘",
  reminder: "提醒",
  todo: "待办",
};

const KIND_ICON: Record<Entry["kind"], ReactNode> = {
  note: <FileTextOutlined />,
  reminder: <BellOutlined />,
  todo: <CheckSquareOutlined />,
};

/** 卡片内正文摘要：剔除图片标记 / HTML / Markdown 符号 */
function previewText(entry: Entry): string {
  return entry.content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_~`-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface TrashPaneProps {
  /** 返回正常列表视图 */
  onBack: () => void;
  /** 抽屉内嵌：顶栏交给 Drawer，隐藏自带的返回 / 标题 / 清空 */
  embedded?: boolean;
}

/**
 * 废纸篓视图：替换左侧正常列表展示软删除条目。
 * 支持单条恢复 / 彻底删除（均带确认），以及一键清空。
 */
export function TrashPane({ onBack, embedded = false }: TrashPaneProps) {
  // 宽屏固定卡片；窄屏跟随笔记列表的网格 / 列表偏好
  const { isNarrow } = useViewport();
  const entryView = useUiStore((state) => state.entryView);
  const showCards = !isNarrow || entryView === "grid";
  const trash = useEntryStore((state) => state.trash);
  const restoreEntry = useEntryStore((state) => state.restoreEntry);
  const purgeEntry = useEntryStore((state) => state.purgeEntry);
  const emptyTrash = useEntryStore((state) => state.emptyTrash);

  const handleRestore = (id: string): void => {
    void restoreEntry(id).then(() => message.success("已恢复"));
  };

  const handlePurge = (id: string): void => {
    void purgeEntry(id).then(() => message.success("已彻底删除"));
  };

  const handleEmpty = (): void => {
    void emptyTrash().then(() => message.success("废纸篓已清空"));
  };

  return (
    <div
      className="flex w-full flex-1 min-h-0 flex-col"
      data-tauri-drag-region="false"
    >
      {/* 顶栏：返回 / 标题计数 / 清空（抽屉内由 Drawer 提供） */}
      {!embedded && (
        <div className="flex w-full shrink-0 items-center justify-between gap-2 px-1 pb-2">
          <button
            type="button"
            onClick={onBack}
            title="返回列表"
            className="flex shrink-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[12px] text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
          >
            <ArrowLeftOutlined className="text-[11px]" />
            <span>返回</span>
          </button>
          <span className="text-[12.5px] font-medium text-[var(--text)]">
            废纸篓（{trash.length}）
          </span>
          <Popconfirm
            title="清空废纸篓"
            description="将彻底删除全部条目，不可恢复"
            okText="清空"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={handleEmpty}
            disabled={trash.length === 0}
          >
            <Button type="text" danger size="small" disabled={trash.length === 0}>
              清空
            </Button>
          </Popconfirm>
        </div>
      )}

      {trash.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="废纸篓是空的" />
          <span className="text-xs color-muted">删除的条目会先移到这里</span>
        </div>
      ) : !showCards ? (
        <div className="flex w-full flex-1 min-h-0 flex-col gap-2 overflow-y-auto px-1 pb-2">
          {trash.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-2 rounded-[8px] bg-[var(--field)] px-2 py-1.5"
            >
              <span
                className="shrink-0 text-[13px] text-[var(--text-muted)]"
                aria-hidden="true"
              >
                {KIND_ICON[entry.kind]}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="min-w-0 truncate text-[12.5px] text-[var(--text)]">
                  {entry.title || "无标题"}
                </span>
                <span className="text-[11px] text-[var(--text-muted)]">
                  {KIND_LABEL[entry.kind]} · 删除于{" "}
                  {formatShort(entry.deletedAt ?? entry.updatedAt)}
                </span>
              </span>
              <Button
                type="text"
                size="small"
                className="icon-btn"
                title="恢复"
                icon={<UndoOutlined />}
                onClick={() => handleRestore(entry.id)}
              />
              <Popconfirm
                title="彻底删除"
                description="删除后不可恢复"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => handlePurge(entry.id)}
              >
                <Button
                  type="text"
                  danger
                  size="small"
                  className="icon-btn"
                  title="彻底删除"
                  icon={<DeleteOutlined />}
                />
              </Popconfirm>
            </div>
          ))}
        </div>
      ) : (
        <div
          className={`grid w-full flex-1 min-h-0 content-start overflow-y-auto px-1 pb-3 ${
            isNarrow
              ? "grid-cols-2 gap-2"
              : "grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3"
          }`}
        >
          {trash.map((entry) => (
            <div
              key={entry.id}
              className={`flex flex-col rounded-[14px] border border-solid border-[var(--border)] bg-[var(--card-bg)] ${
                isNarrow
                  ? "min-h-[148px] gap-1.5 p-[10px]"
                  : "min-h-[172px] gap-2 p-[14px]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-[13px]"
                  style={{
                    color: "var(--kind-accent)",
                    background:
                      "color-mix(in srgb, var(--kind-accent) 12%, transparent)",
                  }}
                  aria-hidden="true"
                >
                  {KIND_ICON[entry.kind]}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text)]">
                  {entry.title || "无标题"}
                </span>
              </div>
              <span
                className={`min-h-0 flex-1 leading-[1.5] text-[var(--text-muted)] ${
                  isNarrow
                    ? "line-clamp-3 text-[11.5px]"
                    : "line-clamp-4 text-[12px]"
                }`}
              >
                {previewText(entry) || "（无内容）"}
              </span>
              <div
                className={
                  isNarrow
                    ? "mt-auto flex flex-col gap-1"
                    : "mt-auto flex items-center justify-between gap-2"
                }
              >
                <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">
                  {KIND_LABEL[entry.kind]} · 删除于{" "}
                  {formatShort(entry.deletedAt ?? entry.updatedAt)}
                </span>
                <span
                  className={`flex shrink-0 items-center gap-0.5${isNarrow ? " self-end" : ""}`}
                >
                  <Button
                    type="text"
                    size="small"
                    className="icon-btn"
                    title="恢复"
                    icon={<UndoOutlined />}
                    onClick={() => handleRestore(entry.id)}
                  />
                  <Popconfirm
                    title="彻底删除"
                    description="删除后不可恢复"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handlePurge(entry.id)}
                  >
                    <Button
                      type="text"
                      danger
                      size="small"
                      className="icon-btn"
                      title="彻底删除"
                      icon={<DeleteOutlined />}
                    />
                  </Popconfirm>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
