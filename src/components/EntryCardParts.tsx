import { Popconfirm } from "antd";
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  PushpinFilled,
  PushpinOutlined,
} from "@ant-design/icons";
import type { Entry, TodoItem } from "../types/entry";

interface EntryToolsProps {
  entry: Entry;
  pinned: boolean;
  onEdit: (entry: Entry) => void;
  onTogglePin: (entry: Entry) => void;
  onCopy: (entry: Entry) => void;
  onRemove: (entry: Entry) => void;
}

/** 卡片工具条：置顶 / 编辑 / 复制 / 删除（贴纸墙与窄屏网格卡片共用） */
export function EntryTools({
  entry,
  pinned,
  onEdit,
  onTogglePin,
  onCopy,
  onRemove,
}: EntryToolsProps) {
  return (
    // 工具条内的点击（含 Popconfirm 弹层，React 事件会沿组件树冒泡）一律不传给卡片
    <span
      className="wall-note-tools"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`wall-note-tool wall-note-pin${pinned ? " is-pinned" : ""}`}
        title={pinned ? "取消置顶" : "置顶便签"}
        aria-label={pinned ? "取消置顶" : "置顶便签"}
        aria-pressed={pinned}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(entry);
        }}
      >
        {pinned ? <PushpinFilled /> : <PushpinOutlined />}
      </button>
      <button
        type="button"
        className="wall-note-tool"
        title="编辑便签"
        aria-label="编辑便签"
        onClick={(event) => {
          event.stopPropagation();
          onEdit(entry);
        }}
      >
        <EditOutlined />
      </button>
      <button
        type="button"
        className="wall-note-tool"
        title="复制内容"
        aria-label="复制内容"
        onClick={(event) => {
          event.stopPropagation();
          onCopy(entry);
        }}
      >
        <CopyOutlined />
      </button>
      <Popconfirm
        title="移入废纸篓"
        description="之后可在废纸篓恢复"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onConfirm={() => onRemove(entry)}
      >
        <button
          type="button"
          className="wall-note-tool wall-note-delete"
          title="移入废纸篓"
          aria-label="移入废纸篓"
          onClick={(event) => event.stopPropagation()}
        >
          <DeleteOutlined />
        </button>
      </Popconfirm>
    </span>
  );
}

interface TodoPreviewProps {
  items: TodoItem[];
  /** 最多展示的子任务数，超出显示 +N */
  limit: number;
}/** 待办子任务预览：贴纸墙与网格卡片共用同一套勾选样式 */
export function TodoPreview({ items, limit }: TodoPreviewProps) {
  return (
    <div className="todo-preview">
      {items.slice(0, limit).map((item) => (
        <span
          key={item.id}
          className={`todo-preview-item${item.done ? " is-done" : ""}`}
        >
          <span className="todo-preview-check" aria-hidden="true" />
          <span className="todo-preview-text">{item.text}</span>
        </span>
      ))}
      {items.length > limit && (
        <span className="todo-preview-more">+{items.length - limit} 项</span>
      )}
    </div>
  );
}

interface EntryTagsProps {
  tags: string[];
  /** 最多展示的标签数，超出显示 +N */
  limit?: number;
}

/** 卡片标签：贴纸墙页脚与网格卡片共用，超出数量折叠为 +N */
export function EntryTags({ tags, limit = 3 }: EntryTagsProps) {
  if (tags.length === 0) return null;
  return (
    <span className="block min-w-0 truncate text-[11px] text-[var(--text-muted)]">
      {tags.slice(0, limit).map((tag) => (
        <span key={tag} className="mr-[7px] opacity-85">
          #{tag}
        </span>
      ))}
      {tags.length > limit && (
        <span className="opacity-85">+{tags.length - limit}</span>
      )}
    </span>
  );
}
