import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauriRuntime } from '../repository'

/**
 * 在线升级（Tauri updater）：端点与签名公钥见 src-tauri/tauri.conf.json plugins.updater。
 * 发布流程：tauri:build 产出 NSIS 安装包 + .sig 签名 → scripts/release-update.mjs 生成
 * latest.json → 与安装包/签名一起上传 GitHub Release（脚本输出具体步骤）。
 */

/** 下载进度（downloadedBytes / totalBytes 由 UI 侧累计与展示） */
export interface UpdateProgress {
  event: 'started' | 'progress' | 'finished'
  totalBytes?: number
  chunkLength?: number
}

/** 检查更新；无更新返回 null。非桌面运行时（浏览器预览）抛错 */
export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauriRuntime()) {
    throw new Error('浏览器预览环境不支持在线升级，请在桌面版中使用')
  }
  // 10s 超时：更新源不可达时尽快反馈，不让 UI 一直转圈
  return check({ timeout: 10_000 })
}

/** 下载并安装更新（Windows NSIS 静默安装），完成后由调用方 relaunch */
export async function downloadAndInstall(
  update: Update,
  onProgress: (progress: UpdateProgress) => void,
): Promise<void> {
  await update.downloadAndInstall((event: DownloadEvent) => {
    switch (event.event) {
      case 'Started':
        onProgress({
          event: 'started',
          totalBytes: event.data.contentLength,
        })
        break
      case 'Progress':
        onProgress({ event: 'progress', chunkLength: event.data.chunkLength })
        break
      case 'Finished':
        onProgress({ event: 'finished' })
        break
    }
  })
}

export { relaunch }
