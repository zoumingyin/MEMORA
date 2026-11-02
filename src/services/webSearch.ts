/**
 * 联网搜索：桌面端经 Rust 代理抓取必应（国内版）结果；
 * 浏览器预览受 CORS 限制无法直连搜索引擎，直接提示改用桌面版。
 */

import { invoke } from '@tauri-apps/api/core'
import dayjs from 'dayjs'
import { isTauriRuntime } from '../repository'
import type { WebSearchResult } from '../types/ai'

/** 注入提示词的最大条数与单条摘要长度：控制提示词体积 */
const MAX_RESULTS_IN_PROMPT = 6
const MAX_SNIPPET_CHARS = 160

/** 搜索给定问题，返回结构化结果；失败时抛出可读错误 */
export async function searchWeb(query: string): Promise<WebSearchResult[]> {
  if (!isTauriRuntime()) {
    throw new Error('浏览器预览不支持联网搜索（无法跨域访问搜索引擎），请使用桌面版。')
  }
  const results = await invoke<WebSearchResult[]>('ai_web_search', { query })
  if (results.length === 0) {
    throw new Error('搜索没有返回结果')
  }
  return results
}

/**
 * 把搜索结果格式化成注入 system 提示词的文本块。
 * 措辞必须显式断言「你具备联网能力、这就是刚搜到的实时数据」：
 * 基础 system prompt 把助手定位在便签应用内，部分模型（尤其免费小模型）
 * 会按训练认知答「我不能联网」——不强调这一点搜索就等于白搜。
 */
export function formatWebResults(results: WebSearchResult[], query: string): string {
  const searchedAt = dayjs().format('YYYY年M月D日 HH:mm')
  const lines = results.slice(0, MAX_RESULTS_IN_PROMPT).map((result, index) => {
    const snippet =
      result.snippet.length > MAX_SNIPPET_CHARS
        ? `${result.snippet.slice(0, MAX_SNIPPET_CHARS)}…`
        : result.snippet
    // 正文摘录是模型可引用的实义内容（摘要可能只有一句话甚至只是入口页）
    const excerpt = result.content?.trim()
    return [
      `[${index + 1}] ${result.title}`,
      snippet,
      excerpt ? `正文摘录：${excerpt}` : null,
      `来源: ${result.url}`,
    ]
      .filter(Boolean)
      .join('\n')
  })
  return [
    '【联网搜索已生效】',
    `你具备联网搜索能力：应用刚刚替你执行了一次真实的必应搜索（搜索词：${query}；搜索时间：${searchedAt}）。`,
    '下面的条目就是刚从网络实时抓取的内容，是当前可用的最新信息，不是你的训练记忆：',
    ...lines,
    '',
    '使用规则：',
    '- 请优先依据上述结果回答用户的最新问题，引用其中的事实时注明来源（如「据 [2]」或附 URL）；',
    '- 绝对不要以「我不能联网」「没有实时信息」「无法获取最新资讯」为由拒绝或回避回答；',
    '- 结果可能不完整或与问题不完全匹配：信息不足时基于现有结果作答并明确说明局限，不要编造搜索结果之外的内容。',
  ].join('\n')
}
