import { invoke } from "@tauri-apps/api/core";
import { useEntryStore } from "../store/useEntryStore";
import { useWindowStore } from "../store/useWindowStore";
import {
  applyBounds,
  currentWorkArea,
  getBounds,
  isMaximized,
  isMinimized,
  logDockGeometry,
  setMinSizeConstraint,
  setShadowEnabled,
  type Bounds,
  type WorkArea,
} from "./tauriWindow";

export type DockEdge = "left" | "right" | "top";

/**
 * 距屏幕边缘多少像素内判定为贴近，触发收纳。
 * 按可见矩形（客户区）计算：透明窗口那圈不可见阴影边框不参与判定，
 * 否则窗口看着还差一截就收了。
 */
export const DOCK_THRESHOLD = 5;
/**
 * 收纳后边缘窄条的逻辑宽度（CSS 像素）：容纳一列便签标题胶囊，不再是光秃细条。
 * 物理厚度按当前缩放换算（stripThicknessPx），高缩放屏上文字不会缩小。
 */
export const STRIP_LOGICAL = 80;

/** 窄条最多展示的便签标题数，超出的被容器裁掉（DockBar 渲染与此对齐） */
export const MAX_CHIPS = 9;

/** 窄条内容长度估算用的胶囊度量（逻辑像素）：与 DockBar 的胶囊样式对齐
 *  （py 5×2 + 行高 15 + 上下边框 2 = 27），仅作缩窗初值，
 *  DockBar 挂载后由 fitStripToContent 按真实 DOM 尺寸校正 */
const CHIP_HEIGHT = 27;
const CHIP_GAP = 6;
const STRIP_PAD_Y = 16;
/** 内容长度下限：至少留一颗胶囊的高度，空列表时窗口仍可悬停展开 */
const STRIP_MIN_LENGTH = STRIP_PAD_Y + CHIP_HEIGHT;

/** 收纳窄条的物理厚度：按当前缩放换算 */
export function stripThicknessPx(): number {
  return Math.round(STRIP_LOGICAL * (window.devicePixelRatio || 1));
}

/** 判定「窗口已收成窄条」的厚度上限（物理像素）：窄条厚度 + 不可见边框余量。
 *  正常窗口最小 422 逻辑像素，远高于此，不会误判 */
export function stripMaxThicknessPx(): number {
  return stripThicknessPx() + 100;
}
/** 停手判定：轮询间隔与需要的连续相同坐标次数 */
const IDLE_POLL_MS = 120;
const IDLE_STABLE_READS = 2;
/** 停手轮询上限：约 1.9s，超过则视为还在拖，等下一次移动事件 */
const IDLE_MAX_POLLS = 16;

/** 只有最新一次检测有效：拖动中会反复进入，旧协程继续下发会与用户抢窗口 */
let dockSeq = 0;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

/** 判断当前窗口贴近哪条边缘，未贴近返回 null */
export function detectDockEdge(
  bounds: Bounds,
  workArea: WorkArea
): DockEdge | null {
  if (bounds.x - workArea.x <= DOCK_THRESHOLD) return "left";
  if (workArea.x + workArea.width - (bounds.x + bounds.width) <= DOCK_THRESHOLD)
    return "right";
  if (bounds.y - workArea.y <= DOCK_THRESHOLD) return "top";
  return null;
}

/** 窄条沿边缘方向的内容长度初值（物理像素）：按当前条目数估算竖排胶囊列高度。
 *  上边缘收纳是横排，胶囊宽度随标题文字变化无法估算，返回 undefined
 *  （沿用原窗口宽度作初值，挂载后同样由 fitStripToContent 实测校正） */
export function stripEstimatedLengthPx(edge: DockEdge): number | undefined {
  if (edge === "top") return undefined;
  const count = Math.min(
    useEntryStore.getState().entries.length,
    MAX_CHIPS,
  );
  const logical = Math.max(
    STRIP_MIN_LENGTH,
    STRIP_PAD_Y + count * CHIP_HEIGHT + Math.max(0, count - 1) * CHIP_GAP,
  );
  return Math.round(logical * (window.devicePixelRatio || 1));
}

/** 窄条目标矩形：贴齐对应边缘，只保留一层窄条厚度。
 *  保留维度（左/右收的 y、上收的 x）夹进工作区：拖放时窗口可能大部分在屏幕外，
 *  窄条若跟着不可见，表现为「贴边后便签消失」，且 show() 拉不回来。
 *  lengthOverridePx：沿边缘方向的窗口长度（物理像素），收纳时按内容高度自适应；
 *  缺省沿用收纳前边界（旧行为兜底） */
