import { createRoot } from 'react-dom/client'
import { SpotlightSearch } from './components/SpotlightSearch.tsx'
import './styles'

// 全局快捷搜索（Spotlight）独立窗口轻量入口：只挂载搜索面板，不加载主应用
// 全量 bundle（主入口含 TipTap / 日历 / 调度等，约 2MB），避免唤起时白屏
createRoot(document.getElementById('root')!).render(<SpotlightSearch />)
