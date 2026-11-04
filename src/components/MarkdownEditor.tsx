import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import {
  Table,
  TableRow,
  TableCell,
  TableHeader,
} from "@tiptap/extension-table";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TurndownService from "turndown";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../repository";
import { markdownToHtml } from "../utils/markdown";
import { openExternal } from "../utils/openExternal";
import { readClipboardText, writeClipboardText } from "../utils/clipboard";
import { currentWorkArea, type WorkArea } from "../window/tauriWindow";
import {
  CTX_MENU_COMMAND_EVENT,
  CTX_MENU_WIN_H,
  CTX_MENU_WIN_W,
  hideCtxMenuWindow,
  openCtxMenu,
  type CtxCommand,
  type CtxMenuState,
} from "../window/ctxMenuWindow";
import {
  BoldOutlined,
  CodeOutlined,
  ItalicOutlined,
  OrderedListOutlined,
  PictureOutlined,
  RedoOutlined,
  StrikethroughOutlined,
  TableOutlined,
  UnderlineOutlined,
  UndoOutlined,
  UnorderedListOutlined,
  SmileOutlined,
  EditOutlined,
} from "@ant-design/icons";
import { ColorPicker, Modal } from "antd";
import EmojiPicker, { type EmojiAnchor } from "./EmojiPicker";
import { DoodleBoard } from "./DoodleBoard";
import { FONT_COLORS, STANDARD_COLORS, DEFAULT_PICKER_COLOR } from "../utils/editorColors";
import {
  ContextMenuPanel,
  type CtxMenuAction,
} from "./ContextMenuPanel";
import { countMarkdownWords } from "../utils/markdown";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

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

/** 表格 DOM → GFM 管道表格文本：单元格内容递归 turndown（保留行内代码/加粗等），竖线转义、换行转 <br> */
function tableToMarkdown(
  table: HTMLTableElement,
  turndown: TurndownService
): string {
  const rows = Array.from(table.rows).map((row) => Array.from(row.cells));
  if (!rows.length) return "";
  const cellText = (cell: HTMLTableCellElement): string =>
    turndown
      .turndown(cell.innerHTML)
      .replace(/\s*\n\s*/g, "<br>")
      .replace(/\|/g, "\\|")
      .trim();
  const line = (cells: HTMLTableCellElement[]): string =>
    `| ${cells.map(cellText).join(" | ")} |`;
  const [header, ...body] = rows;
  const separator = `| ${header.map(() => "---").join(" | ")} |`;
  return [line(header), separator, ...body.map(line)].join("\n") + "\n\n";
}

/** 粘贴 Markdown：剪贴板纯文本命中 Markdown 语法特征时，先解析为 HTML 再插入成真实节点（标题/列表/代码块/表格等） */
const PasteMarkdown = Extension.create({
  name: "pasteMarkdown",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handlePaste(_view, event) {
            const text = event.clipboardData?.getData("text/plain") ?? "";
            if (!text || !looksLikeMarkdown(text)) return false;
            const html = markdownToHtml(text);
            if (!html) return false;
            editor.chain().focus().insertContent(html).run();
            return true;
          },
        },
      }),
    ];
  },
});

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
  turndown.addRule("gfmTable", {
    filter: "table",
    replacement: (_content, node) =>
      tableToMarkdown(node as HTMLTableElement, turndown),
  });
  return turndown;
}

/**
 * 判断剪贴板文本是否"看起来是 Markdown"：命中任一块级语法
 * （标题/列表/引用/代码围栏/表格/分隔线）或行内语法（**加粗**、`行内代码`）即认为可转换。
 * 仅作粘贴识别用，宁可少判不误判：纯普通文本一律走原样插入。
 */
function looksLikeMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const isTableSeparator = (line: string): boolean =>
    /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^#{1,6}\s+\S/.test(t)) return true; // 标题
    if (/^([-*+]|\d{1,3}[.)])\s+\S/.test(t)) return true; // 无序/有序列表
    if (/^>\s?\S/.test(t)) return true; // 引用
    if (/^(```|~~~)/.test(t)) return true; // 代码围栏
    if (/^\s*([-*_]\s*){3,}$/.test(t)) return true; // 分隔线 ---
    if (
      /\|/.test(t) &&
      /^\s*\|.*\|\s*$/.test(t) &&
      lines.some(isTableSeparator)
    )
      return true; // 表格（需同时存在分隔行）
    if (/\*\*[^*\n]+\*\*/.test(t) || /(^|[\s(])`[^`\n]+`/.test(t))
      return true; // 行内加粗 / 行内代码
  }
  return false;
}