function stripRect(
  edge: DockEdge,
  bounds: Bounds,
  workArea: WorkArea,
  lengthOverridePx?: number,
): Bounds {
  if (edge === "left") {
    const height = lengthOverridePx ?? bounds.height;
    return {
      x: workArea.x,
      y: clampRange(
        bounds.y,
        workArea.y,
        workArea.y + workArea.height - height
      ),
      width: stripThicknessPx(),
      height,
    };
  }
  if (edge === "right") {
    const height = lengthOverridePx ?? bounds.height;
    return {
      x: workArea.x + workArea.width - stripThicknessPx(),
      y: clampRange(
        bounds.y,
        workArea.y,
        workArea.y + workArea.height - height
      ),
      width: stripThicknessPx(),
      height,
    };
  }
  const width = lengthOverridePx ?? bounds.width;
  return {
    x: clampRange(
      bounds.x,
      workArea.x,
      workArea.x + workArea.width - width
    ),
    y: workArea.y,
    width,
    height: stripThicknessPx(),
  };
}

/** 把 v 夹进 [min, max]；区间为空（v 超长）时取 min，宁可贴边也不出屏 */
function clampRange(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}

/** 边界是否已经是收纳后的窄条（按贴边方向的厚度判断） */
export function isCollapsedStrip(bounds: Bounds, edge: DockEdge): boolean {
  return (
    (edge === "top" ? bounds.height : bounds.width) <= stripMaxThicknessPx()
  );
}

/** 窄条滑进边缘让位的时长：与 index.css .dock-strip.is-receding 的过渡时长对齐并留少量余量 */
const STRIP_RECEDE_MS = 130;

/** 展开时撑窗后的回读间隔：窄条已隐藏、无拖拽竞争，短轮询即可，减少滑入前的空窗 */
export const EXPAND_SETTLE_MS = 50;

/** 展开流程互斥锁：悬停（DockBar）与托盘/快捷键（expandIfDocked）两条路径共用，
 *  避免并发跑两套 drawer 展开互相抢窗口（表现为来回跳动/闪烁） */
let expandInFlight = false;

export function acquireExpandLock(): boolean {
  if (expandInFlight) return false;
  expandInFlight = true;
  return true;
}

export function releaseExpandLock(): void {
  expandInFlight = false;
}

/** 收纳完成后的冷却时长：指针往往就压在刚收好的窄条上（拖到边缘松手/设置里点收纳），
 *  这不是主动悬停，立刻展开会让便签收一下又弹开，冷却期内忽略 mouseenter */
export const COLLAPSE_COOLDOWN_MS = 450;

let lastCollapseAt = 0;

/** 是否刚完成收纳（冷却期内） */
export function isCollapseRecent(withinMs: number): boolean {
  return Date.now() - lastCollapseAt < withinMs;
}

/**
 * 展开前半段（drawer 式）：把窄条滑进所在边缘收起并隐藏。
 * 先钉住（is-expanding）等一帧落地，再加 is-receding 滑向边缘淡出，最后整条 visibility 隐藏——
 * 窗口撑大瞬间的上一帧必须全透明：WebView2 在 resize 时会把上一帧拉伸合成，
 * 上一帧只要还有窄条内容就会被拉成横贯窗口的色带（表现为小条闪一下）。
 * 隐藏窗口的 rAF 可能被节流不回调，超时兜底避免展开卡死。
 * 返回是否找到窄条节点（找不到时调用方直接撑窗口即可）。
 */
export async function recedeStripForExpand(edge: DockEdge): Promise<boolean> {
  const strip = document.querySelector(".dock-strip");
  if (!(strip instanceof HTMLElement)) return false;
  strip.style.setProperty("--dock-strip-thickness", `${STRIP_LOGICAL}px`);
  strip.classList.add("is-expanding", `edge-${edge}`);
  // 钉住布局先完整绘制一帧，滑出过渡才从贴边态起步
  await Promise.race([
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    ),
    delay(80),
  ]);
  strip.classList.add("is-receding");
  await delay(STRIP_RECEDE_MS);
  strip.style.visibility = "hidden";
  return true;
}

/** 展开失败：撤掉收起与钉住，窄条回到充满窗口的常规布局 */
export function unpinStrip(): void {
  const strip = document.querySelector(".dock-strip");
  if (!(strip instanceof HTMLElement)) return;
  strip.classList.remove(
    "is-receding",
    "is-expanding",
    "edge-left",
    "edge-right",
    "edge-top"
  );
  strip.style.removeProperty("--dock-strip-thickness");
  strip.style.visibility = "";
}

