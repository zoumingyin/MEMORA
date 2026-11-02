import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../repository";

/** 用系统默认浏览器打开外链：桌面端走 opener 插件命令，网页预览退回新标签页 */
export async function openExternal(url: string): Promise<void> {
  if (!isTauriRuntime()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    await invoke("plugin:opener|open_url", { url, with: null });
  } catch (error) {
    console.error("打开外链失败", error);
  }
}
