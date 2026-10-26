import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface ImageLightboxProps {
  images: string[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

/**
 * 图片灯箱：点击正文图片后弹出预览，支持
 * - 关闭：按钮 / 点击遮罩 / Esc
 * - 左右切换：按钮 / ← → 方向键（多图循环）
 * - 加载失败：错误占位 + 重试
 * 通过 Portal 挂载到 body，避免被编辑器 / 窗口 overflow 裁剪。
 */
export function ImageLightbox({
  images,
  index,
  onClose,
  onIndexChange,
}: ImageLightboxProps) {
  const total = images.length;
  const src = images[index];
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  // 切换图片时重置加载状态
  useEffect(() => {
    setError(false);
    setRetry(0);
  }, [index, src]);

  const go = useCallback(
    (delta: number) => {
      if (total <= 1) return;
      onIndexChange((index + delta + total) % total);
    },
    [total, index, onIndexChange],
  );

  // 键盘：Esc 关闭，← → 切换
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  return createPortal(
    <div
      className="md-lightbox"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="md-lightbox-bar">
        <span className="md-lightbox-count">
          {total > 0 ? `${index + 1} / ${total}` : "0 / 0"}
        </span>
        <button
          type="button"
          className="md-lightbox-close"
          title="关闭 (Esc)"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <button
        type="button"
        className="md-lightbox-nav md-lightbox-prev"
        title="上一张 (←)"
        disabled={total <= 1}
        onClick={() => go(-1)}
      >
        ‹
      </button>

      <div className="md-lightbox-stage">
        {error ? (
          <div className="md-lightbox-error">
            <div className="md-lightbox-error-icon">⚠</div>
            <p>图片加载失败</p>
            <p className="md-lightbox-error-src">{src}</p>
            <button
              type="button"
              className="md-lightbox-retry"
              onClick={() => {
                setRetry((k) => k + 1);
                setError(false);
              }}
            >
              重试
            </button>
          </div>
        ) : (
          <img
            key={retry}
            className="md-lightbox-img"
            src={src}
            alt=""
            onError={() => setError(true)}
            onLoad={() => setError(false)}
          />
        )}
      </div>

      <button
        type="button"
        className="md-lightbox-nav md-lightbox-next"
        title="下一张 (→)"
        disabled={total <= 1}
        onClick={() => go(1)}
      >
        ›
      </button>
    </div>,
    document.body,
  );
}
