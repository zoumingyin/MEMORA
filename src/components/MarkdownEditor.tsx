import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { marked } from "marked";
import DOMPurify from "dompurify";
import TurndownService from "turndown";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../repository";
import {
  BoldOutlined,
  CodeOutlined,
  ItalicOutlined,
  LinkOutlined,
  OrderedListOutlined,
  PictureOutlined,
  RedoOutlined,
  StrikethroughOutlined,
  UnderlineOutlined,
  UndoOutlined,
  UnorderedListOutlined,
  CopyOutlined,
  ScissorOutlined,
  SnippetsOutlined,
  CheckSquareOutlined,
  FontColorsOutlined,
  BgColorsOutlined,
  FontSizeOutlined,
  SmileOutlined,
  KeyOutlined,
} from "@ant-design/icons";
import { ColorPicker } from "antd";
import { countMarkdownWords } from "../utils/markdown";

/** 危险协议：跳过导航，避免 XSS */
const UNSAFE_PROTOCOL = /^\s*(javascript|vbscript):/i;

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/** 文字颜色板：红 / 橙 / 绿 / 蓝 / 紫 / 亮白（暗色下文字用） */
const FONT_COLORS = [
  { label: "红", value: "#e5484d" },
  { label: "橙", value: "#f2994a" },
  { label: "绿", value: "#30a46c" },
  { label: "蓝", value: "#3b82f6" },
  { label: "紫", value: "#8e4ec6" },
  { label: "白", value: "#f4f1ea" },
];

/** 完整颜色面板（右键菜单用）：两排颜色 + 标准色 */
const COLOR_PALETTE = [
  "#000000",
  "#4d4d4d",
  "#999999",
  "#e6e6e6",
  "#ffffff",
  "#ff0000",
  "#ff9900",
  "#ffff00",
  "#00ff00",
  "#00ffff",
  "#0066ff",
  "#9900ff",
  "#ff00ff",
  "#ff6699",
  "#663300",
];

/** 标准色（底部一排） */
const STANDARD_COLORS = [
  "#e5484d",
  "#f2994a",
  "#f5d90a",
  "#30a46c",
  "#3b82f6",
  "#8e4ec6",
  "#e5489d",
  "#000000",
];

/** 完整字号列表 */
const FONT_SIZES = [8, 9, 10, 12, 14, 16, 18, 20, 24, 36, 48];

/** 字号扩展：基于 TextStyle 的内联样式（TipTap v3 兼容实现） */
const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element: HTMLElement) => element.style.fontSize || null,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.fontSize
                ? { style: `font-size: ${attributes.fontSize as string}` }
                : {},
          },
        },
      },
    ];
  },
});

/** 文本拖拽移动：选中文字后按住拖动到新位置（保留原格式，可撤销） */
function createTextDragPlugin(): Plugin {
  let dragging = false;
  let dragFrom = 0;
  let dragTo = 0;
  return new Plugin({
    props: {
      handleDOMEvents: {
        dragstart(view, event) {
          const { selection } = view.state;
          if (!selection.empty) {
            dragging = true;
            dragFrom = selection.from;
            dragTo = selection.to;
            const dt = event.dataTransfer;
            if (dt) dt.effectAllowed = "move";
          }
        },
        dragend() {
          dragging = false;
        },
      },
      handleDrop(view, event) {
        if (!dragging) return false;
        const pos = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (!pos) return false;
        const target = pos.pos;
        if (target >= dragFrom && target <= dragTo) return false;
        const { state } = view;
        const slice = state.doc.slice(dragFrom, dragTo);
        const len = dragTo - dragFrom;
        const insertAt = target > dragTo ? target - len : target;
        const tr = state.tr.delete(dragFrom, dragTo);
        tr.insert(insertAt, slice.content);
        tr.scrollIntoView();
        view.dispatch(tr);
        dragging = false;
        event.preventDefault();
        return true;
      },
    },
  });
}

/** 文本拖拽移动扩展（挂到编辑器的插件列表） */
const TextDrag = Extension.create({
  name: "textDrag",
  addProseMirrorPlugins() {
    return [createTextDragPlugin()];
  },
});