/**
 * 所见即所得富文本 Markdown 编辑器（TipTap）：
 * 顶部工具条（标题/加粗/斜体/删除线/下划线/颜色/字号/列表/引用/代码/链接/撤销重做）
 * + 底部字数统计。
 * 数据仍以 Markdown 文本存储：外部 value 为 Markdown，编辑实时转回 Markdown；
 * 颜色/字号/下划线等富文本扩展属性以内嵌 HTML（span/u）形式保留在 Markdown 中。
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
}: MarkdownEditorProps) {
  const [colorOpen, setColorOpen] = useState(false);
  /** 工具栏 antd 拾色器当前颜色（打开时读取选区颜色，拖动时跟随）；初值用不透明色，避免 cleared 颜色触发警告 */
  const [colorValue, setColorValue] = useState<string>(DEFAULT_PICKER_COLOR);
  /** 手写涂鸦弹窗开关与画布产出的 PNG dataURL */
  const [doodleOpen, setDoodleOpen] = useState(false);
  const [doodleData, setDoodleData] = useState("");
  /** 表情选择面板锚点（工具栏按钮 / 右键菜单项触发），null 表示面板关闭 */
  const [emojiAnchor, setEmojiAnchor] = useState<EmojiAnchor | null>(null);
  // 右键上下文菜单（浏览器环境页面内回退；Tauri 环境为独立窗口）
  const [ctxMenu, setCtxMenu] = useState<{ top: number; left: number } | null>(
    null
  );
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastHtmlRef = useRef<string>("");
  /** 标记「刚刚是用户输入触发的 onChange」，同步 effect 据此跳过 setContent，避免光标跳走 */
  const isInternalUpdate = useRef(false);
  const turndown = useMemo(() => createTurndown(), []);
  const htmlToMarkdown = (html: string): string =>
    turndown.turndown(html || "");

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
        // 独立轻量入口（imagePreview.html）：只打包查看器所需代码，秒开；
        // visible:false 隐藏创建，首帧渲染完成后再 show，避免加载期白屏
        url: `imagePreview.html?${params.toString()}`,
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
        visible: false,
        title: "图片预览",
      });
    } catch (error) {
      console.error("打开图片预览失败", error);
      window.open(images[index], "_blank");
    }
  };

  /** 正文点击：图片开独立预览；超链接走系统浏览器打开（阻止默认行为，避免 WebView2 整窗导航/opener 权限报错） */
  const handleBodyClick = (event: React.MouseEvent): void => {
    const target = event.target as HTMLElement;
    const linkEl = target.closest("a");
    if (linkEl) {
      const href = linkEl.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) {
        event.preventDefault();
        event.stopPropagation();
        void openExternal(href);
      }
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

  /**
   * 打开右键菜单窗口（应用启动后预热的常驻窗口，见 window/ctxMenuWindow）：
   * 同步快照选区与格式状态 → 并行读取光标/窗口几何 → 事件通知菜单窗口定位显示。
   * 窗口创建失败或未就绪时回退为页面内菜单。
   */
  const openCtxMenuWindow = async (
    clientX: number,
    clientY: number
  ): Promise<void> => {
    // 快照必须在任何 await 之前完成：等待 IPC 期间选区/焦点可能变化
    const selectedText = getSelectedText();
    const bold = toolActive("bold");
    const strike = toolActive("strike");
    const italic = toolActive("italic");
    const underline = toolActive("underline");
    const color = currentTextColor();
    const isDark = document.documentElement.classList.contains("dark-glass");
    // 快照主窗口当前主题 CSS 变量，供菜单窗口注入，保持菜单视觉与主窗口一致
    const cssVars: Record<string, string> = {};
    for (const key of [
      "--field-rgb",
      "--border",
      "--text",
      "--text-muted",
      "--hover-fill",
      "--kind-accent",
    ]) {
      cssVars[key] = getComputedStyle(document.documentElement)
        .getPropertyValue(key)
        .trim();
    }

    // 系统级光标位置（物理像素，首选）与主窗口几何（兜底定位/边界）并行读取，
    // 减少右键到菜单出现的等待
    const [cursor, geom] = await Promise.all([
      cursorPosition().catch(() => null),
      (async () => {
        try {
          const current = getCurrentWindow();
          const [scale, area, inner] = await Promise.all([
            current.scaleFactor(),
            currentWorkArea(),
            current.innerPosition(),
          ]);
          return { scale, area, inner };
        } catch {
          return { scale: 1, area: null as WorkArea | null, inner: null };
        }
      })(),
    ]);

    // 兜底定位（cursorPosition 失败时）：主窗口内容区位置（物理像素）+ 视口内偏移 × 缩放比，
    // 换算后钳制在当前显示器工作区内。
    let posX = cursor?.x ?? 0;
    let posY = cursor?.y ?? 0;
    if (!cursor) {
      const { scale, area, inner } = geom;
      posX = (inner?.x ?? 0) + Math.round(clientX * scale);
      posY = (inner?.y ?? 0) + Math.round(clientY * scale);
      if (area) {
        posX = Math.min(
          Math.max(posX, area.x),
          area.x + Math.max(0, area.width - Math.round(CTX_MENU_WIN_W * scale))
        );
        posY = Math.min(
          Math.max(posY, area.y),
          area.y + Math.max(0, area.height - Math.round(CTX_MENU_WIN_H * scale))
        );
      }
    }

    const snapshot: CtxMenuState = {
      selectedText,
      bold,
      strike,
      italic,
      underline,
      color,
      isDark,
      cssVars,
      // 定位信息：鼠标物理坐标 + 点击所在显示器工作区（主窗口就在该显示器上）
      cursorX: posX,
      cursorY: posY,
      workArea: geom.area,
    };

    if (await openCtxMenu(snapshot)) return;
    console.error("打开右键菜单窗口失败，回退为页面内菜单");
    showInPageCtxMenu(clientX, clientY);
  };

  /** 页面内右键菜单（浏览器环境回退 / 独立窗口创建失败时兜底） */
  const showInPageCtxMenu = (clientX: number, clientY: number): void => {
    // 面板实际渲染尺寸（内容固定，实测约 165×267；留少量余量避免贴边被裁）
    const menuWidth = 170;
    const menuHeight = 272;
    let left = clientX;
    let top = clientY;
    // 右边界放不下 → 向左翻转（面板右缘贴近鼠标）
    if (left + menuWidth > window.innerWidth) left = clientX - menuWidth;
    // 下边界放不下 → 向上翻转（面板底缘贴近鼠标）
    if (top + menuHeight > window.innerHeight) top = clientY - menuHeight;
    // 左/上边界兜底钳制：面板比视口还大时贴住边缘，保证尽可能完整可见
    left = Math.min(
      Math.max(left, 0),
      Math.max(0, window.innerWidth - menuWidth)
    );
    top = Math.min(
      Math.max(top, 0),
      Math.max(0, window.innerHeight - menuHeight)
    );
    setCtxMenu({ top, left });
  };

  /** 右键菜单：Tauri 环境创建独立菜单窗口（参考图片预览窗口）；浏览器环境保留页面内菜单 */
  const handleContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault();
    if (isTauriRuntime()) {
      void openCtxMenuWindow(event.clientX, event.clientY);
      return;
    }
    showInPageCtxMenu(event.clientX, event.clientY);
  };

  /** 关闭页面内右键菜单（点击别处 / Esc） */
  const closeCtxMenu = (): void => {
    setCtxMenu(null);
  };

  /** 独立菜单窗口命令：菜单窗口点击后通过 Tauri 事件回传，主窗口执行编辑动作 */
  const executeWindowCommand = (command: CtxCommand): void => {
    switch (command.cmd) {
      case "copy":
        // 菜单窗口已写入剪贴板，主窗口无需重复写（期间可能已失焦）
        break;
      case "cut":
        // 菜单窗口已写好剪贴板；主窗口只删除选区，避免失焦窗口重复写剪贴板失败导致剪切无效
        editor?.chain().focus().deleteSelection().run();
        break;
      case "paste":
        if (command.value)
          editor?.chain().focus().insertContent(command.value).run();
        break;
      case "selectAll":
        editor?.chain().focus().selectAll().run();
        break;
      case "bold":
        run(() => editor?.chain().focus().toggleBold().run());
        break;
      case "strike":
        run(() => editor?.chain().focus().toggleStrike().run());
        break;
      case "italic":
        run(() => editor?.chain().focus().toggleItalic().run());
        break;
      case "underline":
        run(() => editor?.chain().focus().toggleUnderline().run());
        break;
      case "color":
        // 实时取色（拾色器拖动中），不抢焦点
        if (command.value) editor?.commands.setColor(command.value);
        break;
      case "colorClear":
        editor?.commands.unsetColor();
        break;
      case "colorCommit":
        editor?.chain().focus().setColor(command.value).run();
        break;
      case "colorClearCommit":
        editor?.chain().focus().unsetColor().run();
        break;
      case "size":
        if (command.value) applyFontSize(command.value);
        break;
      case "sizeDefault":
        applyFontSize(null);
        break;
      case "insertImage":
        fileInputRef.current?.click();
        break;
      case "insertEmoji":
        // 菜单窗口内选中表情后回传，直接插入光标处
        if (command.value)
          editor?.chain().focus().insertContent(command.value).run();
        break;
      case "info":
        break;
    }
  };

  /** 页面内右键菜单动作执行（浏览器环境回退；Tauri 环境命令走 executeWindowCommand） */
  const handleInPageAction = (action: CtxMenuAction): void => {
    switch (action.type) {
      case "copy":
        void copySelection();
        break;
      case "cut":
        void cutSelection();
        break;
      case "paste":
        void pasteFromClipboard();
        break;
      case "selectAll":
        editor?.chain().focus().selectAll().run();
        break;
      case "bold":
        run(() => editor?.chain().focus().toggleBold().run());
        break;
      case "strike":
        run(() => editor?.chain().focus().toggleStrike().run());
        break;
      case "italic":
        run(() => editor?.chain().focus().toggleItalic().run());
        break;
      case "underline":
        run(() => editor?.chain().focus().toggleUnderline().run());
        break;
      case "color":
        // 实时取色，不关闭菜单
        editor?.commands.setColor(action.value);
        return;
      case "colorClear":
        // 实时清色，不关闭菜单
        editor?.commands.unsetColor();
        return;
      case "colorCommit":
        editor?.chain().focus().setColor(action.value).run();
        break;
      case "colorClearCommit":
        editor?.chain().focus().unsetColor().run();
        break;
      case "size":
        applyFontSize(action.value);
        break;
      case "sizeDefault":
        applyFontSize(null);
        break;
      case "insertImage":
        fileInputRef.current?.click();
        break;
      case "insertEmoji":
        // 面板内直接选中的表情，插入光标处
        editor?.chain().focus().insertContent(action.emoji).run();
        break;
      case "info":
        return; // 快捷键介绍：仅展示
    }
    closeCtxMenu();
  };

  // 卸载（切换条目 / 关闭）时兜底隐藏仍开着的常驻菜单窗口（不销毁，下次复用）
  useEffect(() => {
    return () => {
      void hideCtxMenuWindow();
    };
  }, []);

  /** 插入表情到光标处并关闭面板 */
  const insertEmoji = (emoji: string): void => {
    editor?.chain().focus().insertContent(emoji).run();
    setEmojiAnchor(null);
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
        // StarterKit v3 已内置 link / underline，这里关掉，改用下方显式配置的实例
        // （Link.openOnClick=false），避免重复注册产生 duplicate extension 警告
        link: false,
        underline: false,
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
      Link.configure({ openOnClick: false }),
      Image.configure({ allowBase64: true }),
      // GFM 表格：Markdown 管道表 ↔ 编辑器表格节点（列宽拖拽关闭，保持便签轻量）
      Table.configure({ resizable: false, allowTableNodeSelection: true }),
      TableRow,
      TableCell,
      TableHeader,
      TextDrag,
      PasteImage,
      PasteMarkdown,
    ],
    content: markdownToHtml(value),
    onUpdate: ({ editor: current }) => {
      const html = current.getHTML();
      lastHtmlRef.current = html;
      isInternalUpdate.current = true;
      onChange(htmlToMarkdown(html));
    },
    editorProps: {
      attributes: {
        class: "md-prose",
        spellcheck: "false",
      },
    },
  });

  /** 监听独立菜单窗口命令（Tauri 环境；编辑器就绪后注册一次） */
  useEffect(() => {
    if (!isTauriRuntime() || !editor) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<CtxCommand>(CTX_MENU_COMMAND_EVENT, (event) => {
      executeWindowCommand(event.payload);
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editor 就绪后仅需注册一次；命令处理依赖主窗口稳定引用
  }, [editor]);

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

  /* eslint-disable react-hooks/exhaustive-deps --
     value 是有意为之的依赖：它随每次击键更新（onUpdate → onChange → 父组件 state → props），
     作为刷新信号驱动重算 editor.getText()，实现字数/行数实时统计 */
  const wordCount = useMemo(
    () => countMarkdownWords(editor?.getText() ?? ""),
    [editor, value]
  );
  const lineCount = useMemo(
    // getText 默认块间分隔符是 "\n\n"，会把每个段落间多算一个空行（回车一次行号 +2）；
    // 显式改为 "\n" 使 split 后的行数 = 段落数 = 实际行数
    () => (editor?.getText({ blockSeparator: "\n" }) ?? "").split("\n").length,
    [editor, value]
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  const run = (fn: () => void): void => {
    fn();
    editor?.commands.focus();
  };

  /** 清除文字颜色（工具栏“默认”按钮 / 拾色器 allowClear） */
  const clearColor = (): void => {
    editor?.chain().focus().unsetColor().run();
    setColorOpen(false);
  };

  const applyFontSize = (size: string | null): void => {
    if (size) {
      editor?.chain().focus().setMark("textStyle", { fontSize: size }).run();
    } else {
      editor?.chain().focus().setMark("textStyle", { fontSize: null }).run();
    }
  };

  /** 取当前编辑器选区纯文本（比 window.getSelection 更可靠，且不依赖焦点状态） */
  const getSelectedText = (): string => {
    if (!editor) return "";
    const { from, to } = editor.state.selection;
    if (from === to) return "";
    return editor.state.doc.textBetween(from, to, "\n");
  };

  /** 复制：写入选中文本（Tauri 走剪贴板插件，网页预览兜底 Clipboard API） */
  const copySelection = async (): Promise<void> => {
    const text = getSelectedText();
    if (!text) return;
    await writeClipboardText(text);
  };

  /** 剪切：复制选中文本后删除编辑器内选区，写入失败则不删除 */
  const cutSelection = async (): Promise<void> => {
    const text = getSelectedText();
    if (!text) return;
    if (await writeClipboardText(text)) {
      editor?.chain().focus().deleteSelection().run();
    }
  };

  /** 粘贴：读取剪贴板文本并插入光标处（Tauri 走剪贴板插件，网页预览兜底 Clipboard API） */
  const pasteFromClipboard = async (): Promise<void> => {
    const text = await readClipboardText();
    if (!text) return;
    // Markdown 文本 → 先解析为 HTML 再插入，落成真实节点（直接 insertContent 会被当纯文本，星号井号原样显示）
    if (looksLikeMarkdown(text)) {
      editor?.chain().focus().insertContent(markdownToHtml(text)).run();
      return;
    }
    editor?.chain().focus().insertContent(text).run();
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

  /**
   * 当前文字颜色（拾色器初始值）：优先取显式设置的 textStyle 颜色，否则取渲染后的
   * 继承文字色（随主题变化）。返回值始终是不透明颜色——「无颜色」若以 undefined
   * 传给 disabledAlpha 的拾色器，antd 会按 alpha=0 处理并打 dev 警告。
   */
  const currentTextColor = (): string => {
    const explicit = editor?.getAttributes("textStyle").color as
      | string
      | undefined;
    if (explicit) return explicit;
    const root = editorRef.current;
    const inherited = root ? getComputedStyle(root).color : "";
    return inherited || DEFAULT_PICKER_COLOR;
  };

  /** 顶部工具条按钮（含特殊渲染项：type=color 渲染 antd 拾色器，type=clear 渲染清除按钮） */
  const triggerFileInput = (): void => {
    fileInputRef.current?.click();
  };
  /** 把涂鸦画布导出的 PNG 插入光标处（与插入图片共用 Image 扩展） */
  const insertDoodle = (): void => {
    if (!doodleData) return;
    editor?.chain().focus().setImage({ src: doodleData }).run();
    setDoodleOpen(false);
  };
  const tools: Array<{
    key: string;
    title: string;
    label?: React.ReactNode;
    active?: boolean;
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    type?: "button" | "color" | "clear";
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
    {
      key: "table",
      title: "插入表格",
      label: <TableOutlined />,
      active: toolActive("table"),
      onClick: () =>
        run(() =>
          editor
            ?.chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run()
        ),
    },
    {
      key: "emoji",
      title: "插入表情",
      label: <SmileOutlined />,
      active: !!emojiAnchor,
      onClick: (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setEmojiAnchor({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        });
      },
    },
    {
      key: "image",
      title: "插入图片（也可 Ctrl+V 粘贴）",
      label: <PictureOutlined />,
      onClick: triggerFileInput,
    },
    {
      key: "doodle",
      title: "插入手写涂鸦",
      label: <EditOutlined />,
      onClick: () => {
        setDoodleData("");
        setDoodleOpen(true);
      },
    },
    { key: "color", type: "color", title: "文字颜色（antd 拾色器）" },
    { key: "clearColor", type: "clear", title: "清除文字颜色" },
  ];

  return (
    <div className="md-editor" ref={editorRef} data-tauri-drag-region="false">
      <div className="md-editor-bar">
        <div className="md-editor-tools">
          {/* oxlint-disable react/refs -- tools 数组在渲染期构建，其中 onClick 回调仅在用户点击时读取 ref（触发文件选择），并非渲染期访问 */}
          {tools.map((tool) => {
            // 特殊渲染：antd 拾色器
            if (tool.type === "color") {
              return (
                <ColorPicker
                  key={tool.key}
                  open={colorOpen}
                  onOpenChange={(open) => {
                    setColorOpen(open);
                    if (open) {
                      setColorValue(currentTextColor());
                    }
                  }}
                  value={colorValue}
                  format="hex"
                  disabledAlpha
                  allowClear
                  presets={[
                    { label: "常用色", colors: FONT_COLORS.map((c) => c.value) },
                    { label: "标准色", colors: STANDARD_COLORS },
                  ]}
                  onChange={(value) => {
                    if (value.cleared) {
                      editor?.commands.unsetColor();
                      return;
                    }
                    const hex = value.toHexString();
                    setColorValue(hex);
                    editor?.commands.setColor(hex);
                  }}
                  onChangeComplete={(value) => {
                    if (value.cleared) {
                      editor?.chain().focus().unsetColor().run();
                    } else {
                      editor
                        ?.chain()
                        .focus()
                        .setColor(value.toHexString())
                        .run();
                    }
                    setColorOpen(false);
                  }}
                  onClear={clearColor}
                >
                  <button
                    type="button"
                    className={`md-tool md-color-trigger${
                      colorOpen ? " active" : ""
                    }`}
                    title={tool.title}
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    A
                  </button>
                </ColorPicker>
              );
            }
            // 特殊渲染：清除文字颜色
            if (tool.type === "clear") {
              return (
                <button
                  key={tool.key}
                  type="button"
                  className="md-color-clear"
                  title={tool.title}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={clearColor}
                >
                  默认
                </button>
              );
            }
            // 普通按钮
            return (
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
            );
          })}
          {/* oxlint-enable react/refs */}
        </div>
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

      {/* 右键上下文菜单 - 挂载到 body，不被编辑器容器的 overflow 截断
          （浏览器环境回退为页面内菜单；Tauri 环境为独立菜单窗口，功能与样式完全一致） */}
      {ctxMenu &&
        createPortal(
          <>
            <div
              className="md-ctx-mask"
              onClick={closeCtxMenu}
              onContextMenu={(e) => {
                e.preventDefault();
                closeCtxMenu();
              }}
            />
            <ContextMenuPanel
              active={{
                bold: toolActive("bold"),
                strike: toolActive("strike"),
                italic: toolActive("italic"),
                underline: toolActive("underline"),
              }}
              colorValue={currentTextColor()}
              style={{ top: ctxMenu.top, left: ctxMenu.left }}
              onAction={handleInPageAction}
            />
          </>,
          document.body
        )}

      {/* 表情选择面板（portal 到 body，独立于右键菜单） */}
      <EmojiPicker
        anchor={emojiAnchor}
        onClose={() => setEmojiAnchor(null)}
        onPick={insertEmoji}
      />

      {/* 手写涂鸦：复用详情的画板，画好后以 PNG 图片插入正文 */}
      <Modal
        open={doodleOpen}
        onCancel={() => setDoodleOpen(false)}
        title="手写涂鸦"
        centered
        width="min(560px, calc(100vw - 24px))"
        okText="插入"
        cancelText="取消"
        okButtonProps={{ disabled: !doodleData }}
        onOk={insertDoodle}
        destroyOnHidden
      >
        <div className="flex flex-col" style={{ height: "min(400px, 55vh)" }}>
          <DoodleBoard value="" onChange={setDoodleData} />
        </div>
        <div className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">
          画好后点「插入」，涂鸦会以图片形式加入正文。
        </div>
      </Modal>
    </div>
  );
}
