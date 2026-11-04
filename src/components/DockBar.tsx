import { useEffect, useRef } from 'react'
import { useEntryStore } from '../store/useEntryStore'
import { useWindowStore } from '../store/useWindowStore'
import { ENTRY_KIND_COLOR } from '../utils/entryLabels'
import {
  acquireExpandLock,
  COLLAPSE_COOLDOWN_MS,
  EXPAND_SETTLE_MS,
  fitStripToContent,
  isCollapsedStrip,
  isCollapseRecent,
  MAX_CHIPS,
  recedeStripForExpand,
  releaseExpandLock,
  unpinStrip,
  type DockEdge,
} from '../window/edgeDock'
import { getBounds, logDockGeometry, restoreBounds } from '../window/tauriWindow'

/**
 * 收纳到屏幕边缘后的窄条：一列便签标题小胶囊（对齐参考样式），鼠标移入即切回全窗口。
 * 展开后窄条组件卸载，「移出窗口再收回」由 App 的窗口级 mouseleave 负责，
 * 这里只保留会话（边缘与收纳前边界）供那边收回时使用。
 */
export function DockBar() {
  const { dockedEdge, restoredBounds, setDock } = useWindowStore()
  const entries = useEntryStore((state) => state.entries)
  const currentKind = useEntryStore((state) => state.currentKind)

  const handleEnter = (): void => {
    if (!restoredBounds || !dockedEdge) return
    const edge = dockedEdge
    // 刚完成收纳（拖到边缘松手 / 设置里点收纳）：指针往往就压在窄条上，
    // 这不是主动悬停，立刻展开会让便签收一下又弹开，冷却期内忽略；
    // 想展开时把指针移出再移入即可
    if (isCollapseRecent(COLLAPSE_COOLDOWN_MS)) return
    // 防重入：展开期间 mouseenter 可能再次触发（窄条还钉在原边缘），
    // 且要与托盘/快捷键路径互斥——两个展开流程并会来回抢窗口，表现为跳动/闪烁
    if (!acquireExpandLock()) return
    void (async () => {
      try {
        // 窗口先变大、主界面稍后才换上来：这段时间把窄条按原厚度钉在原边缘，
        // 见 index.css 的 .dock-strip.is-expanding
        // 收纳 IPC 还没落地时窗口仍是原尺寸，此刻的悬停是伪「移入」——刚点过收纳按钮
        // 或刚把窗口拖到边缘松手，指针本就在窗内，展开会让窗口收一下又弹回。
        // 用真实厚度判定，不依赖固定延时
        const bounds = await getBounds()
        if (!bounds || !isCollapsedStrip(bounds, edge)) return
        // drawer 式展开前半段：窄条滑进边缘收起并隐藏（滑出后撑窗瞬间的上一帧
        // 才是全透明的，WebView2 拉伸上一帧时不会把窄条拉成色带闪一下）
        const pinned = await recedeStripForExpand(edge)
        if (!pinned) return
        // 窗口原子撑大、短轮询确认后，主界面从同侧滑入（App 的 dock-in-* 动画）：
        // 撑不开就恢复窄条，否则会出现「主界面画在窄条宽度的窗口里」的挤扁状态
        if (!(await restoreBounds(restoredBounds, EXPAND_SETTLE_MS))) {
          unpinStrip()
          console.warn('[dock] 展开失败，窗口未回到正常尺寸', restoredBounds)
          await logDockGeometry('expand-failed')
          return
        }
        setDock(edge, restoredBounds, false)
      } finally {
        releaseExpandLock()
      }
    })()
  }

  const edge: DockEdge = dockedEdge ?? 'right'
  const vertical = edge !== 'top'
  const chips = entries.slice(0, MAX_CHIPS)

  // 窄条高度（上边缘为宽度）按内容自适应：收纳缩窗用的是按条目数的估算初值，
  // 挂载后读真实 DOM 校正；胶囊列变化（条目增删）时 ResizeObserver 再次触发。
  // 长度没变的重复回调由 fitStripToContent 内部去重，不会形成回环
  const stripRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      void fitStripToContent(edge)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [edge])

  return (
    <div
      ref={stripRef}
      className={`dock-strip ${vertical ? 'vertical' : 'horizontal'} kind-${currentKind}`}
      onMouseEnter={handleEnter}
    >
      {chips.map((entry) => {
        const accent = ENTRY_KIND_COLOR[entry.kind]
        return (
          <span
            key={entry.id}
            className={`dock-chip flex min-w-0 items-center gap-[6px] rounded-[8px] border border-[var(--glass-edge)] bg-[rgba(var(--panel-rgb),0.55)] px-[7px] py-[5px] transition-colors duration-150 hover:bg-[rgba(var(--panel-rgb),0.85)] ${
              vertical ? 'w-full' : 'shrink-0'
            }`}
          >
            <span
              className="h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ background: accent }}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-[11px] leading-[15px] text-[var(--text)]">
              {entry.title || '无标题'}
            </span>
          </span>
        )
      })} 
    </div>
  )
}
