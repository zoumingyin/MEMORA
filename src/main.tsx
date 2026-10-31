import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import './styles'
import App from './App.tsx'
import { AlarmDialog } from './components/AlarmDialog.tsx'
import { ImagePreviewDialog } from './components/ImagePreviewDialog.tsx'

// dayjs 全局中文：Calendar/DatePicker 的星期名、月份名、dddd 等格式化输出中文
// （antd 的 zhCN locale 只覆盖组件文案，月份/星期这类由 dayjs 按 locale 生成，需单独设置）
dayjs.locale('zh-cn')

// antd 基础主题：浅色毛玻璃极简，分类主题色在 App 层按当前分类动态注入
const BASE_TOKEN = {
  colorPrimary: '#2563eb',
  colorInfo: '#2563eb',
  colorText: '#1f2937',
  colorTextSecondary: '#6b7280',
  colorTextTertiary: '#6b7280',
  colorBorder: 'rgba(16, 24, 40, 0.16)',
  colorBorderSecondary: 'rgba(16, 24, 40, 0.09)',
  colorBgContainer: 'rgba(255, 255, 255, 0.95)',
  colorBgElevated: 'rgba(255, 255, 255, 0.97)',
  borderRadius: 8,
  borderRadiusLG: 12,
  controlHeight: 30,
  fontSize: 13,
  fontFamily: "system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif",
}

// 闹钟弹窗使用独立 Webview 窗口，通过 ?alarm=1 参数让同一前端包渲染窗口化卡片（交互参考图片预览弹窗）
const isAlarmDialog = new URLSearchParams(location.search).has('alarm')
// 图片预览弹窗使用独立 Webview 窗口，通过 ?imagePreview=1 参数让同一前端包渲染全屏预览
const isImagePreviewDialog = new URLSearchParams(location.search).has('imagePreview')

createRoot(document.getElementById('root')!).render(
  <ConfigProvider locale={zhCN} theme={{ token: BASE_TOKEN }}>
    {isAlarmDialog ? <AlarmDialog /> : isImagePreviewDialog ? <ImagePreviewDialog /> : <App />}
  </ConfigProvider>,
)
