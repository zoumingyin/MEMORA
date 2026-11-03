import { invoke } from '@tauri-apps/api/core'
import { save as dialogSave } from '@tauri-apps/plugin-dialog'
import { isTauriRuntime } from '../repository'
import { ensureWindowVisible } from '../window/tauriWindow'
import type { AlarmItem, Entry, EntryKind } from '../types/entry'

/** 导出图片的分类标题色：与 App.tsx 的 KIND_COLOR 保持一致 */
const KIND_META: Record<EntryKind, { label: string; color: string }> = {
  note: { label: '备忘', color: '#2563eb' },
  reminder: { label: '提醒', color: '#d9686b' },
  todo: { label: '待办', color: '#57a878' },
  draw: { label: '涂鸦', color: '#8b5cf6' },
}

const CANVAS_WIDTH = 720
const PADDING = 44
const DPR = 2
/** 画布高度上限（CSS 像素）：按实际内容高度生成，仅在极端长文时兜底截断 */
const MAX_CANVAS_HEIGHT = 12000
/** 内容区最大底边：给标签与页脚留出空间 */
const CONTENT_BOTTOM = MAX_CANVAS_HEIGHT - 170
const TITLE_SIZE = 30
const BODY_SIZE = 16

const FONT_STACK =
  '"Microsoft YaHei", "PingFang SC", "Segoe UI", "Noto Sans SC", sans-serif'

const font = (size: number, weight = 400): string =>
  `${weight} ${size}px ${FONT_STACK}`

/** 正文 Markdown 转纯文本：保留段落与列表符号，剔除图片、链接地址与标记符号 */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按画布宽度折行：中文逐字断行，英文优先在空格处断开 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  currentFont: string,
): string[] {
  ctx.font = currentFont
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    let line = ''
    let lastSpace = -1
    for (const char of paragraph) {
      const next = line + char
      if (line && ctx.measureText(next).width > maxWidth) {
        if (lastSpace > 0 && /[A-Za-z0-9]/.test(char)) {
          lines.push(line.slice(0, lastSpace).trimEnd())
          line = line.slice(lastSpace + 1) + char
        } else {
          lines.push(line.trimEnd())
          line = char
        }
        lastSpace = -1
      } else {
        line = next
        if (char === ' ') lastSpace = line.length - 1
      }
    }
    if (line) lines.push(line.trimEnd())
  }
  return lines
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = src
  })
}

/**
 * 正文内嵌图片：只嵌入 App 自己生成的 base64 位图（粘贴图片 / 插入涂鸦）。
 * 外部 http 图片绘制会把画布标记为污染（tainted），随后 toDataURL 会直接抛错，因此不嵌入。
 */
const INLINE_IMAGE_SRC = String.raw`data:image\/(?:png|jpe?g|webp|gif|bmp|avif);base64,[^)\s"']+`

interface NoteBlock {
  type: 'text' | 'image'
  value: string
}

/** 把备忘正文拆成「文字段 / 内嵌图片段」，保持原有顺序 */
function splitNoteBlocks(markdown: string): NoteBlock[] {
  const pattern = new RegExp(
    String.raw`!\[[^\]]*\]\(\s*(${INLINE_IMAGE_SRC})\s*\)|<img\b[^>]*\bsrc=["'](${INLINE_IMAGE_SRC})["'][^>]*>`,
    'gi',
  )
  const blocks: NoteBlock[] = []
  let last = 0
  for (const match of markdown.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) {
      blocks.push({ type: 'text', value: markdown.slice(last, index) })
    }
    const src = match[1] ?? match[2]
    if (src) blocks.push({ type: 'image', value: src })
    last = index + match[0].length
  }
  if (last < markdown.length) {
    blocks.push({ type: 'text', value: markdown.slice(last) })
  }
  return blocks
}

