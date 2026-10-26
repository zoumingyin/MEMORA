/** 字数统计：中文字符 + 英文单词（数字视为单词） */
export function countMarkdownWords(text: string): number {
  const cn = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const en = (text.match(/[a-zA-Z0-9]+(?:['’-][a-zA-Z0-9]+)*/g) ?? []).length
  return cn + en
}
