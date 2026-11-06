import type { AiChatMessage } from '../types/ai'
import type { Entry, NoteEntry, ReminderEntry, TodoEntry } from '../types/entry'
import { streamChat } from './aiClient'
import { parseAssistantActions } from '../utils/assistantActions'
import { useAssistantStore } from '../store/useAssistantStore'
import { useEntryStore } from '../store/useEntryStore'

/**
 * AI 日/周总结：定时把最近一段时间内的便签、待办与提醒交给模型，
 * 生成一篇 Markdown 总结并以「AI 总结」标签存为新便签。
 * - 走与对话相同的 streamChat 通道，但不下发任何工具（纯文本模型也能用）；
 * - 隐私不变量：上下文开关（contextEnabled）关闭时不读取、不生成；
 * - 调度在前端 30s 轮询，配合 localStorage 的 last-run 记录去重，
 *   生成失败后进入冷却，避免反复请求。
 */

export type SummaryMode = 'daily' | 'weekly'

export interface SummarySettings {
  dailyEnabled: boolean
  /** 每日生成时间，HH:mm */
  dailyTime: string
  weeklyEnabled: boolean
  /** 每周生成日：0 = 周日，1-6 = 周一至周六（与 Date.getDay 一致） */
  weeklyWeekday: number
  weeklyTime: string
}

export interface SummaryLastRun {
  /** 最近一次日总结的日期（本地 YYYY-MM-DD） */
  daily: string | null
  /** 最近一次周总结所在周的周一日期（本地 YYYY-MM-DD） */
  weekly: string | null
}

const SETTINGS_KEY = 'bianqian.aiSummary.v1'
const LAST_RUN_KEY = 'bianqian.aiSummary.lastRun.v1'
const SUMMARY_TAG = 'AI 总结'
/** 生成失败后的冷却时间：30s 轮询下避免反复打失败请求 */
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000
/** 上下文体积兜底：各段落最多收集条数 */
const MAX_NOTES = 40
const MAX_TODOS = 60
const MAX_REMINDERS = 40
/** 单条正文摘要截断长度 */
const SNIPPET_LEN = 120

const DEFAULT_SETTINGS: SummarySettings = {
  dailyEnabled: false,
  dailyTime: '21:00',
  weeklyEnabled: false,
  weeklyWeekday: 0,
  weeklyTime: '20:00',
}

