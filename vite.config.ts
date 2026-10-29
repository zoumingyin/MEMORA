import react from '@vitejs/plugin-react'
import UnoCSS from '@unocss/vite'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

// Tauri 开发端口固定为 1420，与 tauri.conf.json 的 devUrl 保持一致
export default defineConfig({
  plugins: [react(), UnoCSS()],
  clearScreen: false,
  build: {
    rollupOptions: {
      // 多页入口：图片预览弹窗使用独立轻量入口，避免加载主应用全量 bundle 白屏
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        imagePreview: fileURLToPath(new URL('./imagePreview.html', import.meta.url)),
        alarm: fileURLToPath(new URL('./alarm.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // Rust 后端变更不触发前端 HMR，由 Tauri CLI 监听重载
      ignored: ['**/src-tauri/**'],
    },
  },
})
