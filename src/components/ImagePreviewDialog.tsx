import { useEffect, useState } from "react";
import {
  BorderOutlined,
  CloseOutlined,
  MinusOutlined,
} from "@ant-design/icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Image as AntdImage } from "antd";
import { isTauriRuntime } from "../repository";

interface PreviewParams {
  images: string[];
  index: number;
}

const EMPTY_PARAMS: PreviewParams = { images: [], index: 0 };

function parsePayload(raw: string | null): PreviewParams | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { images?: unknown; index?: unknown };
    return {
      images: Array.isArray(data.images) ? (data.images as string[]) : [],
      index: typeof data.index === "number" ? data.index : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 从弹窗窗口 URL 参数读取 key 取图片数据：Tauri 下走 Rust 内存中转
 * （base64 常超过 localStorage 5MB 配额），浏览器预览 / 旧数据回落本地存储。
 */
async function readParams(): Promise<PreviewParams> {
  const key = new URLSearchParams(location.search).get("key") ?? "";
  if (!key) return EMPTY_PARAMS;
  if (isTauriRuntime()) {
    try {
      const raw = await invoke<string | null>("take_image_preview_payload", {
        key,
      });
      const data = parsePayload(raw);
      if (data) return data;
    } catch (error) {
      console.error("读取图片预览数据失败", error);
    }
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return EMPTY_PARAMS;
    localStorage.removeItem(key);
    return parsePayload(raw) ?? EMPTY_PARAMS;
  } catch {
    return EMPTY_PARAMS;
  }
}

/** 自定义标题栏高度 48px：antd 预览弹层在 index.css 中整体下移让出标题栏（body.img-viewer-window 覆盖） */

/**
 * 图片查看器窗口：自定义标题栏（最小化/最大化/关闭）+ antd Image 预览弹层。
 * 缩放 / 旋转 / 翻转 / 多图切换 / 前后导航均由 antd 预览工具栏提供，跟随全局主题。
 */
export function ImagePreviewDialog() {
  // 数据异步到达（Rust 中转需要一次 IPC）：到达前不渲染，避免闪一帧空状态
  const [params, setParams] = useState<PreviewParams | null>(null);
  const [current, setCurrent] = useState(0);
  // antd 预览弹层受控开关：初始打开；关闭（antd 关闭按钮 / 点击遮罩）后联动关闭窗口
  const [previewOpen, setPreviewOpen] = useState(true);

  // antd 预览弹层 portal 到 body，给 body 挂标记类，
  // 供 index.css 把弹层下移让出标题栏（仅本窗口内生效）
  useEffect(() => {
    document.body.classList.add("img-viewer-window");
    return () => document.body.classList.remove("img-viewer-window");
  }, []);

  // 只读取一次数据；窗口以隐藏方式创建（visible:false），数据到手并渲染后再显示并聚焦，
  // 消除 Webview 加载主 bundle 期间的数秒白屏
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await readParams();
      if (cancelled) return;
      setParams(data);
      setCurrent(data.index);
      if (!isTauriRuntime()) return;
      const win = getCurrentWindow();
      void win.show();
      void win.setFocus();
    })();
    return () => {
      cancelled = true;
    };
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

  if (!params) return null;

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
    <>
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
    </>
  );
}
