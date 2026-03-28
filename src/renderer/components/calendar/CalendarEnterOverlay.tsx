import { motion, AnimatePresence } from 'framer-motion'
import { Calendar, Loader2, ChevronLeft, ChevronRight } from 'lucide-react'

interface CalendarEnterOverlayProps {
  visible: boolean
  direction?: -1 | 1
}

const TRANSITION_EASE = [0.24, 1, 0.36, 1] as const

export default function CalendarEnterOverlay({
  visible,
  direction = 1,
}: CalendarEnterOverlayProps) {
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
          {/* 骨架结构：模拟日历工具栏、迷你日历和主日历 */}
          <div className="flex h-full">
            {/* 左侧边栏 */}
            <div
              className="flex w-[220px] flex-shrink-0 flex-col border-r border-[var(--border-default)]"
              style={{ background: 'var(--surface-elevated-bg)' }}
            >
              {/* 创建按钮占位 */}
              <div className="p-3">
                <div
                  className="h-9 w-full rounded-lg"
                  style={{ background: 'var(--surface-floating-bg)' }}
                />
              </div>

              {/* 迷你日历占位 */}
              <div className="px-3 pb-3">
                <div
                  className="rounded-lg p-2"
                  style={{ background: 'var(--surface-floating-bg)' }}
                >
                  {/* 月份导航 */}
                  <div className="mb-2 flex items-center justify-between px-1">
                    <ChevronLeft className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />
                    <div
                      className="h-3 w-20 rounded"
                      style={{ background: 'var(--border-default)' }}
                    />
                    <ChevronRight className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />
                  </div>
                  {/* 星期标题 */}
                  <div className="mb-1 grid grid-cols-7 gap-1">
                    {['日', '一', '二', '三', '四', '五', '六'].map((day) => (
                      <div
                        key={day}
                        className="flex h-5 items-center justify-center text-[10px]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {day}
                      </div>
                    ))}
                  </div>
                  {/* 日期网格 */}
                  <div className="grid grid-cols-7 gap-1">
                    {Array.from({ length: 35 }).map((_, i) => (
                      <div
                        key={i}
                        className="flex h-6 items-center justify-center rounded"
                        style={{
                          background: i === 15 ? 'var(--color-blue)' : 'transparent',
                          opacity: i < 5 || i > 30 ? 0.3 : 1,
                        }}
                      >
                        <div
                          className="h-2 w-2 rounded-full"
                          style={{
                            background: i === 15 ? 'white' : 'var(--border-default)',
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* 日历源列表占位 */}
              <div className="flex flex-1 flex-col gap-1 px-3 py-2">
                <span
                  className="mb-1 text-[11px]"
                  style={{ color: 'var(--text-muted)' }}
                >
                  我的日历
                </span>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5">
                    <div
                      className="h-3 w-3 rounded"
                      style={{
                        background: i === 0 ? '#5B8DEF' : i === 1 ? '#34D399' : '#8B5CF6',
                      }}
                    />
                    <div
                      className="h-3 flex-1 rounded"
                      style={{ background: 'var(--border-default)', width: `${50 + i * 15}%` }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* 右侧主日历区域 */}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* 工具栏占位 */}
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
              >
                {/* 左侧标题和导航 */}
                <div className="flex items-center gap-3">
                  <div
                    className="h-6 w-28 rounded-md"
                    style={{ background: 'var(--surface-floating-bg)' }}
                  />
                  <div className="flex items-center gap-1">
                    <div
                      className="h-7 w-7 rounded-md"
                      style={{ background: 'var(--surface-floating-bg)' }}
                    />
                    <div
                      className="h-7 w-7 rounded-md"
                      style={{ background: 'var(--surface-floating-bg)' }}
                    />
                  </div>
                  <div
                    className="h-7 w-14 rounded-md"
                    style={{ background: 'var(--surface-floating-bg)' }}
                  />
                </div>
                {/* 右侧视图切换 */}
                <div className="flex items-center gap-1">
                  <div
                    className="h-7 w-16 rounded-md"
                    style={{ background: 'var(--surface-floating-bg)' }}
                  />
                  <div
                    className="h-7 w-16 rounded-md"
                    style={{ background: 'var(--color-blue)' }}
                  />
                  <div
                    className="h-7 w-16 rounded-md"
                    style={{ background: 'var(--surface-floating-bg)' }}
                  />
                </div>
              </div>

              {/* 周视图表头 */}
              <div
                className="grid"
                style={{
                  gridTemplateColumns: 'repeat(7, 1fr)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                {Array.from({ length: 7 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-center py-2"
                    style={{
                      borderRight: i < 6 ? '1px solid var(--border-subtle)' : 'none',
                      background: i === 2 ? 'var(--surface-floating-bg)' : 'transparent',
                    }}
                  >
                    <div
                      className="h-3 w-12 rounded"
                      style={{ background: 'var(--border-default)' }}
                    />
                  </div>
                ))}
              </div>

              {/* 日历网格占位 */}
              <div className="relative flex flex-1">
                {/* 时间列 */}
                <div
                  className="w-14 flex-shrink-0 border-r border-[var(--border-subtle)]"
                  style={{ background: 'var(--surface-elevated-bg)' }}
                >
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex h-12 items-start justify-center pt-1"
                    >
                      <div
                        className="h-2 w-6 rounded"
                        style={{ background: 'var(--border-default)', opacity: 0.5 }}
                      />
                    </div>
                  ))}
                </div>

                {/* 日程网格 */}
                <div className="relative flex flex-1">
                  <div
                    className="grid flex-1"
                    style={{
                      gridTemplateColumns: 'repeat(7, 1fr)',
                    }}
                  >
                    {Array.from({ length: 84 }).map((_, i) => (
                      <div
                        key={i}
                        className="border-r border-b border-[var(--border-subtle)]"
                        style={{
                          background: (i % 7) === 2 ? 'color-mix(in srgb, var(--surface-floating-bg) 30%, transparent)' : 'transparent',
                          height: 48,
                        }}
                      />
                    ))}
                  </div>

                  {/* 模拟事件卡片 */}
                  <div
                    className="absolute rounded-md p-1.5"
                    style={{
                      left: `${(2 / 7) * 100}%`,
                      top: 96,
                      width: `${100 / 7 - 1}%`,
                      height: 72,
                      background: '#5B8DEF',
                      opacity: 0.8,
                    }}
                  >
                    <div className="h-2 w-full rounded bg-white/50" />
                  </div>
                  <div
                    className="absolute rounded-md p-1.5"
                    style={{
                      left: `${(4 / 7) * 100}%`,
                      top: 144,
                      width: `${100 / 7 - 1}%`,
                      height: 48,
                      background: '#34D399',
                      opacity: 0.8,
                    }}
                  >
                    <div className="h-2 w-3/4 rounded bg-white/50" />
                  </div>
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
                    加载日历...
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
