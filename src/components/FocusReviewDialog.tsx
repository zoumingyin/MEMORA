import { useState } from "react";
import { App as AntdApp, Button, Checkbox, Modal } from "antd";
import type { TodoEntry } from "../types/entry";
import { useEntryStore } from "../store/useEntryStore";

interface FocusReviewDialogProps {
  open: boolean;
  /** 番茄钟绑定的待办；为空时不渲染 */
  entry: TodoEntry | null;
  onClose: () => void;
}

/** 专注轮结束后勾选期间完成的子任务（只勾选，不新增/删除子任务） */
export function FocusReviewDialog({
  open,
  entry,
  onClose,
}: FocusReviewDialogProps) {
  const { message } = AntdApp.useApp();
  const updateEntry = useEntryStore((state) => state.updateEntry);
  // 由父组件在每次专注结束时重新挂载本组件，选择状态自然从空开始
  const [checked, setChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  if (!entry) return null;
  const pending = entry.items.filter((item) => !item.done);

  const apply = async (): Promise<void> => {
    if (checked.length === 0) return;
    setSaving(true);
    const items = entry.items.map((item) =>
      checked.includes(item.id) ? { ...item, done: true } : item
    );
    const allDone = items.length > 0 && items.every((item) => item.done);
    await updateEntry(entry.id, {
      items,
      done: allDone,
      completedAt: allDone ? Date.now() : null,
    });
    setSaving(false);
    message.success(`已勾选 ${checked.length} 项`);
    onClose();
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="专注完成"
      centered
      width="min(360px, calc(100vw - 24px))"
      footer={
        <>
          <Button onClick={onClose}>稍后处理</Button>
          <Button
            type="primary"
            loading={saving}
            disabled={checked.length === 0}
            onClick={() => void apply()}
          >
            勾选完成
          </Button>
        </>
      }
      destroyOnHidden
    >
      <div className="flex flex-col gap-2">
        <div className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          本轮专注结束。「{entry.title}」还有 {pending.length} 项未完成，勾选这期间做完的事项：
        </div>
        <div className="flex max-h-[260px] flex-col gap-1.5 overflow-auto pr-1">
          {pending.map((item) => (
            <Checkbox
              key={item.id}
              checked={checked.includes(item.id)}
              onChange={(event) =>
                setChecked((prev) =>
                  event.target.checked
                    ? [...prev, item.id]
                    : prev.filter((id) => id !== item.id)
                )
              }
            >
              <span className="break-words text-[12.5px]">{item.text}</span>
            </Checkbox>
          ))}
        </div>
      </div>
    </Modal>
  );
}
