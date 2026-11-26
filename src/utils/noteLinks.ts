import { markdownToHtml } from "./markdown";
import { useEntryStore } from "../store/useEntryStore";
import { useUiStore } from "../store/useUiStore";

/**
 * 便签双向链接：正文 [[便签标题]] 语法的提取、渲染与跳转。
 * - 提取 / 反链计算用 extractWikiLinkTitles；
 * - 展示态渲染用 renderNoteMarkdown（复用 AI 面板同款 .note-ref-link 胶囊语义）；
 * - 编辑态不链接化：TipTap 里保持 [[标题]] 原文，避免破坏编辑。
 * 链接按标题精确匹配解析（trim 后全等），便签改名会使旧链接变为「未解析」态。
 */

export const WIKI_LINK_RE = /\[\[([^[\]\n]+)\]\]/g;

/** 兼容旧数据：turndown 曾把 [[ ]] 转义为 \[\[ \]\] 落盘，提取/渲染前先还原双括号序列 */
export function unwrapEscapedWikiLinks(md: string): string {
  return (md || "").replace(/\\\[\\\[/g, "[[").replace(/\\\]\\\]/g, "]]");
}

/** 标题匹配前的规范化：去首尾空白 */
function normalizeTitle(title: string): string {
  return title.trim();
}

/** 提取正文中引用的便签标题（去重保序，trim 后） */
export function extractWikiLinkTitles(input: string): string[] {
  const md = unwrapEscapedWikiLinks(input);
  const titles: string[] = [];
  for (const match of md.matchAll(WIKI_LINK_RE)) {
    const title = normalizeTitle(match[1]);
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles;
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtmlText(text).replace(/"/g, "&quot;");
}

/**
 * 便签 Markdown → HTML，并把 [[标题]] 渲染为引用胶囊。
 * resolve 把标题解析为目标便签 id；解析失败输出 is-unresolved 胶囊（无 data-id，点击不跳）。
 * 流程与 AI 面板一致：先摘链接为占位符 → markdown+消毒 → 回填真实 <a>（消毒后注入，
 * 内容仅来自本文件对 title/id 的转义拼接）。
 */
export function renderNoteMarkdown(
  input: string,
  resolve: (title: string) => { id: string } | null | undefined
): string {
  const md = unwrapEscapedWikiLinks(input);
  const titles: string[] = [];
  const tokenized = md.replace(WIKI_LINK_RE, (_m, title: string) => {
    titles.push(title);
    return `[[NL${titles.length - 1}]]`;
  });
  let html = markdownToHtml(tokenized);
  titles.forEach((title, index) => {
    const target = resolve(normalizeTitle(title));
    const tag = target
      ? `<a class="note-ref-link" data-id="${escapeHtmlAttr(target.id)}">${escapeHtmlText(title)}</a>`
      : `<a class="note-ref-link is-unresolved" data-title="${escapeHtmlAttr(normalizeTitle(title))}">${escapeHtmlText(title)}</a>`;
    html = html.split(`[[NL${index}]]`).join(tag);
  });
  return html;
}

/** 跳转到指定便签：选中 + 弹详情（与 AI 面板引用跳转同语义） */
export function jumpToEntry(id: string): void {
  useEntryStore.getState().setSelectedId(id);
  useUiStore.getState().setDetailView(true);
}

/**
 * 点击事件命中便签引用胶囊时执行跳转。
 * 命中带 data-id 的胶囊 → 直接跳；返回 true 表示已处理（调用方应阻止冒泡）。
 */
export function handleNoteRefClick(event: {
  target: EventTarget | null;
}): boolean {
  const el = (event.target as HTMLElement | null)?.closest?.(
    ".note-ref-link"
  ) as HTMLElement | null;
  if (!el) return false;
  const id = el.getAttribute("data-id");
  if (!id) return false;
  jumpToEntry(id);
  return true;
}

/** 按标题在条目清单中解析引用目标（仅备忘便签，首个标题全等匹配） */
export function resolveNoteRefByTitle(
  entries: { id: string; kind: string; title: string }[],
  title: string
): { id: string } | null {
  const wanted = normalizeTitle(title);
  if (!wanted) return null;
  const target = entries.find(
    (entry) => entry.kind === "note" && normalizeTitle(entry.title) === wanted
  );
  return target ? { id: target.id } : null;
}
