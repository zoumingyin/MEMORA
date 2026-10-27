import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfigProvider, Button, theme as antdTheme } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEntryStore } from "./store/useEntryStore";
import { useWindowStore } from "./store/useWindowStore";
import { useViewport } from "./hooks/useViewport";
import {
  applyAlwaysOnTop,
  isMaximized,
  loadBoundsFromStorage,
  onWindowMoved,
  onWindowResized,
  restoreBounds,
  saveBoundsToStorage,
} from "./window/tauriWindow";
import { autoSnapIfNearEdge } from "./window/edgeDock";
import { startReminderScheduler } from "./reminder/scheduler";
import { isTauriRuntime } from "./repository";
import { loadCloseBehavior } from "./window/closeBehavior";
import type { EntryKind, NewEntryInput } from "./types/entry";
import { TitleBar } from "./components/TitleBar";
import { CategoryTabs } from "./components/CategoryTabs";
import { SearchBar } from "./components/SearchBar";
import { EntryList } from "./components/EntryList";
import { DetailPane } from "./components/DetailPane";
import { DockBar } from "./components/DockBar";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { CalendarPane } from "./components/CalendarPane";
import { CreateKindDialog } from "./components/CreateKindDialog";

/** 移动事件停止多久后再判定吸附，避免读到拖拽中的旧坐标 */
const SNAP_DEBOUNCE_MS = 160;

const KIND_LABEL: Record<EntryKind, string> = {
  note: "备忘",
  reminder: "提醒",
  todo: "待办",
};

/** antd 主题主色跟随分类主题色（备忘蓝 / 提醒珊瑚红 / 待办绿） */
const KIND_COLOR: Record<EntryKind, string> = {
  note: "#5b8fd9",
  reminder: "#d9686b",
  todo: "#57a878",
};

/** 暗色玻璃变体 CSS 变量（透明度极低时注入 :root；切回亮色时全部移除恢复默认） */
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
  "--hover-fill": "rgba(255, 255, 255, 0.1)",
  // 暗色变体不叠加光晕：深色光晕在黑背景上无衬底作用，反而让亮字边缘发虚（游戏场景模糊感）
  "--text-halo": "none",
  // 暗色下玻璃亮边收敛：55% 白色边框在深色界面上是一圈刺眼的白线
  "--glass-edge": "rgba(236, 230, 220, 0.12)",
  "--glass-highlight": "rgba(236, 230, 220, 0.06)",
};

/** 亮色模式只需覆盖 hover 填充色，其余沿用 :root 默认 */
const LIGHT_TOKENS: Record<string, string> = {
  "--hover-fill": "rgba(0, 0, 0, 0.06)",
};

