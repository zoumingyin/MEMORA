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
import TurndownService from "turndown";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../repository";
import { markdownToHtml } from "../utils/markdown";
import { currentWorkArea, type WorkArea } from "../window/tauriWindow";
import {
  BoldOutlined,
  CodeOutlined,
  ItalicOutlined,
  OrderedListOutlined,
  PictureOutlined,
  RedoOutlined,
  StrikethroughOutlined,
  UnderlineOutlined,
  UndoOutlined,
  UnorderedListOutlined,
  SmileOutlined,
} from "@ant-design/icons";
import { ColorPicker } from "antd";
import EmojiPicker, { type EmojiAnchor } from "./EmojiPicker";
import { FONT_COLORS, STANDARD_COLORS } from "../utils/editorColors";
import {
  ContextMenuPanel,
  type CtxMenuAction,
} from "./ContextMenuPanel";
import type { CtxCommand } from "./CtxMenuDialog";
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
  /** 工具栏 antd 拾色器当前颜色（打开时读取选区颜色，拖动时跟随） */
  const [colorValue, setColorValue] = useState<string | undefined>(undefined);
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
  /** 独立右键菜单窗口实例（Tauri 环境），卸载时兜底关闭 */
  const ctxWinRef = useRef<WebviewWindow | null>(null);
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

  /** 正文点击：拦截图片（独立预览窗口）；链接功能已移除，<a> 仅作静态展示 */
  const handleBodyClick = (event: React.MouseEvent): void => {
    const target = event.target as HTMLElement;
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
   * 独立菜单窗口尺寸（CSS px）：
   * 宽 780 = 面板（约 165）+ 面板内移 240（左侧给子菜单留空间）+ 右侧子菜单横向展开余量，
   * 使子菜单贴屏幕边缘时既能向左也能向右完整展开；高 520 容纳完整字号子菜单（360）。
   * 面板内移量见 CtxMenuDialog 的 CTX_PANEL_OFFSET（240），两者须满足：
   * 面板左缘 + 触发项偏移 - 最宽子菜单(244) ≥ 0，且 面板左缘 + 触发项右缘 + 最宽子菜单 ≤ 780。
   */
  const CTX_MENU_WIN_W = 780;
  const CTX_MENU_WIN_H = 520;

  /** 打开独立右键菜单窗口（Tauri 环境，参考图片预览窗口实现）：
      快照当前选区与格式状态 → localStorage 传递 → 创建 md-ctx-* 透明窗口并定位到鼠标附近 */
  const openCtxMenuWindow = async (
    clientX: number,
    clientY: number
  ): Promise<void> => {
    // 上一个菜单窗口尚未自关时兜底关闭，避免叠加
    if (ctxWinRef.current) {
      try {
        await ctxWinRef.current.close();
      } catch {
        // 已自关 / 权限受限时忽略
      }
    }
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
    // 系统级光标位置（物理像素）：右键瞬间读取，随快照传给菜单窗口做精确定位。
    // 不依赖 innerPosition/scaleFactor 换算，任何 DPI/缩放下都与鼠标点击处严格一致。
    let cursorX = 0;
    let cursorY = 0;
    let cursorCaptured = false;
    try {
      const pos = await cursorPosition();
      cursorX = pos.x;
      cursorY = pos.y;
      cursorCaptured = true;
    } catch {
      // 读取失败时退化为视口换算定位
    }
    // 兜底定位（cursorPosition 失败时）：主窗口内容区位置（innerPosition，物理像素）+ 视口内偏移 × 缩放比，
    // 换算后钳制在当前显示器工作区内。
    const winW = CTX_MENU_WIN_W;
    const winH = CTX_MENU_WIN_H;
    let scale = 1;
    let area: WorkArea | null = null;
    let baseX = 0;
    let baseY = 0;
    try {
      const current = getCurrentWindow();
      scale = await current.scaleFactor();
      area = await currentWorkArea();
      const pos = await current.innerPosition();
      baseX = pos.x;
      baseY = pos.y;
    } catch {
      // 缩放 / 工作区 / 位置查询失败时按 1:1、主窗口位于 (0,0) 处理
    }
    const winWP = Math.round(winW * scale);
    const winHP = Math.round(winH * scale);
    let cx = baseX + Math.round(clientX * scale);
    let cy = baseY + Math.round(clientY * scale);
    if (area) {
      cx = Math.min(Math.max(cx, area.x), area.x + area.width - winWP);
      cy = Math.min(Math.max(cy, area.y), area.y + area.height - winHP);
    }
    const snapshot = {
      selectedText: getSelectedText(),
      bold: toolActive("bold"),
      strike: toolActive("strike"),
      italic: toolActive("italic"),
      underline: toolActive("underline"),
      color: editor?.getAttributes("textStyle").color as string | undefined,
      isDark: document.documentElement.classList.contains("dark-glass"),
      cssVars,
      // 定位信息：系统光标物理坐标 + 菜单窗口期望的 CSS 尺寸
      cursorX,
      cursorY,
      cursorCaptured,
      winW,
      winH,
      // 点击所在显示器工作区（物理像素）：主窗口就在该显示器上，作为菜单翻转/钳制的权威边界
      workArea: area,
    };
    const storageKey = `md-ctx-menu-${Date.now()}`;
    try {
      localStorage.setItem(storageKey, JSON.stringify(snapshot));
    } catch {
      console.error("保存右键菜单状态失败");
      return;
    }
    // 创建选项按物理像素传入（实测运行时按物理像素解释），菜单窗口创建后还会用
    // setPosition/setSize 按物理像素精确定位与校正尺寸，双保险保证落在鼠标处。
    const optX = cursorCaptured ? cursorX : cx;
    const optY = cursorCaptured ? cursorY : cy;
    const params = new URLSearchParams({ key: storageKey });
    try {
      const win = new WebviewWindow(`md-ctx-${Date.now()}`, {
        url: `ctxmenu.html?${params.toString()}`,
        width: winW,
        height: winH,
        x: optX,
        y: optY,
        center: false,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        skipTaskbar: true,
        focus: true,
        visible: false,
        shadow: false,
        title: "右键菜单",
      });
      ctxWinRef.current = win;
      // 窗口加载失败（如能力文件尚未随重编译生效）→ 回退为页面内菜单，保证右键可用
      win.once("tauri://error", () => {
        ctxWinRef.current = null;
        showInPageCtxMenu(clientX, clientY);
      });
    } catch (error) {
      console.error("打开右键菜单窗口失败，回退为页面内菜单", error);
      showInPageCtxMenu(clientX, clientY);
    }
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
        void copySelection();
        break;
      case "cut":
        void cutSelection();
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

  // 卸载（切换条目 / 关闭）时兜底关闭仍开着的独立菜单窗口
  useEffect(() => {
    return () => {
      ctxWinRef.current?.close().catch(() => undefined);
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
    void listen<CtxCommand>("md-ctx-command", (event) => {
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

  /** 复制：优先用 Clipboard API 写入选中文本（替代已弃用的 document.execCommand("copy")） */
  const copySelection = async (): Promise<void> => {
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!write) return;
    const text = getSelectedText();
    if (!text) return;
    try {
      await write(text);
    } catch {
      // 环境不支持或权限被拒：与原 execCommand 静默失败行为一致
    }
  };

  /** 剪切：复制选中文本后删除编辑器内选区（替代已弃用的 document.execCommand("cut")） */
  const cutSelection = async (): Promise<void> => {
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!write) return;
    const text = getSelectedText();
    if (!text) return;
    try {
      await write(text);
      editor?.chain().focus().deleteSelection().run();
    } catch {
      // 环境不支持或权限被拒：静默忽略
    }
  };

  /** 粘贴：读取剪贴板文本并插入光标处（替代已弃用的 document.execCommand("paste")） */
  const pasteFromClipboard = async (): Promise<void> => {
    const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
    if (!read) return;
    try {
      const text = await read();
      if (text) editor?.chain().focus().insertContent(text).run();
    } catch {
      // 权限被拒或环境不支持：静默忽略
    }
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

  /** 顶部工具条按钮（含特殊渲染项：type=color 渲染 antd 拾色器，type=clear 渲染清除按钮） */
  const triggerFileInput = (): void => {
    fileInputRef.current?.click();
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
                      setColorValue(
                        editor?.getAttributes("textStyle").color as
                          | string
                          | undefined
                      );
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
              colorValue={
                editor?.getAttributes("textStyle").color as string | undefined
              }
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
    </div>
  );
}
