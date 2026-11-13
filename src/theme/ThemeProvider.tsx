import { useEffect, useMemo, type ReactNode } from 'react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useThemeStore } from '../store/useThemeStore'
import { buildAntdTheme } from './antdTheme'

/**
 * 全部窗口共用的主题外壳：建立主题订阅 + antd  ConfigProvider + AntdApp 上下文。
 *
 * AntdApp 必须在 ConfigProvider 内：message / notification / modal 的承载节点渲染在
 * App 自己所处的 ConfigProvider 子树里，包在外面拿不到 darkAlgorithm。
 * component={false} 不产生额外 div，才不会破坏 html,body,#root{height:100%} 布局。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme)
  const initializeTheme = useThemeStore((state) => state.initializeTheme)
  const antdTheme = useMemo(() => buildAntdTheme(resolvedTheme), [resolvedTheme])

  useEffect(() => {
    let release: (() => void) | undefined
    let cancelled = false
    void initializeTheme().then((dispose) => {
      if (cancelled) dispose()
      else release = dispose
    })
    return () => {
      cancelled = true
      release?.()
    }
  }, [initializeTheme])

  return (
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <AntdApp component={false}>{children}</AntdApp>
    </ConfigProvider>
  )
}