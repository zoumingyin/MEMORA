import { Modal } from "antd";
import {
  BellOutlined,
  CheckSquareOutlined,
  EditOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";
import type { EntryKind } from "../types/entry";

interface CreateKindDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (kind: EntryKind) => void;
}

interface KindOption {
  kind: EntryKind;
  label: string;
  desc: string;
  icon: ReactNode;
}

/** 新建便签的类型选项（文案与入口处分类主题色一致） */
const KIND_OPTIONS: KindOption[] = [
  {
    kind: "note",
    label: "备忘",
    desc: "纯文本 / Markdown 编辑，自动统计字数",
    icon: <FileTextOutlined />,
  },
  {
    kind: "reminder",
    label: "提醒",
    desc: "闹钟时间 / 提醒模式 / 提醒方式",
    icon: <BellOutlined />,
  },
  {
    kind: "todo",
    label: "待办",
    desc: "子任务清单，完成后自动归档",
    icon: <CheckSquareOutlined />,
  },
  {
    kind: "draw",
    label: "涂鸦",
    desc: "手写画板，随手涂画 / 记草图",
    icon: <EditOutlined />,
  },
];

/**
 * 新建便签类型选择：点「+」新建时弹出，
 * 用户显式选择 备忘 / 提醒 / 待办 / 涂鸦 后创建对应类型条目并进入详情。
 */
export function CreateKindDialog({ open, onClose, onCreate }: CreateKindDialogProps) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="新建便签"
      centered
      footer={null}
      width={360}
    >
      <div className="create-kind-options">
        {KIND_OPTIONS.map((option) => (
          <button
            key={option.kind}
            type="button"
            className={`create-kind-option kind-${option.kind}`}
            onClick={() => onCreate(option.kind)}
          >
            <span className="create-kind-icon">{option.icon}</span>
            <span className="create-kind-text">
              <span className="create-kind-label">{option.label}</span>
              <span className="create-kind-desc">{option.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
