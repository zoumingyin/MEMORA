import { Button, Modal, Select } from "antd";
import {
  CopyOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useRef, useState } from "react";
import { useEntryStore } from "../store/useEntryStore";
import { isTauriRuntime } from "../repository";
import type { EntryKind } from "../types/entry";

interface QuickCaptureProps {
  open: boolean;
  onClose: () => void;
}

const KIND_LABEL: Record<EntryKind, string> = {
  note: "备忘",
  reminder: "提醒",
  todo: "待办",
};

/** 读取剪贴板文本：Tauri 环境用插件，网页预览兜底 navigator.clipboard */
async function readClipboardText(): Promise<string> {
  if (isTauriRuntime()) {
    try {
      return await readText();
    } catch {
      return "";
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

/**
 * 快速记录：全局快捷键 Ctrl+Shift+N / 标题栏闪电按钮唤起。
 * 唤起时自动读取剪贴板文本预填（覆盖「选中文字后快速创建」场景）；输入一段文本一键入库。
 */
export function QuickCapture({ open, onClose }: QuickCaptureProps) {
  const currentKind = useEntryStore((state) => state.currentKind);
  const [kind, setKind] = useState<EntryKind>(() =>
    currentKind === "reminder" ? "note" : currentKind,
  );
  const [text, setText] = useState("");
  const [pasting, setPasting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 打开时自动聚焦并尝试从剪贴板预填（异步读外部剪贴板；输入框本身每次打开由 destroyOnHidden 重建）
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 120);
    void readClipboardText().then((clip) => {
      if (clip.trim()) setText((prev) => prev || clip.trim());
    });
    return () => window.clearTimeout(timer);
  }, [open]);

  const create = async () => {
    const raw = text.trim();
    if (!raw) return;
    const entry = await useEntryStore
      .getState()
      .addEntry({ title: "", content: raw }, kind);
    onClose();
    setText("");
    if (entry) {
      const store = useEntryStore.getState();
      store.setFilter(kind);
      store.setSelectedId(entry.id);
    }
  };

  const pasteClipboard = async () => {
    setPasting(true);
    const clip = await readClipboardText();
    setPasting(false);
    if (clip.trim()) setText((prev) => (prev ? `${prev}\n${clip}` : clip));
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      destroyOnHidden
      title={
        <span className="quick-capture-title">
          <ThunderboltOutlined /> 快速记录
        </span>
      }
      centered
      width={420}
      footer={[
        <Button key="paste" icon={<CopyOutlined />} onClick={() => void pasteClipboard()}>
          {pasting ? "读取中…" : "从剪贴板"}
        </Button>,
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="create"
          type="primary"
          icon={<PlusOutlined />}
          disabled={!text.trim()}
          onClick={() => void create()}
        >
          创建 {KIND_LABEL[kind]}
        </Button>,
      ]}
    >
      <div className="quick-capture-body">
        <textarea
          ref={textareaRef}
          className="quick-capture-input"
          placeholder="输入或粘贴内容，一键新建便签…（Ctrl+Shift+N 唤起）"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              void create();
            }
          }}
        />
        <div className="quick-capture-kind">
          <span>创建为</span>
          <Select
            size="small"
            value={kind}
            onChange={(value) => setKind(value as EntryKind)}
            options={(
              ["note", "reminder", "todo"] as EntryKind[]
            ).map((value) => ({ value, label: KIND_LABEL[value] }))}
          />
        </div>
      </div>
    </Modal>
  );
}
