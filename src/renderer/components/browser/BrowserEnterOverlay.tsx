import { motion, AnimatePresence } from 'framer-motion'
import { Globe, Loader2 } from 'lucide-react'

interface BrowserEnterOverlayProps {
  visible: boolean
  direction?: -1 | 1
}

const TRANSITION_EASE = [0.24, 1, 0.36, 1] as const

export default function BrowserEnterOverlay({
  visible,
  direction = 1,
}: BrowserEnterOverlayProps) {
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
          {/* 骨架结构：模拟浏览器标签栏和地址栏 */}
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
            </div>

            {/* 地址栏占位 */}
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{
                borderBottom: '1px solid var(--border-subtle)',
                background: 'var(--surface-elevated-bg)',
              }}
            >
              {/* 导航按钮 */}
              <div className="flex gap-1">
                <div
                  className="h-7 w-7 rounded-md"
                  style={{ background: 'var(--surface-floating-bg)' }}
                />
                <div
                  className="h-7 w-7 rounded-md"
                  style={{ background: 'var(--surface-floating-bg)' }}
                />
              </div>
              {/* 地址输入框 */}
              <div
                className="flex h-8 flex-1 items-center gap-2 rounded-lg px-3"
                style={{
                  background: 'var(--surface-floating-bg)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <Globe
                  className="flex-shrink-0"
                  style={{
                    width: 14,
                    height: 14,
                    color: 'var(--text-muted)',
                  }}
                />
                <div
                  className="h-3 flex-1 rounded"
                  style={{ background: 'var(--border-default)' }}
                />
              </div>
              {/* 菜单按钮 */}
              <div
                className="h-7 w-7 rounded-md"
                style={{ background: 'var(--surface-floating-bg)' }}
              />
            </div>

            {/* 内容区域占位 */}
            <div
              className="relative flex flex-1 items-center justify-center"
              style={{
                background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
              }}
            >
              {/* 中央加载指示 */}
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
                  加载浏览器...
                </span>
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
