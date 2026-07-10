import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
// @ts-expect-error - @tailwindcss/vite types require bundler moduleResolution
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({
      exclude: ['@openuidev/react-lang', '@openuidev/lang-core'],
    })],
    build: {
      rollupOptions: {
        external: ['rsshub', /^rsshub\/.*/, '@puppeteer/browsers', /^@puppeteer\/browsers\/.*/],
        input: {
          // 微入口：先亮启动动画再动态加载重模块（src/main/index.ts）。
          // 产物仍是 out/main/index.js，package.json "main" 不变。
          index: resolve(__dirname, 'src/main/boot-entry.ts'),
          // 重模块必须是具名 entry 而不是匿名 chunk：entry 产物固定落在
          // out/main/app.js，保住模块内 `join(__dirname, '../preload/…')`
          // 等相对路径的 out/main 基准；掉进 out/main/chunks/ 会整体偏一级
          //（preview 实测 renderer/preload ERR_FILE_NOT_FOUND）。
          app: resolve(__dirname, 'src/main/index.ts'),
          'rsshub-worker': resolve(__dirname, 'src/main/modules/rss-engine/rsshub-worker.mjs'),
          // perf-rescue B1: dedicated worker_thread for heavy DB queries
          // (graph BFS, FTS scan, reindex). The main bundle never imports
          // this file at runtime; worker-bridge.ts spawns it via Worker(path).
          'db-worker': resolve(__dirname, 'src/main/modules/database/worker.ts'),
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({
      exclude: ['@openuidev/react-lang', '@openuidev/lang-core'],
    })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@main': resolve(__dirname, 'src/main'),
        '@preload': resolve(__dirname, 'src/preload'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    optimizeDeps: {
      exclude: ['foliate-js'],
    },
    plugins: [tailwindcss(), react()]
  }
})
