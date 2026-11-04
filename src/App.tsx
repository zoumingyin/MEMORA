import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  App as AntdApp,
  ConfigProvider,
  Button,
  Badge,
  Modal,
  Drawer,
  Popconfirm,
  theme as antdTheme,
} from "antd";
import {
  AppstoreOutlined,
  PlusOutlined,
  RestOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { Sparkles } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEntryStore } from "./store/useEntryStore";
import { useWindowStore } from "./store/useWindowStore";
import { useAssistantStore } from "./store/useAssistantStore";
import { useUiStore } from "./store/useUiStore";
import { useViewport } from "./hooks/useViewport";
import {
  applyAlwaysOnTop,
  currentWorkArea,
  getBounds,
  isMaximized,
  isMinimized,
  isProgrammaticMoveRecent,
  isStorableBounds,
  loadBoundsFromStorage,
  onWindowMoved,
  onWindowResized,
  restoreBounds,
  saveBoundsToStorage,
} from "./window/tauriWindow";
import {
  acquireExpandLock,
  collapseToStripAnimated,
  detectDockEdge,
  detectDockTarget,
  EXPAND_SETTLE_MS,
  isCollapsedStrip,
  recedeStripForExpand,
  releaseExpandLock,
  unpinStrip,
} from "./window/edgeDock";
import { prewarmCtxMenuWindow } from "./window/ctxMenuWindow";
import { toMinuteStart } from "./utils/format";
import { ENTRY_KIND_COLOR, ENTRY_KIND_LABEL } from "./utils/entryLabels";
import { startReminderScheduler } from "./reminder/scheduler";
import { isTauriRuntime } from "./repository";
import type { EntryKind, NewEntryInput } from "./types/entry";
import { TitleBar } from "./components/TitleBar";
import { CategoryTabs } from "./components/CategoryTabs";
import { SearchBar } from "./components/SearchBar";
import { EntryList } from "./components/EntryList";
import { DetailPane } from "./components/DetailPane";
import { DockBar } from "./components/DockBar";
import { CalendarPane } from "./components/CalendarPane";
import { CreateKindDialog } from "./components/CreateKindDialog";
import { TrashPane } from "./components/TrashPane";
import { AssistantPanel } from "./components/AssistantPanel";

/** 移动事件停止多久后再判定贴边收纳，避免读到拖拽中的旧坐标 */
const DOCK_DEBOUNCE_MS = 160;

/** 本程序下发位置/尺寸后的忽略窗口（毫秒）：这段时间内的移动事件视为自己造成的，不做收纳判定 */
const PROGRAMMED_MOVE_MS = 900;

/** 指针离开窗口后延迟收回窄条（毫秒）：吸收擦过边缘阴影的瞬时移出，指针回到窗口即取消 */
const DOCK_LEAVE_COLLAPSE_MS = 320;

/** 托盘单击去抖窗口（毫秒）：双击会产生连续两次 Click + 一次 DoubleClick，
 *  窗口内的第二次 Click 在此忽略，交给 DoubleClick 分支统一「显示 + 展开」，
 *  否则表现为 折→展→折 来回闪 */
const TRAY_TOGGLE_DEBOUNCE_MS = 300;

/** antd 主题主色跟随分类主题色，定义收敛到 utils/entryLabels 的 ENTRY_KIND_COLOR */
const KIND_COLOR = ENTRY_KIND_COLOR;

/** 窄屏视图切换选项：网格 / 列表 */
const ENTRY_VIEW_OPTIONS = [
  { value: "grid", label: "网格视图", icon: <AppstoreOutlined /> },
  { value: "list", label: "列表视图", icon: <UnorderedListOutlined /> },
] as const;

/** 废纸篓计数徽标：固定正圆，两位数起缩小字号避免被数字撑成椭圆 */
const trashBadgeStyles = (count: number) => ({
  indicator: {
    width: 16,
    height: 16,
    lineHeight: "16px",
    paddingInline: 0,
    borderRadius: "50%",
    fontSize: count > 9 ? 9 : 10,
  },
});

/** 暗色玻璃变体 CSS 变量（暗色主题时注入 :root；切回亮色时全部移除恢复默认） */
const DARK_TOKENS: Record<string, string> = {
  "--panel-rgb": "32, 34, 40",
  "--panel-soft-rgb": "42, 45, 52",
  "--field-rgb": "46, 49, 56",
  // 文字调亮一档：半透明背景叠加浅色壁纸后仍有足够对比度
  "--text": "#ffffff",
  "--text-muted": "#e0dcd3",
  "--border": "rgba(236, 230, 220, 0.2)",
  /* 控件边框（暗色）：可见但不刺眼的暖白 */
  "--control-border": "rgba(236, 230, 220, 0.35)",
  "--note": "#2563eb",
  "--hover-fill": "rgba(255, 255, 255, 0.1)",
  // 暗色变体不叠加光晕：深色光晕在黑背景上无衬底作用，反而让亮字边缘发虚（游戏场景模糊感）
  "--text-halo": "none",
  // 暗色下玻璃亮边收敛：55% 白色边框在深色界面上是一圈刺眼的白线
  "--glass-edge": "rgba(236, 230, 220, 0.12)",
  "--glass-highlight": "rgba(236, 230, 220, 0.06)",
};

