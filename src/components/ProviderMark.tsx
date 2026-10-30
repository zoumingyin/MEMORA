import { Bot } from 'lucide-react'
import { PROVIDER_MARKS, type ProviderMarkKey } from './providerMarks'

/** 预设服务商名称 → 品牌标识（与设置页下拉选项一一对应） */
const PRESET_MARKS: Record<string, ProviderMarkKey> = {
  DeepSeek: 'deepseek',
  'Moonshot Kimi': 'moonshot',
  OpenAI: 'openai',
  '通义千问（兼容模式）': 'qwen',
  '火山引擎（方舟）': 'volcengine',
  '智谱 GLM': 'zhipu',
  'Ollama（本地）': 'ollama',
}

/** 自定义服务 / 环境变量注入的配置没有预设名称，按接口地址推断品牌 */
const HOST_MARKS: Array<[RegExp, ProviderMarkKey]> = [
  [/(^|\.)deepseek\.com(?::|\/|$)/, 'deepseek'],
  [/moonshot\.(?:cn|ai)(?::|\/|$)/, 'moonshot'],
  [/(^|\.)openai\.com(?::|\/|$)/, 'openai'],
  [/dashscope\.aliyuncs\.com(?::|\/|$)/, 'qwen'],
  [/volces\.com(?::|\/|$)/, 'volcengine'],
  [/bigmodel\.cn(?::|\/|$)/, 'zhipu'],
  [/[:.]11434(?:\/|$)/, 'ollama'],
]

/** 品牌色：深色主题下也能辨认；黑色系标识改用正文颜色随主题反转 */
const MARK_COLOR: Record<ProviderMarkKey, string> = {
  deepseek: 'text-[#4D6BFE]',
  openai: 'text-[var(--text)]',
  moonshot: 'text-[var(--text)]',
  zhipu: 'text-[#3859FF]',
  qwen: 'text-[#615CED]',
  volcengine: 'text-[#1664FF]',
  ollama: 'text-[var(--text)]',
}

function providerMarkKey(
  provider: string,
  baseUrl: string
): ProviderMarkKey | null {
  const preset = PRESET_MARKS[provider.trim()]
  if (preset) return preset
  const url = baseUrl.trim().toLowerCase()
  if (!url) return null
  for (const [pattern, key] of HOST_MARKS) {
    if (pattern.test(url)) return key
  }
  return null
}

export function ProviderMark({
  provider,
  baseUrl,
  size = 14,
  className,
}: {
  provider: string
  baseUrl: string
  size?: number
  className?: string
}) {
  const key = providerMarkKey(provider, baseUrl)
  if (!key) {
    return (
      <Bot
        size={size}
        aria-hidden
        className={['shrink-0', 'text-[var(--kind-accent)]', className]
          .filter(Boolean)
          .join(' ')}
      />
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      className={['shrink-0', MARK_COLOR[key], className].filter(Boolean).join(' ')}
      dangerouslySetInnerHTML={{ __html: PROVIDER_MARKS[key] }}
    />
  )
}