/** 预先加载正文内嵌图片：测量与绘制两趟共用同一批已解码图片 */
async function loadInlineImages(
  blocks: NoteBlock[],
): Promise<Map<string, HTMLImageElement>> {
  const images = new Map<string, HTMLImageElement>()
  await Promise.all(
    blocks
      .filter((block) => block.type === 'image')
      .map(async (block) => {
        try {
          images.set(block.value, await loadImage(block.value))
        } catch {
          // 损坏 / 无法解码的图片跳过，不影响其余内容
        }
      }),
  )
  return images
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

function formatDateTime(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`
}

function formatShortDate(ms: number): string {
  const date = new Date(ms)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}`
}

const ALARM_MODE_LABEL: Record<AlarmItem['mode'], string> = {
  once: '单次',
  loop: '循环',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
  lunar: '每年农历',
  workday: '工作日',
}

/** 圆角矩形路径 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
}

interface ContentResult {
  canvas: HTMLCanvasElement
  height: number
}

/**
 * 绘制便签内容并推进纵向布局。draw=false 时只测量不落笔，
 * 用与正式绘制完全相同的 y 推进逻辑先算出实际高度。
 */
function paintEntry(
  entry: Entry,
  image: HTMLImageElement | null,
  inlineImages: Map<string, HTMLImageElement>,
  ctx: CanvasRenderingContext2D,
  draw: boolean,
): { height: number } {
  const meta = KIND_META[entry.kind]
  const innerWidth = CANVAS_WIDTH - PADDING * 2
  ctx.textBaseline = 'top'

  let y = PADDING
  let truncated = false

  // 顶部：分类色点 + 分类名 + 更新时间
  if (draw) {
    ctx.fillStyle = meta.color
    ctx.beginPath()
    ctx.arc(PADDING + 5, y + 7, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.font = font(13, 600)
    ctx.fillStyle = '#6b7280'
    ctx.fillText(meta.label, PADDING + 18, y)
    ctx.font = font(13)
    ctx.textAlign = 'right'
    ctx.fillText(formatDateTime(entry.updatedAt), CANVAS_WIDTH - PADDING, y)
    ctx.textAlign = 'left'
  }
  y += 20 + 18

  // 标题：完整折行，仅在触及画布高度上限时截断
  const titleLineHeight = Math.round(TITLE_SIZE * 1.38)
  const titleLines = wrapText(
    ctx,
    entry.title.trim() || '无标题',
    innerWidth,
    font(TITLE_SIZE, 700),
  )
  if (draw) {
    ctx.font = font(TITLE_SIZE, 700)
    ctx.fillStyle = '#1f2937'
  }
  for (const line of titleLines) {
    if (y + titleLineHeight > CONTENT_BOTTOM) {
      truncated = true
      break
    }
    if (draw) ctx.fillText(line, PADDING, y)
    y += titleLineHeight
  }
  y += 14

  // 分隔线
  if (draw) {
    ctx.strokeStyle = '#ece7de'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PADDING, y + 0.5)
    ctx.lineTo(CANVAS_WIDTH - PADDING, y + 0.5)
    ctx.stroke()
  }
  y += 24

  const lineHeight = Math.round(BODY_SIZE * 1.7)

  if (entry.kind === 'note') {
    // 文字与内嵌图片按原始顺序交替绘制，按可用高度截断
    const blocks = splitNoteBlocks(entry.content)
    let drew = false
    let stopped = false
    for (const block of blocks) {
      if (stopped) break
      if (block.type === 'text') {
        const text = stripMarkdown(block.value)
        if (!text) continue
        ctx.font = font(BODY_SIZE)
        if (draw) ctx.fillStyle = '#374151'
        const lines = wrapText(ctx, text, innerWidth, font(BODY_SIZE))
        for (const line of lines) {
          if (y + lineHeight > CONTENT_BOTTOM) {
            truncated = true
            stopped = true
            break
          }
          if (draw && line) ctx.fillText(line, PADDING, y)
          y += lineHeight
        }
        if (stopped) break
        drew = true
        y += 6
        continue
      }
      const inline = inlineImages.get(block.value)
      if (!inline) continue
      const scale = Math.min(innerWidth / inline.width, 320 / inline.height, 1)
      const drawWidth = Math.round(inline.width * scale)
      const drawHeight = Math.round(inline.height * scale)
      if (y + drawHeight > CONTENT_BOTTOM) {
        truncated = true
        stopped = true
        break
      }
      if (draw) {
        roundRect(ctx, PADDING, y, drawWidth, drawHeight, 10)
        ctx.save()
        ctx.clip()
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.drawImage(inline, PADDING, y, drawWidth, drawHeight)
        ctx.restore()
      }
      y += drawHeight + 12
      drew = true
    }
    if (!drew) {
      ctx.font = font(BODY_SIZE)
      if (draw) {
        ctx.fillStyle = '#9ca3af'
        ctx.fillText('（空白便签）', PADDING, y)
      }
      y += lineHeight
    } else if (truncated) {
      ctx.font = font(13)
      if (draw) {
        ctx.fillStyle = '#9ca3af'
        ctx.fillText('…（内容较长，已截断）', PADDING, y + 2)
      }
      y += 22
    }
  } else if (entry.kind === 'todo') {
    const textX = PADDING + 26
    let drawn = 0
    for (const item of entry.items) {
      ctx.font = font(BODY_SIZE)
      const lines = wrapText(ctx, item.text, innerWidth - 26, font(BODY_SIZE))
      // 至少放得下一行才开始这一项，避免只剩一个悬空的勾选框
      if (y + lineHeight > CONTENT_BOTTOM) {
        truncated = true
        break
      }
      if (draw) {
        const boxSize = 15
        const boxX = PADDING
        const boxY = y + 4
        roundRect(ctx, boxX, boxY, boxSize, boxSize, 4)
        if (item.done) {
          ctx.fillStyle = meta.color
          ctx.fill()
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(boxX + 3.5, boxY + 7.5)
          ctx.lineTo(boxX + 6.5, boxY + 10.5)
          ctx.lineTo(boxX + 11.5, boxY + 4.5)
          ctx.stroke()
        } else {
          ctx.strokeStyle = '#cfd4dc'
          ctx.lineWidth = 1.5
          ctx.stroke()
        }
        ctx.font = font(BODY_SIZE)
        ctx.fillStyle = item.done ? '#9ca3af' : '#374151'
      }
      for (const line of lines) {
        if (y + lineHeight > CONTENT_BOTTOM) {
          truncated = true
          break
        }
        if (draw) ctx.fillText(line, textX, y)
        y += lineHeight
      }
      y += 6
      drawn += 1
    }
    const remaining = entry.items.length - drawn
    if (remaining > 0) {
      ctx.font = font(13)
      if (draw) {
        ctx.fillStyle = '#9ca3af'
        ctx.fillText(`还有 ${remaining} 项…`, textX, y)
      }
      y += 22
    } else if (truncated) {
      ctx.font = font(13)
      if (draw) {
        ctx.fillStyle = '#9ca3af'
        ctx.fillText('…（内容较长，已截断）', PADDING, y)
      }
      y += 22
    }
    if (entry.items.length === 0) {
      ctx.font = font(BODY_SIZE)
      if (draw) {
        ctx.fillStyle = '#9ca3af'
        ctx.fillText('（没有子任务）', PADDING, y)
      }
      y += lineHeight
    }
  } else if (entry.kind === 'reminder') {
    let drawn = 0
    for (const alarm of entry.alarms) {
      if (y + lineHeight > CONTENT_BOTTOM) {
        truncated = true
        break
      }
      if (draw) {
        ctx.font = font(BODY_SIZE, 600)
        ctx.fillStyle = alarm.notified ? '#9ca3af' : '#374151'
        ctx.fillText(formatShortDate(alarm.remindAt), PADDING, y)
        ctx.font = font(13)
        ctx.fillStyle = '#9ca3af'
        ctx.fillText(
          `${ALARM_MODE_LABEL[alarm.mode]}${alarm.notified ? ' · 已提醒' : ''}`,
          PADDING + 150,
          y + 2,
        )
      }
      y += lineHeight
      drawn += 1
    }
    const remaining = entry.alarms.length - drawn
    if (remaining > 0) {
      ctx.font = font(13)
      if (draw) {
        ctx.fillStyle = '#9ca3af'
        ctx.fillText(`还有 ${remaining} 个闹钟…`, PADDING, y)
      }
      y += 22
    } else if (truncated) {
      ctx.font = font(13)
      if (draw) {
        ctx.fillStyle = '#9ca3af'
        ctx.fillText('…（内容较长，已截断）', PADDING, y)
      }
      y += 22
    }
    if (entry.alarms.length === 0) {
      ctx.font = font(BODY_SIZE)
      if (draw) {
        ctx.fillStyle = '#9ca3af'
        ctx.fillText('（没有闹钟）', PADDING, y)
      }
      y += lineHeight
    }
  } else if (image) {
    const maxHeight = 560
    const scale = Math.min(innerWidth / image.width, maxHeight / image.height, 1)
    const drawWidth = Math.round(image.width * scale)
    const drawHeight = Math.round(image.height * scale)
    if (draw) {
      roundRect(ctx, PADDING, y, drawWidth, drawHeight, 10)
      ctx.save()
      ctx.clip()
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.drawImage(image, PADDING, y, drawWidth, drawHeight)
      ctx.restore()
    }
    y += drawHeight
  } else {
    ctx.font = font(BODY_SIZE)
    if (draw) {
      ctx.fillStyle = '#9ca3af'
      ctx.fillText(entry.content ? '（涂鸦内容无法解析）' : '（空白涂鸦）', PADDING, y)
    }
    y += lineHeight
  }

  // 标签
  if (entry.tags.length > 0) {
    y += 18
    ctx.font = font(13)
    if (draw) ctx.fillStyle = '#6b7280'
    const tagText = entry.tags.map((tag) => `#${tag}`).join('   ')
    const tagLines = wrapText(ctx, tagText, innerWidth, font(13))
    for (const line of tagLines) {
      if (y + 22 > CONTENT_BOTTOM) break
      if (draw) ctx.fillText(line, PADDING, y)
      y += 22
    }
  }

  // 页脚
  y += 22
  if (draw) {
    ctx.strokeStyle = '#f0ece5'
    ctx.beginPath()
    ctx.moveTo(PADDING, y + 0.5)
    ctx.lineTo(CANVAS_WIDTH - PADDING, y + 0.5)
    ctx.stroke()
  }
  y += 16
  if (draw) {
    ctx.font = font(12)
    ctx.fillStyle = '#9ca3af'
    ctx.fillText('便签', PADDING, y)
    ctx.textAlign = 'right'
    ctx.fillText(formatDateTime(Date.now()), CANVAS_WIDTH - PADDING, y)
    ctx.textAlign = 'left'
  }
  y += 18 + PADDING

  return { height: Math.min(y, MAX_CANVAS_HEIGHT) }
}

/** 渲染最终分享图：白底圆角卡片 + 细边框，内容来自透明内容层 */
function composeCard(content: ContentResult): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = content.canvas.width
  canvas.height = content.canvas.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.scale(DPR, DPR)

  roundRect(ctx, 0.5, 0.5, CANVAS_WIDTH - 1, content.height - 1, 24)
  ctx.fillStyle = '#fffefb'
  ctx.fill()
  ctx.strokeStyle = '#ece7de'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.drawImage(
    content.canvas,
    0,
    0,
    content.canvas.width,
    content.canvas.height,
    0,
    0,
    CANVAS_WIDTH,
    content.height,
  )
  return canvas
}

