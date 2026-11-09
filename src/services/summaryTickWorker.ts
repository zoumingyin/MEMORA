/**
 * 总结调度心跳 Worker：
 * 主窗口隐藏 / 收纳成窄条时，页面内的 setInterval 会被 WebView（Chromium）
 * 按页面可见性节流到分钟级甚至暂停，导致总结到点不跑。
 * Worker 内的定时器不受页面可见性节流，由它驱动主线程做调度判定。
 */
setInterval(() => {
  postMessage('tick')
}, 30_000)