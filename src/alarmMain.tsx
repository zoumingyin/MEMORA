import { createRoot } from 'react-dom/client'
import { AlarmDialog } from './components/AlarmDialog.tsx'
import './index.css'
import 'uno.css'

// 闹钟弹窗轻量独立入口：只挂载闹钟卡片，不加载主应用全量 bundle
// （主入口含 TipTap/日历/调度等约 2MB，dev 下逐个请求 5000+ 模块），
// 避免到期后 Webview 加载数十秒导致提醒延迟
createRoot(document.getElementById('root')!).render(<AlarmDialog />)
