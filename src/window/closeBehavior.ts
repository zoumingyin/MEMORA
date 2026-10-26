/** 关闭窗口时的默认行为：hide=最小化到后台（托盘常驻），quit=退出应用 */
export type CloseAction = "hide" | "quit";

export interface CloseBehavior {
  action: CloseAction;
  /** 是否记住该选择（下次点 X 直接执行，不再弹窗） */
  remember: boolean;
}

const STORAGE_KEY = "bianqian.closeBehavior.v1";

/** 读取持久化的关闭行为；无记录或损坏返回 null（表示「每次询问」） */
export function loadCloseBehavior(): CloseBehavior | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CloseBehavior;
    if (parsed.action !== "hide" && parsed.action !== "quit") return null;
    return { action: parsed.action, remember: parsed.remember !== false };
  } catch {
    return null;
  }
}

/** 保存关闭行为（勾选「下次不再询问」或从设置区修改默认行为时调用） */
export function saveCloseBehavior(behavior: CloseBehavior): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(behavior));
  } catch {
    // 存储不可用时静默跳过
  }
}

/** 清除关闭行为（设置区切回「每次询问」时调用） */
export function clearCloseBehavior(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 存储不可用时静默跳过
  }
}
