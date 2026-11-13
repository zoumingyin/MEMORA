import { createRoot } from 'react-dom/client'
import { CtxMenuDialog } from './components/CtxMenuDialog.tsx'
import { ThemeProvider } from './theme/ThemeProvider.tsx'
import './styles'

// Markdown 右键菜单独立窗口轻量入口：只挂载菜单面板，不加载主应用全量 bundle
// （主入口含 TipTap / 日历 / 调度等，约 2MB），避免菜单弹出白屏
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <CtxMenuDialog />
  </ThemeProvider>,
)