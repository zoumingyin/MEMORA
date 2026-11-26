import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { emitTo, listen } from "@tauri-apps/api/event";
import { Modal } from "antd";
import {
  ArrowLeftOutlined,
  CloseOutlined,
  EditOutlined,
} from "@ant-design/icons";
import {
  NOTE_EDIT_H,
  NOTE_EDIT_W,
  NOTE_WINDOW_OPEN_EVENT,
  NOTE_WINDOW_OPEN_REF_EVENT,
  NOTE_WINDOW_PATCH_EVENT,
  NOTE_WINDOW_PATCH_RESULT_EVENT,
  NOTE_WINDOW_PING_EVENT,
  NOTE_WINDOW_READY_EVENT,
  NOTE_WINDOW_REMOVE_EVENT,
  NOTE_WINDOW_SYNC_EVENT,
  NOTE_WINDOW_PREFIX,
  type NoteWindowSnapshot,
} from "../window/noteWindow";
import { EntryWriteError, type EntryWriteErrorCode } from "../repository/errors";
import { flushActiveEditor } from "../editor/editorRegistry";
import { useNow } from "../hooks/useNow";
import { ENTRY_KIND_COLOR } from "../utils/entryLabels";
import { paperTintHex } from "../utils/paper";
import { EntryCardBody } from "./EntryCardBody";
import { DetailPane } from "./DetailPane";
import { EntryTags } from "./EntryCardParts";
import {
  entryDone,
  KIND_ICON,
  rowMeta,
  wallDecoration,
} from "../utils/wallCardMeta";
import type { Entry } from "../types/entry";

/** 从窗口 label（note-<entryId>）解析条目 id */
function entryIdFromLabel(): string {
  return getCurrentWindow().label.slice(NOTE_WINDOW_PREFIX.length);
}

/**
 * 整体按住拖动小窗：mousedown 后移动超过阈值才调原生 startDragging（与缩放
 * 手柄同一通道），原地点击（未超阈值松开）不启动拖动，click 正常触发进编辑。
 * 按钮区（编辑/关闭等）不参与拖动。
 */
function useWindowDragOnPress(): (event: ReactMouseEvent) => void {
  return (event) => {
    if (event.button !== 0) return;
    // 按钮 / 输入类交互元素不触发拖动
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, textarea, a, .wall-note-tools")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    const cleanup = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    const onMove = (move: MouseEvent): void => {
      if (started) return;
      if (
        Math.abs(move.clientX - startX) + Math.abs(move.clientY - startY) <=
        4
      ) {
        return;
      }
      started = true;
      cleanup();
      void getCurrentWindow()
        .startDragging()
        .catch(() => undefined);
    };
    const onUp = (): void => cleanup();
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
}

/**
 * 命中内容区右侧原生滚动条？内容未超出时滚动条宽度为 0，恒为 false，
 * 因此只在真正出现滚动条时拦截，避免滚动条拖拽被卡片的窗口拖动 / 进编辑点击接管。
 */
function isOnScrollbar(event: ReactMouseEvent<HTMLElement>): boolean {
  const el = event.currentTarget;
  const barWidth = el.offsetWidth - el.clientWidth;
  return (
    barWidth > 0 && event.clientX >= el.getBoundingClientRect().right - barWidth
  );
}

/**
 * 展开 / 收起动画：两端裁切值与互为镜像的缓动。
 * 圆角半径全程恒定，等于详情容器当前设定的圆角（编辑态内层 rounded-[14px]、
 * 展示态卡片 .wall-note 的 border-radius 14px）。动画只在 inset 区域上插值，
 * 不做直角 ↔ 圆角过渡：导航开始、进行中、结束后都保持同一个圆角，不会出现
 * 直角状态、圆角渐变或切换瞬间的跳变。
 */