/** 亮色模式：对齐参考风（白底画布 + 发丝边框 + 中性灰次要文字 + 鲜亮蓝主色），其余沿用 :root 默认 */
const LIGHT_TOKENS: Record<string, string> = {
  "--hover-fill": "rgba(16, 24, 40, 0.05)",
  "--text-muted": "#6b7280",
  "--panel-rgb": "248, 249, 251",
  "--panel-soft-rgb": "240, 242, 246",
  "--field-rgb": "255, 255, 255",
  "--border": "rgba(16, 24, 40, 0.09)",
  "--control-border": "rgba(16, 24, 40, 0.16)",
  "--note": "#2563eb",
};

export default function App() {
  // 使用 Context 版 message，提示可继承动态主题（静态 message 拿不到 ConfigProvider）
  const { message } = AntdApp.useApp();
  const docked = useWindowStore((state) => state.docked);
  // 收纳出场动画进行中：仍渲染主界面（播放 dock-out-*），播完才换窄条
  const collapsing = useWindowStore((state) => state.collapsing);
  const dockedEdge = useWindowStore((state) => state.dockedEdge);
  // 主界面滑入方向提示（托盘/快捷键展开时 dockedEdge 已清空，据此仍播放滑入动画）
  const slideFromEdge = useWindowStore((state) => state.slideFromEdge);
  const currentKind = useEntryStore((state) => state.currentKind);
  const filter = useEntryStore((state) => state.filter);
  const view = useEntryStore((state) => state.view);
  const entries = useEntryStore((state) => state.entries);
  const trash = useEntryStore((state) => state.trash);
  const moveToTrash = useEntryStore((state) => state.moveToTrash);
  const selectedId = useEntryStore((state) => state.selectedId);
  const setSelectedId = useEntryStore((state) => state.setSelectedId);
  const opacity = useWindowStore((state) => state.opacity);
  const theme = useWindowStore((state) => state.theme);
  // 窄屏展示偏好（网格 / 列表）；宽屏固定贴纸墙，不读取该偏好
  const entryView = useUiStore((state) => state.entryView);
  const setEntryView = useUiStore((state) => state.setEntryView);
  // 贴纸墙「智能归整」：清空自由摆放坐标，回到默认的最近编辑网格
  const clearWallPositions = useUiStore((state) => state.clearWallPositions);
  // 响应式视口：窄窗口（<620px）切换单栏（列表 ↔ 详情）
  const { isNarrow } = useViewport();
  // 窄窗口单栏模式：是否正在查看详情（true 时列表页被详情替换）
  const [detailView, setDetailView] = useState(false);
  // 快速记录弹窗（全局快捷键 Ctrl+Shift+N / 标题栏闪电按钮）
  const [quickOpen, setQuickOpen] = useState(false);
  // 「+ 新建」的类型选择弹窗
  const [createOpen, setCreateOpen] = useState(false);
  // 废纸篓视图：开启后左侧列表区域替换为 TrashPane（不持久化，重启回到列表）
  const [trashOpen, setTrashOpen] = useState(false);

  // 主题由设置项手动切换（亮色 / 暗色），与背景透明度互不影响；
  // 暗色主题：深色面板 + 浅色文字；默认亮色主题（深色文字），保证浅色/白色壁纸上的可读性
  const darkGlass = theme === "dark";

  // 分层不透明度：面板跟随滑条，标题结构层与文字衬底保留下限，避免低透明度下失读。
  // 暗色主题深底浅字本身对比度高：下限放宽（0.15/0.2/0.25），透明度随滑条平滑变化；
  // 亮色主题白底深字：保底下限较高（0.3/0.5/0.6），防止低透明度下白底细字失读。
  const panelAlpha = darkGlass
    ? Math.max(opacity, 0.15)
    : Math.max(opacity, 0.3);
  const chromeAlpha = darkGlass
    ? Math.max(opacity, 0.2)
    : Math.max(opacity, 0.5);
  const surfaceAlpha = darkGlass
    ? Math.max(opacity, 0.25)
    : Math.max(opacity, 0.6);
  // AI 面板为覆盖层：保底更高的不透明衬底，避免背后列表文字透过玻璃干扰阅读
  const assistantAlpha = Math.max(chromeAlpha, 0.86);
  const glassTokens = useMemo(
    () => (darkGlass ? DARK_TOKENS : LIGHT_TOKENS),
    [darkGlass]
  );

  // 暗色/亮色变量同步到 :root（documentElement）——仅注入 main 内联变量时，
  // 标题栏等继承 body 颜色且无显式 color 的文字会取到 :root 默认深色，暗色模式下变糊
  useEffect(() => {
    const rootStyle = document.documentElement.style;
    if (darkGlass) {
      // 暗色标记类：供 CSS 选择器针对性提亮空态/提示文字（antd Empty、detail-empty 等）
      document.documentElement.classList.add("dark-glass");
      for (const [key, value] of Object.entries(DARK_TOKENS)) {
        rootStyle.setProperty(key, value);
      }
    } else {
      document.documentElement.classList.remove("dark-glass");
      for (const key of Object.keys(DARK_TOKENS)) {
        rootStyle.removeProperty(key);
      }
      for (const [key, value] of Object.entries(LIGHT_TOKENS)) {
        rootStyle.setProperty(key, value);
      }
    }
  }, [darkGlass]);

  // 分类主题色同步到 :root：下拉/弹窗等 portal 元素在 main 外，取不到 main 内联的 --kind-accent。
  // 计算逻辑与渲染层 kindClass 保持一致（显式选中 → 第一条兜底 → currentKind）
  useEffect(() => {
    const kind =
      (selectedId && entries.find((entry) => entry.id === selectedId)?.kind) ||
      entries[0]?.kind ||
      currentKind;
    document.documentElement.style.setProperty(
      "--kind-accent",
      KIND_COLOR[kind]
    );
  }, [selectedId, currentKind, entries]);

  // 预热 Markdown 右键菜单窗口：启动稳定后隐藏创建一次，首次右键也无需等待窗口加载。
  // Rust 数据加载不依赖页面，故延时创建，避免与首屏渲染争抢资源。
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const timer = window.setTimeout(prewarmCtxMenuWindow, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    // 启动时加载本机条目 + 废纸篓计数（角标展示）
    void useEntryStore.getState().loadAll();
    void useEntryStore.getState().loadTrash();
    // 启动到期提醒轮询，返回的清理函数随组件卸载执行
    const stopScheduler = startReminderScheduler();
    // 恢复上次保存的置顶状态；背景透明度由 CSS 变量直接生效
    void applyAlwaysOnTop(useWindowStore.getState().alwaysOnTop);
    // 首次启动按配置默认尺寸（422×540）打开；之后每次启动恢复上次会话保存的尺寸/位置
    // （仅自由悬浮态；收纳窄条不恢复，避免被吸附坐标干扰）。
    // 透明窗口最大化渲染异常（任务栏有图标但界面空白）：
    // 若上次退出/双击拖拽区后窗口处于最大化，启动时统一还原为普通尺寸。
    if (isTauriRuntime()) {
      const savedBounds = loadBoundsFromStorage();
      if (savedBounds) void restoreBounds(savedBounds);
      void getCurrentWindow()
        .isMaximized()
        .then((maximized) => {
          if (maximized) void getCurrentWindow().unmaximize();
        });
    }

    let disposed = false;
    let dockTimer: number | undefined;
    let detachMoved: () => void = () => undefined;
    let detachResized: () => void = () => undefined;
    let detachOpenNote: () => void = () => undefined;
    let detachTrayCreate: () => void = () => undefined;
    let detachTrayAssistant: () => void = () => undefined;
    let detachTrayToggle: () => void = () => undefined;
    let detachSecondInstance: () => void = () => undefined;
    let detachQuickCapture: () => void = () => undefined;
    let detachToggleWindow: () => void = () => undefined;
    let detachWindowShown: () => void = () => undefined;
    let detachFocusShown: () => void = () => undefined;

    // 收纳窄条态不渲染列表与弹窗：托盘 / 提醒唤起前先展开回普通窗口。
    // drawer 式展开：窄条先滑进边缘收起（同时保证撑窗瞬间上一帧全透明防闪），
    // 窗口原子撑大后主界面从同侧滑入。先撑窗口再换界面——反过来的话，
    // 撑开失败时就变成「主界面画在窄条宽度的窗口里」的挤扁状态。
    // 返回 Promise：托盘单击的「隐藏+收纳」分支要等展开完成后再 show，
    // 避免窄条先闪一帧；其余调用方保持 fire-and-forget 不受影响
    const expandIfDocked = (): Promise<void> => {
      if (!acquireExpandLock()) return Promise.resolve();
      return (async () => {
        try {
          let winState = useWindowStore.getState();
          let edge = winState.dockedEdge;
          let docked = winState.docked;
          // 状态自愈：展开/收纳竞态可能留下「窗口已是窄条尺寸、docked 却是 false」
          // 的脏状态（表现为贴边后便签消失、显示主窗口也无反应）。
          // 按当前几何重建收纳会话再展开；正常尺寸的窗口不命中此分支，行为不变
          if (!docked) {
            const bounds = await getBounds();
            const area = await currentWorkArea();
            const stripShaped =
              !!bounds &&
              (isCollapsedStrip(bounds, "left") ||
                isCollapsedStrip(bounds, "top"));
            if (bounds && area && stripShaped) {
              const detected = detectDockEdge(bounds, area);
              edge =
                detected ??
                (isCollapsedStrip(bounds, "left") ? "left" : "top");
              docked = true;
              useWindowStore.getState().setDock(edge, bounds, true);
              winState = useWindowStore.getState();
            } else if (bounds && area) {
              // 窗口整个落在工作区外（收纳/竞态残留）：夹回可见区即完成「重新显示」
              const outside =
                bounds.x + bounds.width <= area.x ||
                bounds.x >= area.x + area.width ||
                bounds.y + bounds.height <= area.y ||
                bounds.y >= area.y + area.height;
              if (outside) {
                await restoreBounds(bounds, EXPAND_SETTLE_MS);
                return;
              }
            }
          }
          if (!docked) return;
          if (edge) await recedeStripForExpand(edge);
          const bounds = winState.restoredBounds ?? (await getBounds());
          // restoreBounds 回读确认窗口真的撑开了才换界面：撑不开就恢复窄条，
          // 否则主界面会画在窄条宽度的窗口里，挤成一条没法操作
          if (bounds && (await restoreBounds(bounds, EXPAND_SETTLE_MS))) {
            // 结束收纳会话（鼠标移出不再收回），但保留滑入方向供主界面播放动画
            winState.setSlideFrom(edge);
            winState.clearDock();
            window.setTimeout(
              () => useWindowStore.getState().setSlideFrom(null),
              600,
            );
          } else {
            unpinStrip();
          }
        } finally {
          releaseExpandLock();
        }
      })();
    };

    // 提醒弹窗「进入便签」：主窗口聚焦，选中对应条目并切到该分类；收纳态先展开
    if (isTauriRuntime()) {
      const promise = listen<{ entryId: string; alarmId?: string }>(
        "reminder:open-note",
        (event) => {
          const { entryId } = event.payload;
          const entryState = useEntryStore.getState();
          const entry = entryState.entries.find((item) => item.id === entryId);
          if (entry) {
            entryState.setFilter(entry.kind);
            entryState.setSelectedId(entryId);
          }
          expandIfDocked();
          void getCurrentWindow().setFocus();
        }
      );
      promise.then((detach) => {
        detachOpenNote = detach;
      });
    }

    // 托盘菜单「新建便签」：主窗口已由 Rust 显示聚焦，前端弹出类型选择弹窗
    if (isTauriRuntime()) {
      const trayPromise = listen("tray:create-entry", () => {
        expandIfDocked();
        setCreateOpen(true);
      });
      trayPromise.then((detach) => {
        detachTrayCreate = detach;
      });
      // 托盘菜单「AI 助手」：主窗口已由 Rust 显示聚焦，前端打开助手面板
      const trayAssistantPromise = listen("tray:open-assistant", () => {
        expandIfDocked();
        useAssistantStore.getState().openPanel();
      });
      trayAssistantPromise.then((detach) => {
        detachTrayAssistant = detach;
      });
      // 托盘左键单击（任务栏图标）：显示/隐藏切换的判定挪到前端——
      // 只有前端知道收纳态，收纳时点击图标应弹出展开而不是把窄条隐藏掉
      let lastToggleAt = 0;
      const trayTogglePromise = listen("tray:toggle-main", async () => {
        // 双击去抖：第二次 Click 在窗口内忽略，由 DoubleClick 分支统一显示+展开
        const now = Date.now();
        if (now - lastToggleAt < TRAY_TOGGLE_DEBOUNCE_MS) return;
        lastToggleAt = now;
        const winState = useWindowStore.getState();
        const win = getCurrentWindow();
        // 收纳窄条态（含窄条被隐藏的情况）：单击 = 显示 + 自动展开，不做隐藏切换。
        // 隐藏态下先在后台把窗口撑回正常尺寸再 show：直接 show 会让窄条
        // 先闪一帧、随后才被展开替换
        if (winState.docked) {
          await expandIfDocked();
          void win.unminimize();
          void win.show();
          void win.setFocus();
          return;
        }
        // 与原 Rust 侧判定一致：可见性读取失败按可见处理，最小化读取失败按未最小化处理
        const visible = await win.isVisible().catch(() => true);
        const minimized = await win.isMinimized().catch(() => false);
        if (visible && !minimized) {
          void win.hide();
        } else {
          void win.unminimize();
          void win.show();
          void win.setFocus();
          // 窗口若处于「窄条尺寸但 docked=false」的脏状态（展开/收纳竞态残留），
          // 顺带自愈展开；正常尺寸时空操作
          expandIfDocked();
        }
      });
      trayTogglePromise.then((detach) => {
        detachTrayToggle = detach;
      });
      // 单实例二次启动：Rust 已聚焦主窗口，前端兜底再聚焦一次；收纳窄条态先展开
      const secondPromise = listen("app:second-instance", () => {
        expandIfDocked();
        void getCurrentWindow().setFocus();
      });
      secondPromise.then((detach) => {
        detachSecondInstance = detach;
      });
      // 透明无边框窗口在 Windows 上 hide→show 后，WebView2 有时不重绘
      // （窗口已可见但画面空白，任务栏有图标、界面不出现）。
      // 托盘/快捷键/二次启动恢复显示都会带来焦点事件，收到后强制刷新一次合成层。
      const focusPromise = getCurrentWindow().onFocusChanged(
        ({ payload: focused }) => {
          if (!focused) return;
          requestAnimationFrame(() => {
            document.documentElement.style.transform = "translateZ(0)";
            requestAnimationFrame(() => {
              document.documentElement.style.transform = "";
            });
          });
        }
      );
      focusPromise.then((detach) => {
        detachFocusShown = detach;
      });
      // 点 X / Alt+F4：Rust 端拦截后直接隐藏到系统托盘，前端无需处理
      // 全局快捷键唤起快速记录（Rust global-shortcut Ctrl+Shift+N）
      // 收纳窄条态不渲染主界面与弹窗：先展开回普通窗口，quickOpen 状态保留，
      // 展开完成后快速记录弹窗随主界面一起出现
      const quickPromise = listen("global:quick-capture", () => {
        expandIfDocked();
        setQuickOpen(true);
      });
      quickPromise.then((detach) => {
        detachQuickCapture = detach;
      });
      // 全局快捷键 Ctrl+Shift+Space：窗口可见且聚焦时隐藏；收纳窄条态改为展开
      const togglePromise = listen("global:toggle-window", () => {
        const winState = useWindowStore.getState();
        if (winState.docked) {
          expandIfDocked();
          void getCurrentWindow().setFocus();
          return;
        }
        void getCurrentWindow().hide();
      });
      togglePromise.then((detach) => {
        detachToggleWindow = detach;
      });
      // 窗口隐藏时按下快捷键：Rust 已显示并聚焦，前端负责把收纳窄条展开
      const shownPromise = listen("global:window-shown", () => {
        expandIfDocked();
      });
      shownPromise.then((detach) => {
        detachWindowShown = detach;
      });
    }
    // 网页/预览环境兜底：Ctrl+Shift+N 同样唤起（bu 预览与 Web 兜底仓储可用）
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        (event.key === "N" || event.key === "n")
      ) {
        event.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    const scheduleDock = () => {
      window.clearTimeout(dockTimer);
      dockTimer = window.setTimeout(() => {
        const state = useWindowStore.getState();
        if (!state.edgeDocking || state.docked) return;
        // 只看用户拖拽：本程序刚下发过位置/尺寸（悬停展开、启动恢复），
        // 由此产生的移动事件不算「拖到边缘」，否则展开后马上又收回去
        if (isProgrammaticMoveRecent(PROGRAMMED_MOVE_MS)) return;
        void detectDockTarget().then(async (scan) => {
          if (!scan || disposed) return;
          const state = useWindowStore.getState();
          // 停手但没贴边：用户把窗口拖离了边缘，结束收纳会话（此后移出窗口不再收回窄条）
          if (!scan.edge) {
            state.clearDock();
            return;
          }
          // 先置收纳态再缩窗：缩窗触发的 move/resize 事件到达时 docked 已为 true，
          // 既不会把窄条尺寸写进启动恢复存储，也不会再排一轮检测
          // （collapseToStripAnimated 内部先 setDock 再播出场动画、最后缩窗）
          if (useWindowStore.getState().collapsing) return;
          const started = await collapseToStripAnimated(
            scan.edge,
            scan.bounds,
            scan.workArea,
          );
          // 展开流程持锁期间收纳被拒：回滚收纳态，避免「docked=true 但窗口
          // 还是正常尺寸」导致 DockBar 渲染成一大块色板
          if (!started) state.clearDock();
        });
      }, DOCK_DEBOUNCE_MS);
    };

    // 移动：贴边收纳判定 + 保存边界（供下次启动恢复）；收纳窄条态不覆盖保存的位置。
    // 最小化时 Windows 会把窗口矩形挪到屏幕外（-25600）并缩成窄条，这类脏边界既不落盘也不收纳。
    void onWindowMoved((bounds) => {
      if (!isStorableBounds(bounds)) return;
      if (!useWindowStore.getState().docked) saveBoundsToStorage(bounds);
      scheduleDock();
    }).then((detach) => {
      detachMoved = detach;
    });
    // 尺寸变化：保存边界（供下次启动恢复）。最大化状态落盘会让下次启动恢复成
    // 异常大窗口（透明窗口渲染异常），故最大化时不落盘。
    void onWindowResized(async (bounds) => {
      // 最小化检测：Windows 最小化时窗口矩形缩成约 160×28（IsIconic 为真）。
      // 收纳窄条被点任务栏按钮会最小化到屏幕外——这正是「贴边后便签消失」的路径；
      // 按需求改为弹出展开：任务栏点击收纳态便签 = 显示 + 自动展开。
      // 普通窗口的最小化保持系统默认行为，不干预
      if (bounds.width <= 200 && bounds.height <= 60) {
        if (await isMinimized()) {
          if (useWindowStore.getState().docked) {
            void (async () => {
              const win = getCurrentWindow();
              await win.unminimize();
              await expandIfDocked();
              await win.setFocus();
            })();
          }
          return;
        }
      }
      if (!isStorableBounds(bounds)) return;
      if (useWindowStore.getState().docked) return;
      const maximized = await isMaximized();
      if (!maximized) saveBoundsToStorage(bounds);
    }).then((detach) => {
      detachResized = detach;
    });

    return () => {
      disposed = true;
      stopScheduler();
      window.clearTimeout(dockTimer);
      window.removeEventListener("keydown", onKeyDown);
      detachMoved();
      detachResized();
      detachOpenNote();
      detachTrayCreate();
      detachTrayAssistant();
      detachTrayToggle();
      detachSecondInstance();
      detachQuickCapture();
      detachToggleWindow();
      detachWindowShown();
      detachFocusShown();
    };
  }, []);

  // 窄条展开后「鼠标移出窗口就收回」：展开时窄条组件已卸载，没人再监听它的 mouseleave，
  // 所以这一半逻辑挂在窗口级——指针离开文档可视区即收回，回到窗口则取消这次收回。
  useEffect(() => {
    if (!dockedEdge || docked) return;
    const root = document.documentElement;
    let timer: number | undefined;
    const cancel = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };
    const collapse = () => {
      timer = undefined;
      const state = useWindowStore.getState();
      const edge = state.dockedEdge;
      const bounds = state.restoredBounds;
      if (!edge || !bounds || state.docked || !state.edgeDocking) return;
      void (async () => {
        const workArea = await currentWorkArea();
        const latest = useWindowStore.getState();
        // 取工作区期间会话变了（托盘展开、拖离边缘）：不再下发
        if (!workArea || latest.docked || latest.dockedEdge !== edge) return;
        // 收纳出场动画进行中（另一条路径已在收）：不重入
        if (latest.collapsing) return;
        const started = await collapseToStripAnimated(edge, bounds, workArea);
        // 展开流程持锁期间收纳被拒：回到「已展开、保留会话」的原状态
        if (!started) useWindowStore.getState().setDock(edge, bounds, false);
      })();
    };
    const onLeave = () => {
      cancel();
      timer = window.setTimeout(collapse, DOCK_LEAVE_COLLAPSE_MS);
    };
    root.addEventListener("mouseleave", onLeave);
    root.addEventListener("mouseenter", cancel);
    return () => {
      cancel();
      root.removeEventListener("mouseleave", onLeave);
      root.removeEventListener("mouseenter", cancel);
    };
  }, [dockedEdge, docked]);

  // 选中项由列表派生：显式选中失效（删除 / 外部变更）时自动回落第一条，无需 effect 同步。
  // 提前到主题配置之前计算（主题需按 kindClass 注入主色）。
  const selectedEntry =
    (selectedId && entries.find((entry) => entry.id === selectedId)) ||
    entries[0] ||
    null;
  // 界面主题色跟随当前详情条目分类；未选中时跟随最后使用的分类
  const kindClass = selectedEntry ? selectedEntry.kind : currentKind;

  // antd 主题集中控制：暗色/亮色算法 + 全局 token + 组件级配置。
  // 此前散落的 CSS !important 覆盖（下拉选中项 / primary 阴影 / 各输入控件边框 / focus ring）全部收敛到此处，
  // 暗色模式用 darkAlgorithm 让所有 antd 控件自动切深色背景 + 浅色文字。
  const antdThemeConfig = useMemo(() => {
    const primary = KIND_COLOR[kindClass];
    const controlBorder = darkGlass
      ? "rgba(236, 230, 220, 0.3)"
      : "rgba(16, 24, 40, 0.16)";
    return {
      algorithm: darkGlass
        ? antdTheme.darkAlgorithm
        : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: primary,
        colorInfo: primary,
        // 控件边框统一色（普通 / 聚焦 / hover）
        colorBorder: controlBorder,
        colorBorderSecondary: darkGlass
          ? "rgba(236, 230, 220, 0.14)"
          : "rgba(16, 24, 40, 0.09)",
        // 去掉 focus ring（主色光晕）
        controlOutline: "transparent",
        controlOutlineWidth: 0,
        borderRadius: 8,
        ...(darkGlass
          ? {
              colorText: "#f6f3ed",
              colorTextSecondary: "#c9c3b8",
              colorTextTertiary: "#b8b2a7",
              colorTextPlaceholder: "#b8b2a7",
              // 下拉 / 弹层背景：暗色不透明实底（避免透出底层卡片）
              colorBgElevated: "rgb(34, 36, 42)",
              colorBgContainer: "transparent",
              colorFillTertiary: "rgba(236, 230, 220, 0.10)",
              colorFillQuaternary: "rgba(236, 230, 220, 0.05)",
            }
          : {
              // 亮色模式：弹层 / 输入容器跟随白色面板，对齐参考风（白底 + 中性灰 + 发丝边框）
              colorText: "#1f2937",
              colorTextSecondary: "#6b7280",
              colorTextTertiary: "#6b7280",
              colorTextPlaceholder: "#6b7280",
              colorBgElevated: "rgba(255, 255, 255, 0.97)",
              colorBgContainer: "rgba(255, 255, 255, 0.95)",
            }),
      },
      components: {
        // 下拉菜单（Dropdown）：暗色下选中项默认主色蓝字压深蓝底，对比度差；
        // 暗色用更亮的蓝字 + 略深选中底，分组标题提亮，确保可读
        Menu: {
          itemColor: darkGlass ? "#e8e4dc" : "#1f2937",
          // 暗色选中项：白字 + 蓝底（避免原蓝字压深蓝底看不清）；亮色保持主色蓝字
          itemSelectedColor: darkGlass ? "#ffffff" : primary,
          itemSelectedBg: darkGlass
            ? primary
            : `color-mix(in srgb, ${primary} 18%, transparent)`,
          itemActiveBg: darkGlass
            ? "rgba(255, 255, 255, 0.08)"
            : "rgba(0, 0, 0, 0.05)",
          itemGroupTitleColor: darkGlass ? "#c9c3b8" : "#6b7280",
          // 弹层背景：暗色不透明实底，避免透出底层卡片
          popupBg: darkGlass ? "rgb(34, 36, 42)" : "rgb(255, 255, 255)",
        },
        Select: {
          // 选中项主题色浅底 + 主色文字（替代原发白的 colorPrimaryBg）
          optionSelectedBg: `color-mix(in srgb, ${primary} 18%, transparent)`,
          optionSelectedColor: primary,
          optionActiveBg: darkGlass
            ? "rgba(255, 255, 255, 0.08)"
            : "rgba(0, 0, 0, 0.05)",
        },
        Input: {
          activeBorderColor: controlBorder,
          hoverBorderColor: controlBorder,
        },
        InputNumber: {
          activeBorderColor: controlBorder,
          hoverBorderColor: controlBorder,
        },
        DatePicker: {
          activeBorderColor: controlBorder,
          hoverBorderColor: controlBorder,
        },
        // primary 按钮去掉默认主色浅底投影（暗色界面上的白横条）
        Button: {
          primaryShadow: "none",
        },
        Modal: {
          titleFontSize: 15,
        },
      },
    } as const;
  }, [darkGlass, kindClass]);

  if (docked && !collapsing) return <DockBar />;

  // 新建：弹出类型选择（备忘 / 提醒 / 待办），用户显式选择后创建
  const handleCreate = (): void => {
    setCreateOpen(true);
  };

  // 按选定类型创建并进入详情（窄窗口直接进详情页）
  const handleCreateWithKind = async (kind: EntryKind): Promise<void> => {
    const input: NewEntryInput = { title: "", content: "" };
    if (kind === "reminder")
      input.remindAt = toMinuteStart(Date.now() + 3600_000);
    const entry = await useEntryStore.getState().addEntry(input, kind);
    setCreateOpen(false);
    if (entry) {
      setSelectedId(entry.id);
      setDetailView(true);
    }
  };

  // 删除 = 移入废纸篓（软删除），可从废纸篓恢复
  const handleRemove = (id: string): void => {
    setSelectedId(null);
    setDetailView(false);
    void moveToTrash(id);
  };

  // 打开废纸篓视图：拉取最新内容并退出详情
  const handleOpenTrash = (): void => {
    setTrashOpen(true);
    setDetailView(false);
    void useEntryStore.getState().loadTrash();
  };

  const handleCloseTrash = (): void => {
    setTrashOpen(false);
  };

  const handleEmptyTrash = (): void => {
    void useEntryStore
      .getState()
      .emptyTrash()
      .then(() => message.success("废纸篓已清空"));
  };

  // 窄窗口：点条目进入详情（宽窗口忽略 detailView，两栏同显）
  const handleSelect = (id: string): void => {
    setSelectedId(id);
    setDetailView(true);
  };

  const handleBackToList = (): void => {
    setDetailView(false);
  };

  // 智能归整：撤销自由摆放，按当前排序（默认最近编辑）重新铺成整齐网格
  const handleTidyWall = (): void => {
    clearWallPositions();
    message.success("已按最近编辑重新归整");
  };

  return (
    <ConfigProvider theme={antdThemeConfig}>
      {/* 这里再嵌套一层 App：让 message 的承载节点落在动态主题的 ConfigProvider 内，
          暗色模式下提示也能跟随；component={false} 不额外产生包裹元素 */}
      <AntdApp component={false}>
        {/* 展开时 <main> 是重新挂载的，dock-in-* 动画随挂载自动播放一次，不需要计时器清理 */}
        <main
          className={`app-shell kind-${kindClass} relative${
            collapsing && dockedEdge
              ? ` dock-out-${dockedEdge}`
              : dockedEdge
                ? ` dock-in-${dockedEdge}`
                : slideFromEdge
                  ? ` dock-in-${slideFromEdge}`
                  : ""
          }`}
          data-tauri-drag-region="deep"
          style={
            {
              "--panel-alpha": panelAlpha,
              "--chrome-alpha": chromeAlpha,
              "--surface-alpha": surfaceAlpha,
              "--assistant-alpha": assistantAlpha,
              ...glassTokens,
            } as CSSProperties
          }
        >
          <TitleBar quickOpen={quickOpen} setQuickOpen={setQuickOpen} />
          <div className={`app-body${isNarrow ? " app-body-narrow" : ""}`}>
            {isNarrow ? (
              detailView ? (
                <DetailPane
                  entry={selectedEntry}
                  onRemove={handleRemove}
                  onBack={handleBackToList}
                />
              ) : (
                <aside
                  className={`note-list-pane p-x-2${view === "calendar" ? " calendar-mode" : ""}`}
                >
                  {view === "calendar" ? (
                    <>
                      <CategoryTabs />
                      <CalendarPane onSelect={handleSelect} />
                    </>
                  ) : trashOpen ? (
                    <TrashPane onBack={handleCloseTrash} />
                  ) : (
                    <>
                      <div className="flex items-center">
                        <CategoryTabs />
                        <SearchBar />
                      </div>
                      <div className="list-header w-full">
                        <span className="list-title">
                          {filter === "all" ? "全部笔记" : ENTRY_KIND_LABEL[filter]}
                        </span>
                        <div
                          className="flex shrink-0 items-center gap-0.5 rounded-[9px] bg-[var(--hover-fill)] p-0.5"
                          role="group"
                          aria-label="切换列表展示模式"
                          data-tauri-drag-region="false"
                        >
                          {ENTRY_VIEW_OPTIONS.map((option) => {
                            const active = entryView === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                title={option.label}
                                aria-label={option.label}
                                aria-pressed={active}
                                className={`flex h-6 w-6 items-center justify-center rounded-[7px] border-0 text-[12px] transition-colors duration-150 ${
                                  active
                                    ? "bg-[var(--card-bg)] text-[var(--text)] shadow-[0_1px_2px_rgba(16,24,40,0.12)]"
                                    : "bg-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
                                }`}
                                onClick={() => setEntryView(option.value)}
                              >
                                {option.icon}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Badge
                            count={trash.length}
                            size="small"
                            offset={[-3, 3]}
                            title={`废纸篓（${trash.length} 条）`}
                            styles={trashBadgeStyles(trash.length)}
                          >
                            <Button
                              type="text"
                              shape="circle"
                              size="small"
                              icon={<RestOutlined />}
                              title="废纸篓"
                              onClick={handleOpenTrash}
                            />
                          </Badge>
                          <Button
                            type="primary"
                            shape="circle"
                            size="small"
                            icon={<PlusOutlined />}
                            title="新建一条"
                            onClick={handleCreate}
                          />
                        </div>
                      </div>
                      <EntryList onSelect={handleSelect} mode={entryView} />
                    </>
                  )}
                </aside>
              )
            ) : view === "calendar" ? (
              <>
                <aside className="note-list-pane p-x-2 calendar-mode">
                  <CategoryTabs />
                  <CalendarPane onSelect={handleSelect} />
                </aside>
                <DetailPane entry={selectedEntry} onRemove={handleRemove} />
              </>
            ) : (
              <>
                <section
                  className="wall-pane"
                  data-tauri-drag-region="false"
                  aria-label="便签贴纸墙"
                >
                  <header className="wall-toolbar">
                    <span className="wall-hint">
                      <span className="wall-hint-dot" aria-hidden="true" />
                      便签贴纸墙 · 按住卡片拖到任意位置
                    </span>
                    <div className="wall-toolbar-actions">
                      <Badge
                        count={trash.length}
                        size="small"
                        offset={[-2, 5]}
                        title={`废纸篓（${trash.length} 条）`}
                        styles={trashBadgeStyles(trash.length)}
                      >
                        <button
                          type="button"
                          className="wall-tool-btn"
                          title="废纸篓"
                          aria-label="废纸篓"
                          onClick={handleOpenTrash}
                        >
                          <RestOutlined />
                        </button>
                      </Badge>
                      <button
                        type="button"
                        className="wall-tool-btn"
                        title="按最近编辑重新归整"
                        onClick={handleTidyWall}
                      >
                        <Sparkles size={13} />
                        <span>智能归整</span>
                      </button>
                      <button
                        type="button"
                        className="wall-new-btn"
                        title="贴新便签"
                        onClick={handleCreate}
                      >
                        <PlusOutlined />
                        <span>贴新便签</span>
                      </button>
                    </div>
                  </header>
                  <div className="wall-filters">
                    <CategoryTabs />
                    <SearchBar />
                  </div>
                  <EntryList onSelect={handleSelect} mode="wall" />
                </section>
                {detailView && selectedEntry && (
                  <Modal
                    open
                    onCancel={handleBackToList}
                    footer={null}
                    centered
                    width={680}
                    destroyOnHidden
                    className="wall-detail-modal"
                  >
                    <div
                      className="wall-detail-dialog"
                      data-tauri-drag-region="false"
                    >
                      <DetailPane
                        entry={selectedEntry}
                        onRemove={handleRemove}
                      />
                    </div>
                  </Modal>
                )}
                <Drawer
                  open={trashOpen}
                  onClose={handleCloseTrash}
                  placement="right"
                  width={420}
                  destroyOnHidden
                  rootClassName="trash-drawer"
                  title={
                    <span className="flex items-center gap-2">
                      废纸篓
                      <span className="text-[11px] font-normal text-[var(--text-muted)]">
                        {trash.length} 条
                      </span>
                    </span>
                  }
                  extra={
                    <Popconfirm
                      title="清空废纸篓"
                      description="将彻底删除全部条目，不可恢复"
                      okText="清空"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={handleEmptyTrash}
                      disabled={trash.length === 0}
                    >
                      <Button
                        type="text"
                        danger
                        size="small"
                        disabled={trash.length === 0}
                      >
                        清空
                      </Button>
                    </Popconfirm>
                  }
                >
                  <TrashPane onBack={handleCloseTrash} embedded />
                </Drawer>
              </>
            )}
          </div>
          <AssistantPanel />
        </main>
        <CreateKindDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreate={(kind) => void handleCreateWithKind(kind)}
        />
      </AntdApp>
    </ConfigProvider>
  );
}
