import { useEffect, useState } from "react";

/** 与 index.css 的窄窗口断点保持一致：<620px 切换单栏布局 */
export const NARROW_BREAKPOINT = 620;

/**
 * 响应式视口：监听窗口尺寸变化。
 * 桌面窗口可缩放，窄模式下从「左右两栏」切换为「列表/详情单栏」。
 */
export function useViewport() {
  const [width, setWidth] = useState<number>(() =>
    typeof window === "undefined" ? 1024 : window.innerWidth,
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return {
    width,
    isNarrow: width < NARROW_BREAKPOINT,
  };
}
