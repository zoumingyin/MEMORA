/**
 * 主题引导脚本：在各窗口 HTML 的 head 里同步执行，早于模块 bundle 与首帧渲染。
 * 只做「根节点打标记」这一件事，完整令牌由 memora-tokens.css / memora-bridge.css 提供，
 * 避免在这里复制一份颜色造成漂移。
 *
 * 与 useThemeStore 读同一个键；system 档先用 matchMedia 解析，
 * 真正的 Windows 注册表值由 store 初始化后校准。
 */
;(function () {
  var mode = 'system'
  try {
    var raw = localStorage.getItem('bianqian.theme.v1')
    if (raw) {
      var parsed = JSON.parse(raw)
      if (parsed && (parsed.mode === 'light' || parsed.mode === 'dark' || parsed.mode === 'system')) {
        mode = parsed.mode
      }
    } else {
      // 旧版本把主题存在 window.v1，升级后首次启动沿用用户原选择
      var legacyRaw = localStorage.getItem('bianqian.window.v1')
      if (legacyRaw) {
        var legacy = JSON.parse(legacyRaw)
        if (legacy && (legacy.theme === 'light' || legacy.theme === 'dark')) mode = legacy.theme
      }
    }
  } catch {
    // 存储不可用：按跟随系统处理
  }
  var prefersDark = false
  try {
    prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    prefersDark = false
  }
  var resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode
  var root = document.documentElement
  root.setAttribute('data-theme', resolved)
  root.classList.toggle('dark-glass', resolved === 'dark')
  root.style.colorScheme = resolved
})()