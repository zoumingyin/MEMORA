import { useEffect, useState } from 'react'
import {
  CloseOutlined,
  LeftOutlined,
  RightOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  FullscreenOutlined,
  MinusOutlined,
  BorderOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
} from '@ant-design/icons'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from '../repository'

/** 从弹窗窗口 URL 参数读取 storageKey，再从 localStorage 取图片数据（只读取一次） */
function readParams(): { images: string[]; index: number; isDark: boolean } {
  const query = new URLSearchParams(location.search)
  const key = query.get('key') ?? ''
  if (!key) return { images: [], index: 0, isDark: false }
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { images: [], index: 0, isDark: false }
    const data = JSON.parse(raw) as { images: string[]; index: number; isDark: boolean }
    localStorage.removeItem(key)
    return { images: data.images ?? [], index: data.index ?? 0, isDark: data.isDark ?? false }
  } catch {
    return { images: [], index: 0, isDark: false }
  }
}

/**
 * 图片查看器窗口：跟随主题的毛玻璃风格，居中显示图片。
 */
export function ImagePreviewDialog() {
  // 只在组件初始化时读取一次数据，避免重新渲染时重复读取导致数据被删除
  const [params] = useState(() => readParams())
  const [current, setCurrent] = useState(params.index)
  const [zoom, setZoom] = useState(100)
  const [rotation, setRotation] = useState(0)

  // 暗色模式下的 CSS 变量（和 App.tsx 里的 DARK_TOKENS 保持一致）
  const DARK_TOKENS = {
    "--panel-rgb": "32, 34, 40",
    "--panel-soft-rgb": "42, 45, 52",
    "--field-rgb": "46, 49, 56",
    "--text": "#ffffff",
    "--text-muted": "#e0dcd3",
    "--border": "rgba(236, 230, 220, 0.2)",
    "--control-border": "rgba(236, 230, 220, 0.35)",
    "--hover-fill": "rgba(255, 255, 255, 0.1)",
    "--text-halo": "none",
    "--glass-edge": "rgba(236, 230, 220, 0.12)",
    "--glass-highlight": "rgba(236, 230, 220, 0.06)",
  }

  // 亮色模式下需要恢复的变量
  const LIGHT_TOKENS = {
    "--hover-fill": "rgba(0, 0, 0, 0.06)",
  }

  // 应用主题：读取到 isDark 后，设置 CSS 变量和 dark-glass 类
  useEffect(() => {
    const rootStyle = document.documentElement.style
    if (params.isDark) {
      document.documentElement.classList.add('dark-glass')
      for (const [key, value] of Object.entries(DARK_TOKENS)) {
        rootStyle.setProperty(key, value)
      }
    } else {
      document.documentElement.classList.remove('dark-glass')
      for (const key of Object.keys(DARK_TOKENS)) {
        rootStyle.removeProperty(key)
      }
      for (const [key, value] of Object.entries(LIGHT_TOKENS)) {
        rootStyle.setProperty(key, value)
      }
    }
  }, [params.isDark])

  const handleClose = async (): Promise<void> => {
    if (isTauriRuntime()) {
      try {
        await getCurrentWindow().close()
      } catch (e) {
        console.error('关闭窗口失败', e)
      }
    }
  }

  const handleMinimize = async (): Promise<void> => {
    if (isTauriRuntime()) {
      try {
        await getCurrentWindow().minimize()
      } catch (e) {
        console.error('最小化窗口失败', e)
      }
    }
  }

  const handleToggleMaximize = async (): Promise<void> => {
    if (isTauriRuntime()) {
      try {
        const win = getCurrentWindow()
        const isMax = await win.isMaximized()
        if (isMax) {
          await win.unmaximize()
        } else {
          await win.maximize()
        }
      } catch (e) {
        console.error('最大化窗口失败', e)
      }
    }
  }

  const prev = (): void => {
    setCurrent((i) => (i - 1 + params.images.length) % params.images.length)
    setZoom(100)
    setRotation(0)
  }

  const next = (): void => {
    setCurrent((i) => (i + 1) % params.images.length)
    setZoom(100)
    setRotation(0)
  }

  const zoomIn = (): void => setZoom((z) => Math.min(z + 20, 500))
  const zoomOut = (): void => setZoom((z) => Math.max(z - 20, 20))
  const resetZoom = (): void => setZoom(100)
  const rotateLeft = (): void => setRotation((r) => r - 90)
  const rotateRight = (): void => setRotation((r) => r + 90)

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void handleClose()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (params.images.length === 0) {
    return (
      <div className="img-viewer">
        <div className="img-viewer-titlebar">
          <span className="img-viewer-title">查看图片</span>
          <button type="button" className="img-viewer-tool-btn" onClick={() => void handleClose()}>
            <CloseOutlined />
          </button>
        </div>
        <div className="img-viewer-body">
          <p className="img-viewer-empty">没有可显示的图片</p>
        </div>
      </div>
    )
  }

  const src = params.images[current]

  return (
    <div className="img-viewer">
      {/* 顶部紫色标题栏 */}
      <div className="img-viewer-titlebar">
        <span className="img-viewer-title">查看图片</span>
        <div className="img-viewer-toolbar">
          <span className="img-viewer-zoom">{zoom}%</span>
          <button type="button" className="img-viewer-tool-btn" title="缩小" onClick={zoomOut}>
            <ZoomOutOutlined />
          </button>
          <button type="button" className="img-viewer-tool-btn" title="适应窗口" onClick={resetZoom}>
            <FullscreenOutlined />
          </button>
          <button type="button" className="img-viewer-tool-btn" title="放大" onClick={zoomIn}>
            <ZoomInOutlined />
          </button>
          <button type="button" className="img-viewer-tool-btn" title="向左旋转" onClick={rotateLeft}>
            <RotateLeftOutlined />
          </button>
          <button type="button" className="img-viewer-tool-btn" title="向右旋转" onClick={rotateRight}>
            <RotateRightOutlined />
          </button>
          <span className="img-viewer-sep" />
          <button type="button" className="img-viewer-tool-btn" title="最小化" onClick={() => void handleMinimize()}>
            <MinusOutlined />
          </button>
          <button type="button" className="img-viewer-tool-btn" title="最大化" onClick={() => void handleToggleMaximize()}>
            <BorderOutlined />
          </button>
          <button type="button" className="img-viewer-tool-btn" title="关闭 (Esc)" onClick={() => void handleClose()}>
            <CloseOutlined />
          </button>
        </div>
      </div>

      {/* 图片显示区域 */}
      <div className="img-viewer-body">
        {params.images.length > 1 && (
          <button type="button" className="img-viewer-nav img-viewer-prev" title="上一张" onClick={prev}>
            <LeftOutlined />
          </button>
        )}

        <div className="img-viewer-stage">
          <img
            src={src}
            alt="预览"
            className="img-viewer-img"
            style={{
              transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
            }}
          />
        </div>

        {params.images.length > 1 && (
          <button type="button" className="img-viewer-nav img-viewer-next" title="下一张" onClick={next}>
            <RightOutlined />
          </button>
        )}
      </div>

      {/* 底部状态栏 */}
      {params.images.length > 1 && (
        <div className="img-viewer-status">
          {current + 1} / {params.images.length}
        </div>
      )}
    </div>
  )
}
