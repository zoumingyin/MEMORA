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
  },
})
