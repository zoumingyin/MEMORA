/**
 * 闹钟调度心跳 Worker：
 * 主窗口隐藏 / 被遮挡（如收纳到屏幕边缘）时，页面内的 setInterval 会被
 * WebView（Chromium）按页面可见性节流到分钟级，导致闹钟迟到。
 * Worker 内的定时器不受页面可见性节流，由它持续发 tick 驱动主线程扫描。
 */
setInterval(() => {
  postMessage("tick")
}, 500)
