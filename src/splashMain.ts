import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  SPLASH_READY_EVENT,
  SPLASH_STATE_EVENT,
  type SplashState,
} from "./window/splash";

/**
 * 启动页入口（splash.html）：不加载 React 与主应用 bundle，只做进度展示。
 * 进度来自 Rust / 主窗口的真实里程碑，页面自身不计时、不伪造推进。
 */
const bar = document.getElementById("bar") as HTMLDivElement;
const status = document.getElementById("status") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLParagraphElement;
const dismiss = document.getElementById("dismiss") as HTMLButtonElement;

function render(state: SplashState): void {
  const pct = Math.max(0, Math.min(1, state.progress));
  bar.style.width = `${Math.round(pct * 100)}%`;
  status.textContent = state.status;
  if (state.error) {
    errorEl.textContent = state.error;
    errorEl.hidden = false;
    dismiss.hidden = false;
  }
}

dismiss.addEventListener("click", () => {
  void getCurrentWindow().close();
});

void (async () => {
  try {
    await listen<SplashState>(SPLASH_STATE_EVENT, (event) => {
      render(event.payload);
    });
    // 页面可能晚于早期里程碑加载：请求 Rust 回放当前状态
    await emit(SPLASH_READY_EVENT);
  } catch (error) {
    // 事件通道不可用时不阻塞启动：Rust 侧有兜底关闭
    console.error("启动页事件订阅失败", error);
  }
})();