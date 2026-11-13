import { createRoot } from 'react-dom/client'
import { NoteWindow } from './components/NoteWindow.tsx'
import { ThemeProvider } from './theme/ThemeProvider.tsx'
import './styles'

// 便签独立小窗轻量入口：只挂载小窗面板，不加载主应用全量 bundle
// （主入口含 TipTap / 日历 / 调度等，约 2MB），避免弹窗白屏
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <NoteWindow />
  </ThemeProvider>,
)