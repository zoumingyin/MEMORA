import { useEffect, useState } from "react";
import {
  BorderOutlined,
  CloseOutlined,
  MinusOutlined,
} from "@ant-design/icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ConfigProvider, Image as AntdImage, theme as antdTheme } from "antd";
import { isTauriRuntime } from "../repository";

/** 从弹窗窗口 URL 参数读取 storageKey，再从 localStorage 取图片数据（只读取一次） */
function readParams(): { images: string[]; index: number; isDark: boolean } {
  const query = new URLSearchParams(location.search);
  const key = query.get("key") ?? "";
  if (!key) return { images: [], index: 0, isDark: false };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { images: [], index: 0, isDark: false };
    const data = JSON.parse(raw) as {
      images: string[];
      index: number;
      isDark: boolean;
    };
    localStorage.removeItem(key);
    return {
      images: data.images ?? [],
      index: data.index ?? 0,
      isDark: data.isDark ?? false,
    };
  } catch {
    return { images: [], index: 0, isDark: false };
  }
}

/** 自定义标题栏高度 48px：antd 预览弹层在 index.css 中整体下移让出标题栏（body.img-viewer-window 覆盖） */

// 暗色模式下的 CSS 变量（和 App.tsx 里的 DARK_TOKENS 保持一致）
// 模块级常量：引用稳定，不随组件渲染重建
const DARK_TOKENS = {
  "--panel-rgb": "32, 34, 40",
  "--panel-soft-rgb": "42, 45, 52",
  "--field-rgb": "46, 49, 56",
  "--text": "#ffffff",
  "--text-muted": "#e0dcd3",
  "--border": "rgba(236, 230, 220, 0.2)",
  "--control-border": "rgba(236, 230, 220, 0.35)",
  "--hover-fill": "rgba(255, 255, 255, 0.1)",
  "--text-halo": "none",
  "--glass-edge": "rgba(236, 230, 220, 0.12)",
  "--glass-highlight": "rgba(236, 230, 220, 0.06)",
};

// 亮色模式下需要恢复的变量
const LIGHT_TOKENS = {
  "--hover-fill": "rgba(0, 0, 0, 0.06)",
};

/**
 * 图片查看器窗口：自定义标题栏（最小化/最大化/关闭）+ antd Image 预览弹层。
 * 缩放 / 旋转 / 翻转 / 多图切换 / 前后导航均由 antd 预览工具栏提供，跟随明暗主题。
 */
export function ImagePreviewDialog() {
  // 只在组件初始化时读取一次数据，避免重新渲染时重复读取导致数据被删除
  const [params] = useState(() => readParams());
  const [current, setCurrent] = useState(params.index);
  // antd 预览弹层受控开关：初始打开；关闭（antd 关闭按钮 / 点击遮罩）后联动关闭窗口
  const [previewOpen, setPreviewOpen] = useState(true);

  // 应用主题：读取到 isDark 后，设置 CSS 变量和 dark-glass 类；
  // antd 预览的明暗由下方 ConfigProvider 的 algorithm 单独控制
  useEffect(() => {
    const rootStyle = document.documentElement.style;
    if (params.isDark) {
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
  }, [params.isDark]);

  // antd 预览弹层 portal 到 body，给 body 挂标记类，
  // 供 index.css 把弹层下移让出标题栏（仅本窗口内生效）
  useEffect(() => {
    document.body.classList.add("img-viewer-window");
    return () => document.body.classList.remove("img-viewer-window");
  }, []);

  // 窗口以隐藏方式创建（visible:false）：首帧渲染完成后再显示并聚焦，
  // 消除 Webview 加载主 bundle 期间的数秒白屏
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const win = getCurrentWindow();
    void win.show();
    void win.setFocus();
  }, []);

  const handleClose = async (): Promise<void> => {
    if (isTauriRuntime()) {
      try {
        await getCurrentWindow().close();
      } catch (e) {
        console.error("关闭窗口失败", e);
      }
    }
  };

  const handleMinimize = async (): Promise<void> => {
    if (isTauriRuntime()) {
      try {
        await getCurrentWindow().minimize();
      } catch (e) {
        console.error("最小化窗口失败", e);
      }
    }
  };

  const handleToggleMaximize = async (): Promise<void> => {
    if (isTauriRuntime()) {
      try {
        const win = getCurrentWindow();
        const isMax = await win.isMaximized();
        if (isMax) {
          await win.unmaximize();
        } else {
          await win.maximize();
        }
      } catch (e) {
        console.error("最大化窗口失败", e);
      }
    }
  };

  // antd 预览关闭（关闭按钮 / 点击遮罩）→ 关闭整个窗口
  useEffect(() => {
    if (!previewOpen) void handleClose();
  }, [previewOpen]);

  // Esc 关闭窗口（antd 预览不处理 Esc，保留自研快捷键）；左右方向键切换图片由 antd 内置处理
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPreviewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (params.images.length === 0) {
    return (
      <div className="img-viewer">
        <div className="img-viewer-titlebar">
          <span className="img-viewer-title">查看图片</span>
          <button
            type="button"
            className="img-viewer-tool-btn"
            onClick={() => void handleClose()}
          >
            <CloseOutlined />
          </button>
        </div>
        <div className="img-viewer-body">
          <p className="img-viewer-empty">没有可显示的图片</p>
        </div>
      </div>
    );
  }

  return (
    <ConfigProvider
      theme={params.isDark ? { algorithm: antdTheme.darkAlgorithm } : undefined}
    >
      <div className="img-viewer">
        {/* 顶部标题栏：仅保留窗口控制按钮（缩放/旋转/多图切换由 antd 预览工具栏提供） */}
        <div className="img-viewer-titlebar">
          <span className="img-viewer-title">查看图片</span>
          <div className="img-viewer-toolbar">
            <button
              type="button"
              className="img-viewer-tool-btn"
              title="最小化"
              onClick={() => void handleMinimize()}
            >
              <MinusOutlined />
            </button>
            <button
              type="button"
              className="img-viewer-tool-btn"
              title="最大化"
              onClick={() => void handleToggleMaximize()}
            >
              <BorderOutlined />
            </button>
            <button
              type="button"
              className="img-viewer-tool-btn"
              title="关闭 (Esc)"
              onClick={() => void handleClose()}
            >
              <CloseOutlined />
            </button>
          </div>
        </div>
      </div>

      {/* antd 图片预览：填满标题栏以下区域，缩放/旋转/翻转/多图切换由 antd 工具栏提供；
          关闭预览（按钮/Esc/点遮罩）会联动关闭整个窗口 */}
      <AntdImage.PreviewGroup
        items={params.images}
        preview={{
          open: previewOpen,
          current,
          onChange: (next) => setCurrent(next),
          onOpenChange: (open) => setPreviewOpen(open),
        }}
      />
    </ConfigProvider>
  );
}
