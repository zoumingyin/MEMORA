import { Modal, Switch, Tree } from "antd";
import type { TreeDataNode } from "antd";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  open as dialogOpen,
  save as dialogSave,
} from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../repository";
import { useWindowStore } from "../store/useWindowStore";
import { useEntryStore } from "../store/useEntryStore";
import type { Entry } from "../types/entry";
import {
  clearCloseBehavior,
  loadCloseBehavior,
  saveCloseBehavior,
  type CloseAction,
} from "../window/closeBehavior";
import { currentWorkArea, getBounds } from "../window/tauriWindow";
import { collapseToStrip, detectDockEdge } from "../window/edgeDock";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const CLOSE_ACTION_LABEL: { value: CloseAction | null; label: string }[] = [
  { value: null, label: "每次询问" },
  { value: "hide", label: "最小化" },
  { value: "quit", label: "退出应用" },
];

/** 设置树：分组 → 条目，左侧树导航（可折叠）、右侧内容区 */
interface SettingNode {
  key: string;
  label: string;
  hint: string;
}

interface SettingGroup {
  key: string;
  label: string;
  children: SettingNode[];
}

/** 设置树节点数据（antd Tree）：叶子 key 与内容区渲染一一对应 */
const SETTING_TREE: SettingGroup[] = [
  {
    key: "appearance",
    label: "外观",
    children: [
      {
        key: "opacity",
        label: "背景透明度",
        hint: "文字保持不透明，≤55% 自动切暗色",
      },
    ],
  },
  {
    key: "window",
    label: "窗口行为",
    children: [
      { key: "pin", label: "窗口置顶", hint: "常驻其他程序最上层" },
      { key: "edge", label: "边缘吸附", hint: "拖拽贴近屏幕边缘自动停靠" },
      { key: "collapse", label: "收纳到屏幕", hint: "收起为屏幕边缘窄条" },
      { key: "close", label: "关闭窗口时", hint: "点 X 或 Alt+F4 后的行为" },
    ],
  },
  {
    key: "startup",
    label: "启动与后台",
    children: [
      {
        key: "autostart",
        label: "开机自启动",
        hint: "登录 Windows 后自动启动",
      },
    ],
  },
  {
    key: "data",
    label: "数据管理",
    children: [
      { key: "export", label: "导出数据", hint: "全部条目导出为 JSON 文件" },
      {
        key: "import",
        label: "导入数据",
        hint: "从 JSON 合并导入，跳过重复条目",
      },
      {
        key: "backup",
        label: "备份数据库",
        hint: "完整复制 SQLite 数据库文件（桌面版）",
      },
      {
        key: "restore",
        label: "恢复数据库",
        hint: "用备份覆盖当前数据库，重启后生效",
      },
    ],
  },
];

/** 可折叠设置树的节点数据；仅叶子可被选中切换内容 */
const SETTING_TREE_DATA: TreeDataNode[] = SETTING_TREE.map((group) => ({
  key: group.key,
  title: group.label,
  children: group.children.map((node) => ({
    key: node.key,
    title: node.label,
  })),
}));

/** 叶子节点 key 集合（分组 key 不渲染内容） */
const SETTING_LEAF_KEYS = new Set(
  SETTING_TREE.flatMap((group) => group.children.map((node) => node.key))
);

/** 导出文件格式：版本 + 导出时间 + 全量条目 */
interface ExportFile {
  version: 1;
  exportedAt: number;
  entries: Entry[];
}

function isValidEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    (entry.kind === "note" ||
      entry.kind === "reminder" ||
      entry.kind === "todo") &&
    typeof entry.title === "string" &&
    typeof entry.content === "string" &&
    typeof entry.createdAt === "number" &&
    typeof entry.updatedAt === "number"
  );
}

function parseExportFile(raw: string): Entry[] {
  const parsed = JSON.parse(raw) as Partial<ExportFile>;
  if (
    !Array.isArray(parsed.entries) ||
    !parsed.entries.every((entry) => isValidEntry(entry))
  ) {
    throw new Error("文件格式不正确：不是有效的便签导出文件");
  }
  return parsed.entries as Entry[];
}

