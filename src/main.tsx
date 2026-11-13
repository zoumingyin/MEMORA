import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import './styles'
import { ThemeProvider } from './theme/ThemeProvider.tsx'
import App from './App.tsx'
import { AlarmDialog } from './components/AlarmDialog.tsx'
import { ImagePreviewDialog } from './components/ImagePreviewDialog.tsx'
import { isTauriRuntime } from './repository'

// dayjs 全局中文：Calendar/DatePicker 的星期名、月份名、dddd 等格式化输出中文
// （antd 的 zhCN locale 只覆盖组件文案，月份/星期这类由 dayjs 按 locale 生成，需单独设置）
dayjs.locale('zh-cn')

// 闹钟弹窗使用独立 Webview 窗口，通过 ?alarm=1 参数让同一前端包渲染窗口化卡片（交互参考图片预览弹窗）
const isAlarmDialog = new URLSearchParams(location.search).has('alarm')
// 图片预览弹窗使用独立 Webview 窗口，通过 ?imagePreview=1 参数让同一前端包渲染全屏预览
const isImagePreviewDialog = new URLSearchParams(location.search).has('imagePreview')

// 旧版图片预览把 base64 存在 localStorage，预览窗口没加载完就被关掉会留下大体积残留，
// 攒满 5MB 配额后所有预览都失败。数据已改走 Rust 内存中转，这里清掉历史残留。
try {
  const stale: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key?.startsWith('image-preview-')) stale.push(key)
  }
  for (const key of stale) localStorage.removeItem(key)
} catch {
  // 存储不可用时跳过
}

// 启动页里程碑：主入口 bundle 已执行到挂载前（弹窗复用时不报，避免回退进度）
if (!isAlarmDialog && !isImagePreviewDialog && isTauriRuntime()) {
  void invoke('splash_report', { progress: 0.6, status: '正在加载界面…' }).catch(
    () => undefined,
  )
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    {isAlarmDialog ? <AlarmDialog /> : isImagePreviewDialog ? <ImagePreviewDialog /> : <App />}
  </ThemeProvider>,
)