async function renderEntryCanvas(entry: Entry): Promise<HTMLCanvasElement> {
  let image: HTMLImageElement | null = null
  if (entry.kind === 'draw' && entry.content) {
    try {
      image = await loadImage(entry.content)
    } catch {
      image = null
    }
  }
  const inlineImages =
    entry.kind === 'note'
      ? await loadInlineImages(splitNoteBlocks(entry.content))
      : new Map<string, HTMLImageElement>()

  // 第一趟只测量：算出实际内容高度，画布不再固定为上限高度
  const measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) throw new Error('无法创建画布')
  const { height } = paintEntry(entry, image, inlineImages, measureCtx, false)
  const contentHeight = Math.max(1, Math.ceil(height))

  // 第二趟按精确高度正式绘制
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH * DPR
  canvas.height = contentHeight * DPR
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.scale(DPR, DPR)
  paintEntry(entry, image, inlineImages, ctx, true)

  return composeCard({ canvas, height: contentHeight })
}

function safeFileName(entry: Entry): string {
  const base = (entry.title.trim() || KIND_META[entry.kind].label).slice(0, 40)
  return `${base.replace(/[\\/:*?"<>|]/g, '_')}.png`
}

/**
 * 导出一条便签为 PNG 分享图：
 * 桌面版走保存对话框 + Rust 写文件；浏览器预览直接触发下载。
 */
export async function exportEntryImage(
  entry: Entry,
): Promise<'saved' | 'cancelled'> {
  const canvas = await renderEntryCanvas(entry)
  const dataUrl = canvas.toDataURL('image/png')

  if (!isTauriRuntime()) {
    const link = document.createElement('a')
    link.href = dataUrl
    link.download = safeFileName(entry)
    link.click()
    return 'saved'
  }

  // 保存对话框会临时抢走焦点；关闭后兜底还原主窗口，
  // 避免窗口停在最小化 / 屏幕外的状态看起来像「便签消失了」
  try {
    const path = await dialogSave({
      defaultPath: safeFileName(entry),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    })
    if (!path) return 'cancelled'
    await invoke('write_image_file', {
      path,
      data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    })
    return 'saved'
  } finally {
    await ensureWindowVisible()
  }
}