/**
 * 软件设置入口（标题栏齿轮按钮）：树形分组展示。
 * 外观 / 窗口行为（置顶、边缘吸附、收纳到屏幕边缘、关闭行为）/ 启动与后台 / 数据管理。
 * 边缘吸附与收纳到屏幕边缘自标题栏移入此处集中管理。
 * 关闭行为持久化 `bianqian.closeBehavior.v1`；开机自启动走 tauri-plugin-autostart。
 */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const { alwaysOnTop, opacity, edgeDocking } = useWindowStore();
  const { setAlwaysOnTop, setOpacity, setEdgeDocking, setDock } =
    useWindowStore();
  // 当前树节点：默认定位到「背景透明度」
  const [activeKey, setActiveKey] = useState("opacity");
  // 关闭窗口时的默认行为：null=每次询问；hide/quit=记住并直接执行
  const [closeAction, setCloseAction] = useState<CloseAction | null>(() => {
    const behavior = loadCloseBehavior();
    return behavior ? behavior.action : null;
  });
  // 开机自启动开关状态（仅 Tauri 环境可查询，默认关）
  const [autostart, setAutostart] = useState(false);
  // 数据管理操作结果提示（弹窗内文本，避免 portal 脱离主题）
  const [dataStatus, setDataStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // 预览环境（浏览器 localStorage）导入用的隐藏文件选择器
  const previewFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && isTauriRuntime()) {
      void isEnabled()
        .then(setAutostart)
        .catch(() => setAutostart(false));
    }
  }, [open]);

  /** 修改关闭行为：每次询问清除记忆，其余记住并直接执行 */
  const handleCloseBehavior = (action: CloseAction | null) => {
    setCloseAction(action);
    if (action === null) {
      clearCloseBehavior();
    } else {
      saveCloseBehavior({ action, remember: true });
    }
  };

  /** 开机自启动开关：写入/移除系统启动项 */
  const handleAutostart = async (value: boolean) => {
    setAutostart(value);
    if (!isTauriRuntime()) return;
    try {
      if (value) {
        await enable();
      } else {
        await disable();
      }
    } catch {
      setAutostart(!value);
    }
  };

  /** 导出全部条目为 JSON（桌面写文件 / 预览下载） */
  const handleExport = async () => {
    setBusy(true);
    setDataStatus("");
    try {
      const payload: ExportFile = {
        version: 1,
        exportedAt: Date.now(),
        entries: useEntryStore.getState().entries,
      };
      const raw = JSON.stringify(payload, null, 2);
      if (isTauriRuntime()) {
        const dest = await dialogSave({
          title: "导出便签数据",
          defaultPath: `bianqian-backup-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!dest) return;
        await invoke("write_entries_json", { path: dest, data: raw });
        setDataStatus(`已导出 ${payload.entries.length} 条到 ${dest}`);
      } else {
        const blob = new Blob([raw], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `bianqian-backup-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        setDataStatus(`已导出 ${payload.entries.length} 条（浏览器下载）`);
      }
    } catch (error) {
      setDataStatus(
        `导出失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusy(false);
    }
  };

  /** 导入 JSON 文件：按 id 合并，跳过已存在条目（预览环境先弹文件选择器） */
  const handleImport = async () => {
    setBusy(true);
    setDataStatus("");
    try {
      let raw: string | null = null;
      if (isTauriRuntime()) {
        const picked = await dialogOpen({
          title: "导入便签数据",
          multiple: false,
          directory: false,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!picked || Array.isArray(picked)) return;
        raw = await invoke<string>("read_entries_json", { path: picked });
      } else {
        // 预览环境：首次点击先唤起文件选择器，选中后 onChange 再进入此处
        if (!previewFileRef.current?.files?.[0]) {
          previewFileRef.current?.click();
          return;
        }
        const file = previewFileRef.current.files[0];
        raw = await file.text();
      }
      const entries = parseExportFile(raw ?? "");
      const imported = await useEntryStore.getState().importEntries(entries);
      setDataStatus(
        `导入完成：新增 ${imported} 条，跳过 ${entries.length - imported} 条重复`
      );
    } catch (error) {
      setDataStatus(
        `导入失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusy(false);
    }
  };

  /** 备份数据库：完整复制 SQLite 文件（仅桌面环境） */
  const handleBackupDb = async () => {
    setBusy(true);
    setDataStatus("");
    try {
      if (!isTauriRuntime()) {
        setDataStatus("数据库备份仅桌面版可用，预览环境请使用「导出数据」");
        return;
      }
      const dest = await dialogSave({
        title: "备份数据库",
        defaultPath: `bianqian-db-${new Date().toISOString().slice(0, 10)}.db`,
        filters: [{ name: "SQLite", extensions: ["db"] }],
      });
      if (!dest) return;
      await invoke("backup_db", { destPath: dest });
      setDataStatus(`数据库已备份到 ${dest}`);
    } catch (error) {
      setDataStatus(
        `备份失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusy(false);
    }
  };

  /** 恢复数据库：用备份文件覆盖当前 SQLite，重启后生效（仅桌面环境） */
  const handleRestoreDb = async () => {
    setBusy(true);
    setDataStatus("");
    try {
      if (!isTauriRuntime()) {
        setDataStatus("数据库恢复仅桌面版可用，预览环境请使用「导入数据」");
        return;
      }
      const picked = await dialogOpen({
        title: "从备份恢复",
        multiple: false,
        directory: false,
        filters: [{ name: "SQLite", extensions: ["db"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      await invoke("restore_db", { srcPath: picked });
      setDataStatus("数据库已恢复，重启应用后生效");
    } catch (error) {
      setDataStatus(
        `恢复失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusy(false);
    }
  };

  /** 收纳到屏幕边缘：收纳为窄条并关闭设置（原标题栏入口，已移入设置） */
  const handleCollapseToEdge = async () => {
    const bounds = await getBounds();
    if (!bounds) return;
    const workArea = await currentWorkArea();
    if (!workArea) return;
    let edge = useWindowStore.getState().dockedEdge;
    if (!edge) edge = detectDockEdge(bounds, workArea) ?? "right";
    setDock(edge, bounds, true);
    await collapseToStrip(edge, bounds, workArea);
    onClose();
  };

  /** 渲染当前选中节点的设置内容 */
  const renderContent = (key: string) => {
    switch (key) {
      case "opacity":
        return (
          <div className="settings-item grid">
            <div className="settings-item-main">
              <span className="settings-item-label">背景透明度</span>
              <span className="settings-item-hint">
                文字保持不透明，≤55% 自动切暗色
              </span>
            </div>
            <div className="settings-opacity-control">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(opacity * 100)}
                onChange={(event) =>
                  setOpacity(Number(event.target.value) / 100)
                }
              />
              <span className="settings-opacity-value">
                {Math.round(opacity * 100)}%
              </span>
            </div>
          </div>
        );
      case "pin":
        return (
          <div className="settings-item">
            <div className="settings-item-main">
              <span className="settings-item-label">窗口置顶</span>
              <span className="settings-item-hint">常驻其他程序最上层</span>
            </div>
            <Switch
              size="small"
              checked={alwaysOnTop}
              onChange={(value) => void setAlwaysOnTop(value)}
            />
          </div>
        );
      case "edge":
        return (
          <div className="settings-item">
            <div className="settings-item-main">
              <span className="settings-item-label">边缘吸附</span>
              <span className="settings-item-hint">
                拖拽贴近屏幕边缘自动停靠
              </span>
            </div>
            <Switch
              size="small"
              checked={edgeDocking}
              onChange={(value) => setEdgeDocking(value)}
            />
          </div>
        );
      case "collapse":
        return (
          <div className="settings-item grid">
            <div className="settings-item-main ">
              <span className="settings-item-label">收纳到屏幕边缘</span>
              <span className="settings-item-hint">
                收起为屏幕边缘窄条，点击窄条展开
              </span>
            </div>
            <button
              type="button"
              className="data-action-btn w-25"
              onClick={() => void handleCollapseToEdge()}
            >
              收纳
            </button>
          </div>
        );
      case "close":
        return (
          <div className="settings-item grid ">
            <div className="settings-item-main">
              <span className="settings-item-label">关闭窗口时</span>
              <span className="settings-item-hint">
                点 X 或 Alt+F4 后的行为
              </span>
            </div>
            <div className="close-behavior-options">
              {CLOSE_ACTION_LABEL.map(({ value, label }) => (
                <button
                  key={label}
                  type="button"
                  className={`close-behavior-option ${
                    closeAction === value ? "active" : ""
                  }`}
                  onClick={() => handleCloseBehavior(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        );
      case "autostart":
        return (
          <div className="settings-item">
            <div className="settings-item-main">
              <span className="settings-item-label">开机自启动</span>
              <span className="settings-item-hint">
                登录 Windows 后自动启动
              </span>
            </div>
            <Switch
              size="small"
              checked={autostart}
              onChange={(value) => void handleAutostart(value)}
            />
          </div>
        );
      case "export":
        return (
          <div className="settings-item grid">
            <div className="settings-item-main">
              <span className="settings-item-label">导出数据</span>
              <span className="settings-item-hint">
                全部条目导出为 JSON 文件
              </span>
            </div>
            <button
              type="button"
              className="data-action-btn w-25"
              disabled={busy}
              onClick={() => void handleExport()}
            >
              导出
            </button>
          </div>
        );
      case "import":
        return (
          <div className="settings-item grid">
            <div className="settings-item-main">
              <span className="settings-item-label">导入数据</span>
              <span className="settings-item-hint">
                从 JSON 合并导入，跳过重复条目
              </span>
            </div>
            <button
              type="button"
              className="data-action-btn w-25"
              disabled={busy}
              onClick={() => void handleImport()}
            >
              导入
            </button>
          </div>
        );
      case "backup":
        return (
          <div className="settings-item grid">
            <div className="settings-item-main">
              <span className="settings-item-label">备份数据库</span>
              <span className="settings-item-hint">
                完整复制 SQLite 数据库文件（桌面版）
              </span>
            </div>
            <button
              type="button"
              className="data-action-btn w-25"
              disabled={busy}
              onClick={() => void handleBackupDb()}
            >
              备份
            </button>
          </div>
        );
      case "restore":
        return (
          <div className="settings-item grid">
            <div className="settings-item-main">
              <span className="settings-item-label">恢复数据库</span>
              <span className="settings-item-hint">
                用备份覆盖当前数据库，重启后生效
              </span>
            </div>
            <button
              type="button"
              className="data-action-btn danger w-25"
              disabled={busy}
              onClick={() => void handleRestoreDb()}
            >
              恢复
            </button>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="设置"
      centered
      footer={null}
      width={560}
    >
      <div className="settings-tree">
        <div className="settings-tree-nav">
          <Tree
            showLine
            defaultExpandAll
            blockNode
            selectedKeys={[activeKey]}
            onSelect={(keys) => {
              const key = keys[0] as string | undefined;
              if (key && SETTING_LEAF_KEYS.has(key)) setActiveKey(key);
            }}
            treeData={SETTING_TREE_DATA}
          />
        </div>
        <div className="settings-tree-content">
          {renderContent(activeKey)}
          {dataStatus && <div className="data-status">{dataStatus}</div>}
        </div>
      </div>
      {/* 预览环境（浏览器 localStorage）导入用的隐藏文件选择器 */}
      <input
        ref={previewFileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={() => void handleImport()}
      />
    </Modal>
  );
}