export default function App() {
  const docked = useWindowStore((state) => state.docked);
  const currentKind = useEntryStore((state) => state.currentKind);
  const filter = useEntryStore((state) => state.filter);
  const view = useEntryStore((state) => state.view);
  const entries = useEntryStore((state) => state.entries);
  const selectedId = useEntryStore((state) => state.selectedId);
  const setSelectedId = useEntryStore((state) => state.setSelectedId);
  const removeEntry = useEntryStore((state) => state.removeEntry);
  const opacity = useWindowStore((state) => state.opacity);
  // 响应式视口：窄窗口（<620px）切换单栏（列表 ↔ 详情）
  const { isNarrow } = useViewport();
  // 窄窗口单栏模式：是否正在查看详情（true 时列表页被详情替换）
  const [detailView, setDetailView] = useState(false);
  // 点 X 的关闭确认弹窗（Rust 拦截 CloseRequested 后触发）
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  // 快速记录弹窗（全局快捷键 Ctrl+Shift+N / 标题栏闪电按钮）
  const [quickOpen, setQuickOpen] = useState(false);
  // 「+ 新建」的类型选择弹窗
  const [createOpen, setCreateOpen] = useState(false);

  // 极低透明度（≤0.2）才自动切换暗色玻璃变体：深色面板 + 浅色文字
  // 默认亮色模式（深色文字），保证浅色/白色壁纸上的可读性
  const darkGlass = opacity <= 0.2;

  // 分层不透明度：面板跟随滑条，标题结构层与文字衬底保留下限，避免低透明度下失读。
  // 暗色/亮色共用同一套下限：暗色模式下深色底 + 浅色文字本身有对比度，
  // 透明度调低后背景变透，文字依然可读（比亮色模式下白底细字的宽容度更高）。
  const panelAlpha = Math.max(opacity, 0.3);
  const chromeAlpha = Math.max(opacity, 0.5);
  const surfaceAlpha = Math.max(opacity, 0.6);
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

  useEffect(() => {
    // 启动时加载本机条目
    void useEntryStore.getState().loadAll();
    // 启动到期提醒轮询，返回的清理函数随组件卸载执行
    const stopScheduler = startReminderScheduler();
    // 恢复上次保存的置顶状态；背景透明度由 CSS 变量直接生效
    void applyAlwaysOnTop(useWindowStore.getState().alwaysOnTop);
    // 异常恢复：重启后恢复上次的窗口位置/尺寸（仅自由悬浮态；收纳窄条不恢复，避免被吸附坐标干扰）
    if (isTauriRuntime()) {
      const savedBounds = loadBoundsFromStorage();
      if (savedBounds) void restoreBounds(savedBounds);
      // 透明窗口最大化渲染异常（任务栏有图标但界面空白）。
      // 若上次退出/双击拖拽区后窗口处于最大化，启动时统一还原为普通尺寸。
      void getCurrentWindow()
        .isMaximized()
        .then((maximized) => {
          if (maximized) void getCurrentWindow().unmaximize();
        });
    }

    let disposed = false;
    let snapTimer: number | undefined;
    let detachMoved: () => void = () => undefined;
    let detachResized: () => void = () => undefined;
    let detachOpenNote: () => void = () => undefined;
    let detachTrayNew: () => void = () => undefined;
    let detachSecondInstance: () => void = () => undefined;
    let detachCloseRequested: () => void = () => undefined;
    let detachQuickCapture: () => void = () => undefined;
    let detachFocusShown: () => void = () => undefined;

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
          const winState = useWindowStore.getState();
          if (winState.docked) {
            if (winState.restoredBounds)
              void restoreBounds(winState.restoredBounds);
            winState.clearDock();
          }
          void getCurrentWindow().setFocus();
        }
      );
      promise.then((detach) => {
        detachOpenNote = detach;
      });
    }

    // 托盘菜单「新建便签」：主窗口已由 Rust 显示聚焦，前端新建一条并选中
    if (isTauriRuntime()) {
      const trayPromise = listen("tray:new-note", () => {
        const entryState = useEntryStore.getState();
        const kind =
          entryState.filter === "all"
            ? entryState.currentKind
            : entryState.filter;
        const input: NewEntryInput = { title: "", content: "" };
        if (kind === "reminder") input.remindAt = Date.now() + 3600_000;
        void entryState.addEntry(input).then((entry) => {
          if (entry) useEntryStore.getState().setSelectedId(entry.id);
        });
      });
      trayPromise.then((detach) => {
        detachTrayNew = detach;
      });
      // 单实例二次启动：Rust 已聚焦主窗口，前端仅作兜底再聚焦一次
      const secondPromise = listen("app:second-instance", () => {
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
      // 点 X / Alt+F4：Rust 拦截关闭后发事件——已记住行为则直接执行，否则弹选择
      const closePromise = listen("window:close-requested", () => {
        const behavior = loadCloseBehavior();
        if (behavior) {
          if (behavior.action === "quit") {
            void invoke("quit_app");
          } else {
            void getCurrentWindow().hide();
          }
        } else {
          setCloseConfirmOpen(true);
        }
      });
      closePromise.then((detach) => {
        detachCloseRequested = detach;
      });
      // 全局快捷键唤起快速记录（Rust global-shortcut Ctrl+Shift+N）
      const quickPromise = listen("global:quick-capture", () => {
        setQuickOpen(true);
      });
      quickPromise.then((detach) => {
        detachQuickCapture = detach;
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

    const scheduleSnap = () => {
      window.clearTimeout(snapTimer);
      snapTimer = window.setTimeout(() => {
        const state = useWindowStore.getState();
        if (!state.edgeDocking || state.docked) return;
        void autoSnapIfNearEdge().then((result) => {
          if (!result || disposed) return;
          useWindowStore.getState().setDock(result.edge, result.bounds, false);
        });
      }, SNAP_DEBOUNCE_MS);
    };

    // 移动：吸附判定 + 保存边界（异常恢复）；收纳窄条态不覆盖保存的位置
    void onWindowMoved((bounds) => {
      if (!useWindowStore.getState().docked) saveBoundsToStorage(bounds);
      scheduleSnap();
    }).then((detach) => {
      detachMoved = detach;
    });
    // 尺寸变化：保存边界（异常恢复）。最大化状态下保存全屏尺寸会让下次启动
    // 恢复成异常的大窗口（透明窗口渲染异常），故最大化时不落盘。
    void onWindowResized(async (bounds) => {
      if (useWindowStore.getState().docked) return;
      const maximized = await isMaximized();
      if (!maximized) saveBoundsToStorage(bounds);
    }).then((detach) => {
      detachResized = detach;
    });

    return () => {
      disposed = true;
      stopScheduler();
      window.clearTimeout(snapTimer);
      window.removeEventListener("keydown", onKeyDown);
      detachMoved();
      detachResized();
      detachOpenNote();
      detachTrayNew();
      detachSecondInstance();
      detachCloseRequested();
      detachQuickCapture();
      detachFocusShown();
    };
  }, []);

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
      : "rgba(96, 84, 64, 0.28)";
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
          : "rgba(96, 84, 64, 0.14)",
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
              // 下拉 / 弹层背景：暗色实底
              colorBgElevated: "rgba(34, 36, 42, 0.97)",
              colorBgContainer: "transparent",
              colorFillTertiary: "rgba(236, 230, 220, 0.10)",
              colorFillQuaternary: "rgba(236, 230, 220, 0.05)",
            }
          : {}),
      },
      components: {
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

  if (docked) return <DockBar />;

  // 新建：弹出类型选择（备忘 / 提醒 / 待办），用户显式选择后创建
  const handleCreate = (): void => {
    setCreateOpen(true);
  };

  // 按选定类型创建并进入详情（窄窗口直接进详情页）
  const handleCreateWithKind = async (kind: EntryKind): Promise<void> => {
    const input: NewEntryInput = { title: "", content: "" };
    if (kind === "reminder") input.remindAt = Date.now() + 3600_000;
    const entry = await useEntryStore.getState().addEntry(input, kind);
    setCreateOpen(false);
    if (entry) {
      setSelectedId(entry.id);
      setDetailView(true);
    }
  };

  const handleRemove = (id: string): void => {
    setSelectedId(null);
    setDetailView(false);
    void removeEntry(id);
  };

  // 窄窗口：点条目进入详情（宽窗口忽略 detailView，两栏同显）
  const handleSelect = (id: string): void => {
    setSelectedId(id);
    setDetailView(true);
  };

  const handleBackToList = (): void => {
    setDetailView(false);
  };

  return (
    <ConfigProvider theme={antdThemeConfig}>
      <main
        className={`app-shell kind-${kindClass}`}
        data-tauri-drag-region="deep"
        style={
          {
            "--panel-alpha": panelAlpha,
            "--chrome-alpha": chromeAlpha,
            "--surface-alpha": surfaceAlpha,
            ...glassTokens,
          } as CSSProperties
        }
      >
        <TitleBar quickOpen={quickOpen} setQuickOpen={setQuickOpen} />
        <div className={`app-body${isNarrow ? " app-body-narrow" : ""}`}>
          {(!isNarrow || !detailView) && (
            <aside
              className={`note-list-pane p-x-2${view === "calendar" ? " calendar-mode" : ""}`}
            >
              {view === "calendar" ? (
                <>
                  <CategoryTabs />
                  <CalendarPane onSelect={handleSelect} />
                </>
              ) : (
                <>
                  <div className="list-filter-row">
                    <CategoryTabs />
                    <SearchBar />
                  </div>
                  <div className="list-header w-full">
                    <span className="list-title">
                      {filter === "all" ? "全部笔记" : KIND_LABEL[filter]}
                    </span>
                    <Button
                      type="primary"
                      shape="circle"
                      size="small"
                      icon={<PlusOutlined />}
                      title="新建一条"
                      onClick={handleCreate}
                    />
                  </div>
                  <EntryList selectedId={selectedId} onSelect={handleSelect} />
                </>
              )}
            </aside>
          )}
          {(!isNarrow || detailView) && (
            <DetailPane
              entry={selectedEntry}
              onRemove={handleRemove}
              onBack={isNarrow ? handleBackToList : undefined}
            />
          )}
        </div>
      </main>
      <CloseConfirmDialog
        open={closeConfirmOpen}
        onClose={() => setCloseConfirmOpen(false)}
      />
      <CreateKindDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={(kind) => void handleCreateWithKind(kind)}
      />
    </ConfigProvider>
  );
}
