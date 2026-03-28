import { motion, AnimatePresence } from 'framer-motion'
import { Rss, Loader2, RefreshCw, Star, Trash2 } from 'lucide-react'

interface RSSEnterOverlayProps {
  visible: boolean
  direction?: -1 | 1
}

const TRANSITION_EASE = [0.24, 1, 0.36, 1] as const

export default function RSSEnterOverlay({
  visible,
  direction = 1,
}: RSSEnterOverlayProps) {
  return (
    <AnimatePresence mode="wait">
      {visible && (
        <motion.div
          initial={{ opacity: 1, x: direction > 0 ? '30%' : '-30%' }}
          animate={{ opacity: 1, x: '0%' }}
          exit={{ opacity: 0, x: '0%' }}
          transition={{
            duration: 0.28,
            ease: TRANSITION_EASE,
          }}
          className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
          style={{
            borderRadius: 'inherit',
            background: 'color-mix(in srgb, var(--bg-content) 18%, transparent)',
          }}
        >
          {/* 骨架结构：模拟 RSS 工具栏、源列表和文章列表 */}
          <div className="flex h-full">
            {/* 左侧源列表面板 */}
            <div
              className="flex w-[200px] flex-shrink-0 flex-col border-r border-[var(--border-default)]"
              style={{ background: 'color-mix(in srgb, var(--bg-content) 18%, transparent)' }}
            >
              {/* 源列表头部 */}
              <div
                className="flex items-center justify-between px-3 py-3"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
              >
                <span
                  className="text-[12px] font-medium"
                  style={{ color: 'var(--text-muted)' }}
                >
                  订阅源
                </span>
                <RefreshCw
                  className="h-3.5 w-3.5"
                  style={{ color: 'var(--text-muted)' }}
                />
              </div>
              {/* 源列表项占位 */}
              <div className="flex flex-col gap-1 p-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-md px-2 py-2"
                    style={{ background: i === 0 ? 'var(--surface-floating-bg)' : 'transparent' }}
                  >
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{ background: i === 0 ? 'var(--color-blue)' : 'var(--border-default)' }}
                    />
                    <div
                      className="h-3 flex-1 rounded"
                      style={{ background: 'var(--border-default)', width: `${60 + (i % 3) * 15}%` }}
                    />
                    <div
                      className="h-4 w-5 rounded"
                      style={{ background: 'var(--surface-floating-bg)' }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* 右侧文章列表区域 */}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* 工具栏占位 */}
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
              >
                {/* 筛选按钮占位 */}
                <div className="flex items-center gap-2">
                  <div
                    className="h-7 w-16 rounded-md"
                    style={{ background: 'var(--surface-floating-bg)' }}
                  />
                  <div
                    className="h-7 w-16 rounded-md"
                    style={{ background: 'var(--surface-floating-bg)' }}
                  />
                  <div
                    className="h-7 w-16 rounded-md"
                    style={{ background: 'var(--surface-floating-bg)' }}
                  />
                </div>
                {/* 右侧操作按钮占位 */}
                <div className="flex items-center gap-2">
                  <div
                    className="h-7 w-7 rounded-md"
                    style={{ background: 'var(--surface-floating-bg)' }}
                  />
                  <div
                    className="h-7 w-20 rounded-md"
                    style={{ background: 'var(--surface-floating-bg)' }}
                  />
                </div>
              </div>

              {/* 文章列表占位 */}
              <div className="flex flex-1 flex-col">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 border-b border-[var(--border-subtle)] px-4 py-4"
                    style={{
                      background: i === 0 ? 'color-mix(in srgb, var(--surface-floating-bg) 50%, transparent)' : 'transparent',
                      opacity: 1 - i * 0.1,
                    }}
                  >
                    {/* 左侧蓝色条（未读标记） */}
                    {i < 3 && (
                      <div
                        className="mt-1 h-2 w-2 rounded-full flex-shrink-0"
                        style={{ background: 'var(--color-blue)' }}
                      />
                    )}
                    {/* 内容区域 */}
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      {/* 标题 */}
                      <div
                        className="h-4 rounded"
                        style={{
                          background: 'var(--surface-floating-bg)',
                          width: `${70 + (i % 4) * 10}%`,
                        }}
                      />
                      {/* 摘要 */}
                      <div
                        className="h-3 rounded"
                        style={{
                          background: 'var(--border-default)',
                          width: `${90 - (i % 3) * 10}%`,
                        }}
                      />
                      {/* 底部信息 */}
                      <div className="mt-1 flex items-center gap-3">
                        <div
                          className="h-2.5 w-16 rounded"
                          style={{ background: 'var(--border-default)', opacity: 0.6 }}
                        />
                        <div
                          className="h-2.5 w-20 rounded"
                          style={{ background: 'var(--border-default)', opacity: 0.6 }}
                        />
                      </div>
                    </div>
                    {/* 右侧收藏按钮 */}
                    <Star
                      className="h-4 w-4 flex-shrink-0"
                      style={{ color: i === 1 ? 'var(--color-yellow)' : 'var(--border-default)' }}
                    />
                  </div>
                ))}
              </div>

              {/* 中央加载指示 */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                  <div className="relative">
                    <div
                      className="h-10 w-10 rounded-full"
                      style={{
                        border: '2px solid var(--border-default)',
                        borderTopColor: 'var(--color-blue)',
                      }}
                    />
                    <motion.div
                      className="absolute inset-0"
                      animate={{ rotate: 360 }}
                      transition={{
                        duration: 0.8,
                        repeat: Infinity,
                        ease: 'linear',
                      }}
                    >
                      <Loader2
                        className="h-10 w-10"
                        style={{ color: 'var(--color-blue)' }}
                      />
                    </motion.div>
                  </div>
                  <span
                    className="text-[13px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    加载 RSS...
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 玻璃效果边缘 */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              borderRadius: 'inherit',
              boxShadow: 'inset 0 0 0 1px var(--border-subtle)',
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
