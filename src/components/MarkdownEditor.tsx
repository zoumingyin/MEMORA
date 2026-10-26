import { useMemo, useRef, useState, type ReactNode } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Button, Segmented } from 'antd'
import {
  ColumnWidthOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
} from '@ant-design/icons'
import { countMarkdownWords } from '../utils/markdown'

export type MarkdownViewMode = 'edit' | 'split' | 'preview'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

type TextTransform = (sel: string) => string

/** 在选区两侧包裹包裹符；无选区时插入示例内容 */
function wrap(prefix: string, suffix: string, fallback: string): TextTransform {
  return (sel) => (sel ? `${prefix}${sel}${suffix}` : `${prefix}${fallback}${suffix}`)
}

/** 行首前缀（列表 / 引用 / 标题） */
function linePrefix(prefix: string, fallback: string): TextTransform {
  return (sel) => {
    const body = sel || fallback
    return body
      .split('\n')
      .map((line) => `${prefix}${line}`)
      .join('\n')
  }
}

/** 工具栏定义（纯描述，不引用组件内状态/ref，避免渲染期副作用） */
const TOOLS: Array<{ title: string; label: string; transform: TextTransform }> = [
  { title: '标题', label: 'H', transform: linePrefix('## ', '标题') },
  { title: '加粗', label: 'B', transform: wrap('**', '**', '加粗文字') },
  { title: '斜体', label: 'I', transform: wrap('*', '*', '斜体文字') },
  { title: '删除线', label: 'S', transform: wrap('~~', '~~', '删除文字') },
  { title: '无序列表', label: '•', transform: linePrefix('- ', '列表项') },
  { title: '有序列表', label: '1.', transform: linePrefix('1. ', '列表项') },
  { title: '引用', label: '❝', transform: linePrefix('> ', '引用内容') },
  { title: '代码块', label: '</>', transform: wrap('```\n', '\n```', '代码') },
  { title: '链接', label: '🔗', transform: wrap('[', '](https://)', '链接文字') },
  { title: '图片', label: '🖼', transform: wrap('![', '](https://)', '图片描述') },
]

/** 视图切换选项（antd Segmented） */
const MODE_OPTIONS: Array<{ value: MarkdownViewMode; label: ReactNode }> = [
  { value: 'edit', label: <span className="md-mode-label"><EyeInvisibleOutlined />编辑</span> },
  { value: 'split', label: <span className="md-mode-label"><ColumnWidthOutlined />分屏</span> },
  { value: 'preview', label: <span className="md-mode-label"><EyeOutlined />预览</span> },
]

/**
 * 轻量 Markdown 编辑器（antd 控件，用于备忘）：工具栏 + 编辑/分屏/预览三模式 + 底部字数统计。
 * 渲染经 marked 解析、DOMPurify 消毒，防止备忘内的原始 HTML 注入。
 */
export function MarkdownEditor({ value, onChange, placeholder }: MarkdownEditorProps) {
  const [mode, setMode] = useState<MarkdownViewMode>('edit')
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const wordCount = useMemo(() => countMarkdownWords(value), [value])
  const lineCount = useMemo(() => (value ? value.split('\n').length : 0), [value])

  /** 对当前选区应用变换并写回，随后尽力恢复光标 */
  const apply = (transform: TextTransform): void => {
    const el = areaRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const sel = value.slice(start, end)
    const next = transform(sel)
    const before = value.slice(0, start)
    const after = value.slice(end)
    onChange(`${before}${next}${after}`)
    requestAnimationFrame(() => {
      if (!areaRef.current) return
      areaRef.current.focus()
      areaRef.current.setSelectionRange(start, start + next.length)
    })
  }

  const html = useMemo(() => {
    if (mode === 'edit') return ''
    const raw = marked.parse(value || '')
    return DOMPurify.sanitize(typeof raw === 'string' ? raw : '')
  }, [value, mode])

  const renderPreview = (): ReactNode =>
    value.trim() ? (
      <div className="md-preview" dangerouslySetInnerHTML={{ __html: html }} />
    ) : (
      <div className="md-preview md-preview-empty">（暂无内容）</div>
    )

  return (
    <div className="md-editor">
      <div className="md-editor-bar">
        <div className="md-editor-tools">
          {TOOLS.map((tool) => (
            <Button
              key={tool.title}
              type="text"
              size="small"
              className="md-tool"
              title={tool.title}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => apply(tool.transform)}
            >
              {tool.label}
            </Button>
          ))}
        </div>
        <Segmented<MarkdownViewMode>
          size="small"
          value={mode}
          options={MODE_OPTIONS}
          onChange={(value) => setMode(value)}
        />
      </div>

      <div className={`md-editor-body md-mode-${mode}`}>
        {mode !== 'preview' && (
          <textarea
            ref={areaRef}
            className="md-textarea"
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
          />
        )}
        {mode !== 'edit' && renderPreview()}
      </div>

      <div className="md-editor-status">
        <span>Markdown</span>
        <span>
          {wordCount} 字 · {lineCount} 行
        </span>
      </div>
    </div>
  )
}
