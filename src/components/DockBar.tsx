import { useRef } from 'react'
import { DownOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons'
import { useEntryStore } from '../store/useEntryStore'
import { useWindowStore } from '../store/useWindowStore'
import { collapseToStrip, type DockEdge } from '../window/edgeDock'
import { currentWorkArea, restoreBounds } from '../window/tauriWindow'

/** 鼠标移出窄条后延迟收起的时长：吸收边缘像素抖动，避免反复收放造成卡顿 */
const COLLAPSE_DEBOUNCE_MS = 200

/**
 * 收纳到屏幕边缘后的窄条：鼠标移入立即切回全窗口（尺寸/位置并行异步恢复），
 * 移出经防抖后收窄；用序号 token 防止「展开中途的旧收起」把已展开的窗口又切成窄条。
 */
export function DockBar() {
  const { dockedEdge, restoredBounds, setDock, clearDock } = useWindowStore()
  const currentKind = useEntryStore((state) => state.currentKind)

  // 收起防抖定时器：移入时清除；令牌：每次交互自增，异步完成后仅当令牌仍是自己才切换 UI
  const leaveTimerRef = useRef<number | undefined>(undefined)
  const collapseTokenRef = useRef(0)

  const handleEnter = (): void => {
    if (leaveTimerRef.current) {
      window.clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = undefined
    }
    // 使进行中的收起失效，避免旧收起把已展开窗口又切回窄条
    collapseTokenRef.current += 1
    if (!restoredBounds) return
    clearDock()
    void restoreBounds(restoredBounds)
  }

  const handleLeave = (): void => {
    if (!restoredBounds || !dockedEdge) return
    if (leaveTimerRef.current) return
    const edge = dockedEdge
    const bounds = restoredBounds
    const token = ++collapseTokenRef.current
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = undefined
      void (async () => {
        const workArea = await currentWorkArea()
        if (!workArea) return
        await collapseToStrip(edge, bounds, workArea)
        // 期间用户已重新移入展开：不再切换 UI，避免窗口已恢复但界面还是窄条
        if (collapseTokenRef.current !== token) return
        setDock(edge, bounds, true)
      })()
    }, COLLAPSE_DEBOUNCE_MS)
  }

  const edge: DockEdge = dockedEdge ?? 'right'
  const Icon =
    edge === 'left' ? RightOutlined : edge === 'right' ? LeftOutlined : DownOutlined
  const vertical = edge !== 'top'

  return (
    <div
      className={`dock-strip kind-${currentKind} ${vertical ? 'vertical' : ''}`}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <span className="dock-strip-handle">
        <Icon size={14} />
      </span>
    </div>
  )
}
