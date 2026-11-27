import {
  AutoComplete,
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Tree,
} from "antd";
import type { InputRef, TreeDataNode } from "antd";
import { ExportOutlined, SyncOutlined } from "@ant-design/icons";
import { disable, enable } from "@tauri-apps/plugin-autostart";
import { getVersion } from "@tauri-apps/api/app";
import { Progress } from "antd";
import {
  open as dialogOpen,
  save as dialogSave,
} from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../repository";
import { closeDatabase, resetDatabaseCache } from "../repository/db";
import { flushActiveEditor } from "../editor/editorRegistry";
import { useWindowStore } from "../store/useWindowStore";
import { useEntryStore } from "../store/useEntryStore";
import { useAssistantStore } from "../store/useAssistantStore";
import { useAiProfileStore } from "../store/useAiProfileStore";
import { FreeBadge } from "./FreeBadge";
import { ModalityBadge } from "./ModalityBadge";
import { TagManager } from "./TagManager";
import { AutoBackupSetting } from "./AutoBackupSetting";
import { BrandLogo } from "./BrandLogo";
import { ThemeModePicker } from "./ThemeModePicker";
import {
  isNonTextModality,
  type AiFreeSource,
  type AiProfileInput,
  type AiProfileStatus,
  type ReasoningEffort,
} from "../types/ai";
import {
  clearAiKey,
  deleteAiProfile,
  isLocalBaseUrl,
  listModels,
  saveAiProfile,
  testAiConnection,
} from "../services/aiClient";
import type { Entry } from "../types/entry";
import {
  readSummaryLastRun,
  readSummarySettings,
  readSummaryStatus,
  runSummary,
  WEEKDAY_LABELS,
  writeSummarySettings,
  type SummaryLastRun,
  type SummaryMode,
  type SummarySettings,
} from "../services/dailySummary";
import { currentWorkArea, getBounds } from "../window/tauriWindow";
import { collapseToStripAnimated, detectDockEdge } from "../window/edgeDock";
import { openExternal } from "../utils/openExternal";
import { formatShort } from "../utils/format";
import {
  loadCloseBehavior,
  saveCloseBehavior,
  type CloseBehavior,
} from "../window/closeBehavior";
import {
  checkForUpdate,
  downloadAndInstall,
  relaunch,
} from "../services/updater";
import type { Update } from "@tauri-apps/plugin-updater";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** 打开时定位的叶子设置页（AI 助手「去设置」跳转用） */
  initialSection?: string | null;
}

/**
 * AI 服务预设：选择后自动填入接口地址与默认模型；模型名可自由修改
 */
const AI_PRESETS: {
  label: string;
  baseUrl: string;
  model: string;
  models: string[];
}[] = [
  {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    label: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    models: [
      "moonshot-v1-8k",
      "moonshot-v1-32k",
      "moonshot-v1-128k",
      "kimi-latest",
    ],
  },
  {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
  },
  {
    label: "通义千问（兼容模式）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long"],
  },
  {
    // 火山引擎方舟 OpenAI 兼容接口；模型也可填控制台的推理接入点 ID（ep-xxx）
    label: "火山引擎（方舟）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-1-6-250615",
    models: [
      "doubao-seed-1-6-250615",
      "doubao-1-5-pro-32k-250115",
      "doubao-1-5-lite-32k-250115",
    ],
  },
  {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    models: ["glm-4-flash", "glm-4-air", "glm-4-plus"],
  },
  {
    label: "Ollama（本地）",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    models: ["qwen2.5:7b", "qwen2.5:14b", "llama3.1:8b", "deepseek-r1:7b"],
  },
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
        key: "theme",
        label: "主题模式",
        hint: "浅色 / 深色 / 跟随系统",
      },
      {
        key: "opacity",
        label: "背景透明度",
        hint: "仅调整背景透明程度，不影响主题",
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
      { key: "shortcut", label: "全局快捷键", hint: "任意应用下生效" },
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
      {
        key: "close-behavior",
        label: "关闭窗口时",
        hint: "每次询问 / 最小化到托盘 / 退出并停止提醒",
      },
    ],
  },
  {
    key: "assistant",
    label: "AI 助手",
    children: [
      {
        key: "ai-config",
        label: "接入配置",
        hint: "管理多个模型配置与 API 密钥",
      },
      {
        key: "ai-privacy",
        label: "上下文",
        hint: "控制 AI 可读取的便签内容",
      },
      {
        key: "ai-summary",
        label: "日 / 周总结",
        hint: "定时用 AI 生成总结便签",
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
      {
        key: "tags",
        label: "标签管理",
        hint: "重命名 / 合并 / 删除全部标签",
      },
      {
        key: "auto-backup",
        label: "自动备份",
        hint: "每日备份数据库并保留最近 7 份",
      },
    ],
  },
  {
    key: "about",
    label: "关于",
    children: [
      {
        key: "update",
        label: "软件更新",
        hint: "在线检查并安装新版本",
      },
      {
        key: "about-info",
        label: "关于与友链",
        hint: "应用说明与友情链接",
      },
    ],
  },
];

/** 友情链接：NexHubStudio（作者主页） */
const FRIEND_LINK = {
  name: "NexHubStudio",
  url: "https://gitee.com/zoumingyin/NexHubStudio",
};

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

/** 总结生成时间候选：每 30 分钟一档 */
const SUMMARY_TIME_OPTIONS = Array.from({ length: 48 }, (_, index) => {
  const h = `${Math.floor(index / 2)}`.padStart(2, "0");
  const m = index % 2 === 0 ? "00" : "30";
  return { value: `${h}:${m}`, label: `${h}:${m}` };
});

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
      entry.kind === "todo" ||
      entry.kind === "draw") &&
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

/** 备份文件元数据（与后端 BackupMetadata 同构） */
interface BackupMetadata {
  kind: string;
  programVersion: string;
  schemaVersion: number;
  backupAt: number;
  backupAtText: string;
  localDate: string;
  sourcePath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  quickCheck: string;
  integrityCheck: string;
  requiredTables: boolean;
  journalMode: string;
  walHandled: string;
  valid: boolean;
}

interface RestoreResult {
  backup: BackupMetadata;
  preRestoreSnapshot: string | null;
  schemaVersion: number;
}

function describeBackup(meta: BackupMetadata): string {
  const sizeKb = Math.max(1, Math.round(meta.sizeBytes / 1024));
  const checks =
    meta.valid && meta.requiredTables
      ? "校验通过"
      : `校验异常（quick=${meta.quickCheck}，integrity=${meta.integrityCheck}）`;
  return `schema v${meta.schemaVersion}，${sizeKb} KB，SHA256 ${meta.sha256.slice(0, 12)}…，${checks}，WAL：${meta.walHandled}`;
}

