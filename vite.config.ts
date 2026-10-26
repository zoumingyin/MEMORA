import react from '@vitejs/plugin-react'
import UnoCSS from '@unocss/vite'
import { defineConfig } from 'vite'

// Tauri 开发端口固定为 1420，与 tauri.conf.json 的 devUrl 保持一致
export default defineConfig({
  plugins: [react(), UnoCSS()],
  clearScreen: false,
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
