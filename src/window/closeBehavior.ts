/** 点 X 的退出语义：最小化到托盘继续提醒 / 退出并停止提醒 */
export type CloseBehavior = 'tray' | 'exit'

const CLOSE_BEHAVIOR_KEY = 'bianqian.closeBehavior.v1'

export function loadCloseBehavior(): CloseBehavior | null {
  try {
    const value = localStorage.getItem(CLOSE_BEHAVIOR_KEY)
    return value === 'tray' || value === 'exit' ? value : null
  } catch {
    return null
  }
}

export function saveCloseBehavior(behavior: CloseBehavior | null): void {
  try {
    if (behavior) localStorage.setItem(CLOSE_BEHAVIOR_KEY, behavior)
    else localStorage.removeItem(CLOSE_BEHAVIOR_KEY)
  } catch {
    // 存储不可用时仅在本次会话内生效
  }
}
