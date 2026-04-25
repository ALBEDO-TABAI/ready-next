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
          index: resolve(__dirname, 'src/main/index.ts'),
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
    plugins: [tailwindcss(), react()]
  }
})
