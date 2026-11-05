import { marked } from "marked";
import DOMPurify from "dompurify";

/** 字数统计：中文字符 + 英文单词（数字视为单词） */
export function countMarkdownWords(text: string): number {
  const cn = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const en = (text.match(/[a-zA-Z0-9]+(?:['’-][a-zA-Z0-9]+)*/g) ?? []).length
  return cn + en
}

/**
 * markdown → HTML：marked 解析 + DOMPurify 消毒（放行内联 style 以保留颜色/字号）。
 * 用于便签列表中对「备忘」类条目的正文做富文本渲染。
 * ADD_TAGS 放行 note-ref：AI 回答中的便签引用胶囊（<note-ref id="...">标题</note-ref>），
 * 点击跳转选中对应便签（见 AssistantPanel 的 handleLinkClick）。
 */
export function markdownToHtml(md: string): string {
  const raw = marked.parse(md || "");
  return DOMPurify.sanitize(typeof raw === "string" ? raw : "", {
    ADD_TAGS: ["note-ref"],
    ADD_ATTR: ["style"],
  });
}
