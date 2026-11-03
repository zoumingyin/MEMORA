import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isTauriRuntime } from "../repository";

/**
 * 读取剪贴板文本：Tauri 环境必须走插件（WebView2 会拒绝 navigator.clipboard.readText），
 * 网页预览兜底 navigator.clipboard。失败返回空串。
 */
export async function readClipboardText(): Promise<string> {
  try {
    if (isTauriRuntime()) return await readText();
    return (await navigator.clipboard?.readText?.()) ?? "";
  } catch {
    return "";
  }
}

/** 写入剪贴板文本：Tauri 环境走插件，网页预览兜底 navigator.clipboard；返回是否写入成功 */
export async function writeClipboardText(value: string): Promise<boolean> {
  if (!value) return false;
  try {
    if (isTauriRuntime()) {
      await writeText(value);
      return true;
    }
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!write) return false;
    await write(value);
    return true;
  } catch {
    return false;
  }
}