const EDIT_ANIM_MS = 240;
const EDIT_ANIM_EASING_OUT = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const EDIT_ANIM_EASING_IN = "cubic-bezier(0.64, 0, 0.78, 0.39)";
/** 与展示态 .wall-note、编辑态内层 rounded-[14px] 保持一致；clip-path 两端共用 */
const EDIT_CORNER_RADIUS = 14;
const EDIT_FULL_CLIP = `inset(0px 0px 0px 0px round ${EDIT_CORNER_RADIUS}px)`;

/**
 * 展示态卡片在编辑窗（NOTE_EDIT_W×NOTE_EDIT_H）内的裁切区域：
 * 展示态根左右各 8px、上 14px、下 8px → 卡片位于 (8,14)，尺寸 (cssW-16)×(cssH-22)。
 * 展开用它的 from，收起用它的 to，保证两端完全对称；圆角与 EDIT_FULL_CLIP 相同。
 */
function editCardClip(cssSize: { w: number; h: number }): string {
  const cardW = cssSize.w - 16;
  const cardH = cssSize.h - 22;
  const right = Math.max(0, NOTE_EDIT_W - 8 - cardW);
  const bottom = Math.max(0, NOTE_EDIT_H - 14 - cardH);
  return `inset(14px ${right}px ${bottom}px 8px round ${EDIT_CORNER_RADIUS}px)`;
}

/** 窗口几何（物理像素）：客户区尺寸 + 外框位置，进入编辑前留存以便还原 */
interface WindowGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

async function readGeometry(): Promise<WindowGeometry> {
  const win = getCurrentWindow();
  const [size, pos] = await Promise.all([win.innerSize(), win.outerPosition()]);
  return { width: size.width, height: size.height, x: pos.x, y: pos.y };
}

/**
 * 编辑态展开：按 scaleFactor 换成物理像素放大窗口，左上角保持不动并 clamp
 * 进当前显示器工作区（小窗贴屏幕右下角时自动向左/上平移，不越界）。
 */
async function expandForEdit(
  geom: WindowGeometry,
  scale: number
): Promise<void> {
  const win = getCurrentWindow();
  const monitor = await currentMonitor();
  const width = Math.round(NOTE_EDIT_W * scale);
  const height = Math.round(NOTE_EDIT_H * scale);
  let { x, y } = geom;
  const area = monitor?.workArea;
  if (area) {
    const maxX = Math.max(
      area.position.x,
      area.position.x + area.size.width - width
    );
    const maxY = Math.max(
      area.position.y,
      area.position.y + area.size.height - height
    );
    x = Math.min(Math.max(x, area.position.x), maxX);
    y = Math.min(Math.max(y, area.position.y), maxY);
  }
  // 先平移再放大：避免贴屏幕右下角时先放大导致一帧内容被裁到屏幕外
  if (x !== geom.x || y !== geom.y) {
    await win.setPosition(new PhysicalPosition(x, y));
  }
  await win.setSize(new PhysicalSize(width, height));
}

/** 退出编辑：恢复进入前的展示态尺寸与位置（含用户手动缩放过的尺寸） */
async function collapseForView(geom: WindowGeometry): Promise<void> {
  const win = getCurrentWindow();
  await win.setSize(new PhysicalSize(geom.width, geom.height));
  await win.setPosition(new PhysicalPosition(geom.x, geom.y));
}