/**
 * 收纳为边缘窄条；收纳前的边界由调用方保存，供展开恢复。
 * 尺寸与位置一步下发（补间会让窗口在中间尺寸重排整个界面，表现为抖动），
 * 下发后由 applyBounds 回读校正，直到窄条真的贴住边缘。
 * 返回是否真的执行（展开流程持锁期间拒绝收纳，调用方应回滚收纳态）。
 * 整个缩窗+验证期间持有展开互斥锁：窄条刚落地时指针往往就压在上面，
 * 布局重算触发的 mouseenter 若此刻启动展开，两边并发下发矩形互相覆盖，
 * 可能留下「窗口 24px 但 docked=false」的脏状态（便签消失且无法唤回）。
 */
export async function collapseToStrip(
  edge: DockEdge,
  bounds: Bounds,
  workArea: WorkArea
): Promise<boolean> {
  if (!acquireExpandLock()) return false;
  try {
    return await collapseToStripLocked(edge, bounds, workArea);
  } finally {
    lastCollapseAt = Date.now();
    releaseExpandLock();
  }
}

/** 收纳缩窗的执行段：调用方必须已持有展开互斥锁 */
async function collapseToStripLocked(
  edge: DockEdge,
  bounds: Bounds,
  workArea: WorkArea
): Promise<boolean> {
  // 窄条厚度小于 tauri.conf.json 里的 minWidth/minHeight，
  // 不先清空最小尺寸约束，Windows 的 WM_GETMINMAXINFO 会把 setSize 顶回 422×540，
  // 表现为「收一下又弹回原尺寸」；展开时由 restoreBounds 设回约束
  await setMinSizeConstraint(false);
  // 关投影会让 tao 重写窗口样式并强制非客户区重算（SWP_FRAMECHANGED + WM_NCCALCSIZE），
  // 客户区向外扩一圈不可见边框，DWM 对重算后的边框绘一帧亮色——画面闪现白边。
  // 先用 DWMWA_CLOAK 把窗口从合成器临时隐藏（此刻 dock-out 已播完、内容本就全透明，
  // 斗篷/揭开在视觉上无感），样式重算与缩窗全程不可见，揭开时即是最终窄条
  await invoke("set_window_cloaked", { cloaked: true }).catch(() => undefined);
  try {
    // 收纳窄条是贴边浮层，关掉 DWM 投影避免胶囊列悬空发虚；展开恢复时再开回来
    await setShadowEnabled(false);
    // 沿边缘方向的长度按条目数自适应：初值是估算，DockBar 挂载后实测校正
    lastFitLengthPx = -1;
    const target = stripRect(
      edge,
      bounds,
      workArea,
      stripEstimatedLengthPx(edge)
    );
    const settled = await applyBounds(target);
    await logDockGeometry("collapse", { edge, target, settled });
    return true;
  } finally {
    await invoke("set_window_cloaked", { cloaked: false }).catch(() => undefined);
  }
}

/** 收纳出场动画时长：与 index.css .app-shell.dock-out-* 的 0.18s 对齐，留少量余量 */
export const DOCK_OUT_ANIM_MS = 210;

/**
 * 带出场动画的收纳（与展开的 drawer 式对称）：
 * 先置收纳态并让主界面播放滑向贴边侧的 dock-out-* 动画（窗口仍全尺寸），
 * 播完再真正缩窗、由 DockBar 的 dock-strip-in 淡入。
 * 整个动画+缩窗期间持有展开互斥锁，托盘/快捷键展开不会插进来抢窗口。
 * 返回 false 表示被拒（并发收纳/展开），调用方应回滚收纳态。
 */
export async function collapseToStripAnimated(
  edge: DockEdge,
  bounds: Bounds,
  workArea: WorkArea
): Promise<boolean> {
  if (!acquireExpandLock()) return false;
  const winState = useWindowStore.getState();
  // 先置收纳态：缩窗触发的 move/resize 事件到达时 docked 已为 true，
  // 既不会把窄条尺寸写进启动恢复存储，也不会再排一轮贴边检测
  winState.setDock(edge, bounds, true);
  winState.setCollapsing(true);
  try {
    // 等主界面滑出动画播完（fill:both 保持透明末帧），再缩窗换窄条
    await delay(DOCK_OUT_ANIM_MS);
    await collapseToStripLocked(edge, bounds, workArea);
    return true;
  } finally {
    useWindowStore.getState().setCollapsing(false);
    lastCollapseAt = Date.now();
    releaseExpandLock();
  }
}

