import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo, listen } from "@tauri-apps/api/event";
import { CloseOutlined, EditOutlined } from "@ant-design/icons";
import {
  NOTE_WINDOW_OPEN_EVENT,
  NOTE_WINDOW_PATCH_EVENT,
  NOTE_WINDOW_PING_EVENT,
  NOTE_WINDOW_READY_EVENT,
  NOTE_WINDOW_REMOVE_EVENT,
  NOTE_WINDOW_SYNC_EVENT,
  NOTE_WINDOW_PREFIX,
  type NoteWindowSnapshot,
} from "../window/noteWindow";
import { useNow } from "../hooks/useNow";
import { paperTintHex } from "../utils/paper";
import { EntryCardBody } from "./EntryCardBody";
import { DetailPane } from "./DetailPane";
import { EntryTags } from "./EntryCardParts";
import { formatMonthDay, KIND_ICON, wallDecoration } from "../utils/wallCardMeta";
import type { Entry } from "../types/entry";

/** 从窗口 label（note-<entryId>）解析条目 id */
function entryIdFromLabel(): string {
  return getCurrentWindow().label.slice(NOTE_WINDOW_PREFIX.length);
}

/** 右下角缩放手柄：拖拽调用原生 resize（SouthEast 方向），展示态/编辑态均可用 */
function ResizeHandle() {
  return (
    <div
      className="absolute right-[2px] bottom-[2px] z-10 h-[18px] w-[18px] cursor-[nwse-resize] rounded-[4px]"
      style={{
        background:
          "repeating-linear-gradient(-45deg, transparent 0 2px, var(--border) 2px 3px)",
      }}
      title="拖拽调整大小"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void getCurrentWindow()
          .startResizeDragging("SouthEast")
          .catch(() => undefined);
      }}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

/**
 * 便签独立小窗（note.html 轻量入口），双模式：
 *
 * 展示态（默认）：直接复用贴纸墙卡片渲染 —— .note-row.wall-note 全套样式 +
 * 共享的 EntryCardBody（备忘 Markdown / 涂鸦图 / 待办进度条+子任务 / 提醒状态），
 * 与贴纸墙上的卡片像素级一致；点卡片进入编辑（与墙上点卡片开详情同交互）。
 *
 * 编辑态：复用 DetailPane 本体（TipTap 富文本 / 闹钟编辑器 / 纸张外观 / 标签），
 * 经 DetailEditGateway 把存盘改为事件回传主窗口统一落盘；「返回列表」回到卡片视图。
 *
 * 数据由主窗口经 open/sync 事件下发；删除联动：小窗发起删除 → 主窗口移入废纸篓
 * → entries 同步中发现条目消失 → 主窗口销毁本小窗。
 */
