import type { AiModality } from '../types/ai'

const MODALITY_LABELS: Record<AiModality, string> = {
  text: '文本',
  image: '图片',
  audio: '语音',
  video: '视频',
}

interface ModalityBadgeProps {
  /** null 表示普通用户配置，按文本处理 */
  modality: AiModality | null
}

/**
 * 模型输出模态标签：文本模型用弱化样式，图片 / 语音 / 视频用警示色，
 * 因为这些免费条目不能用于本应用的文本对话。
 */
export function ModalityBadge({ modality }: ModalityBadgeProps) {
  const value = modality ?? 'text'
  const isText = value === 'text'
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 text-[9px] leading-[14px] font-semibold ${
        isText
          ? 'border-[var(--border)] text-[var(--text-muted)]'
          : 'border-[var(--danger)] text-[var(--danger)]'
      }`}
    >
      {MODALITY_LABELS[value]}
    </span>
  )
}
