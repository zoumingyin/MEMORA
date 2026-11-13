/**
 * 启动页与主窗口之间的初始化进度契约。
 *
 * 进度只由真实里程碑推进（Rust setup / 前端 bundle 就绪 / 便签读库完成），
 * 不做定时假进度。启动页加载晚于早期里程碑时，通过 splash:ready 让 Rust
 * 回放当前状态，避免停在 0%。
 */

/** 启动页窗口标签（tauri.conf.json 中声明） */
export const SPLASH_LABEL = "splash";

/** Rust → 启动页：当前初始化状态全量回放 */
export const SPLASH_STATE_EVENT = "splash:state";
/** 启动页 → Rust：页面已就绪，请回放当前状态 */
export const SPLASH_READY_EVENT = "splash:ready";

export interface SplashState {
  /** 0 ~ 1，仅由真实里程碑推进 */
  progress: number;
  status: string;
  /** 非空表示初始化失败：启动页展示错误并保留关闭入口 */
  error: string | null;
}