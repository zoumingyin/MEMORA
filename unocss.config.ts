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
      // MEMORA 语义色：备忘=主色蓝 / 提醒=珊瑚 / 待办=成功绿 / 涂鸦=AI 紫
      note: '#536dff',
      reminder: '#e56875',
      todo: '#16a78a',
      draw: '#8b5cf6',
      // 跟随 CSS 变量：主题切换（data-theme）时自动换色，避免固定色值在深色面板上失读
      ink: 'var(--text)',
      muted: 'var(--text-muted)',
    },
  },
  shortcuts: {
    'flex-center': 'flex items-center justify-center',
    // 卡片（参考风）：固定高度 + 白底 + 发丝边框；竖向布局（图标在顶 → 标题 → 描述/缩略图 → 分隔线 → 时间）
    // hover：边框高亮 + 柔和投影上浮（投影令牌分亮/暗两套，见 index.css --card-hover-shadow）；
    // 不改背景色，纸张淡染/纹理（note-row[data-paper]）不受 hover 影响；无选中 active 态
    'note-card':
      'flex flex-col items-start gap-1.5 w-full h-[196px] overflow-hidden text-left p-[14px] border border-solid border-[var(--border)] rounded-[var(--memora-radius-card)] bg-[var(--card-bg)] text-[var(--text)] transition hover:border-[var(--card-border-hover)] hover:shadow-[var(--card-hover-shadow)]',
  },
})