/** 软件更新设置：在线检查 → 下载（带进度）→ 安装重启 */
function UpdateSetting() {
  const [currentVersion, setCurrentVersion] = useState("");
  const [phase, setPhase] = useState<
    "idle" | "checking" | "available" | "latest" | "downloading" | "installing"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{
    version: string;
    body?: string;
    currentVersion: string;
  } | null>(null);
  const [progress, setProgress] = useState<{
    downloaded: number;
    total: number;
  } | null>(null);
  const updateRef = useRef<Update | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setCurrentVersion("浏览器预览");
      return;
    }
    getVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion("未知"));
    return () => {
      // Update 持有 Rust 侧资源：不安装也要释放
      void updateRef.current?.close().catch(() => undefined);
    };
  }, []);

  const handleCheck = async (): Promise<void> => {
    setError(null);
    setPhase("checking");
    try {
      const update = await checkForUpdate();
      if (update) {
        updateRef.current = update;
        setInfo({
          version: update.version,
          body: update.body,
          currentVersion: update.currentVersion,
        });
        setPhase("available");
      } else {
        setPhase("latest");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  };

  const handleInstall = async (): Promise<void> => {
    const update = updateRef.current;
    if (!update) return;
    setError(null);
    setPhase("downloading");
    let downloaded = 0;
    let total = 0;
    try {
      await downloadAndInstall(update, (progress) => {
        if (progress.event === "started") {
          total = progress.totalBytes ?? 0;
          setProgress({ downloaded: 0, total });
        } else if (progress.event === "progress") {
          downloaded += progress.chunkLength ?? 0;
          setProgress({ downloaded, total });
        } else {
          setProgress({ downloaded: total, total });
        }
      });
      setPhase("installing");
      // Windows NSIS 静默安装包默认 restartAfterInstall；此处兜底重启
      setTimeout(() => void relaunch(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("available");
    }
  };

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="settings-item">
        <div className="settings-item-main">
          <span className="settings-item-label">当前版本</span>
          <span className="settings-item-hint">
            {currentVersion ? `MEMORA v${currentVersion}` : "读取中…"}
          </span>
        </div>
        <Button
          size="small"
          icon={<SyncOutlined spin={phase === "checking"} />}
          disabled={
            !isTauriRuntime() ||
            phase === "checking" ||
            phase === "downloading" ||
            phase === "installing"
          }
          onClick={() => void handleCheck()}
        >
          检查更新
        </Button>
      </div>
      {phase === "latest" && (
        <div className="settings-item">
          <div className="settings-item-main">
            <span className="settings-item-label">已是最新版本</span>
            <span className="settings-item-hint">当前没有可用更新</span>
          </div>
        </div>
      )}
      {phase === "available" && info && (
        <div className="settings-item grid gap-2">
          <div className="settings-item-main">
            <span className="settings-item-label">
              发现新版本 v{info.version}（当前 v{info.currentVersion}）
            </span>
            {info.body && (
              <span className="settings-item-hint whitespace-pre-wrap break-all">
                {info.body}
              </span>
            )}
          </div>
          <Button type="primary" size="small" onClick={() => void handleInstall()}>
            下载并安装
          </Button>
        </div>
      )}
      {(phase === "downloading" || phase === "installing") && (
        <div className="settings-item grid gap-1">
          <span className="settings-item-label">
            {phase === "downloading"
              ? `正在下载更新… ${
                  progress && progress.total > 0
                    ? `${(progress.downloaded / 1024 / 1024).toFixed(1)} / ${(progress.total / 1024 / 1024).toFixed(1)} MB`
                    : ""
                }`
              : "安装完成，即将重启应用…"}
          </span>
          {phase === "downloading" && progress && progress.total > 0 && (
            <Progress percent={pct} size="small" />
          )}
        </div>
      )}
      {error && (
        <div className="settings-item">
          <div className="settings-item-main">
            <span className="settings-item-label">检查更新失败</span>
            <span className="settings-item-hint break-all">{error}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** 关闭窗口行为设置：每次询问 / 记住最小化到托盘 / 记住退出并停止提醒 */
function CloseBehaviorSetting() {
  const [value, setValue] = useState<CloseBehavior | "ask">(
    () => loadCloseBehavior() ?? "ask"
  );
  return (
    <div className="settings-item grid">
      <div className="settings-item-main">
        <span className="settings-item-label">关闭窗口行为</span>
        <span className="settings-item-hint">
          最小化到托盘会继续提醒；退出会停止全部提醒
        </span>
      </div>
      <Select
        size="small"
        style={{ width: 128 }}
        value={value}
        onChange={(next: CloseBehavior | "ask") => {
          setValue(next);
          saveCloseBehavior(next === "ask" ? null : next);
        }}
        options={[
          { value: "ask", label: "每次询问" },
          { value: "tray", label: "最小化到托盘" },
          { value: "exit", label: "退出并停止提醒" },
        ]}
      />
    </div>
  );
}

/**
 * 软件设置入口（标题栏齿轮按钮）：树形分组展示。
 * 外观 / 窗口行为（置顶、边缘吸附、收纳到屏幕边缘）/ 启动与后台 / 数据管理。
 * 边缘吸附与收纳到屏幕边缘自标题栏移入此处集中管理。
 * 关闭窗口固定隐藏到系统托盘（Rust 端拦截实现）；开机自启动走 tauri-plugin-autostart。
 */
export function SettingsDialog({
  open,
  onClose,
  initialSection,
}: SettingsDialogProps) {
  const { alwaysOnTop, opacity, edgeDocking } = useWindowStore();
  const { setAlwaysOnTop, setOpacity, setEdgeDocking } = useWindowStore();
  // 当前树节点：默认「主题」；由「去设置」跳转时直接定位到目标页
  const [activeKey, setActiveKey] = useState(() =>
    initialSection && SETTING_LEAF_KEYS.has(initialSection)
      ? initialSection
      : "theme"
  );
  // 开机自启动开关状态（仅 Tauri 环境可查询，默认关）
  const [autostart, setAutostart] = useState(false);
  // 数据管理操作结果提示（弹窗内文本，避免 portal 脱离主题）
  const [dataStatus, setDataStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // 预览环境（浏览器 localStorage）导入用的隐藏文件选择器
  const previewFileRef = useRef<HTMLInputElement>(null);

  // ===== AI 助手配置（多模型） =====
  const aiStatus = useAiProfileStore((state) => state.status);
  const aiLoading = useAiProfileStore((state) => state.loading);
  const aiLoad = useAiProfileStore((state) => state.load);
  const aiActivate = useAiProfileStore((state) => state.activate);
  const aiSync = useAiProfileStore((state) => state.sync);
  // 表单：null 表示新增，否则编辑该配置；表单在弹窗中展示
  const [aiEditingId, setAiEditingId] = useState<string | null>(null);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [aiName, setAiName] = useState("");
  const [aiNameTouched, setAiNameTouched] = useState(false);
  const [aiProvider, setAiProvider] = useState(AI_PRESETS[0].label);
  const [aiBaseUrl, setAiBaseUrl] = useState(AI_PRESETS[0].baseUrl);
  const [aiModel, setAiModel] = useState(AI_PRESETS[0].model);
  const [aiReasoning, setAiReasoning] = useState<ReasoningEffort | "">("low");
  const [aiKey, setAiKey] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessage, setAiMessage] = useState("");
  // 免费来源密钥：按来源保存输入草稿，保存成功后清空（只展示掩码）
  const [aiRemoteModels, setAiRemoteModels] = useState<string[]>([]);
  const [aiModelHint, setAiModelHint] = useState("");
  const [aiLoadingModels, setAiLoadingModels] = useState(false);
  const baseUrlRef = useRef<InputRef>(null);
  const modelRequestSeq = useRef(0);
  const aiContextEnabled = useAssistantStore((state) => state.contextEnabled);
  const setAiContextEnabled = useAssistantStore(
    (state) => state.setContextEnabled
  );
  const entryCount = useEntryStore((state) => state.entries.length);
  const [summarySettings, setSummarySettings] = useState<SummarySettings>(() =>
    readSummarySettings()
  );
  const [summaryLastRun, setSummaryLastRun] = useState<SummaryLastRun>(() =>
    readSummaryLastRun()
  );
  const [summaryBusy, setSummaryBusy] = useState<SummaryMode | null>(null);
  const [summaryMessage, setSummaryMessage] = useState("");
  const [summaryStatus, setSummaryStatus] = useState(() => readSummaryStatus());
  // TitleBar 用 key 控制开关重挂载：useState 初始化器每次打开都会重读本地值，
  // 无需再写 open effect；手动生成后由 handleManualSummary 刷新 last-run。

  /** 更新总结设置并立即落盘（调度器每轮直接读 localStorage） */
  const updateSummarySettings = (patch: Partial<SummarySettings>) => {
    setSummarySettings((prev) => {
      const next = { ...prev, ...patch };
      writeSummarySettings(next);
      return next;
    });
  };

  /** 手动生成一次总结；去重逻辑与服务端一致（同日/同周只生成一次） */
  const handleManualSummary = async (mode: SummaryMode) => {
    setSummaryBusy(mode);
    setSummaryMessage("");
    try {
      await runSummary(mode);
      setSummaryLastRun(readSummaryLastRun());
      setSummaryMessage(
        mode === "daily" ? "日总结已生成，可在便签列表查看。" : "周总结已生成，可在便签列表查看。"
      );
    } catch (error) {
      setSummaryMessage(
        error instanceof Error ? error.message : "生成失败，请稍后重试。"
      );
    } finally {
      setSummaryBusy(null);
      setSummaryStatus(readSummaryStatus());
    }
  };

  const aiProfiles = aiStatus?.profiles ?? [];
  const editingProfile = aiEditingId
    ? (aiProfiles.find((profile) => profile.id === aiEditingId) ?? null)
    : null;
  const activeProfile =
    aiProfiles.find((profile) => profile.id === aiStatus?.activeId) ?? null;
  const customProfiles = aiProfiles.filter((profile) => !profile.free);
  const freeProfiles = aiProfiles.filter((profile) => profile.free);
  // 免费模型按来源分组：模型清单一律由后端运行时获取，这里只按来源归属
  const freeGroups = (aiStatus?.freeSources ?? []).map((source) => ({
    ...source,
    items: freeProfiles.filter((profile) => profile.source === source.source),
  }));
  const FREE_SOURCE_LABELS: Record<
    AiFreeSource["status"],
    { text: string; className: string }
  > = {
    ok: { text: "实时", className: "text-[var(--text-muted)]" },
    cached: { text: "缓存", className: "text-[var(--text-muted)]" },
    fallback: { text: "兜底", className: "text-[var(--text-muted)]" },
    unavailable: { text: "不可用", className: "text-[var(--danger)]" },
  };
  // 服务商下拉值：已保存的自定义服务名不在预设内时统一显示为「自定义服务」
  const aiProviderValue = AI_PRESETS.some(
    (preset) => preset.label === aiProvider
  )
    ? aiProvider
    : "自定义服务";
  const aiKeyPlaceholder = editingProfile?.keyMasked
    ? `已保存 ${editingProfile.keyMasked}，留空表示不修改`
    : isLocalBaseUrl(aiBaseUrl)
      ? "本机服务通常无需密钥，可留空"
      : "sk-…";

  // 模型候选：官方 /models 接口结果 + 预设内置建议（去重，接口结果优先）
  const matchedPreset = AI_PRESETS.find(
    (preset) => preset.baseUrl === aiBaseUrl.trim().replace(/\/+$/, "")
  );
  const aiModelOptions = Array.from(
    new Set([...aiRemoteModels, ...(matchedPreset?.models ?? [])])
  ).map((value) => ({ value }));

  /** 拉取官方模型列表；失败时保留内置建议并提示可手动输入 */
  const loadRemoteModels = useCallback(async (input: AiProfileInput) => {
    const seq = modelRequestSeq.current + 1;
    modelRequestSeq.current = seq;
    setAiLoadingModels(true);
    try {
      const models = await listModels(input);
      if (modelRequestSeq.current !== seq) return;
      setAiRemoteModels(models);
      setAiModelHint(`已从官方接口获取 ${models.length} 个模型`);
    } catch (error) {
      if (modelRequestSeq.current !== seq) return;
      setAiRemoteModels([]);
      setAiModelHint("未能从官方接口获取模型列表，已保留本地建议，可手动输入");
      console.warn("获取模型列表失败", error);
    } finally {
      if (modelRequestSeq.current === seq) setAiLoadingModels(false);
    }
  }, []);

  /** 地址 + 密钥可用时自动拉取；密钥未填写且服务需要鉴权时只给提示 */
  const refreshModelsIfPossible = (
    baseUrl: string,
    model: string,
    target: AiProfileStatus | null = editingProfile
  ) => {
    if (!baseUrl.trim()) return;
    if (!aiKey.trim() && !target?.keyMasked && !isLocalBaseUrl(baseUrl)) {
      setAiRemoteModels([]);
      setAiModelHint("填写 API 密钥后可从官方接口获取模型列表");
      return;
    }
    void loadRemoteModels({
      id: target?.id,
      baseUrl,
      model,
      apiKey: aiKey.trim() || undefined,
    });
  };

  /** 表单重置为新增模式：默认填入第一个预设，显示名称默认取模型名 */
  const resetAiForm = () => {
    setAiEditingId(null);
    setAiName(AI_PRESETS[0].model);
    setAiNameTouched(false);
    setAiProvider(AI_PRESETS[0].label);
    setAiBaseUrl(AI_PRESETS[0].baseUrl);
    setAiModel(AI_PRESETS[0].model);
    setAiReasoning("");
    setAiKey("");
    setAiRemoteModels([]);
    setAiModelHint("");
  };

  const openAddDialog = () => {
    resetAiForm();
    setAiMessage("");
    setAiDialogOpen(true);
  };

  const closeAiDialog = () => {
    setAiDialogOpen(false);
    resetAiForm();
    setAiMessage("");
  };

  /** 模型变化时，未自定义的显示名称跟随模型名 */
  const handleModelChange = (value: string) => {
    const previous = aiModel;
    setAiModel(value);
    if (!aiNameTouched || !aiName.trim() || aiName === previous) {
      setAiName(value);
    }
  };

  // 每次打开时读取配置列表（只同步状态，表单保持当前编辑内容）
  useEffect(() => {
    if (!open) return;
    void aiLoad().catch(() => undefined);
    return () => {
      modelRequestSeq.current += 1;
    };
  }, [open, aiLoad]);

  const handleAiSave = async () => {
    const baseUrl = aiBaseUrl.trim();
    const model = aiModel.trim();
    if (!baseUrl) {
      setAiMessage("请填写接口地址（Base URL）");
      baseUrlRef.current?.focus();
      return;
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      setAiMessage("接口地址需以 http:// 或 https:// 开头");
      baseUrlRef.current?.focus();
      return;
    }
    if (!model) {
      setAiMessage("请填写模型名称");
      return;
    }
    if (
      !aiKey.trim() &&
      !editingProfile?.keyMasked &&
      !isLocalBaseUrl(baseUrl)
    ) {
      setAiMessage("请填写 API 密钥（本机服务可留空）");
      return;
    }

    setAiBusy(true);
    setAiMessage("");
    const knownIds = new Set(aiProfiles.map((profile) => profile.id));
    try {
      const status = await saveAiProfile({
        id: aiEditingId ?? undefined,
        name: aiName.trim() || undefined,
        provider: aiProvider,
        baseUrl,
        model,
        apiKey: aiKey.trim() || undefined,
        reasoning: aiReasoning || "",
      });
      aiSync(status);
      const savedId =
        aiEditingId ??
        status.profiles.find((profile) => !knownIds.has(profile.id))?.id ??
        status.activeId;
      const saved = status.profiles.find((profile) => profile.id === savedId);
      setAiDialogOpen(false);
      resetAiForm();
      setAiMessage(
        saved?.configured
          ? `已保存「${saved.name}」，可在对话界面的模型选择器中切换使用`
          : "已保存，但还缺少 API 密钥（本机服务可忽略此项）"
      );
      if (saved?.configured) {
        void loadRemoteModels({
          id: saved.id,
          baseUrl: saved.baseUrl,
          model: saved.model,
        });
      }
    } catch (error) {
      setAiMessage(
        `保存失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setAiBusy(false);
    }
  };

  const handleAiTest = async () => {
    if (!aiBaseUrl.trim() || !aiModel.trim()) {
      setAiMessage("请先填写接口地址与模型名称");
      return;
    }
    setAiBusy(true);
    setAiMessage("正在测试连接…");
    try {
      const result = await testAiConnection({
        id: aiEditingId ?? undefined,
        baseUrl: aiBaseUrl,
        model: aiModel,
        apiKey: aiKey.trim() || undefined,
      });
      setAiMessage(result);
    } catch (error) {
      setAiMessage(
        `测试失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setAiBusy(false);
    }
  };

  /** 开始编辑一条已保存配置（密钥只回显掩码，输入框留空） */
  const startEditProfile = (profile: AiProfileStatus) => {
    setAiEditingId(profile.id);
    setAiName(profile.name);
    setAiNameTouched(true);
    setAiProvider(profile.provider);
    setAiBaseUrl(profile.baseUrl);
    setAiModel(profile.model);
    setAiReasoning(profile.reasoning ?? "");
    setAiKey("");
    setAiRemoteModels([]);
    setAiModelHint("");
    setAiMessage("");
    setAiDialogOpen(true);
    refreshModelsIfPossible(profile.baseUrl, profile.model, profile);
  };

  /** 切换对话使用的模型配置 */
  const handleActivateProfile = async (profile: AiProfileStatus) => {
    if (aiStatus?.activeId === profile.id) return;
    try {
      await aiActivate(profile.id);
      setAiMessage(`已切换到 ${profile.provider} · ${profile.model}`);
    } catch (error) {
      setAiMessage(
        `切换失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleDeleteProfile = async (profile: AiProfileStatus) => {
    setAiBusy(true);
    setAiMessage("");
    try {
      const status = await deleteAiProfile(profile.id);
      aiSync(status);
      if (aiEditingId === profile.id) resetAiForm();
      setAiMessage(`已删除 ${profile.provider} · ${profile.model}`);
    } catch (error) {
      setAiMessage(
        `删除失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setAiBusy(false);
    }
  };

  const handleAiClearKey = async () => {
    if (!editingProfile) return;
    setAiBusy(true);
    setAiMessage("");
    try {
      const status = await clearAiKey(editingProfile.id);
      aiSync(status);
      setAiMessage(
        isTauriRuntime()
          ? "已清除该配置保存在本机的密钥"
          : "已清除该配置保存在本浏览器的密钥"
      );
    } catch (error) {
      setAiMessage(
        `清除失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setAiBusy(false);
    }
  };

  /** 服务商下拉：选中预设时自动填入接口地址与默认模型（显示名称跟随模型名） */
  const applyAiPreset = (label: string) => {
    setAiProvider(label);
    const preset = AI_PRESETS.find((item) => item.label === label);
    if (!preset) return;
    setAiBaseUrl(preset.baseUrl);
    handleModelChange(preset.model);
    setAiMessage("");
    setAiRemoteModels([]);
    setAiModelHint("");
    refreshModelsIfPossible(preset.baseUrl, preset.model);
  };

  useEffect(() => {
    if (open && isTauriRuntime()) {
      // 用 Rust 命令读取真实开关：插件 isEnabled 在 Windows 非管理员下读 HKLM 会抛错而失效
      void invoke<boolean>("get_autostart_enabled")
        .then(setAutostart)
        .catch(() => setAutostart(false));
    }
  }, [open]);

  // 监听托盘菜单切换「开机自启动」：实时同步设置页开关，无需重开弹窗
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const promise = listen<boolean>("autostart:changed", (event) => {
      setAutostart(event.payload);
    });
    return () => {
      void promise.then((unlisten) => unlisten());
    };
  }, []);

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
      // 回传新状态，让托盘菜单勾选态实时同步（Rust 只更新勾选视觉，不重复 enable/disable）
      if (isTauriRuntime()) void emit("autostart:set", { enabled: value });
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

  /** 备份数据库：VACUUM INTO 一致性快照 + 完整性校验 + 元数据，仅桌面环境 */
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
      const meta = await invoke<BackupMetadata>("backup_db", {
        destPath: dest,
      });
      if (!meta.valid || !meta.requiredTables) {
        setDataStatus(
          `备份文件未通过校验，请勿用于恢复：${describeBackup(meta)}`
        );
        return;
      }
      setDataStatus(`数据库已备份到 ${dest}（${describeBackup(meta)}）`);
    } catch (error) {
      setDataStatus(
        `备份失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusy(false);
    }
  };

  /** 恢复数据库：先落盘并关闭连接，后端校验 + 恢复前快照 + 原子替换，失败自动回退 */
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
      const saved = await flushActiveEditor();
      if (!saved) {
        setDataStatus("恢复已取消：当前便签尚未保存，请先处理保存失败");
        return;
      }
      await closeDatabase();
      try {
        const result = await invoke<RestoreResult>("restore_db", {
          srcPath: picked,
        });
        resetDatabaseCache();
        await useEntryStore.getState().loadAll();
        setDataStatus(
          `数据库已恢复（schema v${result.schemaVersion}，${describeBackup(
            result.backup
          )}）；恢复前快照：${result.preRestoreSnapshot ?? "无"}`
        );
      } catch (error) {
        // 恢复失败时后端已回退原库：重新打开连接并重载，界面不留在空数据状态
        resetDatabaseCache();
        await useEntryStore.getState().retryLoad().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      setDataStatus(
        `恢复失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBusy(false);
    }
  };

  /** 收纳到屏幕边缘：带出场动画收为窄条并关闭设置（原标题栏入口，已移入设置） */
  const handleCollapseToEdge = async () => {
    const bounds = await getBounds();
    if (!bounds) return;
    const workArea = await currentWorkArea();
    if (!workArea) return;
    if (useWindowStore.getState().collapsing) return;
    let edge = useWindowStore.getState().dockedEdge;
    if (!edge) edge = detectDockEdge(bounds, workArea) ?? "right";
    const started = await collapseToStripAnimated(edge, bounds, workArea);
    // 持锁被拒：回滚收纳态，保持展开原状
    if (!started) useWindowStore.getState().setDock(edge, bounds, false);
    onClose();
  };

  /** 渲染当前选中节点的设置内容 */
  const renderContent = (key: string) => {
    switch (key) {
      case "theme":
        return (
          <div className="settings-item grid">
            <div className="settings-item-main">
              <span className="settings-item-label">主题模式</span>
              <span className="settings-item-hint">
                浅色 / 深色 / 跟随系统，全部窗口同步生效
              </span>
            </div>
            <ThemeModePicker />
          </div>
        );
      case "opacity":
        return (
          <div className="settings-item grid">
            <div className="settings-item-main">
              <span className="settings-item-label">背景透明度</span>
              <span className="settings-item-hint">
                仅调整背景透明程度，不影响主题
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
                拖到屏幕边缘松手自动收成窄条，移入窄条即展开
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
      case "shortcut":
        return (
          <div className="flex flex-col">
            <div className="mb-1 mt-1 text-[11px] font-600 text-[var(--text-muted)]">
              全局快捷键 · 任何应用下生效
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">显示 / 隐藏主窗口</span>
                <span className="settings-item-hint">
                  窗口隐藏时按下可恢复；可见且聚焦时隐藏；收纳窄条态下展开
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                Ctrl + Shift + Space
              </span>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">快速记录</span>
                <span className="settings-item-hint">
                  唤起快速记录窗口并读取剪贴板预填
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                Ctrl + Shift + N
              </span>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">全局快捷搜索</span>
                <span className="settings-item-hint">
                  唤起 Spotlight 搜索小窗，再按可切换显示 / 隐藏
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                Ctrl + Shift + F
              </span>
            </div>

            <div className="mb-1 mt-4 text-[11px] font-600 text-[var(--text-muted)]">
              应用内快捷键 · 焦点位于对应输入框或面板时生效
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">列表搜索定位条目</span>
                <span className="settings-item-hint">
                  在标题栏搜索框中切换选中、打开详情
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                ↑ / ↓ · Enter
              </span>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">快捷搜索窗操作</span>
                <span className="settings-item-hint">
                  切换结果、打开便签、关闭窗口
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                ↑ / ↓ · Enter · Esc
              </span>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">快速记录提交</span>
                <span className="settings-item-hint">
                  在快速记录窗口中直接创建便签
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                Ctrl + Enter
              </span>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">AI 助手对话</span>
                <span className="settings-item-hint">
                  发送消息 / 换行 / 关闭面板
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                Enter · Shift + Enter · Esc
              </span>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">条目内联编辑</span>
                <span className="settings-item-hint">
                  标题框保存 / 放弃当前修改
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                Enter · Esc
              </span>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">新建标签 / 重命名</span>
                <span className="settings-item-hint">
                  标签输入框中确认 / 取消
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                Enter · Esc
              </span>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">提醒弹窗确认</span>
                <span className="settings-item-hint">等同于点击「我知道了」</span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                Esc
              </span>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">关闭浮层</span>
                <span className="settings-item-hint">
                  图片预览、右键菜单、表情面板、标题栏搜索
                </span>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                Esc
              </span>
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
      case "close-behavior":
        return <CloseBehaviorSetting />;
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
                生成一致性快照并校验（含 SHA256 与元数据），桌面版
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
                校验备份后原子替换；失败自动回退，恢复前自动建快照
              </span>
            </div>
            <Popconfirm
              title="从备份恢复数据库？"
              description="将关闭当前数据库连接，先创建恢复前快照，再用备份覆盖；校验或替换失败会自动回退。"
              okText="恢复"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={busy}
              onConfirm={() => void handleRestoreDb()}
            >
              <button
                type="button"
                className="data-action-btn danger w-25"
                disabled={busy}
              >
                恢复
              </button>
            </Popconfirm>
          </div>
        );
      case "tags":
        return <TagManager />;
      case "auto-backup":
        return <AutoBackupSetting />;
      case "ai-config": {
        return (
          <div className="flex flex-col gap-3 py-1">
            {/* 概览：配置数量 + 当前使用的模型 */}
            <div className="flex items-center gap-2.5 rounded-[8px] border border-[var(--border)] bg-[var(--hover-fill)] px-2.5 py-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  activeProfile?.configured
                    ? "bg-[var(--todo)]"
                    : "bg-[var(--danger)]"
                }`}
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] font-semibold text-[var(--text)]">
                  {customProfiles.length === 0
                    ? "尚未添加自己的模型配置"
                    : `已配置 ${customProfiles.length} 个模型`}
                  {freeProfiles.length > 0 &&
                    ` · ${freeProfiles.length} 个免费模型`}
                </span>
                <span className="truncate text-[10.5px] text-[var(--text-muted)]">
                  {activeProfile
                    ? `当前：${activeProfile.provider} · ${activeProfile.name}`
                    : "新增自己的模型，或直接选中下方的免费模型开始对话"}
                </span>
              </div>
            </div>

            {/* 已保存配置：点击切换为当前使用，编辑 / 删除走弹窗 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] text-[var(--text-muted)]">
                  我的模型
                </span>
                <button
                  type="button"
                  className="data-action-btn primary shrink-0 whitespace-nowrap"
                  disabled={aiBusy}
                  onClick={openAddDialog}
                >
                  新增模型
                </button>
              </div>
              {customProfiles.length === 0 ? (
                <button
                  type="button"
                  className="cursor-pointer rounded-[8px] border border-dashed border-[var(--border)] bg-transparent px-2.5 py-3 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--card-border-hover)] hover:text-[var(--text)]"
                  onClick={openAddDialog}
                >
                  还没有自己的模型配置，点击添加（也可以直接使用下方免费模型）
                </button>
              ) : (
                customProfiles.map((profile) => {
                  const active = profile.id === aiStatus?.activeId;
                  return (
                    <div
                      key={profile.id}
                      className={`flex items-start gap-2 rounded-[8px] border px-2.5 py-2 ${
                        active
                          ? "border-[var(--card-active-border)] bg-[var(--card-active-bg)]"
                          : "border-[var(--border)]"
                      }`}
                    >
                      <button
                        type="button"
                        title={active ? "当前使用中的模型" : "切换为当前使用"}
                        className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left"
                        onClick={() => void handleActivateProfile(profile)}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] font-semibold text-[var(--text)]">
                            {profile.name}
                          </span>
                          {active && (
                            <span className="shrink-0 rounded-full border border-[var(--card-active-border)] px-1.5 text-[9.5px] leading-[15px] font-semibold text-[var(--kind-accent)]">
                              当前
                            </span>
                          )}
                          {profile.readOnly && (
                            <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 text-[9.5px] leading-[15px] text-[var(--text-muted)]">
                              环境变量
                            </span>
                          )}
                          {profile.keySource === "browser" && (
                            <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 text-[9.5px] leading-[15px] text-[var(--text-muted)]">
                              本浏览器
                            </span>
                          )}
                          {!profile.configured && (
                            <span className="shrink-0 rounded-full border border-[var(--danger)] px-1.5 text-[9.5px] leading-[15px] text-[var(--danger)]">
                              缺少密钥
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-muted)]">
                          {profile.provider} · {profile.model}
                        </span>
                        <span className="block truncate text-[10px] text-[var(--text-muted)]">
                          {profile.baseUrl}
                        </span>
                      </button>
                      {!profile.readOnly && (
                        <div className="flex shrink-0 flex-col gap-1">
                          <button
                            type="button"
                            className="cursor-pointer border-0 bg-transparent p-0 text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text)]"
                            onClick={() => startEditProfile(profile)}
                          >
                            编辑
                          </button>
                          <Popconfirm
                            title="删除该模型配置？"
                            description="仅删除本机保存的接口参数与密钥，不影响聊天记录。"
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            disabled={aiBusy}
                            onConfirm={() => void handleDeleteProfile(profile)}
                          >
                            <button
                              type="button"
                              disabled={aiBusy}
                              className="cursor-pointer border-0 bg-transparent p-0 text-[10.5px] text-[var(--danger)] hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              删除
                            </button>
                          </Popconfirm>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* 分隔线：自己的模型与内置免费模型分开展示 */}
            <div className="h-px shrink-0 bg-[var(--border)]" />

            {/* 内置免费模型：按来源分组展示接口地址、限速说明与所需密钥 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className="text-[11.5px] text-[var(--text-muted)]">
                  内置免费模型
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="whitespace-nowrap text-[10px] text-[var(--text-muted)]">
                    {freeProfiles.length} 个 · 运行时拉取
                  </span>
                  <button
                    type="button"
                    className="data-action-btn shrink-0 whitespace-nowrap"
                    disabled={aiLoading}
                    onClick={() => void aiLoad(true).catch(() => undefined)}
                  >
                    {aiLoading ? "获取中…" : "重新获取"}
                  </button>
                </div>
              </div>
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--hover-fill)] px-2.5 py-2 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
                模型清单在运行时从各网关的 /models
                接口获取；接口不可用时回退到本地缓存或内置默认模型。OpenCode Zen
                使用应用内置的账号密钥，只保留零费用模型；其余为公开第三方网关，选中后提问会直接发送给对应服务商，提示词可能被记录，请勿发送敏感内容。标有「语音
                / 视频 / 图片」的模型不能用于文本对话，已置灰。
              </div>
              {freeGroups.map((group) => (
                <div
                  key={group.source}
                  className="flex flex-col gap-1 rounded-[8px] border border-[var(--border)] px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--text)]">
                      {group.label}
                    </span>
                    <FreeBadge />
                    <span
                      className={`shrink-0 text-[9.5px] ${FREE_SOURCE_LABELS[group.status].className}`}
                    >
                      {FREE_SOURCE_LABELS[group.status].text}
                    </span>
                    <span className="ml-auto shrink-0 text-[9.5px] text-[var(--text-muted)]">
                      {group.items.length} 个模型
                    </span>
                  </div>
                  <span
                    className="select-all truncate font-mono text-[10px] text-[var(--text-muted)]"
                    title={group.baseUrl}
                  >
                    {group.baseUrl}
                  </span>
                  {group.note && (
                    <span className="text-[10px] leading-relaxed text-[var(--text-muted)]">
                      {group.note}
                    </span>
                  )}
                  {group.items.length === 0 && (
                    <span className="text-[10px] leading-relaxed text-[var(--text-muted)]">
                      该网关暂不可用，可点击「重新获取」重试。
                    </span>
                  )}
                  <div className="flex flex-col">
                    {group.items.map((profile) => {
                      const active = profile.id === aiStatus?.activeId;
                      const nonText = isNonTextModality(profile.modality);
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          title={
                            active
                              ? "当前使用中的模型"
                              : nonText
                                ? "该模型输出语音 / 视频 / 图片，不能用于文本对话"
                                : `切换为 ${profile.name}`
                          }
                          disabled={nonText}
                          className={`flex items-center gap-2 rounded-[6px] border-0 px-1.5 py-1 text-left transition-colors ${
                            nonText
                              ? "cursor-not-allowed opacity-50"
                              : active
                                ? "cursor-pointer bg-[var(--card-active-bg)]"
                                : "cursor-pointer bg-transparent hover:bg-[var(--hover-fill)]"
                          }`}
                          onClick={() => void handleActivateProfile(profile)}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-[11.5px] text-[var(--text)]">
                                {profile.name}
                              </span>
                              {active && (
                                <span className="shrink-0 rounded-full border border-[var(--card-active-border)] px-1.5 text-[9.5px] leading-[15px] font-semibold text-[var(--kind-accent)]">
                                  当前
                                </span>
                              )}
                              <ModalityBadge modality={profile.modality} />
                            </span>
                            <span className="truncate font-mono text-[10px] text-[var(--text-muted)]">
                              {profile.model}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {aiMessage && <div className="data-status">{aiMessage}</div>}
          </div>
        );
      }
      case "ai-privacy":
        return (
          <div className="flex flex-col gap-3">
            <div className="settings-item">
              <div className="settings-item-main">
                <span className="settings-item-label">读取便签作为上下文</span>
                <span className="settings-item-hint">
                  开启后提问会附带笔记摘要；关闭则只回答通用问题
                </span>
              </div>
              <Switch
                size="small"
                checked={aiContextEnabled}
                onChange={setAiContextEnabled}
              />
            </div>
            <div className="rounded-[8px] bg-[var(--hover-fill)] p-2.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
              <p className="m-0">
                发送范围：当前 {entryCount} 条便签的标题、正文摘要与标签，最多约
                6000 字；不含图片、废纸篓与已删除内容。
              </p>
              <p className="m-0 mt-1">
                对话记录仅保存在本机（localStorage，最多 40
                条），不会上传到本应用服务器。
              </p>
              {!isTauriRuntime() && (
                <p className="m-0 mt-1">
                  浏览器预览会直连你在「接入配置」中填写的 AI
                  服务，便签摘要随请求发往该服务。
                </p>
              )}
              <p className="m-0 mt-1">
                关闭上下文后，之前已发送的内容无法撤回；如涉及敏感笔记，请保持关闭。
              </p>
            </div>
          </div>
        );
      case "ai-summary": {
        return (
          <div className="flex flex-col gap-3">
            {(summarySettings.dailyEnabled || summarySettings.weeklyEnabled) &&
              !aiContextEnabled && (
                <div className="flex items-center justify-between gap-2 rounded-[8px] bg-[var(--hover-fill)] p-2.5 text-[11px] leading-relaxed text-[var(--danger)]">
                  <span className="flex-1">
                    「读取便签作为上下文」已关闭，自动总结不会运行。
                  </span>
                  <Button
                    size="small"
                    className="shrink-0"
                    onClick={() => setActiveKey("ai-privacy")}
                  >
                    去开启
                  </Button>
                </div>
              )}
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">每日总结</span>
                <span className="settings-item-hint">
                  每天在指定时间用 AI 总结当天的便签、待办与提醒
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  size="small"
                  style={{ width: 88 }}
                  value={summarySettings.dailyTime}
                  options={SUMMARY_TIME_OPTIONS}
                  disabled={!summarySettings.dailyEnabled}
                  onChange={(value) => updateSummarySettings({ dailyTime: value })}
                />
                <Switch
                  size="small"
                  checked={summarySettings.dailyEnabled}
                  onChange={(value) => updateSummarySettings({ dailyEnabled: value })}
                />
              </div>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">每周总结</span>
                <span className="settings-item-hint">
                  每周在指定时间用 AI 总结最近 7 天的记录
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  size="small"
                  style={{ width: 72 }}
                  value={summarySettings.weeklyWeekday}
                  options={WEEKDAY_LABELS.map((label, index) => ({
                    value: index,
                    label,
                  }))}
                  disabled={!summarySettings.weeklyEnabled}
                  onChange={(value) => updateSummarySettings({ weeklyWeekday: value })}
                />
                <Select
                  size="small"
                  style={{ width: 88 }}
                  value={summarySettings.weeklyTime}
                  options={SUMMARY_TIME_OPTIONS}
                  disabled={!summarySettings.weeklyEnabled}
                  onChange={(value) => updateSummarySettings({ weeklyTime: value })}
                />
                <Switch
                  size="small"
                  checked={summarySettings.weeklyEnabled}
                  onChange={(value) => updateSummarySettings({ weeklyEnabled: value })}
                />
              </div>
            </div>
            <div className="settings-item grid">
              <div className="settings-item-main">
                <span className="settings-item-label">立即生成</span>
                <span className="settings-item-hint">
                  手动触发一次；同一角度当天/当周只生成一篇
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="small"
                  loading={summaryBusy === "daily"}
                  disabled={summaryBusy !== null}
                  onClick={() => void handleManualSummary("daily")}
                >
                  日总结
                </Button>
                <Button
                  size="small"
                  loading={summaryBusy === "weekly"}
                  disabled={summaryBusy !== null}
                  onClick={() => void handleManualSummary("weekly")}
                >
                  周总结
                </Button>
              </div>
            </div>
            {summaryMessage && (
              <div className="rounded-[8px] bg-[var(--hover-fill)] p-2.5 text-[11px] leading-relaxed text-[var(--text)]">
                {summaryMessage}
              </div>
            )}
            {aiContextEnabled && summaryStatus.problem && (
              <div className="rounded-[8px] bg-[var(--hover-fill)] p-2.5 text-[11px] leading-relaxed text-[var(--danger)]">
                自动运行未完成
                {summaryStatus.at ? `（${formatShort(summaryStatus.at)}）` : ""}：
                {summaryStatus.problem}
              </div>
            )}
            <div className="rounded-[8px] bg-[var(--hover-fill)] p-2.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
              <p className="m-0">
                上次生成：日总结 {summaryLastRun.daily ?? "从未生成"} · 周总结{" "}
                {summaryLastRun.weekly ?? "从未生成"}。
              </p>
              <p className="m-0 mt-1">
                总结以「AI 总结」标签保存为普通便签，可编辑或删除；生成会读取便签内容，
                需开启「上下文与隐私」且模型可用；请求失败后会暂停 10 分钟再重试。
              </p>
            </div>
          </div>
        );
      }
      case "update":
        return <UpdateSetting />;
      case "about-info":
        return (
          <div className="flex flex-col gap-2.5">
            <div className="about-brand">
              <BrandLogo height={30} />
              <span className="about-brand-tag">THINK · NOTE · DO</span>
            </div>
            <div className="settings-item">
              <div className="settings-item-main">
                <span className="settings-item-label">MEMORA</span>
                <span className="settings-item-hint">
                  本地优先的桌面效率工具，便签数据仅保存在本机
                </span>
              </div>
            </div>
            <div className="settings-item">
              <div className="settings-item-main">
                <span className="settings-item-label">友情链接</span>
                <span className="settings-item-hint break-all">
                  {FRIEND_LINK.name} · {FRIEND_LINK.url}
                </span>
              </div>
              <Button
                size="small"
                icon={<ExportOutlined />}
                onClick={() => void openExternal(FRIEND_LINK.url)}
              >
                访问
              </Button>
            </div>
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
      styles={{
        container: { padding: 0 },
        header: { padding: "10px 12px 6px" },
        body: { padding: "0 12px 10px" },
      }}
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
              if (!key || !SETTING_LEAF_KEYS.has(key)) return;
              setActiveKey(key);
              // 心跳每 30s 判定一次，切到总结页时重读阻塞/失败原因
              if (key === "ai-summary") setSummaryStatus(readSummaryStatus());
            }}
            treeData={SETTING_TREE_DATA}
          />
        </div>
        <div className="settings-tree-content">
          {renderContent(activeKey)}
          {dataStatus && <div className="data-status">{dataStatus}</div>}
        </div>
      </div>
      {/* 新增 / 编辑模型：独立弹窗，避免表单挤占设置页 */}
      <Modal
        open={aiDialogOpen}
        onCancel={closeAiDialog}
        title={aiEditingId ? "编辑模型" : "新增模型"}
        centered
        footer={null}
        width={420}
        destroyOnHidden
      >
        <div className="flex flex-col gap-2.5 pt-1">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-muted)]">
              显示名称
            </span>
            <Input
              size="small"
              value={aiName}
              placeholder={`默认：${aiModel || "模型名称"}`}
              onChange={(event) => {
                setAiName(event.target.value);
                setAiNameTouched(true);
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-muted)]">服务商</span>
            <Select
              size="small"
              value={aiProviderValue}
              onChange={(value) => applyAiPreset(value)}
              options={[
                ...AI_PRESETS.map((preset) => ({
                  value: preset.label,
                  label: preset.label,
                })),
                { value: "自定义服务", label: "自定义服务" },
              ]}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-muted)]">
              接口地址（Base URL）
            </span>
            <Input
              ref={baseUrlRef}
              size="small"
              value={aiBaseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(event) => {
                setAiBaseUrl(event.target.value);
                // 换服务后旧服务的模型候选立即失效，失焦时再按新地址拉取
                setAiRemoteModels([]);
                setAiModelHint("");
              }}
              onBlur={() => refreshModelsIfPossible(aiBaseUrl, aiModel)}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <span>模型</span>
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={aiLoadingModels || !aiBaseUrl.trim()}
                onClick={() => refreshModelsIfPossible(aiBaseUrl, aiModel)}
              >
                {aiLoadingModels ? "获取中…" : "从服务获取"}
              </button>
            </span>
            <AutoComplete
              size="small"
              value={aiModel}
              options={aiModelOptions}
              placeholder={
                aiModelOptions.length > 0
                  ? "从下拉选择，或直接输入模型名"
                  : "输入模型名称"
              }
              filterOption={(inputValue, option) =>
                String(option?.value ?? "")
                  .toLowerCase()
                  .includes(inputValue.toLowerCase())
              }
              onChange={handleModelChange}
            />
            {/* 提示位固定高度：异步出现的模型候选提示不能让弹窗高度跳动 */}
            <span
              className="block h-[15px] truncate text-[10px] leading-[15px] text-[var(--text-muted)]"
              title={aiModelHint || undefined}
            >
              {aiModelHint}
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-muted)]">
              推理强度
            </span>
            <Select
              size="small"
              value={aiReasoning}
              onChange={(value) =>
                setAiReasoning(value as ReasoningEffort | "")
              }
              options={[
                { value: "", label: "默认（由服务商决定）" },
                { value: "none", label: "无 · 关闭思考，最快" },
                { value: "low", label: "低" },
                { value: "medium", label: "中" },
                { value: "high", label: "高" },
              ]}
            />
            <span className="text-[10px] leading-relaxed text-[var(--text-muted)]">
              思考模型（豆包 Seed、DeepSeek
              等）会先推理再回复；关闭思考可显著降低首字延迟，复杂任务质量会下降。
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
              <span>API 密钥</span>
              {editingProfile?.keyMasked &&
                editingProfile.keySource !== "env" && (
                  <button
                    type="button"
                    className="cursor-pointer border-0 bg-transparent p-0 text-[10.5px] text-[var(--danger)] hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={aiBusy}
                    onClick={() => void handleAiClearKey()}
                  >
                    清除已保存密钥
                  </button>
                )}
            </span>
            <Input.Password
              size="small"
              value={aiKey}
              autoComplete="off"
              placeholder={aiKeyPlaceholder}
              onChange={(event) => setAiKey(event.target.value)}
              onBlur={() => {
                if (aiKey.trim()) {
                  refreshModelsIfPossible(aiBaseUrl, aiModel);
                }
              }}
            />
          </label>

          <p className="m-0 text-[10px] leading-relaxed text-[var(--text-muted)]">
            {isTauriRuntime()
              ? "支持任意 OpenAI 兼容接口。密钥由桌面端 Rust 后端保管，不会写入前端代码或聊天记录；也可通过环境变量 BIANQIAN_AI_API_KEY 注入（优先于本机保存值）。"
              : "浏览器预览下配置与密钥保存在本浏览器 localStorage，仅供本地调试，请避免在公共设备填写正式密钥。"}
          </p>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="data-action-btn"
              disabled={aiBusy}
              onClick={() => void handleAiTest()}
            >
              测试连接
            </button>
            <button
              type="button"
              className="data-action-btn"
              disabled={aiBusy}
              onClick={closeAiDialog}
            >
              取消
            </button>
            <button
              type="button"
              className="data-action-btn primary"
              disabled={aiBusy}
              onClick={() => void handleAiSave()}
            >
              {aiBusy ? "处理中…" : aiEditingId ? "保存修改" : "添加配置"}
            </button>
          </div>

          {aiMessage && <div className="data-status">{aiMessage}</div>}
        </div>
      </Modal>
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