export function NoteWindow() {
  // 窗口 label 生命周期内不变，惰性初始化一次即可
  const [entryId] = useState(entryIdFromLabel);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [pinned, setPinned] = useState(false);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const now = useNow();
  // 最近一次同步的条目数据：编辑网关 getEntry 供 DetailForm flush 对比 patch
  const lastSyncedRef = useRef<Entry | null>(null);

  // 编辑网关：DetailPane 的存盘通道改为事件回传主窗口（与主窗口 updateEntry 同语义）
  const gateway = {
    getEntry: (id: string): Entry | null =>
      lastSyncedRef.current?.id === id ? lastSyncedRef.current : null,
    updateEntry: (id: string, patch: Partial<Entry>): void => {
      void emitTo("main", NOTE_WINDOW_PATCH_EVENT, { id, patch }).catch(
        () => undefined,
      );
    },
    toggleReminderDone: (id: string): void => {
      const current = lastSyncedRef.current;
      if (!current || current.id !== id || current.kind !== "reminder") return;
      const nextDone = !current.done;
      // 与主窗口 toggleReminderDone 同语义：已处理 = 全部闹钟一并标记
      void emitTo("main", NOTE_WINDOW_PATCH_EVENT, {
        id,
        patch: {
          done: nextDone,
          notified: nextDone,
          alarms: current.alarms.map((alarm) => ({
            ...alarm,
            notified: nextDone,
          })),
        },
      }).catch(() => undefined);
    },
    knownTags,
  };

  useEffect(() => {
    let disposed = false;
    let detachOpen: (() => void) | null = null;
    let detachPing: (() => void) | null = null;
    let detachSync: (() => void) | null = null;

    void (async () => {
      const [unOpen, unPing, unSync] = await Promise.all([
        listen<NoteWindowSnapshot & { id: string }>(
          NOTE_WINDOW_OPEN_EVENT,
          (event) => {
            const incoming = event.payload;
            if (incoming.id !== entryId) return;
            // 主题变量注入（与主窗口一致）
            for (const [key, value] of Object.entries(incoming.cssVars)) {
              document.documentElement.style.setProperty(key, value);
            }
            document.documentElement.classList.toggle(
              "dark-glass",
              incoming.isDark,
            );
            lastSyncedRef.current = incoming.entry;
            setEntry(incoming.entry);
            setKnownTags(incoming.knownTags);
            setPinned(incoming.pinned);
          },
        ),
        listen<{ id: string }>(NOTE_WINDOW_PING_EVENT, (event) => {
          if (event.payload?.id !== entryId) return;
          void emitTo("main", NOTE_WINDOW_READY_EVENT, { id: entryId });
        }),
        listen<{ id: string; entry: Entry; knownTags: string[] }>(
          NOTE_WINDOW_SYNC_EVENT,
          (event) => {
            if (event.payload?.id !== entryId) return;
            lastSyncedRef.current = event.payload.entry;
            setEntry(event.payload.entry);
            setKnownTags(event.payload.knownTags);
          },
        ),
      ]);
      if (disposed) {
        unOpen();
        unPing();
        unSync();
        return;
      }
      detachOpen = unOpen;
      detachPing = unPing;
      detachSync = unSync;
      // 注册完监听即回报就绪（主窗口 open 流程会 ping 补齐竞态）
      await emitTo("main", NOTE_WINDOW_READY_EVENT, { id: entryId }).catch(
        () => undefined,
      );
    })();

    return () => {
      disposed = true;
      detachOpen?.();
      detachPing?.();
      detachSync?.();
    };
  }, [entryId]);

  if (!entry) {
    return (
      <div className="flex h-full w-full items-center justify-center p-3">
        <span className="text-[12px] text-[var(--text-muted)]">加载中…</span>
      </div>
    );
  }

  // 编辑态：DetailPane 本体（能力与主窗口详情完全一致）
  if (mode === "edit") {
    return (
      <div className="relative h-full w-full p-[8px]">
        <DetailPane
          entry={entry}
          gateway={gateway}
          onBack={() => setMode("view")}
          onRemove={(id) => {
            void emitTo("main", NOTE_WINDOW_REMOVE_EVENT, { id }).catch(
              () => undefined,
            );
          }}
        />
        <ResizeHandle />
      </div>
    );
  }

  const kind = entry.kind;
  const isDone =
    kind === "todo"
      ? entry.items.length > 0 && entry.items.every((item) => item.done)
      : kind === "reminder"
        ? entry.alarms.length === 0
          ? Boolean(entry.done)
          : entry.alarms.every((alarm) => alarm.notified)
        : false;
  // 纸张外观：底色染色 + 纹理（与贴纸墙卡片同一套 data-paper / --card-tint 通道）
  const tintHex = paperTintHex(entry.color);
  const paperActive = (entry.paper ?? "plain") !== "plain";

  return (
    <div className="relative h-full w-full pb-[8px] pl-[8px] pr-[8px] pt-[14px]">
      {/* 右下角缩放手柄：拖拽自由调整窗口宽高（原生 resize，不经过卡片点击） */}
      <ResizeHandle />
      {/* 展示态：与贴纸墙卡片同一套结构/样式，点卡片进入编辑（同墙上点卡片开详情） */}
      <div
        className={`note-row wall-note wall-note-flow kind-${kind} ${wallDecoration(entry.id, pinned)} w-full! h-full! [rotate:0deg]! cursor-pointer! hover:[translate:none]! hover:[box-shadow:var(--wall-card-shadow)]! ${isDone ? "is-done" : ""}`}
        data-paper={paperActive ? entry.paper : undefined}
        style={tintHex ? ({ "--card-tint": tintHex } as CSSProperties) : undefined}
        onClick={() => setMode("edit")}
      >
        {/* 头部 = 拖拽区：图标 + 标题 + 工具（编辑 / 关闭），整行按住可拖动小窗 */}
        <div className="wall-note-head" data-tauri-drag-region>
          <span className="wall-note-kind" aria-hidden="true" data-tauri-drag-region>
            {KIND_ICON[kind]}
          </span>
          <span className="wall-note-title" data-tauri-drag-region>
            {entry.title || "便签"}
          </span>
          <span
            className="wall-note-tools"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="wall-note-tool"
              title="编辑便签"
              aria-label="编辑便签"
              onClick={(event) => {
                event.stopPropagation();
                setMode("edit");
              }}
            >
              <EditOutlined />
            </button>
            <button
              type="button"
              className="wall-note-tool"
              title="关闭小窗"
              aria-label="关闭小窗"
              onClick={(event) => {
                event.stopPropagation();
                void getCurrentWindow().close();
              }}
            >
              <CloseOutlined />
            </button>
          </span>
        </div>

        {/* 正文：共享 EntryCardBody，与贴纸墙卡片像素级一致 */}
        <div className="wall-note-body">
          <EntryCardBody entry={entry} now={now} />
        </div>

        {/* 页脚：标签 + 日期，与贴纸墙卡片完全一致 */}
        <div className="wall-note-foot">
          <span className="wall-note-tags">
            <EntryTags tags={entry.tags} />
          </span>
          <span className="wall-note-date">
            {formatMonthDay(entry.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}
