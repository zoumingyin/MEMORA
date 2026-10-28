import {
  defineConfig,
  presetAttributify,
  presetUno,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss'

// UnoCSS：原子类 CSS 引擎，配合 antd 与自研毛玻璃样式层
export default defineConfig({
  presets: [
    presetUno(),
    presetAttributify(),
  ],
  transformers: [
    transformerDirectives(),
    transformerVariantGroup(),
  ],
  theme: {
    colors: {
      note: '#5b8fd9',
      reminder: '#d9686b',
      todo: '#57a878',
      // 跟随 CSS 变量：暗色玻璃模式（:root 注入 DARK_TOKENS）时自动换浅色，避免固定色值在深色面板上失读
      ink: 'var(--text)',
      muted: 'var(--text-muted)',
    },
  },
  shortcuts: {
    'flex-center': 'flex items-center justify-center',
    // 纸张卡片（随主题自适应）：实色浅底 + 细边框 + 圆角 + 轻微阴影；hover/active 见下方
    'note-card':
      'flex items-center gap-2 w-full text-left px-11px py-10px border border-solid border-[var(--border)] rounded-xl bg-[rgb(var(--field-rgb))] text-[var(--text)] shadow-[var(--card-shadow)] transition hover:bg-[var(--card-accent-bg)] hover:border-[var(--card-accent-border)] hover:shadow-[var(--card-shadow-active)]',
    // 选中卡片：强调色填充 + 内描边环 + 投影
    'note-card-active':
      'flex items-center gap-2 w-full text-left px-11px py-10px border border-solid rounded-xl text-[var(--text)] bg-[var(--card-accent-bg)] border-[var(--card-accent-border)] shadow-[var(--card-shadow-active)]',
  },
})