/** 读设置；字段缺失或非法时回落默认值 */
export function readSummarySettings(): SummarySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<SummarySettings>
    return {
      dailyEnabled: parsed.dailyEnabled === true,
      dailyTime: isValidTime(parsed.dailyTime) ? parsed.dailyTime! : DEFAULT_SETTINGS.dailyTime,
      weeklyEnabled: parsed.weeklyEnabled === true,
      weeklyWeekday:
        typeof parsed.weeklyWeekday === 'number' &&
        Number.isInteger(parsed.weeklyWeekday) &&
        parsed.weeklyWeekday >= 0 &&
        parsed.weeklyWeekday <= 6
          ? parsed.weeklyWeekday
          : DEFAULT_SETTINGS.weeklyWeekday,
      weeklyTime: isValidTime(parsed.weeklyTime) ? parsed.weeklyTime! : DEFAULT_SETTINGS.weeklyTime,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function writeSummarySettings(settings: SummarySettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function readSummaryLastRun(): SummaryLastRun {
  try {
    const raw = localStorage.getItem(LAST_RUN_KEY)
    if (!raw) return { daily: null, weekly: null }
    const parsed = JSON.parse(raw) as Partial<SummaryLastRun>
    return {
      daily: typeof parsed.daily === 'string' ? parsed.daily : null,
      weekly: typeof parsed.weekly === 'string' ? parsed.weekly : null,
    }
  } catch {
    return { daily: null, weekly: null }
  }
}

function writeSummaryLastRun(next: SummaryLastRun): void {
  localStorage.setItem(LAST_RUN_KEY, JSON.stringify(next))
}

function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/** 本地日期键 YYYY-MM-DD（设置页展示 last-run 时也使用） */
export function dateKey(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 所在周的周一日期键（用于周总结去重与展示） */
export function weekStartKey(date: Date): string {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const day = monday.getDay()
  const diff = day === 0 ? 6 : day - 1
  monday.setDate(monday.getDate() - diff)
  return dateKey(monday)
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map((part) => Number.parseInt(part, 10))
  return (h || 0) * 60 + (m || 0)
}

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function truncate(text: string, max = SNIPPET_LEN): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function isTodo(entry: Entry): entry is TodoEntry {
  return entry.kind === 'todo'
}

function isReminder(entry: Entry): entry is ReminderEntry {
  return entry.kind === 'reminder'
}

function isNoteText(entry: Entry): entry is NoteEntry {
  return entry.kind === 'note'
}

interface SummaryContext {
  mode: SummaryMode
  windowStart: Date
  windowEnd: Date
  notes: string[]
  todosDone: string[]
  todosPending: string[]
  remindersUpcoming: string[]
}

/**
 * 从 entryStore 收集总结窗口内的素材：
 * 日总结 = 今天 0 点至今；周总结 = 最近 7 天。
 * 涂鸦不参与（内容是图片，模型无法读取）。
 */
function buildSummaryContext(mode: SummaryMode): SummaryContext {
  const now = new Date()
  const windowStart =
    mode === 'daily'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  const entries = useEntryStore
    .getState()
    .entries.filter((entry) => !entry.deletedAt && entry.kind !== 'draw')

  const notes: string[] = []
  const todosDone: string[] = []
  const todosPending: string[] = []
  const remindersUpcoming: string[] = []

  for (const entry of entries) {
    if (isTodo(entry)) {
      if (entry.done && entry.completedAt && entry.completedAt >= windowStart.getTime()) {
        const items = entry.items.filter((item) => item.done).map((item) => item.text)
        todosDone.push(
          truncate(items.length > 0 ? `${entry.title}（${items.join('；')}）` : entry.title),
        )
      } else if (!entry.done) {
        const pendingItems = entry.items.filter((item) => !item.done).map((item) => item.text)
        todosPending.push(
          truncate(
            pendingItems.length > 0
              ? `${entry.title}（未完成：${pendingItems.join('；')}）`
              : entry.title,
          ),
        )
      }
      continue
    }
    if (isReminder(entry)) {
      const nowMs = now.getTime()
      if (
        !entry.done &&
        entry.remindAt >= nowMs &&
        entry.remindAt <= nowMs + 7 * 24 * 60 * 60 * 1000
      ) {
        remindersUpcoming.push(truncate(`${entry.title}（${dateKey(new Date(entry.remindAt))}）`))
      }
      continue
    }
    // 备忘：看窗口内新建或修改过的
    if (isNoteText(entry)) {
      if (entry.createdAt >= windowStart.getTime() || entry.updatedAt >= windowStart.getTime()) {
        notes.push(truncate(entry.content ? `${entry.title}：${entry.content}` : entry.title))
      }
    }
  }

  return {
    mode,
    windowStart,
    windowEnd: now,
    notes: notes.slice(0, MAX_NOTES),
    todosDone: todosDone.slice(0, MAX_TODOS),
    todosPending: todosPending.slice(0, MAX_TODOS),
    remindersUpcoming: remindersUpcoming.slice(0, MAX_REMINDERS),
  }
}

function buildMessages(context: SummaryContext): AiChatMessage[] {
  const { mode, windowStart, windowEnd } = context
  const rangeText =
    mode === 'daily'
      ? `今天（${dateKey(windowStart)}）`
      : `最近一周（${dateKey(windowStart)} 至 ${dateKey(windowEnd)}）`

  const section = (title: string, items: string[]): string =>
    items.length > 0 ? `${title}：\n${items.map((item) => `- ${item}`).join('\n')}` : `${title}：无`

  const material = [
    section('新建或修改的备忘', context.notes),
    section('已完成的待办', context.todosDone),
    section('未完成的待办', context.todosPending),
    section('未来 7 天内的提醒', context.remindersUpcoming),
  ].join('\n\n')

  const system =
    '你是用户的个人便签助理。请根据给定的便签素材写一篇简洁的总结，' +
    '输出 Markdown：以「## 概览」开始（2-3 句话概括这段时间的整体情况），' +
    '之后用「## 」小节归类要点（例如：已完成、进行中、待关注、备忘回顾），' +
    '条目用「- 」列表，保留关键时间与数字。不要虚构素材里没有的内容，' +
    '不要输出 <action> 标签或任何操作指令，不要添加开场白与结尾客套。'

  const user = `请为我总结${rangeText}的便签记录。\n\n${material}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function summaryTitle(mode: SummaryMode): string {
  const now = new Date()
  if (mode === 'daily') return `AI 日总结 · ${dateKey(now)}`
  return `AI 周总结 · ${weekStartKey(now)} ~ ${dateKey(now)}`
}

/** 把 streamChat 包成 Promise：收集增量文本，错误转异常 */
function streamOnce(messages: AiChatMessage[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let text = ''
    void streamChat(`summary-${Date.now().toString(36)}`, null, messages, {
      onDelta: (delta) => {
        text += delta
      },
      onDone: () => resolve(text),
      onError: (error) => reject(new Error(error.message)),
    })
  })
}

function hasExistingSummary(mode: SummaryMode): boolean {
  const title = summaryTitle(mode)
  return useEntryStore
    .getState()
    .entries.some(
      (entry) =>
        !entry.deletedAt && entry.tags.includes(SUMMARY_TAG) && entry.title === title,
    )
}

export interface RunSummaryOptions {
  /** 手动触发：跳过去重与冷却（仍尊重上下文隐私开关） */
  force?: boolean
}

/**
 * 生成并保存一次总结，返回新便签 id。
 * 抛出 Error 时说明未生成（文案已面向用户）。
 */
export async function runSummary(
  mode: SummaryMode,
  options: RunSummaryOptions = {},
): Promise<string> {
  if (!useAssistantStore.getState().contextEnabled) {
    throw new Error('「读取便签作为上下文」已关闭，生成总结需要读取便签内容；请先在设置中开启。')
  }
  if (!options.force) {
    const lastRun = readSummaryLastRun()
    if (mode === 'daily' && lastRun.daily === dateKey(new Date())) {
      throw new Error('今天已经生成过日总结。')
    }
    if (mode === 'weekly' && lastRun.weekly === weekStartKey(new Date())) {
      throw new Error('本周已经生成过周总结。')
    }
    if (hasExistingSummary(mode)) {
      throw new Error('已存在同名的总结便签。')
    }
  }

  const context = buildSummaryContext(mode)
  const empty =
    context.notes.length === 0 &&
    context.todosDone.length === 0 &&
    context.todosPending.length === 0 &&
    context.remindersUpcoming.length === 0
  if (empty) {
    throw new Error(mode === 'daily' ? '今天还没有可总结的记录。' : '最近一周没有可总结的记录。')
  }

  const raw = await streamOnce(buildMessages(context))
  const { text } = parseAssistantActions(raw)
  const body = text.trim()
  if (!body) {
    throw new Error('模型没有返回有效内容，请稍后重试或更换模型。')
  }

  const entry = await useEntryStore.getState().addEntry(
    {
      title: summaryTitle(mode),
      content: body,
      tags: [SUMMARY_TAG],
    },
    'note',
  )
  if (!entry) {
    throw new Error('总结已生成，但写入便签失败，请重试。')
  }

  const lastRun = readSummaryLastRun()
  writeSummaryLastRun({
    ...lastRun,
    [mode]: mode === 'daily' ? dateKey(new Date()) : weekStartKey(new Date()),
  })
  return entry.id
}

let failureAt = 0

interface SchedulerState {
  timer: number | null
  busy: boolean
}

const scheduler: SchedulerState = { timer: null, busy: false }

/** 调度器心跳：检查设置与上次运行记录，到点触发生成 */
async function tick(): Promise<void> {
  const settings = readSummarySettings()
  if (!settings.dailyEnabled && !settings.weeklyEnabled) return
  if (!useAssistantStore.getState().contextEnabled) return
  if (scheduler.busy) return
  // 距上次失败仍在冷却期内：跳过本轮，避免反复请求
  if (Date.now() - failureAt < FAILURE_COOLDOWN_MS) return

  const now = new Date()
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const lastRun = readSummaryLastRun()

  const due: SummaryMode[] = []
  if (
    settings.dailyEnabled &&
    nowMinutes >= timeToMinutes(settings.dailyTime) &&
    lastRun.daily !== dateKey(now)
  ) {
    due.push('daily')
  }
  if (
    settings.weeklyEnabled &&
    now.getDay() === settings.weeklyWeekday &&
    nowMinutes >= timeToMinutes(settings.weeklyTime) &&
    lastRun.weekly !== weekStartKey(now)
  ) {
    due.push('weekly')
  }

  for (const mode of due) {
    scheduler.busy = true
    try {
      await runSummary(mode)
    } catch (error) {
      failureAt = Date.now()
      if (import.meta.env.DEV) {
        console.warn('[AI 总结] 自动生成失败：', error)
      }
    } finally {
      scheduler.busy = false
    }
  }
}

/** 启动总结调度器（30s 轮询），返回清理函数 */
export function startSummaryScheduler(): () => void {
  if (scheduler.timer !== null) return () => undefined
  // 启动即先判定一次：重启后「到点未跑」的任务无需等第一个 30s 才补上
  void tick()
  // 窗口最小化/隐藏时页面定时器会被 WebView 节流到分钟级；
  // 回到前台立即补一次判定，缩小漏检窗口
  const onVisible = (): void => {
    if (!document.hidden) void tick()
  }
  document.addEventListener('visibilitychange', onVisible)
  scheduler.timer = window.setInterval(() => {
    void tick()
  }, 30_000)
  return () => {
    if (scheduler.timer !== null) {
      window.clearInterval(scheduler.timer)
      scheduler.timer = null
    }
    document.removeEventListener('visibilitychange', onVisible)
  }
}
