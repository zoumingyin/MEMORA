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
      note: '#2563eb',
      reminder: '#d9686b',
      todo: '#57a878',
      // 跟随 CSS 变量：暗色玻璃模式（:root 注入 DARK_TOKENS）时自动换浅色，避免固定色值在深色面板上失读
      ink: 'var(--text)',
      muted: 'var(--text-muted)',
    },
  },
  shortcuts: {
    'flex-center': 'flex items-center justify-center',
    // 卡片（严格参考风）：固定高度 + 白底 + 发丝边框 + 无投影；竖向布局（图标在顶 → 标题 → 描述/缩略图 → 分隔线 → 时间），hover 浅蓝高亮、active 蓝边选中
    'note-card':
      'flex flex-col items-start gap-1.5 w-full h-[196px] overflow-hidden text-left p-[14px] border border-solid border-[var(--border)] rounded-[14px] bg-[var(--card-bg)] text-[var(--text)] transition hover:bg-[var(--card-active-bg)] hover:border-[var(--card-border-hover)]',
    // 选中卡片：浅蓝填充 + 鲜亮蓝描边
    'note-card-active':
      'flex flex-col items-start gap-1.5 w-full h-[196px] overflow-hidden text-left p-[14px] border border-solid rounded-[14px] text-[var(--text)] bg-[var(--card-active-bg)] border-[var(--card-active-border)] transition',
  },
})
