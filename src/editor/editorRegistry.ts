export interface ActiveEditor {
  entryId: string
  hasUnsaved: () => boolean
  /** 落盘当前草稿；返回是否已全部保存成功 */
  flush: () => Promise<boolean>
  discard: () => void
}

let active: ActiveEditor | null = null

/** 详情表单挂载时登记：切换条目 / 关闭小窗前统一询问并落盘 */
export function registerActiveEditor(editor: ActiveEditor): () => void {
  active = editor
  return () => {
    if (active === editor) active = null
  }
}

export function getActiveEditor(): ActiveEditor | null {
  return active
}

export async function flushActiveEditor(): Promise<boolean> {
  if (!active) return true
  return active.flush()
}

export function discardActiveEditor(): void {
  active?.discard()
}
