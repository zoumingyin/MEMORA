/**
 * 部分 OpenAI 兼容上游会在流式 function name 中混入控制标记
 * （例如 create_entry<|channel|>json）。这里只在去掉标记后
 * 精确命中本轮已注册工具名时才归一化；未知名称保持原样，
 * 仍由执行层按工具范围拦截。
 */
export function normalizeToolCallName(
  name: string,
  allowed: ReadonlySet<string>,
): string {
  if (allowed.has(name)) return name
  const marker = name.indexOf('<|')
  if (marker <= 0) return name
  const candidate = name.slice(0, marker).trim()
  return allowed.has(candidate) ? candidate : name
}
