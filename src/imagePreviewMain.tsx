import { createRoot } from 'react-dom/client'
import { ImagePreviewDialog } from './components/ImagePreviewDialog.tsx'
import { ThemeProvider } from './theme/ThemeProvider.tsx'
import './styles'

// 图片预览轻量独立入口：只挂载查看器组件，不加载主应用全量 bundle
// （主入口含 TipTap / 日历 / 调度等，约 2MB），避免弹窗白屏数秒
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <ImagePreviewDialog />
  </ThemeProvider>,
)