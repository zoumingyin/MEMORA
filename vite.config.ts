import react from '@vitejs/plugin-react'
import UnoCSS from '@unocss/vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

// 编译期内置 OpenCode 密钥：与 src-tauri/build.rs 读同一个密钥文件
// （src-tauri/keys/opencode.key，已 gitignore）。浏览器预览没有 Rust
// 后端，免费模型请求由前端直连，密钥通过 define 注入为编译期常量；
// 文件缺失时置空，构建照常通过。
const BUILTIN_OPENCODE_KEY = (() => {
  try {
    return readFileSync(
      fileURLToPath(new URL('./src-tauri/keys/opencode.key', import.meta.url)),
      'utf8',
    ).trim()
  } catch {
    return ''
  }
})()

// Tauri 开发端口固定为 1420，与 tauri.conf.json 的 devUrl 保持一致
export default defineConfig({
  plugins: [react(), UnoCSS()],
  define: {
    __BUILTIN_OPENCODE_KEY__: JSON.stringify(BUILTIN_OPENCODE_KEY),
  },
  clearScreen: false,
  build: {
    rollupOptions: {
      // 多页入口：图片预览 / 闹钟 / 右键菜单 / 快捷搜索使用独立轻量入口，避免加载主应用全量 bundle 白屏
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        imagePreview: fileURLToPath(new URL('./imagePreview.html', import.meta.url)),
        alarm: fileURLToPath(new URL('./alarm.html', import.meta.url)),
        ctxmenu: fileURLToPath(new URL('./ctxmenu.html', import.meta.url)),
        spotlight: fileURLToPath(new URL('./spotlight.html', import.meta.url)),
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