/** 粘贴图片：剪贴板中的 image 文件 → 读取为 base64 dataURL → 插入编辑器 */
const PasteImage = Extension.create({
  name: "pasteImage",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste(view, event) {
            const items = Array.from(event.clipboardData?.items ?? []);
            const imageItem = items.find((item) =>
              item.type.startsWith("image/")
            );
            if (!imageItem) return false;
            const file = imageItem.getAsFile();
            if (!file) return false;
            const reader = new FileReader();
            reader.onload = () => {
              const src = reader.result as string;
              const { tr } = view.state;
              const pos = view.state.selection.from;
              tr.insert(pos, view.state.schema.nodes.image.create({ src }));
              view.dispatch(tr);
              view.focus();
            };
            reader.readAsDataURL(file);
            return true;
          },
        },
      }),
    ];
  },
});

/** markdown → HTML：marked 解析 + DOMPurify 消毒（放行内联 style 以保留颜色/字号） */
function markdownToHtml(md: string): string {
  const raw = marked.parse(md || "");
  return DOMPurify.sanitize(typeof raw === "string" ? raw : "", {
    ADD_ATTR: ["style"],
  });
}

/** HTML → markdown：turndown；带内联样式 span 与下划线转为内嵌 HTML 保留 */
function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  turndown.addRule("styledInline", {
    filter: (node) =>
      (node.nodeName === "SPAN" && node.getAttribute("style") !== null) ||
      node.nodeName === "U",
    replacement: (content, node) => {
      if (node.nodeName === "U") return `<u>${content}</u>`;
      const style = node.getAttribute("style");
      return style ? `<span style="${style}">${content}</span>` : content;
    },
  });
  return turndown;
}