/** 右下角缩放手柄：拖拽调用原生 resize（SouthEast 方向），展示态/编辑态均可用 */
function ResizeHandle() {
  return (
    <div
      className="absolute right-[6px] bottom-[6px] z-10 h-[18px] w-[18px] cursor-[nwse-resize] rounded-[4px]"
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
  /** 全部备忘便签清单：解析正文 [[引用]] 胶囊（主窗口随打开/同步下发） */
  const [noteRefs, setNoteRefs] = useState<Array<{ id: string; title: string }>>(
    []
  );
  const [pinned, setPinned] = useState(false);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const now = useNow();
  // 整体按住拖动（移动超阈值生效，原地点击仍进编辑）
  const dragOnPress = useWindowDragOnPress();
  // 展示态几何（进入编辑前留存）与切换去抖：避免快速连点重复 setSize
  const viewGeometryRef = useRef<WindowGeometry | null>(null);
  // 展示态 CSS 尺寸：过渡期冻结卡片、以及动画起点都用它（用户手动缩放过也准确）
  const viewCssSizeRef = useRef<{ w: number; h: number } | null>(null);
  const [frozenSize, setFrozenSize] = useState<{
    w: number;
    h: number;
  } | null>(null);
  // 收起过渡期把编辑态外层冻结在 560×620：窗口缩回去后 clip-path 基准不变
  const [editSizeFrozen, setEditSizeFrozen] = useState(false);
  const switchingRef = useRef(false);
  const editRootRef = useRef<HTMLDivElement | null>(null);
  // 最近一次同步的条目数据：编辑网关 getEntry 供 DetailForm flush 对比 patch
  const lastSyncedRef = useRef<Entry | null>(null);
  // 在途 patch 请求：主窗口确认落盘后才算保存成功
  const pendingPatchesRef = useRef(
    new Map<
      string,
      {
        resolve: (entry: Entry) => void;
        reject: (error: Error) => void;
        timer: number;
      }
    >()
  );

  /**
   * 展开动画：窗口 setSize 是瞬时的，用内容可见区域从展示态卡片大小裁切长大。
   * 走 Web Animations + useLayoutEffect，在首次绘制前就进入 0% 关键帧，
   * 不会先闪一帧全尺寸（这正是「收缩一下再展开」的另一个来源）。
   */
  useLayoutEffect(() => {
    const el = editRootRef.current;
    const from = viewCssSizeRef.current;
    if (mode !== "edit" || !el || !from) return;
    const animation = el.animate(
      [
        { clipPath: editCardClip(from) },
        { clipPath: EDIT_FULL_CLIP },
      ],
      {
        duration: EDIT_ANIM_MS,
        easing: EDIT_ANIM_EASING_OUT,
        fill: "backwards",
      }
    );
    return () => animation.cancel();
  }, [mode]);

  /** 进编辑：冻结展示态尺寸 → 放大窗口 → 同步切视图，避免中间帧卡片被拉大再收缩 */
  const enterEdit = async (): Promise<void> => {
    if (switchingRef.current || mode === "edit") return;
    switchingRef.current = true;
    try {
      // 先留存几何再放大：即使后续 IPC 失败，返回时仍可还原展示态尺寸
      const geom = await readGeometry();
      viewGeometryRef.current = geom;
      const scale = await getCurrentWindow().scaleFactor();
      const cssSize = { w: geom.width / scale, h: geom.height / scale };
      viewCssSizeRef.current = cssSize;
      // 同步渲染固定尺寸：否则窗口变大时展示态的 h-full/w-full 会把卡片拉伸
      flushSync(() => setFrozenSize(cssSize));
      // 等一帧让冻结尺寸真正绘制（后台标签页 rAF 不触发时用超时兜底）
      await Promise.race([
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        ),
        new Promise<void>((resolve) =>
          window.setTimeout(() => resolve(), 60)
        ),
      ]);
      await expandForEdit(geom, scale);
    } catch (error) {
      // 权限/几何读取失败时降级：不播动画，仍进编辑并沿用内容区滚动
      console.error("展开编辑小窗失败", error);
      viewCssSizeRef.current = null;
    } finally {
      switchingRef.current = false;
      // 一次同步提交直接进编辑态：layout effect 在绘制前启动动画，无首帧闪现
      flushSync(() => {
        setFrozenSize(null);
        setMode("edit");
      });
    }
  };

  /** 返回展示态：先落盘，再镜像收起动画 → 缩窗 → 同帧切回卡片，与展开完全对称 */
  const exitEdit = async (): Promise<void> => {
    if (switchingRef.current || mode === "view") return;
    // 返回列表前落盘：保存失败不切视图，避免草稿在切换中被覆盖
    if (!(await ensureSaved())) return;
    switchingRef.current = true;
    try {
      const el = editRootRef.current;
      const from = viewCssSizeRef.current;
      const geom = viewGeometryRef.current;
      if (el && from) {
        // 冻结编辑态尺寸：窗口缩回后 clip-path 仍按 560×620 计算，可见区仍是卡片
        flushSync(() => setEditSizeFrozen(true));
        // 取消可能仍在进行的展开动画，避免两个 clip-path 动画叠加
        for (const running of el.getAnimations()) running.cancel();
        const animation = el.animate(
          [
            { clipPath: EDIT_FULL_CLIP },
            { clipPath: editCardClip(from) },
          ],
          {
            duration: EDIT_ANIM_MS,
            easing: EDIT_ANIM_EASING_IN,
            fill: "forwards",
          }
        );
        // fill:forwards 保留终点（卡片大小）直到切视图；后台标签页用超时兜底
        await Promise.race([
          animation.finished.catch(() => undefined),
          new Promise<void>((resolve) =>
            window.setTimeout(() => resolve(), EDIT_ANIM_MS + 150)
          ),
        ]);
      }
      if (geom) {
        await collapseForView(geom);
        viewGeometryRef.current = null;
      }
      viewCssSizeRef.current = null;
    } catch (error) {
      console.error("收起编辑小窗失败", error);
    } finally {
      switchingRef.current = false;
      // 收起动画是 fill:forwards：若不清理，clip-path 会残留到展示态。它的 inset
      // 按 560×620 计算（right≈288 / bottom≈378），在 280×250 的窗口里裁出负宽高，
      // 内容整块不可见 —— 透明无边框窗口看起来就像「不见了」。
      // 三层防护：① 取消动画；② 两个分支根 div 用不同 key 强制 DOM 重建，动画随
      // 元素销毁；③ 展示态根带 [clip-path:none]! 覆盖任何残留的 animation 级样式。
      // cancel 与下面的 flushSync 在同一同步任务内，浏览器不会绘制中间态。
      for (const running of editRootRef.current?.getAnimations() ?? []) {
        running.cancel();
      }
      if (editRootRef.current) editRootRef.current.style.clipPath = "";
      // 一次同步提交：展示态卡片正好落在收起动画终点 (8,14)/(264×228)，无跳变
      flushSync(() => {
        setEditSizeFrozen(false);
        setFrozenSize(null);
        setMode("view");
      });
    }
  };

  /** 请求主窗口落盘：等待 patch-result 回执，超时或失败按写入错误处理 */
  const requestPatch = (
    id: string,
    patch: Partial<Entry>,
    expectedVersion: number
  ): Promise<Entry> =>
    new Promise<Entry>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const fail = (error: Error): void => {
        const pending = pendingPatchesRef.current.get(requestId);
        if (!pending) return;
        window.clearTimeout(pending.timer);
        pendingPatchesRef.current.delete(requestId);
        reject(error);
      };
      const timer = window.setTimeout(() => {
        pendingPatchesRef.current.delete(requestId);
        reject(new EntryWriteError("io", "保存超时，请重试"));
      }, 15000);
      pendingPatchesRef.current.set(requestId, { resolve, reject, timer });
      void emitTo("main", NOTE_WINDOW_PATCH_EVENT, {
        id,
        patch,
        expectedVersion,
        requestId,
        windowLabel: getCurrentWindow().label,
      }).catch(() => fail(new EntryWriteError("io", "无法连接主窗口，请重试")));
    });

  // 编辑网关：DetailPane 的存盘通道改为事件回传主窗口（与主窗口 updateEntry 同语义）
  const gateway = {
    getEntry: (id: string): Entry | null =>
      lastSyncedRef.current?.id === id ? lastSyncedRef.current : null,
    updateEntry: (
      id: string,
      patch: Partial<Entry>,
      expectedVersion: number
    ): Promise<Entry> => requestPatch(id, patch, expectedVersion),
    toggleReminderDone: async (id: string): Promise<void> => {
      const current = lastSyncedRef.current;
      if (!current || current.id !== id || current.kind !== "reminder") return;
      const nextDone = !current.done;
      // 与主窗口 toggleReminderDone 同语义：已处理 = 全部闹钟一并标记
      await requestPatch(
        id,
        {
          done: nextDone,
          notified: nextDone,
          alarms: current.alarms.map((alarm) => ({
            ...alarm,
            notified: nextDone,
          })),
        },
        current.version
      );
    },
    knownTags,
    noteRefs,
  };

  /** 关闭前落盘：有未保存内容或保存失败时留在窗口内提示，不静默丢内容 */
  const ensureSaved = async (): Promise<boolean> => {
    try {
      const saved = await flushActiveEditor();
      if (!saved) {
        Modal.error({
          title: "便签尚未保存",
          content: "保存失败，已保留编辑内容。请重试保存或稍后再关闭窗口。",
        });
        return false;
      }
      return true;
    } catch (error) {
      Modal.error({
        title: "便签尚未保存",
        content: error instanceof Error ? error.message : "保存失败，请重试",
      });
      return false;
    }
  };

  /** 关闭小窗：先落盘，成功后才真正关闭 */
  const closeSafely = async (): Promise<void> => {
    if (!(await ensureSaved())) return;
    await getCurrentWindow().close();
  };

  // 分类点缀色同步到 :root：antd 下拉/弹窗 portal 到 body，取不到卡片内联的 kind-* 类。
  // 小窗只有一条条目，accent 由自身分类决定，不跟随主窗口当前筛选
  useEffect(() => {
    if (!entry) return;
    document.documentElement.style.setProperty(
      "--kind-accent",
      ENTRY_KIND_COLOR[entry.kind]
    );
  }, [entry]);

  useEffect(() => {
    let disposed = false;
    let detachOpen: (() => void) | null = null;
    let detachPing: (() => void) | null = null;
    let detachSync: (() => void) | null = null;
    let detachResult: (() => void) | null = null;

    void (async () => {
      const [unOpen, unPing, unSync, unResult] = await Promise.all([
        listen<NoteWindowSnapshot & { id: string }>(
          NOTE_WINDOW_OPEN_EVENT,
          (event) => {
            const incoming = event.payload;
            if (incoming.id !== entryId) return;
            lastSyncedRef.current = incoming.entry;
            setEntry(incoming.entry);
            setKnownTags(incoming.knownTags);
            setNoteRefs(incoming.noteRefs);
            setPinned(incoming.pinned);
          }
        ),
        listen<{ id: string }>(NOTE_WINDOW_PING_EVENT, (event) => {
          if (event.payload?.id !== entryId) return;
          void emitTo("main", NOTE_WINDOW_READY_EVENT, { id: entryId });
        }),
        listen<{
          id: string;
          entry: Entry;
          knownTags: string[];
          noteRefs: Array<{ id: string; title: string }>;
        }>(
          NOTE_WINDOW_SYNC_EVENT,
          (event) => {
            if (event.payload?.id !== entryId) return;
            lastSyncedRef.current = event.payload.entry;
            setEntry(event.payload.entry);
            setKnownTags(event.payload.knownTags);
            setNoteRefs(event.payload.noteRefs);
          }
        ),
        listen<{
          requestId: string;
          entry?: Entry;
          code?: EntryWriteErrorCode;
          message?: string;
        }>(NOTE_WINDOW_PATCH_RESULT_EVENT, (event) => {
          const payload = event.payload;
          if (!payload?.requestId) return;
          const pending = pendingPatchesRef.current.get(payload.requestId);
          if (!pending) return;
          window.clearTimeout(pending.timer);
          pendingPatchesRef.current.delete(payload.requestId);
          if (payload.entry) {
            lastSyncedRef.current = payload.entry;
            setEntry(payload.entry);
          }
          if (payload.code) {
            pending.reject(
              new EntryWriteError(
                payload.code,
                payload.message ?? "保存失败，请重试",
                payload.entry ?? null
              )
            );
          } else if (payload.entry) {
            pending.resolve(payload.entry);
          }
        }),
      ]);
      if (disposed) {
        unOpen();
        unPing();
        unSync();
        unResult();
        return;
      }
      detachOpen = unOpen;
      detachPing = unPing;
      detachSync = unSync;
      detachResult = unResult;
      // 注册完监听即回报就绪（主窗口 open 流程会 ping 补齐竞态）
      await emitTo("main", NOTE_WINDOW_READY_EVENT, { id: entryId }).catch(
        () => undefined
      );
    })();

    const pendingPatches = pendingPatchesRef.current;
    return () => {
      disposed = true;
      detachOpen?.();
      detachPing?.();
      detachSync?.();
      detachResult?.();
      for (const pending of pendingPatches.values()) {
        window.clearTimeout(pending.timer);
        pending.reject(new EntryWriteError("io", "窗口已关闭，保存中断"));
      }
      pendingPatches.clear();
    };
  }, [entryId]);

  if (!entry) {
    return (
      <div className="flex h-full w-full items-center justify-center p-3">
        <span className="text-[12px] text-[var(--text-muted)]">加载中…</span>
      </div>
    );
  }

  // 编辑态：窗口已展开为 NOTE_EDIT_W×NOTE_EDIT_H，DetailPane 本体能力不变
  if (mode === "edit") {
    return (
      // 外层承载展开/收起动画（只插值 inset 区域）与缩放手柄；内层圆角静态恒定 14px，
      // 与贴纸墙卡片同款圆角/发丝边，不参与动画，切换全程都保持同一个圆角
      <div
        key="edit"
        ref={editRootRef}
        className="relative h-full w-full"
        style={
          editSizeFrozen
            ? { width: NOTE_EDIT_W, height: NOTE_EDIT_H }
            : undefined
        }
      >
        <div className="flex h-full w-full flex-col overflow-hidden rounded-[14px] border border-solid border-[var(--border)] bg-[var(--card-bg)] p-[8px]">
          {/* 顶部条：返回 / 关闭 + 拖动区（放大后仍可拖走，按钮不参与拖动） */}
          <div
            className="flex h-[34px] shrink-0 items-center justify-between gap-2 border-b border-solid border-[var(--border)] px-1 pb-1"
            onMouseDown={dragOnPress}
          >
            <button
              type="button"
              className="inline-flex h-[24px] items-center gap-1 rounded-[6px] px-2 text-[11.5px] text-[var(--text-muted)] hover:bg-[var(--hover-fill)] hover:text-[var(--text)]"
              onClick={() => void exitEdit()}
            >
              <ArrowLeftOutlined />
              返回
            </button>
            <span className="pointer-events-none text-[12px] text-[var(--text-muted)]">
              编辑便签
            </span>
            <button
              type="button"
              className="inline-flex h-[24px] w-[24px] items-center justify-center rounded-[6px] text-[11.5px] text-[var(--text-muted)] hover:bg-[var(--hover-fill)] hover:text-[var(--text)]"
              title="关闭小窗"
              aria-label="关闭小窗"
              onClick={() => void closeSafely()}
            >
              <CloseOutlined />
            </button>
          </div>
          {/* 内容区：flex 链闭合让编辑器拿到剩余高度并在内部滚动；
              窗口被手动缩到很小时由这层兜底滚动，滚动链不传给页面主体 */}
          <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain">
            <DetailPane
              entry={entry}
              gateway={gateway}
              onRemove={(id) => {
                void (async () => {
                  // 删除前先落盘，避免未保存草稿随条目一起丢失
                  if (!(await ensureSaved())) return;
                  await emitTo("main", NOTE_WINDOW_REMOVE_EVENT, {
                    id,
                  }).catch(() => undefined);
                })();
              }}
            />
          </div>
        </div>
        <ResizeHandle />
      </div>
    );
  }

  const kind = entry.kind;
  // 页脚元信息与完成态判定都用列表同源的共享函数，保证各类型便签显示一致
  const meta = rowMeta(entry, now);
  const isDone = entryDone(entry);
  // 纸张外观：底色染色 + 纹理（与贴纸墙卡片同一套 data-paper / --card-tint 通道）
  const tintHex = paperTintHex(entry.color);
  const paperActive = (entry.paper ?? "plain") !== "plain";

  return (
    <div
      key="view"
      className="relative h-full w-full pb-[8px] pl-[8px] pr-[8px] pt-[14px] [clip-path:none]!"
      style={
        frozenSize ? { width: frozenSize.w, height: frozenSize.h } : undefined
      }
    >
      {/* 右下角缩放手柄：拖拽自由调整窗口宽高（原生 resize，不经过卡片点击） */}
      <ResizeHandle />
      {/* 展示态：与贴纸墙卡片同一套结构/样式，点卡片进入编辑（同墙上点卡片开详情） */}
      <div
        className={` note-row wall-note wall-note-flow kind-${kind} ${wallDecoration(entry.id, pinned)} w-full! h-full! [rotate:0deg]! cursor-pointer! hover:[translate:none]! hover:[box-shadow:var(--wall-card-shadow)]! ${isDone ? "is-done done" : ""} ${meta.overdue ? "overdue" : ""}`}
        data-paper={paperActive ? entry.paper : undefined}
        style={
          tintHex ? ({ "--card-tint": tintHex } as CSSProperties) : undefined
        }
        onMouseDown={dragOnPress}
        onClick={() => void enterEdit()}
      >
        {/* 头部：图标 + 标题 + 工具（编辑 / 关闭）；拖动由卡片整体 mousedown 接管 */}
        <div className="wall-note-head">
          <span className="wall-note-kind" aria-hidden="true">
            {KIND_ICON[kind]}
          </span>
          <span className="wall-note-title">{entry.title || "便签"}</span>
          <span
            className="wall-note-tools"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="wall-note-tool"
              title="编辑便签"
              aria-label="编辑便签"
              onClick={(event) => {
                event.stopPropagation();
                void enterEdit();
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
                void closeSafely();
              }}
            >
              <CloseOutlined />
            </button>
          </span>
        </div>

        {/* 正文：共享 EntryCardBody，与贴纸墙卡片像素级一致；
            小窗内改为唯一滚动区（解除卡片对 Markdown 的定高裁切），
            滚动链不传给小窗本体；滚动条上的按下/点击不让卡片拖动或进编辑接管 */}
        <div
          className="wall-note-body overflow-y-auto! overscroll-contain [&_.wall-note-md]:max-h-none! [&_.wall-note-md]:overflow-visible!"
          onMouseDown={(event) => {
            if (isOnScrollbar(event)) event.stopPropagation();
          }}
          onClick={(event) => {
            if (isOnScrollbar(event)) event.stopPropagation();
            // 点中正文便签引用胶囊：转发主窗口解析跳转（小窗没有全量条目清单，无法本地解析）
            const refEl = (
              event.target as HTMLElement
            ).closest?.(".note-ref-link") as HTMLElement | null;
            if (refEl) {
              event.stopPropagation();
              const id = refEl.getAttribute("data-id") ?? undefined;
              const title = refEl.getAttribute("data-title") ?? undefined;
              if (id || title) {
                void emitTo("main", NOTE_WINDOW_OPEN_REF_EVENT, { id, title });
              }
            }
          }}
        >
          <EntryCardBody
            entry={entry}
            now={now}
            resolveNoteRef={(title) => {
              const wanted = title.trim();
              const hit = noteRefs.find((item) => item.title.trim() === wanted);
              return hit ? { id: hit.id } : null;
            }}
          />
        </div>

        {/* 页脚：标签 + 与便签列表同源的元信息（备忘/涂鸦更新时间、待办进度、
            提醒相对时间/已到期/已处理）；已完成、已到期沿用列表的同一套配色 */}
        <div className="wall-note-foot">
          <span className="wall-note-tags">
            <EntryTags tags={entry.tags} />
          </span>
          <span
            className={`row-meta max-w-[70%] shrink-0 ${meta.overdue ? "overdue" : ""}`}
          >
            {meta.text}
          </span>
        </div>
      </div>
    </div>
  );
}
