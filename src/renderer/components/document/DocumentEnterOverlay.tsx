import { motion, AnimatePresence } from 'framer-motion'
import { FileText, Loader2 } from 'lucide-react'

interface DocumentEnterOverlayProps {
  visible: boolean
  direction?: -1 | 1
}

const TRANSITION_EASE = [0.24, 1, 0.36, 1] as const

export default function DocumentEnterOverlay({
  visible,
  direction = 1,
}: DocumentEnterOverlayProps) {
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
            background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
          }}
        >
          {/* 骨架结构：模拟文档标签栏、路径栏和编辑器 */}
          <div className="flex h-full flex-col">
            {/* 标签栏占位 */}
            <div
              className="flex items-center gap-1 px-2 py-2"
              style={{
                borderBottom: '1px solid var(--border-subtle)',
                background: 'var(--surface-elevated-bg)',
              }}
            >
              {/* 标签占位 */}
              <div
                className="h-7 w-28 rounded-md"
                style={{ background: 'var(--surface-floating-bg)' }}
              />
              {/* 新建标签按钮占位 */}
              <div
                className="ml-1 flex h-6 w-6 items-center justify-center rounded"
                style={{ color: 'var(--text-muted)' }}
              >
                <span className="text-lg leading-none">+</span>
              </div>
              {/* 右侧模式切换占位 */}
              <div className="ml-auto flex items-center gap-1">
                <div
                  className="h-6 w-16 rounded-md"
                  style={{ background: 'var(--surface-floating-bg)' }}
                />
              </div>
            </div>

            {/* 路径栏占位 */}
            <div
              className="flex items-center px-4"
              style={{
                height: 30,
                borderBottom: '1px solid var(--border-subtle)',
                background: 'var(--workbench-liquid-chrome-bg, color-mix(in srgb, var(--bg-content) 18%, transparent))',
              }}
            >
              <div
                className="ml-auto h-3 w-48 rounded"
                style={{ background: 'var(--border-default)' }}
              />
            </div>

            {/* 编辑器区域占位 */}
            <div
              className="relative flex flex-1 flex-col overflow-hidden"
              style={{
                background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
              }}
            >
              {/* 模拟编辑器内容 */}
              <div className="flex flex-1 p-6">
                {/* 左侧行号占位 */}
                <div className="mr-4 flex w-8 flex-col gap-2">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-3 w-full rounded"
                      style={{ background: 'var(--border-default)', opacity: 0.3 + (i % 3) * 0.1 }}
                    />
                  ))}
                </div>
                {/* 右侧内容占位 */}
                <div className="flex flex-1 flex-col gap-3">
                  {/* 标题占位 */}
                  <div
                    className="mb-2 h-8 w-3/5 rounded-lg"
                    style={{ background: 'var(--surface-floating-bg)' }}
                  />
                  {/* 段落占位 */}
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-4 rounded"
                      style={{
                        background: 'var(--border-default)',
                        width: i === 5 ? '60%' : '100%',
                        opacity: 0.5 - i * 0.05,
                      }}
                    />
                  ))}
                </div>
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
                    加载文档...
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
