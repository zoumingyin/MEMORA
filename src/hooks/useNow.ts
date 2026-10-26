import { useEffect, useState } from 'react'

/**
 * 返回按固定间隔刷新的当前时间戳（毫秒）。
 * 用于在渲染期判断“是否到期”，避免在 render 阶段直接调用 impure 的 Date.now()。
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])

  return now
}