/** 上一次自适应下发的长度（物理像素）：窗口 resize 会再次触发 ResizeObserver，
 *  长度没变就不重复下发，避免校正自己触发的回调形成回环 */
let lastFitLengthPx = -1;

/**
 * 收纳窄条高度（上边缘为宽度）按内容自适应：读取窄条真实 DOM 尺寸，
 * 把沿边缘方向的窗口长度校正为内容长度。估算初值与真实渲染
 * （字体度量、系统缩放、横排胶囊宽度）有出入，DockBar 挂载后调用一次校正；
 * 条目增删导致胶囊列变化时由 DockBar 的 ResizeObserver 再次触发。
 * 窗口已不是窄条（展开中/未收纳）时不动；展开流程持锁期间也不动，避免与展开抢窗口。
 */
export async function fitStripToContent(edge: DockEdge): Promise<void> {
  if (expandInFlight) return;
  const strip = document.querySelector(".dock-strip");
  if (!(strip instanceof HTMLElement)) return;
  const bounds = await getBounds();
  if (!bounds || !isCollapsedStrip(bounds, edge)) return;
  const workArea = await currentWorkArea();
  if (!workArea) return;
  // 窄条没有固定高度/宽度（index.css 仅注释掉 height:100%），盒子尺寸即内容尺寸
  const lengthLogical = edge === "top" ? strip.offsetWidth : strip.offsetHeight;
  const dpr = window.devicePixelRatio || 1;
  const maxLength =
    edge === "top" ? workArea.width : workArea.height;
  const lengthPx = Math.min(
    maxLength,
    Math.round(Math.max(STRIP_MIN_LENGTH, lengthLogical) * dpr),
  );
  if (Math.abs(lengthPx - lastFitLengthPx) <= 1) return;
  lastFitLengthPx = lengthPx;
  const target = stripRect(edge, bounds, workArea, lengthPx);
  await applyBounds(target);
  await logDockGeometry("fit-strip", { edge, lengthLogical, lengthPx });
}

export interface DockScan {
  /** 停手时贴近的边缘；null 表示已停手但没有贴边（调用方据此结束收纳会话） */
  edge: DockEdge | null;
  /** 收纳前的边界，供展开时恢复 */
  bounds: Bounds;
  workArea: WorkArea;
}

/**
 * 拖拽停手后判定是否贴边：只等待与检测，不下发缩窗。
 * 收纳必须由调用方先置收纳态再调 collapseToStrip——否则窄条尺寸会被 resize/move
 * 事件写进启动恢复存储，且缩窗自身触发的事件会重新调度本轮检测。
 * 返回 null 表示判定被打断（仍在拖、被新调度取代、最大化等），调用方不应据此改状态。
 */
export async function detectDockTarget(): Promise<DockScan | null> {
  // 最大化状态下不做任何收纳/移动：最大化窗口被 setPosition 会被 Windows 立即还原，
  // 双击标题栏最大化后「马上变回来」即由此路径引发
  if (await isMaximized()) return null;
  // 最小化窗口矩形在屏幕外（如 -25600,-25600），会被误判为贴左边并收纳，
  // 把窗口的正常位置改写成一个屏幕外的坏坐标
  if (await isMinimized()) return null;

  const seq = ++dockSeq;
  let bounds = await getBounds();
  if (!bounds) return null;
  // 先等手停下来：Windows 拖动窗口是模态循环，期间的 setSize/setPosition 会被系统忽略，
  // 而松手后不再产生移动事件——过早收纳就再也没有第二次机会（表现为拖到边缘不吸附）
  let stable = 0;
  for (let i = 0; i < IDLE_MAX_POLLS && stable < IDLE_STABLE_READS; i += 1) {
    await delay(IDLE_POLL_MS);
    if (seq !== dockSeq) return null;
    const next = await getBounds();
    if (!next) return null;
    stable = next.x === bounds.x && next.y === bounds.y ? stable + 1 : 0;
    bounds = next;
  }
  // 轮询用尽仍在移动：交给下一次移动事件重新调度，避免和用户抢窗口
  if (stable < IDLE_STABLE_READS) return null;

  const workArea = await currentWorkArea();
  if (!workArea) return null;
  return { edge: detectDockEdge(bounds, workArea), bounds, workArea };
}