/**
 * 所见即所得富文本 Markdown 编辑器（TipTap）：
 * 顶部工具条（标题/加粗/斜体/删除线/下划线/颜色/字号/列表/引用/代码/链接/撤销重做）
 * + 选中文字浮动工具条 + 底部字数统计。
 * 数据仍以 Markdown 文本存储：外部 value 为 Markdown，编辑实时转回 Markdown；
 * 颜色/字号/下划线等富文本扩展属性以内嵌 HTML（span/u）形式保留在 Markdown 中。
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
}: MarkdownEditorProps) {
  const [fbar, setFbar] = useState<{ top: number; left: number } | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  // 右键上下文菜单
  const [ctxMenu, setCtxMenu] = useState<{ top: number; left: number } | null>(
    null
  );
  const [ctxSubmenu, setCtxSubmenu] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastHtmlRef = useRef<string>("");
  /** 标记「刚刚是用户输入触发的 onChange」，同步 effect 据此跳过 setContent，避免光标跳走 */
  const isInternalUpdate = useRef(false);
  const turndown = useMemo(() => createTurndown(), []);
  const htmlToMarkdown = (html: string): string =>
    turndown.turndown(html || "");

  /** 打开超链接：始终通过浏览器新开窗口打开，不在本项目内做内部路由跳转。
      相对路径由浏览器按当前文档基地址解析；过滤 javascript:/vbscript: 等危险协议。 */
  const openLink = (rawHref: string): void => {
    const href = rawHref.trim();
    if (!href || UNSAFE_PROTOCOL.test(href)) return;
    window.open(href, "_blank", "noopener,noreferrer");
  };

  /** 打开图片预览：创建独立图片查看器窗口（Tauri 环境），浏览器预览退化为新标签页 */
  const openImagePreview = async (
    images: string[],
    index: number
  ): Promise<void> => {
    if (!isTauriRuntime()) {
      window.open(images[index], "_blank");
      return;
    }
    try {
      const label = `image-preview-${Date.now()}`;
      // 图片数据（base64）不放在 URL 参数里，避免 URL 过长导致 431 错误；
      // 通过 localStorage 传递，预览窗口加载后读取。
      const storageKey = `image-preview-${Date.now()}`;
      const isDark = document.documentElement.classList.contains("dark-glass");
      localStorage.setItem(
        storageKey,
        JSON.stringify({ images, index, isDark })
      );
      const params = new URLSearchParams({
        imagePreview: "1",
        key: storageKey,
      });
      new WebviewWindow(label, {
        url: `index.html?${params.toString()}`,
        width: 900,
        height: 650,
        minWidth: 400,
        minHeight: 300,
        center: true,
        decorations: false,
        transparent: false,
        alwaysOnTop: false,
        resizable: true,
        skipTaskbar: false,
        focus: true,
        visible: true,
        title: "图片预览",
      });
    } catch (error) {
      console.error("打开图片预览失败", error);
      window.open(images[index], "_blank");
    }
  };

  /** 正文点击：拦截超链接（新窗口打开）与图片（独立预览窗口） */
  const handleBodyClick = (event: React.MouseEvent): void => {
    const target = event.target as HTMLElement;
    const linkEl = target.closest("a");
    const href = linkEl?.getAttribute("href");
    if (linkEl && href) {
      event.preventDefault();
      event.stopPropagation();
      openLink(href);
      return;
    }
    const imgEl = target.closest("img");
    if (imgEl) {
      event.preventDefault();
      event.stopPropagation();
      const root = editorRef.current;
      const imgs = root ? Array.from(root.querySelectorAll("img")) : [];
      const idx = imgs.indexOf(imgEl);
      const sources = imgs.map(
        (img) => img.currentSrc || img.getAttribute("src") || ""
      );
      if (idx >= 0 && sources[idx]) {
        void openImagePreview(sources, idx);
      }
    }
  };

  /** 右键菜单：拦截默认右键，显示自定义上下文菜单 */
  const handleContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault();
    const menuWidth = 220;
    const menuHeight = 520;
    let left = event.clientX;
    let top = event.clientY;
    // 防止菜单超出右边界
    if (left + menuWidth > window.innerWidth)
      left = window.innerWidth - menuWidth - 8;
    // 如果往下弹会超出底部，就往上弹
    if (top + menuHeight > window.innerHeight) {
      top = event.clientY;
    }
    if (top < 0) top = 0;
    setCtxMenu({ top, left });
    setCtxSubmenu(null);
  };

  /** 关闭右键菜单（点击别处 / Esc） */
  const closeCtxMenu = (): void => {
    setCtxMenu(null);
    setCtxSubmenu(null);
  };

  /** 标记加载失败的图片，便于 CSS 显示破损占位（error 不冒泡，用捕获阶段监听） */
  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    const onError = (event: Event): void => {
      if (event.target instanceof HTMLImageElement) {
        event.target.classList.add("md-img-broken");
      }
    };
    root.addEventListener("error", onError, true);
    return () => root.removeEventListener("error", onError, true);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      TextStyle,
      Color,
      FontSize,
      Placeholder.configure({
        placeholder:
          placeholder ??
          "写点什么… 支持 # 标题、**加粗**、- 列表、> 引用、```代码```",
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
      }),
      Image.configure({ allowBase64: true }),
      TextDrag,
      PasteImage,
    ],
    content: markdownToHtml(value),
    onUpdate: ({ editor: current }) => {
      const html = current.getHTML();
      lastHtmlRef.current = html;
      isInternalUpdate.current = true;
      onChange(htmlToMarkdown(html));
    },
    onSelectionUpdate: ({ editor: current }) => {
      const { from, to } = current.state.selection;
      if (from !== to && current.isFocused) {
        const selection = window.getSelection();
        const box = editorRef.current?.getBoundingClientRect();
        if (selection && selection.rangeCount > 0 && box) {
          const rect = selection.getRangeAt(0).getBoundingClientRect();
          setFbar({
            top: Math.max(rect.top - box.top - 36, 4),
            left: rect.left - box.left + rect.width / 2,
          });
        }
      } else {
        setFbar(null);
      }
    },
    onBlur: () => {
      setFbar(null);
      setColorOpen(false);
    },
    editorProps: {
      attributes: {
        class: "md-prose",
        spellcheck: "false",
      },
    },
  });

  // 外部 Markdown 变化（切换条目 / 外部落盘）→ 同步进编辑器（跳过自身回写）
  useEffect(() => {
    if (!editor) return;
    // 自己输入触发的 value 变化，跳过同步，避免 setContent 重置光标
    if (isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }
    const nextHtml = markdownToHtml(value);
    if (nextHtml !== editor.getHTML()) {
      editor.commands.setContent(nextHtml, { emitUpdate: false });
    }
  }, [value, editor]);

  const wordCount = useMemo(
    () => countMarkdownWords(editor?.getText() ?? ""),
    [editor]
  );
  const lineCount = useMemo(
    () => (editor?.getText() ?? "").split("\n").length,
    [editor]
  );

  const run = (fn: () => void): void => {
    fn();
    editor?.commands.focus();
  };

  const applyColor = (color: string | null): void => {
    if (color) {
      editor?.chain().focus().setColor(color).run();
    } else {
      editor?.chain().focus().unsetColor().run();
    }
    setColorOpen(false);
    setFbar(null);
  };

  const applyFontSize = (size: string | null): void => {
    if (size) {
      editor?.chain().focus().setMark("textStyle", { fontSize: size }).run();
    } else {
      editor?.chain().focus().setMark("textStyle", { fontSize: null }).run();
    }
    setFbar(null);
  };

  const applyLink = (): void => {
    // 光标已在链接里 → 预填当前地址，便于修改；否则清空准备新建
    const currentHref = editor?.getAttributes("link").href as
      | string
      | undefined;
    setLinkUrl(currentHref ?? "");
    setFbar(null);
    setLinkDraft(true);
  };

  // 链接输入条展开时聚焦输入框
  useEffect(() => {
    if (linkDraft) linkInputRef.current?.focus();
  }, [linkDraft]);

  const confirmLink = (): void => {
    const href = linkUrl.trim();
    if (href) {
      editor?.chain().focus().setLink({ href }).run();
    } else {
      editor?.chain().focus().unsetLink().run();
    }
    setLinkDraft(false);
    setFbar(null);
  };

  const cancelLink = (): void => {
    setLinkDraft(false);
  };

  const onImageFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      editor
        ?.chain()
        .focus()
        .setImage({ src: reader.result as string })
        .run();
    };
    reader.readAsDataURL(file);
  };

  const toolActive = (name: string): boolean => editor?.isActive(name) ?? false;
  const headingActive = (level: number): boolean =>
    editor?.isActive("heading", { level }) ?? false;

  /** 顶部工具条按钮 */
  const tools: Array<{
    key: string;
    title: string;
    label?: React.ReactNode;
    active?: boolean;
    onClick: () => void;
  }> = [
    {
      key: "undo",
      title: "撤销",
      label: <UndoOutlined />,
      onClick: () => run(() => editor?.commands.undo()),
    },
    {
      key: "redo",
      title: "重做",
      label: <RedoOutlined />,
      onClick: () => run(() => editor?.commands.redo()),
    },
    {
      key: "h1",
      title: "一级标题",
      label: "H1",
      active: headingActive(1),
      onClick: () =>
        run(() => editor?.chain().focus().toggleHeading({ level: 1 }).run()),
    },
    {
      key: "h2",
      title: "二级标题",
      label: "H2",
      active: headingActive(2),
      onClick: () =>
        run(() => editor?.chain().focus().toggleHeading({ level: 2 }).run()),
    },
    {
      key: "h3",
      title: "三级标题",
      label: "H3",
      active: headingActive(3),
      onClick: () =>
        run(() => editor?.chain().focus().toggleHeading({ level: 3 }).run()),
    },
    {
      key: "bold",
      title: "加粗",
      label: <BoldOutlined />,
      active: toolActive("bold"),
      onClick: () => run(() => editor?.chain().focus().toggleBold().run()),
    },
    {
      key: "italic",
      title: "斜体",
      label: <ItalicOutlined />,
      active: toolActive("italic"),
      onClick: () => run(() => editor?.chain().focus().toggleItalic().run()),
    },
    {
      key: "strike",
      title: "删除线",
      label: <StrikethroughOutlined />,
      active: toolActive("strike"),
      onClick: () => run(() => editor?.chain().focus().toggleStrike().run()),
    },
    {
      key: "underline",
      title: "下划线",
      label: <UnderlineOutlined />,
      active: toolActive("underline"),
      onClick: () => run(() => editor?.chain().focus().toggleUnderline().run()),
    },
    {
      key: "bullet",
      title: "无序列表",
      label: <UnorderedListOutlined />,
      active: toolActive("bulletList"),
      onClick: () =>
        run(() => editor?.chain().focus().toggleBulletList().run()),
    },
    {
      key: "ordered",
      title: "有序列表",
      label: <OrderedListOutlined />,
      active: toolActive("orderedList"),
      onClick: () =>
        run(() => editor?.chain().focus().toggleOrderedList().run()),
    },
    {
      key: "quote",
      title: "引用",
      label: "❝",
      active: toolActive("blockquote"),
      onClick: () =>
        run(() => editor?.chain().focus().toggleBlockquote().run()),
    },
    {
      key: "code",
      title: "代码块",
      label: <CodeOutlined />,
      active: toolActive("codeBlock"),
      onClick: () => run(() => editor?.chain().focus().toggleCodeBlock().run()),
    },
    { key: "link", title: "链接", label: <LinkOutlined />, onClick: applyLink },
  ];

  /** 浮动工具条按钮（选中文字时出现） */
  const fbarTools: Array<{
    key: string;
    title: string;
    label: React.ReactNode;
    active?: boolean;
    onClick: () => void;
  }> = [
    {
      key: "fb-bold",
      title: "加粗",
      label: <BoldOutlined />,
      active: toolActive("bold"),
      onClick: () => run(() => editor?.chain().focus().toggleBold().run()),
    },
    {
      key: "fb-italic",
      title: "斜体",
      label: <ItalicOutlined />,
      active: toolActive("italic"),
      onClick: () => run(() => editor?.chain().focus().toggleItalic().run()),
    },
    {
      key: "fb-strike",
      title: "删除线",
      label: <StrikethroughOutlined />,
      active: toolActive("strike"),
      onClick: () => run(() => editor?.chain().focus().toggleStrike().run()),
    },
    {
      key: "fb-underline",
      title: "下划线",
      label: <UnderlineOutlined />,
      active: toolActive("underline"),
      onClick: () => run(() => editor?.chain().focus().toggleUnderline().run()),
    },
    {
      key: "fb-small",
      title: "小字号",
      label: "A-",
      onClick: () => applyFontSize("11px"),
    },
    {
      key: "fb-large",
      title: "大字号",
      label: "A+",
      onClick: () => applyFontSize("18px"),
    },
  ];

  return (
    <div className="md-editor" ref={editorRef} data-tauri-drag-region="false">
      <div className="md-editor-bar">
        <div className="md-editor-tools">
          {tools.map((tool) => (
            <button
              key={tool.key}
              type="button"
              className={`md-tool${tool.active ? " active" : ""}`}
              title={tool.title}
              onMouseDown={(event) => event.preventDefault()}
              onClick={tool.onClick}
            >
              {tool.label}
            </button>
          ))}
          {/* 文字颜色色板 */}
          <div className="md-color-wrap">
            <button
              type="button"
              className="md-tool"
              title="插入图片（也可 Ctrl+V 粘贴）"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
            >
              <PictureOutlined />
            </button>
            <button
              type="button"
              className={`md-tool md-color-trigger${colorOpen ? " active" : ""}`}
              title="文字颜色"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setColorOpen((open) => !open)}
            >
              A
            </button>
            {colorOpen && (
              <div
                className="md-color-palette"
                onMouseDown={(event) => event.preventDefault()}
              >
                {FONT_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    className="md-color-dot"
                    title={color.label}
                    style={{ background: color.value }}
                    onClick={() => applyColor(color.value)}
                  />
                ))}
                <button
                  type="button"
                  className="md-color-clear"
                  title="清除颜色"
                  onClick={() => applyColor(null)}
                >
                  默认
                </button>
              </div>
            )}
          </div>
        </div>
        {linkDraft && (
          <div className="md-linkbar">
            <input
              ref={linkInputRef}
              className="md-link-input"
              value={linkUrl}
              placeholder="输入链接地址，回车确认，Esc 取消"
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") confirmLink();
                else if (event.key === "Escape") cancelLink();
              }}
              onBlur={() => {
                if (linkDraft) setTimeout(cancelLink, 120);
              }}
            />
            <button type="button" className="md-link-btn" onClick={confirmLink}>
              确定
            </button>
            {editor?.isActive("link") && (
              <button
                type="button"
                className="md-link-btn md-link-btn-danger"
                title="移除链接"
                onClick={() => {
                  editor?.chain().focus().unsetLink().run();
                  setLinkDraft(false);
                  setFbar(null);
                }}
              >
                移除链接
              </button>
            )}
            <button type="button" className="md-link-btn" onClick={cancelLink}>
              取消
            </button>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={onImageFile}
        />
      </div>

      <div
        className="md-editor-body"
        onClick={handleBodyClick}
        onContextMenu={handleContextMenu}
      >
        <EditorContent editor={editor} />
      </div>

      <div className="md-editor-status">
        <span>Markdown</span>
        <span>
          {wordCount} 字 · {lineCount} 行
        </span>
      </div>

      {/* 右键上下文菜单 - 挂载到 body，不被编辑器容器的 overflow 截断 */}
      {ctxMenu && createPortal(
        <>
          <div
            className="md-ctx-mask"
            onClick={closeCtxMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeCtxMenu();
            }}
          />
          <div
            className="md-ctx-menu"
            style={{ top: ctxMenu.top, left: ctxMenu.left }}
            onMouseLeave={() => setCtxSubmenu(null)}
          >
            <div className="flex">
              {/* 复制 */}
              <div
                className="md-ctx-item"
                onClick={() => {
                  document.execCommand("copy");
                  closeCtxMenu();
                }}
              >
                <span className="md-ctx-label ">
                  <CopyOutlined />
                  复制
                </span>
              </div>
              {/* 剪切 */}
              <div
                className="md-ctx-item"
                onClick={() => {
                  document.execCommand("cut");
                  closeCtxMenu();
                }}
              >
                <span className="md-ctx-label">
                  <ScissorOutlined />
                  剪切
                </span>
              </div>
              {/* 粘贴 */}
              <div
                className="md-ctx-item"
                onClick={() => {
                  document.execCommand("paste");
                  closeCtxMenu();
                }}
              >
                <span className="md-ctx-label">
                  <SnippetsOutlined />
                  粘贴
                </span>
              </div>
              {/* 全选 */}
              <div
                className="md-ctx-item"
                onClick={() => {
                  editor?.chain().focus().selectAll().run();
                  closeCtxMenu();
                }}
              >
                <span className="md-ctx-label">
                  <CheckSquareOutlined />
                  全选
                </span>
              </div>
            </div>
            <div className="md-ctx-sep" />
            <div className="flex">
              {/* 加粗 */}
              <div
                className={`md-ctx-item${toolActive("bold") ? " active" : ""}`}
                onClick={() => {
                  run(() => editor?.chain().focus().toggleBold().run());
                  closeCtxMenu();
                }}
              >
                <span className="md-ctx-label">
                  <span className="md-ctx-b">B</span>
                  加粗
                </span>
              </div>
              {/* 中划线 */}
              <div
                className={`md-ctx-item${toolActive("strike") ? " active" : ""}`}
                onClick={() => {
                  run(() => editor?.chain().focus().toggleStrike().run());
                  closeCtxMenu();
                }}
              >
                <span className="md-ctx-label">
                  <span className="md-ctx-s">S</span>
                  中划线
                </span>
              </div>
              {/* 倾斜 */}
              <div
                className={`md-ctx-item${toolActive("italic") ? " active" : ""}`}
                onClick={() => {
                  run(() => editor?.chain().focus().toggleItalic().run());
                  closeCtxMenu();
                }}
              >
                <span className="md-ctx-label">
                  <span className="md-ctx-i">I</span>
                  倾斜
                </span>
              </div>
              {/* 下划线 */}
              <div
                className={`md-ctx-item${toolActive("underline") ? " active" : ""}`}
                onClick={() => {
                  run(() => editor?.chain().focus().toggleUnderline().run());
                  closeCtxMenu();
                }}
              >
                <span className="md-ctx-label">
                  <span className="md-ctx-u">U</span>
                  下划线
                </span>
              </div>
            </div>
            <div className="md-ctx-sep" />
            {/* 文字颜色 */}
            <div
              className="md-ctx-item"
              onMouseEnter={() => setCtxSubmenu("color")}
            >
              <span className="md-ctx-label">
                <FontColorsOutlined style={{ color: "#e5484d" }} />
                文字颜色
              </span>
              <span className="md-ctx-arrow">›</span>
              {ctxSubmenu === "color" && (
                <div
                  className="md-ctx-submenu submenu-up"
                  onMouseEnter={() => setCtxSubmenu("color")}
                >
                  <button
                    type="button"
                    className="md-ctx-color-item"
                    onClick={() => {
                      applyColor(null);
                      closeCtxMenu();
                    }}
                  >
                    <span style={{ display: "inline-block", width: "16px", height: "16px", background: "#000000", borderRadius: "3px", marginRight: "8px" }} />
                    默认字体颜色
                  </button>
                  <div className="md-ctx-sep" />
                  <div style={{ padding: "8px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: "4px" }}>
                      {[
                        "#000000", "#404040", "#808080", "#bfbfbf", "#ffffff",
                        "#000080", "#0000ff", "#0080ff", "#80c0ff", "#e0f0ff",
                        "#804000", "#ff8000", "#ffc000", "#ffe080", "#fff0e0",
                        "#008000", "#00ff00", "#80ff80", "#e0ffe0", "#f0fff0",
                        "#800000", "#ff0000", "#ff8080", "#ffe0e0", "#fff0f0",
                        "#800080", "#ff00ff", "#ff80ff", "#ffe0ff", "#fff0ff",
                      ].map((c) => (
                        <button
                          key={c}
                          type="button"
                          title={c}
                          onClick={() => {
                            applyColor(c);
                            closeCtxMenu();
                          }}
                          style={{
                            width: "16px",
                            height: "16px",
                            borderRadius: "3px",
                            border: "1px solid rgba(0,0,0,0.1)",
                            background: c,
                            cursor: "pointer",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="md-ctx-sep" />
                  <div style={{ padding: "0 8px 8px 8px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: "4px" }}>
                      {[
                        "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff",
                        "#0066ff", "#9900ff", "#ff00ff", "#ff6699", "#663300",
                      ].map((c) => (
                        <button
                          key={c}
                          type="button"
                          title={c}
                          onClick={() => {
                            applyColor(c);
                            closeCtxMenu();
                          }}
                          style={{
                            width: "16px",
                            height: "16px",
                            borderRadius: "3px",
                            border: "1px solid rgba(0,0,0,0.1)",
                            background: c,
                            cursor: "pointer",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* 文字背景色 */}
            <div
              className="md-ctx-item"
              onMouseEnter={() => setCtxSubmenu("bg")}
            >
              <span className="md-ctx-label">
                <BgColorsOutlined style={{ color: "#f2994a" }} />
                文字背景色
              </span>
              <span className="md-ctx-arrow">›</span>
              {ctxSubmenu === "bg" && (
                <div
                  className="md-ctx-submenu submenu-up"
                  onMouseEnter={() => setCtxSubmenu("bg")}
                >
                  <button
                    type="button"
                    className="md-ctx-color-item"
                    onClick={() => {
                      editor
                        ?.chain()
                        .focus()
                        .setMark("textStyle", { backgroundColor: null })
                        .run();
                      closeCtxMenu();
                    }}
                  >
                    <span style={{ display: "inline-block", width: "16px", height: "16px", background: "#ffffff", borderRadius: "3px", marginRight: "8px", border: "1px solid rgba(0,0,0,0.1)" }} />
                    默认背景颜色
                  </button>
                  <div className="md-ctx-sep" />
                  <div style={{ padding: "8px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: "4px" }}>
                      {[
                        "#000000", "#404040", "#808080", "#bfbfbf", "#ffffff",
                        "#000080", "#0000ff", "#0080ff", "#80c0ff", "#e0f0ff",
                        "#804000", "#ff8000", "#ffc000", "#ffe080", "#fff0e0",
                        "#008000", "#00ff00", "#80ff80", "#e0ffe0", "#f0fff0",
                        "#800000", "#ff0000", "#ff8080", "#ffe0e0", "#fff0f0",
                        "#800080", "#ff00ff", "#ff80ff", "#ffe0ff", "#fff0ff",
                      ].map((c) => (
                        <button
                          key={c}
                          type="button"
                          title={c}
                          onClick={() => {
                            editor
                              ?.chain()
                              .focus()
                              .setMark("textStyle", { backgroundColor: c })
                              .run();
                            closeCtxMenu();
                          }}
                          style={{
                            width: "16px",
                            height: "16px",
                            borderRadius: "3px",
                            border: "1px solid rgba(0,0,0,0.1)",
                            background: c,
                            cursor: "pointer",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="md-ctx-sep" />
                  <div style={{ padding: "0 8px 8px 8px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: "4px" }}>
                      {[
                        "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff",
                        "#0066ff", "#9900ff", "#ff00ff", "#ff6699", "#663300",
                      ].map((c) => (
                        <button
                          key={c}
                          type="button"
                          title={c}
                          onClick={() => {
                            editor
                              ?.chain()
                              .focus()
                              .setMark("textStyle", { backgroundColor: c })
                              .run();
                            closeCtxMenu();
                          }}
                          style={{
                            width: "16px",
                            height: "16px",
                            borderRadius: "3px",
                            border: "1px solid rgba(0,0,0,0.1)",
                            background: c,
                            cursor: "pointer",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* 文字大小 */}
            <div
              className="md-ctx-item"
              onMouseEnter={() => setCtxSubmenu("size")}
            >
              <span className="md-ctx-label">
                <FontSizeOutlined />
                文字大小
              </span>
              <span className="md-ctx-arrow">›</span>
              {ctxSubmenu === "size" && (
                <div
                  className="md-ctx-submenu submenu-up"
                  onMouseEnter={() => setCtxSubmenu("size")}
                >
                  {FONT_SIZES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      className="md-ctx-color-item"
                      onClick={() => {
                        applyFontSize(`${size}px`);
                        closeCtxMenu();
                      }}
                    >
                      {size}
                    </button>
                  ))}
                  <div className="md-ctx-sep" />
                  <button
                    type="button"
                    className="md-ctx-color-item"
                    onClick={() => {
                      applyFontSize(null);
                      closeCtxMenu();
                    }}
                  >
                    默认 (13px)
                  </button>
                </div>
              )}
            </div>
            <div className="md-ctx-sep" />
            {/* 插入图片 */}
            <div
              className="md-ctx-item"
              onClick={() => {
                fileInputRef.current?.click();
                closeCtxMenu();
              }}
            >
              <span className="md-ctx-label">
                <PictureOutlined />
                插入图片
              </span>
            </div>
            {/* 插入表情 */}
            <div
              className="md-ctx-item"
              onClick={() => {
                const emoji = prompt("输入表情或符号：", "😊");
                if (emoji) {
                  editor?.chain().focus().insertContent(emoji).run();
                }
                closeCtxMenu();
              }}
            >
              <span className="md-ctx-label">
                <SmileOutlined />
                插入表情
              </span>
            </div>
            <div className="md-ctx-sep" />
            {/* 快捷键介绍 */}
            <div
              className="md-ctx-item"
              title="快捷键：Ctrl+B 加粗 / Ctrl+I 斜体 / Ctrl+U 下划线 / Ctrl+Z 撤销"
            >
              <span className="md-ctx-label">
                <KeyOutlined />
                快捷键介绍
              </span>
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
